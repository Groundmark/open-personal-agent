// node --test test/   (from fixtures/)
// The end-to-end errand, plus the refusals each contract promises.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runErrand, startAll, checkedCall, violations } from '../errand/run.js';
import { call, request, ulid } from '../lib/wire.js';
import { verifyAll } from '../history/history.js';
import { startSite, FIXTURE_USER, ORDER_DEADLINE } from '../site/server.js';
import { BrowserWorker } from '../browser-worker/worker.js';
import { PERSON } from '../channel/terminal.js';
import { FixtureCredentialStore } from '../store/fixture-store.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'opa-test-'));
const SECRETS = ['FIXTURE-pa55word-not-real', 'FIXTURE-token-not-real'];

async function withEnv(fn) {
  const env = await startAll(tmp());
  try { return await fn(env); } finally { await env.stop(); }
}
const B = (env, op, args, errandId = ulid()) => checkedCall(env.sock('broker-core'), op, 'core', errandId, args);
async function approvedGrant(env, args) {
  const r = await B(env, 'grant.request', args);
  assert.equal(r.ok, true, JSON.stringify(r));
  const w = env.waitFor(r.result.grant_id);
  assert.equal(await w, 'approved');
  return r.result.grant_id;
}
const BOOK = { venue: 'Casa Verde', date: '2026-12-04', time: '19:00', party_size: 2 };

test('the errand books exactly one table, logs verify, no schema violations, no secret anywhere', async () => {
  const r = await runErrand({ dir: tmp() });
  assert.match(r.confirmation, /^FT-[A-F0-9]{6}$/);
  assert.equal(r.bookings.length, 1);
  assert.deepEqual({ venue: r.bookings[0].venue, date: r.bookings[0].date, time: r.bookings[0].time, party_size: r.bookings[0].party_size }, BOOK);
  assert.deepEqual(r.violations, []);
  for (const v of Object.values(r.verify)) assert.equal(v.ok, true);
  for (const f of fs.readdirSync(r.dir).filter((f) => f.endsWith('.jsonl'))) {
    const text = fs.readFileSync(path.join(r.dir, f), 'utf8');
    for (const s of SECRETS) assert.ok(!text.includes(s), `${s} leaked into ${f}`);
  }
  for (const m of r.outbox) for (const s of SECRETS) assert.ok(!m.text.includes(s));
  const actions = fs.readFileSync(path.join(r.dir, 'actions.jsonl'), 'utf8');
  assert.match(actions, /"type":"identity.declaration"/);
  assert.match(actions, /"presented":false/);
});

test('a booking grant must be one-shot', () => withEnv(async (env) => {
  const r = await B(env, 'grant.request', { credential: 'fake-table', ops: ['book'], constraints: BOOK, mode: 'standing', ttl_seconds: 600, purpose: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'one_shot_required');
}));

test('a pending grant cannot be used', async () => {
  const env = await startAll(tmp());
  env.broker.autoApprove = false;
  try {
    const r = await B(env, 'grant.request', { credential: 'fake-mcp', ops: ['search'], constraints: {}, mode: 'standing', ttl_seconds: 600, purpose: 'x' });
    const u = await B(env, 'mcp.call', { grant_id: r.result.grant_id, server: 'fake-reservations', tool: 'search_restaurants', arguments: { term: 'casa' } });
    assert.equal(u.error, 'grant_not_approved');
  } finally { await env.stop(); }
});

test('MCP booking: arguments must match the approved grant, and the grant is spent after one use', () => withEnv(async (env) => {
  const g = await approvedGrant(env, { credential: 'fake-mcp', ops: ['book'], constraints: BOOK, mode: 'one_shot', ttl_seconds: 600, purpose: 'x' });
  const wrong = await B(env, 'mcp.call', { grant_id: g, server: 'fake-reservations', tool: 'book_table', arguments: { ...BOOK, party_size: 6 } });
  assert.equal(wrong.error, 'constraint_mismatch');
  const right = await B(env, 'mcp.call', { grant_id: g, server: 'fake-reservations', tool: 'book_table', arguments: BOOK });
  assert.equal(right.ok, true);
  assert.ok(!JSON.stringify(right).includes('FIXTURE-token'));
  const again = await B(env, 'mcp.call', { grant_id: g, server: 'fake-reservations', tool: 'book_table', arguments: BOOK });
  assert.equal(again.error, 'grant_consumed');
  const st = await B(env, 'grant.status', { grant_id: g });
  assert.equal(st.result.state, 'consumed');
  assert.match(fs.readFileSync(path.join(env.dir, 'actions.jsonl'), 'utf8'), /"type":"grant.refused"/);
}));

test('a search grant cannot book', () => withEnv(async (env) => {
  const g = await approvedGrant(env, { credential: 'fake-mcp', ops: ['search'], constraints: {}, mode: 'standing', ttl_seconds: 600, purpose: 'x' });
  const r = await B(env, 'mcp.call', { grant_id: g, server: 'fake-reservations', tool: 'book_table', arguments: BOOK });
  assert.equal(r.error, 'op_not_granted');
}));

test('browser: the binding click is refused when the page differs from the grant', () => withEnv(async (env) => {
  const g = await approvedGrant(env, { credential: 'fake-table', ops: ['search', 'login'], constraints: {}, mode: 'standing', ttl_seconds: 600, purpose: 'x' });
  const wrongBook = await approvedGrant(env, { credential: 'fake-table', ops: ['book'], constraints: { ...BOOK, time: '20:30' }, mode: 'one_shot', ttl_seconds: 600, purpose: 'x' });
  const o = await B(env, 'browser.open', { grant_id: g, url: `${env.site.origin}/confirm?r=casa-verde&date=2026-12-04&time=19:00&covers=2` });
  const s = o.result.session_id;
  await B(env, 'browser.fill_login', { grant_id: g, session_id: s, credential: 'fake-table' });
  const atConfirm = await B(env, 'browser.act', { grant_id: g, session_id: s, action: 'click', target: 'Sign in' });
  assert.equal(atConfirm.result.page.title, 'Confirm reservation');
  const noGrant = await B(env, 'browser.act', { grant_id: g, session_id: s, action: 'click', target: 'Complete reservation' });
  assert.equal(noGrant.error, 'constraint_mismatch');
  const mismatch = await B(env, 'browser.act', { grant_id: g, session_id: s, action: 'click', target: 'Complete reservation', book_grant_id: wrongBook });
  assert.equal(mismatch.error, 'constraint_mismatch');
  assert.equal(env.site.bookings.length, 0);
}));

test('browser: logins are bound to their origin, and secrets cannot be typed', async () => {
  const site = await startSite();
  const store = new FixtureCredentialStore();
  store.setOrigin('fake-table', 'http://127.0.0.1:1'); // not this site
  const w = new BrowserWorker({ store, getBookGrant: () => null });
  try {
    const { session_id } = await w.open({ url: site.origin + '/login' });
    await assert.rejects(w.fill_login({ session_id, credential: 'fake-table' }), { code: 'origin_mismatch' });
    await assert.rejects(w.act({ session_id, action: 'type', target: 'Password', value: 'FIXTURE-pa55word-not-real' }), { code: 'secret_value_refused' });
  } finally { await site.close(); }
});

test('browser: a site that refuses declared automation is reported, not worked around', async () => {
  const site = await startSite({ blockAutomation: true });
  const w = new BrowserWorker({ store: new FixtureCredentialStore(), getBookGrant: () => null });
  try {
    const { session_id } = await w.open({ url: site.origin + '/' });
    await assert.rejects(w.act({ session_id, action: 'click', target: 'Search' }), { code: 'blocked_by_site' });
  } finally { await site.close(); }
});

test('context: denylisted items never come back, unknown scopes are refused, reads are logged', () => withEnv(async (env) => {
  const c = (args) => checkedCall(env.sock('context'), 'context.read', 'core', ulid(), args);
  const r = await c({ scope: 'dining' });
  assert.deepEqual(r.result.items.map((i) => i.id).sort(), ['c1', 'c2']);
  assert.ok(!JSON.stringify(r).includes('FIXTURE-HEALTH'));
  assert.equal((await c({ scope: 'health' })).error, 'unknown_scope');
  assert.equal(verifyAll(env.dir).context.lines, 1);
}));

test('channel: nothing is forwarded or sent before pairing, and the code works once', () => withEnv(async (env) => {
  const ch = env.channel;
  assert.equal(await ch.inbound('hello', PERSON), null);
  const early = await checkedCall(env.sock('channel'), 'channel.send', 'core', ulid(), { channel: 'terminal', to: PERSON.account, text: 'x' });
  assert.equal(early.error, 'not_paired');
  assert.equal(await ch.inbound(ch.pairingCode, PERSON), 'paired');
  assert.equal(ch.sender, PERSON.account);
  const thief = { account: 'acct-stranger', key: 'idkey-stranger', display: 'Person' };
  assert.equal(await ch.inbound(ch.pairingCode, thief), null, 'a spent code pairs no one');
  assert.equal(env.inbox.length, 0);
}));

test('channel: only the paired account with its pinned key reaches the core; a copied display name does not', () => withEnv(async (env) => {
  const ch = env.channel;
  await ch.inbound(ch.pairingCode, PERSON);
  assert.equal(await ch.inbound('what is my order?', { account: 'acct-stranger', key: 'idkey-x', display: PERSON.display }), null);
  assert.equal(await ch.inbound('what is my order?', { ...PERSON, key: 'idkey-new-phone' }), null);
  assert.equal(ch.identityChanged, 1);
  assert.equal(env.inbox.length, 0);
  await ch.inbound('what is my order?', PERSON);
  assert.equal(env.inbox.length, 1);
  assert.equal(env.inbox[0].from, PERSON.account);
  assert.equal(env.inbox[0].from_display, 'Person');
  const r = await checkedCall(env.sock('channel'), 'channel.send', 'core', ulid(), { channel: 'terminal', to: 'acct-stranger', text: 'x' });
  assert.equal(r.error, 'recipient_not_allowed');
}));

test('broker: the socket is the caller; another caller on the core socket is refused', () => withEnv(async (env) => {
  const r = await checkedCall(env.sock('broker-core'), 'status', 'channel-terminal', null, {});
  assert.equal(r.error, 'unauthorized_caller');
  assert.equal((await B(env, 'status', {})).ok, true);
}));

test('broker: a grant names a credential or a session, not both; edit_order is binding', () => withEnv(async (env) => {
  const session = { origin: env.site.origin, browser: 'operator' };
  const both = await B(env, 'grant.request', { credential: 'fake-table', session, ops: ['read'], constraints: {}, mode: 'standing', ttl_seconds: 600, purpose: 'x' });
  assert.equal(both.error, 'bad_request');
  const edit = await B(env, 'grant.request', { session, ops: ['edit_order'], constraints: { changes: [{ item: 'yogurt', quantity: 2 }] }, mode: 'standing', ttl_seconds: 600, purpose: 'x' });
  assert.equal(edit.error, 'one_shot_required');
}));

test('read errand: the person signs in themselves, the agent reads the order and its deadline, and cannot change it', () => withEnv(async (env) => {
  const { site, channel } = env;
  violations.length = 0; // earlier tests send deliberately bad requests
  await channel.inbound(channel.pairingCode, PERSON);
  await channel.inbound('What do I have coming this week, and until when can I change it?', PERSON);
  const ask = env.inbox.shift();
  const errand = ulid();
  const Be = (op, args) => B(env, op, args, errand);

  const g = await approvedGrant(env, { session: { origin: site.origin, browser: 'operator' }, ops: ['read', 'login'], constraints: { scope: 'orders' }, mode: 'standing', ttl_seconds: 3600, purpose: 'Read your upcoming order' });
  const o = await Be('browser.open', { grant_id: g, url: `${site.origin}/account/order`, read_only: true });
  assert.equal(o.result.page.title, 'Sign in');
  const s = o.result.session_id;

  // The agent asks the person to sign in; they do, from their own password manager.
  await checkedCall(env.sock('channel'), 'channel.send', 'core', errand, { channel: 'terminal', to: ask.from, text: 'Please sign in to the shop on your Mac.' });
  const waiting = Be('browser.await_login', { grant_id: g, session_id: s, timeout_seconds: 5 });
  await env.broker.worker.operatorSignIn(s, FIXTURE_USER);
  assert.deepEqual((await waiting).result, { logged_in: true, login_mode: 'operator_filled' });

  const order = await Be('browser.extract', { grant_id: g, session_id: s, target: 'Upcoming order' });
  assert.equal(order.ok, true, JSON.stringify(order));
  assert.match(order.result.page.text, /Plain Yogurt 750g x 1/);
  assert.match(order.result.page.text, /Total \$28\.27/);
  assert.ok(!order.result.page.text.includes('Burrito'), 'promotions are outside the region');
  assert.deepEqual(order.result.page.notices, [ORDER_DEADLINE]);

  // Every edit to a standing order is binding; a read-only session can't make one.
  const plus = await Be('browser.act', { grant_id: g, session_id: s, action: 'click', target: 'Add one Plain Yogurt 750g' });
  assert.equal(plus.error, 'read_only_session');
  assert.equal(site.order.find((i) => i.id === 'yogurt').qty, 1);
  // Links still work.
  assert.equal((await Be('browser.act', { grant_id: g, session_id: s, action: 'click', target: 'View order' })).ok, true);

  // The grant is held to its origin, and there is no credential to fill.
  assert.equal((await Be('browser.open', { grant_id: g, url: 'http://127.0.0.1:1/' })).error, 'origin_mismatch');
  assert.equal((await Be('browser.fill_login', { grant_id: g, session_id: s, credential: 'fake-table' })).error, 'op_not_granted');

  const reply = `This week: delivery 2026-12-01, 12:00 to 18:00, 4 items, $28.27. ${order.result.page.notices[0]}; you can change it until then.`;
  await checkedCall(env.sock('channel'), 'channel.send', 'core', errand, { channel: 'terminal', to: ask.from, text: reply });
  assert.match(channel.outbox.at(-1).text, /16:00 on 2026-11-30/);

  // When the grant ends, so does the session, whatever the cookies say.
  await Be('grant.revoke', { grant_id: g, reason: 'errand done' });
  assert.equal((await Be('browser.extract', { grant_id: g, session_id: s, target: 'Upcoming order' })).error, 'grant_revoked');
  const actions = fs.readFileSync(path.join(env.dir, 'actions.jsonl'), 'utf8');
  assert.match(actions, /"type":"browser.closed_on_grant_end"/);
  assert.match(actions, /"login_mode":"operator_filled"/);
  assert.match(actions, /"mode":"operator_browser"/);
  assert.ok(!actions.includes(FIXTURE_USER.password));
  assert.deepEqual(violations.filter((v) => !v.startsWith('infer')), []);
}));

test('browser: a read-only session refuses typing', async () => {
  const site = await startSite();
  const w = new BrowserWorker({ store: new FixtureCredentialStore(), getBookGrant: () => null });
  try {
    const { session_id } = await w.open({ url: site.origin + '/', read_only: true });
    await assert.rejects(w.act({ session_id, action: 'type', target: 'Where', value: 'x' }), { code: 'read_only_session' });
  } finally { await site.close(); }
});

test('router: unknown logical model is refused', () => withEnv(async (env) => {
  const res = await fetch(env.router.url, { method: 'POST', body: JSON.stringify(request('infer', 'core', ulid(), { model: 'gpt-whatever', messages: [] })) });
  assert.equal((await res.json()).error, 'unknown_model');
}));

test('envelope: unknown ops and broken envelopes get the common errors', () => withEnv(async (env) => {
  assert.equal((await call(env.sock('broker-core'), request('grant.mint', 'core', null, {}))).error, 'unknown_op');
  assert.equal((await call(env.sock('broker-core'), { op: 'status' })).error, 'bad_request');
}));

test('history: tampering with a log is detected', async () => {
  const r = await runErrand({ dir: tmp() });
  const p = path.join(r.dir, 'actions.jsonl');
  const lines = fs.readFileSync(p, 'utf8').split('\n');
  lines[2] = lines[2].replace('"op":"search"', '"op":"book"');
  fs.writeFileSync(p, lines.join('\n'));
  const v = verifyAll(r.dir);
  assert.equal(v.actions.ok, false);
  assert.equal(v.conversation.ok, true);
});
