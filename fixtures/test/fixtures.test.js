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
import { startSite } from '../site/server.js';
import { BrowserWorker } from '../browser-worker/worker.js';
import { FixtureCredentialStore } from '../store/fixture-store.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'opa-test-'));
const SECRETS = ['FIXTURE-pa55word-not-real', 'FIXTURE-token-not-real'];

async function withEnv(fn) {
  const env = await startAll(tmp());
  try { return await fn(env); } finally { await env.stop(); }
}
const B = (env, op, args, errandId = ulid()) => checkedCall(env.sock('broker'), op, 'core', errandId, args);
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

test('channel: only the allowlisted sender reaches the core; sends to others are refused', () => withEnv(async (env) => {
  assert.equal(await env.channel.inbound('hi', 'stranger@fixture'), null);
  assert.equal(env.channel.dropped, 1);
  assert.equal(env.inbox.length, 0);
  const r = await checkedCall(env.sock('channel'), 'channel.send', 'core', ulid(), { channel: 'terminal', to: 'stranger@fixture', text: 'x' });
  assert.equal(r.error, 'recipient_not_allowed');
}));

test('router: unknown logical model is refused', () => withEnv(async (env) => {
  const res = await fetch(env.router.url, { method: 'POST', body: JSON.stringify(request('infer', 'core', ulid(), { model: 'gpt-whatever', messages: [] })) });
  assert.equal((await res.json()).error, 'unknown_model');
}));

test('envelope: unknown ops and broken envelopes get the common errors', () => withEnv(async (env) => {
  assert.equal((await call(env.sock('broker'), request('grant.mint', 'core', null, {}))).error, 'unknown_op');
  assert.equal((await call(env.sock('broker'), { op: 'status' })).error, 'bad_request');
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
