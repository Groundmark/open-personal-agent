// The fixture errand: every fixture plus a stand-in core, booking a table end to end.
// This is the integration test every package keeps green. When the real core
// (parts/core) exists, it replaces `standInCore` and this script still has to pass.
//
//   npm run errand            # prints the conversation and the history
//
// Every request and response is checked against contracts/schemas/.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serve, call, request, ulid } from '../lib/wire.js';
import { Log } from '../lib/log.js';
import { validate, validateEnvelope } from '../lib/schema.js';
import { FixtureCredentialStore } from '../store/fixture-store.js';
import { startSite } from '../site/server.js';
import { BrokerFixture } from '../broker/broker.js';
import { ContextFixture } from '../context/context.js';
import { TerminalChannel } from '../channel/terminal.js';
import { startRouter, infer } from '../router/router.js';
import { verifyAll, show } from '../history/history.js';

const SCHEMA_FILE = (op) =>
  op === 'infer' ? 'router.schema.json'
    : op.startsWith('browser.') ? 'browser-worker.schema.json'
      : op.startsWith('channel.') || op === 'grant.event' ? 'channel.schema.json'
        : op.startsWith('context.') ? 'context-gateway.schema.json'
          : 'broker.schema.json';

export const violations = [];

function check(kind, op, data) {
  const errs = kind === 'request' || kind === 'ok_response' || kind === 'error_response'
    ? validateEnvelope(kind, data) : [];
  let defErrs = [];
  try { defErrs = validate(SCHEMA_FILE(op), kind, data); } catch { /* no def for this op/kind: fine */ }
  for (const e of [...errs, ...defErrs]) violations.push(`${op} ${kind}: ${e}`);
}

/** Send a request over a socket, checking both sides against the schemas. */
export async function checkedCall(socket, op, caller, errandId, args) {
  const req = request(op, caller, errandId, args);
  check('request', op, req);
  check(`${op}.args`, op, args);
  const res = await call(socket, req);
  check(res.ok ? 'ok_response' : 'error_response', op, res);
  if (res.ok) check(`${op}.result`, op, res.result);
  return res;
}

export const SCRIPT = [
  { when: 'Book a table', tool_calls: [{ name: 'find_table', arguments: { venue: 'Casa Verde', date: '2026-12-04', time: '19:00', party_size: 2 } }] },
  { when: 'Reservation confirmed', text: 'Booked.' },
  { when: '*', text: 'Sorry, I did not follow that.' },
];

/** Start every fixture in `dir`. Returns handles and a stop() function. */
export async function startAll(dir, { storeOpts } = {}) {
  // Unix socket paths are limited to ~104-108 bytes; use a short directory if `dir` is long.
  const sockDir = path.join(dir, 'x.sock').length > 100 ? fs.mkdtempSync('/tmp/opa-') : dir;
  const sock = (n) => path.join(sockDir, `${n}.sock`);
  const site = await startSite();
  const store = new FixtureCredentialStore({}, storeOpts);
  store.setOrigin('fake-table', site.origin);

  const waiters = new Map();
  const inbox = [];
  const coreServer = await serve(sock('core'), {
    'channel.inbound': async (a) => { inbox.push(a); return {}; },
    'grant.event': async ({ grant_id, state }) => { waiters.get(grant_id)?.(state); return {}; },
  });

  const broker = new BrokerFixture({
    store, logPath: path.join(dir, 'actions.jsonl'),
    onGrantEvent: (grant_id, state) => checkedCall(sock('core'), 'grant.event', 'broker', null, { grant_id, state }),
  });
  const brokerServer = await broker.listen(sock('broker-core'));
  const brokerChannelServer = await broker.listen(sock('broker-channel-terminal'), { caller: 'channel-terminal' });
  const context = new ContextFixture({ logPath: path.join(dir, 'context-reads.jsonl') });
  const contextServer = await context.listen(sock('context'));
  const channel = new TerminalChannel({ coreSocket: sock('core'), print: false });
  channel.watchSlots(sock('broker-channel-terminal'));   // the adapter long-polls code.slots, as a real one does
  const channelServer = await channel.listen(sock('channel'));
  const router = await startRouter({ script: SCRIPT });

  fs.writeFileSync(path.join(dir, 'keys.json'), JSON.stringify({
    broker: broker.brokerKey.publicKey.export({ type: 'spki', format: 'pem' }),
    context: context.key.publicKey.export({ type: 'spki', format: 'pem' }),
    agent: broker.agentKey.publicKey.export({ type: 'spki', format: 'pem' }),
  }, null, 2));

  const waitFor = (grantId) => new Promise((resolve) => waiters.set(grantId, resolve));
  const stop = async () => {
    await channel.stop();
    for (const s of [coreServer, brokerServer, brokerChannelServer, contextServer, channelServer]) s.close();
    await router.close(); await site.close();
    if (sockDir !== dir) fs.rmSync(sockDir, { recursive: true, force: true });
  };
  return { dir, sock, site, store, broker, context, channel, router, inbox, waitFor, stop };
}

/** A stand-in for parts/core: the booking errand as a fixed sequence of contract calls. */
export async function standInCore(env, { log = () => {} } = {}) {
  const { sock, site, channel, router, inbox, waitFor, dir } = env;
  const conv = new Log(path.join(dir, 'conversation.jsonl'));
  const B = (op, args) => checkedCall(sock('broker-core'), op, 'core', errandId, args).then((r) => {
    if (!r.ok) throw new Error(`${op} failed: ${r.error} ${r.message}`);
    return r.result;
  });
  const say = async (text) => {
    const args = { channel: 'terminal', to: channel.sender, text, attachments: [] };
    const r = await checkedCall(sock('channel'), 'channel.send', 'core', errandId, args);
    conv.append({ errand_id: errandId, type: 'message', direction: 'out', channel: 'terminal', message_id: r.result.message_id, text, attachments: [] });
    log(`agent>  ${text}`);
  };

  // 0. The person pairs their account with the code the installer showed them.
  if (!channel.pairing) await channel.inbound(channel.pairingCode);

  // 1. The person asks.
  await channel.inbound('Book a table for 2 at Casa Verde on 2026-12-04 at 19:00, please.');
  const msg = inbox.shift();
  const errandId = ulid();
  conv.append({ errand_id: errandId, type: 'message', direction: 'in', channel: msg.channel, message_id: msg.message_id, text: msg.text, attachments: [] });
  log(`person> ${msg.text}`);

  // 2. The model turns it into a plan (scripted).
  const inferArgs = { model: 'default', system: 'You book tables.', messages: [{ role: 'user', content: msg.text }], tools: [{ name: 'find_table', description: 'Find and book a table', parameters: { type: 'object' } }] };
  const inf = await infer(router.url, (() => { const r = request('infer', 'core', errandId, inferArgs); check('request', 'infer', r); check('infer.args', 'infer', inferArgs); return r; })());
  check('infer.result', 'infer', inf.result);
  const want = inf.result.tool_calls[0].arguments;

  // 3. A standing grant to search and log in, approved once with the passkey.
  const standing = await B('grant.request', { credential: 'fake-table', ops: ['search', 'login'], constraints: { site: site.origin }, mode: 'standing', ttl_seconds: 3600, purpose: 'Find a table and sign in' });
  const s1 = waitFor(standing.grant_id);
  await say(`To search I need to use your Fake Table login. Approve: ${standing.approve_url}`);
  if ((await s1) !== 'approved') throw new Error('standing grant not approved');

  // 4. Browse to the slot, sign in through the broker.
  const g = standing.grant_id;
  const { session_id } = await B('browser.open', { grant_id: g, url: site.origin + '/' });
  const act = (action, target, value, extra = {}) => B('browser.act', { grant_id: g, session_id, action, target, ...(value !== undefined ? { value } : {}), ...extra });
  await act('type', 'Where', want.venue);
  await act('type', 'Date', want.date);
  await act('type', 'Time', want.time);
  await act('type', 'People', String(want.party_size));
  await act('click', 'Search');
  await act('click', want.venue);
  const atSlot = await act('click', want.time);
  if (atSlot.page.title === 'Sign in') {
    await B('browser.fill_login', { grant_id: g, session_id, credential: 'fake-table' });
    await act('click', 'Sign in');
  }

  // 6. One-shot booking grant for exactly this option; the person approves with a passkey.
  const book = await B('grant.request', { credential: 'fake-table', ops: ['book'], constraints: { venue: want.venue, date: want.date, time: want.time, party_size: want.party_size }, mode: 'one_shot', ttl_seconds: 900, purpose: 'Book this table' });
  const s2 = waitFor(book.grant_id);
  await say(`${book.summary} Approve with your passkey: ${book.approve_url}`);
  if ((await s2) !== 'approved') throw new Error('booking grant not approved');

  // Log the declaration this agent would present, though the site can't receive one. The broker builds it from the
  // approved booking grant (contracts 0.4), so it can only declare an act the person approved.
  await B('identity.declaration', { grant_id: book.grant_id, act: 'book' });

  // 7. The binding click.
  const done = await act('click', 'Complete reservation', undefined, { book_grant_id: book.grant_id });
  const confirmation = /Confirmation ([A-Z]+-[A-F0-9]+)/.exec(done.page.text)?.[1];

  // 8. Tell the person.
  const replyArgs = { model: 'default', messages: [{ role: 'user', content: msg.text }, { role: 'tool', content: [{ type: 'tool_result', call_id: inf.result.tool_calls[0].call_id, content: done.page.text }] }] };
  const reply = await infer(router.url, request('infer', 'core', errandId, replyArgs));
  check('infer.result', 'infer', reply.result);
  await say(`${reply.result.content[0].text} ${want.venue}, ${want.date} at ${want.time} for ${want.party_size}. Confirmation ${confirmation}.`);
  await B('browser.close', { grant_id: g, session_id });

  return { errandId, confirmation, standingGrant: g, bookGrant: book.grant_id };
}

export async function runErrand({ dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opa-errand-')), log = () => {} } = {}) {
  violations.length = 0;
  const env = await startAll(dir);
  try {
    const out = await standInCore(env, { log });
    return { ...out, dir, bookings: env.site.bookings, outbox: env.channel.outbox, verify: verifyAll(dir), violations: [...violations], env };
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = await runErrand({ log: (l) => console.log(l) });
  console.log('\n--- history show ---\n' + show(r.dir, r.errandId));
  console.log('\n--- history verify ---');
  for (const [k, v] of Object.entries(r.verify)) console.log(`${k.padEnd(13)} ${v.ok ? 'OK' : 'BROKEN'} (${v.lines} lines)`);
  console.log(`\nschema violations: ${r.violations.length}`);
  for (const v of r.violations) console.log('  ' + v);
  console.log(`logs in ${r.dir}`);
  process.exit(r.violations.length || !Object.values(r.verify).every((v) => v.ok) || !r.confirmation ? 1 : 0);
}
