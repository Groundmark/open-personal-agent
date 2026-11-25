// node --test test/   (from fixtures/)
// Contracts 0.3 and 0.4: credentials by site, stores that ask the person themselves, one-time codes, declarations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startAll, checkedCall, violations } from '../errand/run.js';
import { ulid } from '../lib/wire.js';
import { PERSON } from '../channel/terminal.js';
import { MCP_FAULT } from '../broker/broker.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'opa-cred-'));
async function withEnv(fn, storeOpts) {
  const env = await startAll(tmp(), { storeOpts });
  try { return await fn(env); } finally { await env.stop(); }
}
const B = (env, op, args, errandId = ulid()) => checkedCall(env.sock('broker-core'), op, 'core', errandId, args);
async function approved(env, args) {
  const r = await B(env, 'grant.request', args);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(await env.waitFor(r.result.grant_id), 'approved');
  return r.result;
}
const LOGIN = { ops: ['search', 'login'], constraints: {}, mode: 'standing', ttl_seconds: 600, purpose: 'sign in to check availability' };
const allLogs = (env) => fs.readdirSync(env.dir).filter((f) => f.endsWith('.jsonl')).map((f) => fs.readFileSync(path.join(env.dir, f), 'utf8')).join('\n');

test('by site: the grant names the item it found, binds to it, and holds browsing to that site', () => withEnv(async (env) => {
  const g = await approved(env, { ...LOGIN, credential: { domain: 'table.example' } });
  assert.equal(g.credential_ref, 'item-table');
  assert.match(g.summary, /diner@example\.test for table\.example/);
  const out = await B(env, 'browser.open', { grant_id: g.grant_id, url: env.site.origin + '/' });
  assert.equal(out.error, 'origin_mismatch');
}));

test('by site: two logins for one site are ambiguous until a username picks one; an unknown site is not found', () => withEnv(async (env) => {
  const amb = await B(env, 'grant.request', { ...LOGIN, credential: { domain: 'shop.example' } });
  assert.equal(amb.error, 'credential_ambiguous');
  assert.deepEqual(amb.detail.usernames.sort(), ['a@example.test', 'b@example.test']);
  assert.ok(!JSON.stringify(amb).includes('FIXTURE-'));
  const one = await approved(env, { ...LOGIN, credential: { domain: 'shop.example', username: 'b@example.test' } });
  assert.equal(one.credential_ref, 'item-shop-b');
  const none = await B(env, 'grant.request', { ...LOGIN, credential: { domain: 'nowhere.example' } });
  assert.equal(none.error, 'credential_not_found');
}));

test('by site: fill_login and a stored TOTP reach the page, and neither reaches a log or a result', () => withEnv(async (env) => {
  env.store.setOrigin('item-table', env.site.origin);
  const g = await approved(env, { ...LOGIN, credential: { domain: '127.0.0.1' } });
  const { result: { session_id } } = await B(env, 'browser.open', { grant_id: g.grant_id, url: env.site.origin + '/login' });
  const filled = await B(env, 'browser.fill_login', { grant_id: g.grant_id, session_id });
  assert.equal(filled.ok, true, JSON.stringify(filled));
  const code = await B(env, 'browser.fill_code', { grant_id: g.grant_id, session_id, source: 'store_totp' });
  assert.deepEqual(code.result, { filled: true });
  const logs = allLogs(env);
  for (const s of env.store.allSecretValues()) assert.ok(!logs.includes(s), `${s} leaked into a log`);
  assert.match(logs, /"browser":"fill_code"[^}]*"source":"store_totp"/);
  assert.deepEqual(violations, []);
}));

test('a store that asks on the person\'s computer needs them there', () => withEnv(async (env) => {
  const away = await B(env, 'grant.request', { ...LOGIN, credential: { domain: 'table.example' } });
  assert.equal(away.error, 'store_needs_operator');
  const here = await approved(env, { ...LOGIN, credential: { domain: 'table.example' }, operator_present: true });
  assert.match(here.summary, /your vault will ask you which/);
  assert.equal(here.credential_ref, undefined);
}, { approval: 'device_local', listable: false }));

test('a refusal on the store\'s prompt is not_found, logged, and never retried; no answer is its own error', () => withEnv(async (env) => {
  // Sessions are opened through the broker first: a broker may refuse browser calls on sessions it didn't open.
  env.store.prompt.refuse.add('127.0.0.1');
  const g = await approved(env, { ...LOGIN, credential: { domain: '127.0.0.1' }, operator_present: true });
  const { result: { session_id } } = await B(env, 'browser.open', { grant_id: g.grant_id, url: env.site.origin + '/login' });
  const r = await B(env, 'browser.fill_login', { grant_id: g.grant_id, session_id });
  assert.equal(r.error, 'credential_not_found');
  assert.equal(env.store.fetches, 1);
  const logs = fs.readFileSync(path.join(env.dir, 'actions.jsonl'), 'utf8');
  assert.match(logs, /"status":"not_found","store_approval":"device_local"/);
  assert.match(logs, /"type":"grant.refused"/);
  env.store.prompt.refuse.delete('127.0.0.1');
  env.store.prompt.noAnswer.add('127.0.0.1');
  const g2 = await approved(env, { ...LOGIN, credential: { domain: '127.0.0.1', username: 'diner@example.test' }, operator_present: true });
  const o2 = await B(env, 'browser.open', { grant_id: g2.grant_id, url: env.site.origin + '/login' });
  const r2 = await B(env, 'browser.fill_login', { grant_id: g2.grant_id, session_id: o2.result.session_id });
  assert.equal(r2.error, 'store_no_answer');
}, { approval: 'device_local', listable: false }));

test('one-time code from the person: the channel hands it to the broker, the core sees only a placeholder', () => withEnv(async (env) => {
  await env.channel.inbound('482913'); // pair
  env.store.setOrigin('item-table', env.site.origin);
  const g = await approved(env, { ...LOGIN, credential: { domain: '127.0.0.1' } });
  const { result: { session_id } } = await B(env, 'browser.open', { grant_id: g.grant_id, url: env.site.origin + '/login' });
  const pending = B(env, 'browser.fill_code', { grant_id: g.grant_id, session_id, source: 'person', timeout_seconds: 30 });
  while (!env.channel.slots.size) await new Promise((r) => setTimeout(r, 5));   // the channel heard of it through code.slots
  await env.channel.inbound('the code is 771204', PERSON); // not only a code: forwarded as usual, slot stays open
  await env.channel.inbound('771 204', PERSON);
  assert.deepEqual((await pending).result, { filled: true });
  const texts = env.inbox.map((m) => m.text);
  assert.deepEqual(texts.slice(-2), ['the code is 771204', '[one-time code delivered]']);
  assert.ok(!allLogs(env).includes('771204'));
  const fromCore = await B(env, 'code.deliver', { slot_id: 'x', code: '123456' });
  assert.equal(fromCore.error, 'unauthorized_caller');
}));

test('one-time code from the person times out', () => withEnv(async (env) => {
  env.store.setOrigin('item-table', env.site.origin);
  const g = await approved(env, { ...LOGIN, credential: { domain: '127.0.0.1' } });
  const { result: { session_id } } = await B(env, 'browser.open', { grant_id: g.grant_id, url: env.site.origin + '/login' });
  const r = await B(env, 'browser.fill_code', { grant_id: g.grant_id, session_id, source: 'person', timeout_seconds: 1 });
  assert.equal(r.error, 'code_timeout');
}));

test('0.4: the adapter hears of a code slot by asking (code.slots), once, and only on its own socket', () => withEnv(async (env) => {
  env.store.setOrigin('item-table', env.site.origin);
  const C = (op, args) => checkedCall(env.sock('broker-channel-terminal'), op, 'channel-terminal', null, args);
  const first = (await C('code.slots', { wait_seconds: 0 })).result;
  assert.deepEqual(first.slots, []);
  assert.equal(typeof first.cursor, 'string');
  for (const w of [-1, 61, 1.5, '5']) assert.equal((await C('code.slots', { wait_seconds: w })).error, 'bad_request', String(w));
  const g = await approved(env, { ...LOGIN, credential: { domain: '127.0.0.1' } });
  const { result: { session_id } } = await B(env, 'browser.open', { grant_id: g.grant_id, url: env.site.origin + '/login' });
  const waiting = C('code.slots', { wait_seconds: 10, cursor: first.cursor });
  const pending = B(env, 'browser.fill_code', { grant_id: g.grant_id, session_id, source: 'person', timeout_seconds: 30 });
  const heard = (await waiting).result;
  assert.equal(heard.slots.length, 1);
  // Asking again with the new cursor doesn't hand back the same slot; without a cursor, every open slot is listed.
  assert.deepEqual((await C('code.slots', { wait_seconds: 0, cursor: heard.cursor })).result.slots, []);
  assert.equal((await C('code.slots', { wait_seconds: 0 })).result.slots.length, 1);
  assert.equal((await C('code.slots', { wait_seconds: 0, cursor: 'from-before-a-restart' })).result.slots.length, 1);
  // A code is 4 to 10 letters and digits; anything else is refused and the slot stays open.
  assert.equal((await C('code.deliver', { slot_id: heard.slots[0].slot_id, code: 'abc' })).error, 'bad_request');
  assert.equal((await C('code.deliver', { slot_id: heard.slots[0].slot_id, code: '77 12 04' })).error, 'bad_request');
  assert.equal((await C('code.deliver', { slot_id: heard.slots[0].slot_id, code: '771204' })).result.accepted, true);
  assert.deepEqual((await pending).result, { filled: true });
  const onCore = await B(env, 'code.slots', { wait_seconds: 0 });
  assert.equal(onCore.error, 'unauthorized_caller');
  assert.match(onCore.message, /^code\.slots /);
}));

test('0.4: with two channel adapters, a code slot is for the one the person is on', () => withEnv(async (env) => {
  env.store.setOrigin('item-table', env.site.origin);
  const other = await env.broker.listen(env.sock('broker-channel-other'), { caller: 'channel-other' });
  try {
    const T = (op, args) => checkedCall(env.sock('broker-channel-terminal'), op, 'channel-terminal', null, args);
    const O = (op, args) => checkedCall(env.sock('broker-channel-other'), op, 'channel-other', null, args);
    const g = await approved(env, { ...LOGIN, credential: { domain: '127.0.0.1' } });
    const { result: { session_id } } = await B(env, 'browser.open', { grant_id: g.grant_id, url: env.site.origin + '/login' });
    assert.equal((await B(env, 'browser.fill_code', { grant_id: g.grant_id, session_id, source: 'person', timeout_seconds: 5 })).error, 'bad_request');
    const pending = B(env, 'browser.fill_code', { grant_id: g.grant_id, session_id, source: 'person', channel: 'other', timeout_seconds: 30 });
    const { slots } = (await O('code.slots', { wait_seconds: 10 })).result;
    assert.equal(slots.length, 1);
    assert.deepEqual((await T('code.slots', { wait_seconds: 0 })).result.slots, []);
    assert.equal((await T('code.deliver', { slot_id: slots[0].slot_id, code: '771204' })).error, 'bad_request');
    assert.equal((await O('code.deliver', { slot_id: slots[0].slot_id, code: '771204' })).result.accepted, true);
    assert.deepEqual((await pending).result, { filled: true });
  } finally { other.close(); }
}));

test('0.4: no identity.sign; a declaration is built by the broker, only for an act a grant covers', () => withEnv(async (env) => {
  const b64 = (s) => Buffer.from(s).toString('base64');
  assert.equal((await B(env, 'identity.sign', { purpose: 'declaration', payload_b64: b64('{"act":"book"}') })).error, 'unknown_op');
  const BOOK = { venue: 'Casa Verde', date: '2026-12-04', time: '19:00', party_size: 2 };
  // Not approved yet: refused. Then approved: the declaration names the act, and takes the rest from the grant.
  env.broker.autoApprove = false;
  const pend = (await B(env, 'grant.request', { credential: 'fake-mcp', ops: ['book'], constraints: BOOK, mode: 'one_shot', ttl_seconds: 600, purpose: 'Book' })).result;
  assert.equal((await B(env, 'identity.declaration', { grant_id: pend.grant_id, act: 'book' })).error, 'grant_not_approved');
  env.broker.approve(pend.grant_id);
  assert.equal((await B(env, 'identity.declaration', { grant_id: pend.grant_id, act: 'pay' })).error, 'op_not_granted');
  const d = (await B(env, 'identity.declaration', { grant_id: pend.grant_id, act: 'book' })).result;
  assert.equal(d.declaration.relying_party, 'fake-reservations');
  assert.deepEqual(d.declaration.constraints, BOOK);
  // The caller can't name another relying party.
  assert.equal((await B(env, 'identity.declaration', { grant_id: pend.grant_id, act: 'book', relying_party: 'https://elsewhere.example' })).error, 'bad_request');
  // After the act, the spent one-shot grant still covers a declaration of it; a revoked grant doesn't.
  assert.equal((await B(env, 'mcp.call', { grant_id: pend.grant_id, server: 'fake-reservations', tool: 'book_table', arguments: BOOK })).ok, true);
  assert.equal((await B(env, 'identity.declaration', { grant_id: pend.grant_id, act: 'book' })).ok, true);
  env.broker.autoApprove = true;
  const s = await approved(env, { ...LOGIN, credential: 'fake-table' });
  await B(env, 'grant.revoke', { grant_id: s.grant_id, reason: 'test' });
  assert.equal((await B(env, 'identity.declaration', { grant_id: s.grant_id, act: 'search' })).error, 'grant_revoked');
  assert.equal((await B(env, 'identity.declaration', { grant_id: ulid(), act: 'book' })).error, 'grant_not_found');
}));

test('0.4: an unknown outcome spends a one-shot grant; only a definite refusal gives it back', () => withEnv(async (env) => {
  const BOOK = { venue: 'Casa Verde', date: '2026-12-04', time: '19:00', party_size: 2 };
  const call = (g) => B(env, 'mcp.call', { grant_id: g.grant_id, server: 'fake-reservations', tool: 'book_table', arguments: BOOK });
  const g = await approved(env, { credential: 'fake-mcp', ops: ['book'], constraints: BOOK, mode: 'one_shot', ttl_seconds: 600, purpose: 'Book' });
  MCP_FAULT.next = 'refused';
  assert.equal((await call(g)).error, 'upstream_error');
  assert.equal((await B(env, 'grant.status', { grant_id: g.grant_id })).result.state, 'approved');   // nothing happened: try again
  MCP_FAULT.next = 'unknown';
  assert.equal((await call(g)).error, 'upstream_error');
  assert.equal((await B(env, 'grant.status', { grant_id: g.grant_id })).result.state, 'consumed');   // might have gone through
  assert.equal((await call(g)).error, 'grant_consumed');                                             // so no retry
  assert.match(fs.readFileSync(path.join(env.dir, 'actions.jsonl'), 'utf8'), /"status":"unknown"/);
}));

test('0.4: a one-shot grant can\'t be used by two concurrent calls', () => withEnv(async (env) => {
  const BOOK = { venue: 'Casa Verde', date: '2026-12-04', time: '19:00', party_size: 2 };
  const g = await approved(env, { credential: 'fake-mcp', ops: ['book'], constraints: BOOK, mode: 'one_shot', ttl_seconds: 600, purpose: 'Book' });
  const call = () => B(env, 'mcp.call', { grant_id: g.grant_id, server: 'fake-reservations', tool: 'book_table', arguments: BOOK });
  const r = await Promise.all([call(), call()]);
  assert.deepEqual(r.map((x) => x.ok).sort(), [false, true]);
  assert.equal(r.find((x) => !x.ok).error, 'grant_consumed');
}));

test('0.4: revoking a spent grant stops declarations; a code slot ends with its grant', () => withEnv(async (env) => {
  const BOOK = { venue: 'Casa Verde', date: '2026-12-04', time: '19:00', party_size: 2 };
  const g = await approved(env, { credential: 'fake-mcp', ops: ['book'], constraints: BOOK, mode: 'one_shot', ttl_seconds: 600, purpose: 'Book' });
  assert.equal((await B(env, 'mcp.call', { grant_id: g.grant_id, server: 'fake-reservations', tool: 'book_table', arguments: BOOK })).ok, true);
  assert.equal((await B(env, 'grant.revoke', { grant_id: g.grant_id, reason: 'test' })).result.state, 'revoked');
  assert.equal((await B(env, 'identity.declaration', { grant_id: g.grant_id, act: 'book' })).error, 'grant_revoked');
  // A session opened under a search grant; the code is asked for under a login grant, which is then revoked.
  env.store.setOrigin('item-table', env.site.origin);
  const search = await approved(env, { ops: ['search'], constraints: {}, mode: 'standing', ttl_seconds: 600, purpose: 'look', credential: { domain: '127.0.0.1' } });
  const login = await approved(env, { ...LOGIN, credential: { domain: '127.0.0.1' } });
  const { result: { session_id } } = await B(env, 'browser.open', { grant_id: search.grant_id, url: env.site.origin + '/login' });
  const C = (op, args) => checkedCall(env.sock('broker-channel-terminal'), op, 'channel-terminal', null, args);
  const pending = B(env, 'browser.fill_code', { grant_id: login.grant_id, session_id, source: 'person', timeout_seconds: 30 });
  const { slots } = (await C('code.slots', { wait_seconds: 10 })).result;
  assert.equal(slots.length, 1);
  await B(env, 'grant.revoke', { grant_id: login.grant_id, reason: 'test' });
  assert.equal((await pending).error, 'grant_revoked');
  assert.equal((await C('code.deliver', { slot_id: slots[0].slot_id, code: '771204' })).error, 'bad_request');
  // Revoking the grant that opened the session ends the slot too.
  const login2 = await approved(env, { ...LOGIN, credential: { domain: '127.0.0.1' } });
  const { cursor } = (await C('code.slots', { wait_seconds: 0 })).result;
  const p2 = B(env, 'browser.fill_code', { grant_id: login2.grant_id, session_id, source: 'person', timeout_seconds: 30 });
  const heard = (await C('code.slots', { wait_seconds: 10, cursor })).result.slots;
  assert.equal(heard.length, 1);
  await B(env, 'grant.revoke', { grant_id: search.grant_id, reason: 'test' });
  assert.equal((await p2).error, 'bad_request');
  assert.equal((await C('code.deliver', { slot_id: heard[0].slot_id, code: '771204' })).error, 'bad_request');
}));

test('0.4: a channel adapter\'s socket serves only code.slots, code.deliver and status', () => withEnv(async (env) => {
  const C = (op, args) => checkedCall(env.sock('broker-channel-terminal'), op, 'channel-terminal', null, args);
  for (const [op, args] of [['grant.request', { ...LOGIN, credential: 'fake-table' }], ['identity.declaration', { grant_id: ulid(), act: 'book' }],
    ['browser.fill_code', { grant_id: ulid(), session_id: 's', source: 'person', channel: 'terminal' }], ['mcp.call', { grant_id: ulid(), server: 'fake-reservations', tool: 'book_table', arguments: {} }]]) {
    assert.equal((await C(op, args)).error, 'unauthorized_caller', op);
  }
  assert.equal((await C('status', {})).ok, true);
}));

test('0.4: grant.request and grant.status return the exact request of a binding grant', () => withEnv(async (env) => {
  const BOOK = { venue: 'Casa Verde', date: '2026-12-04', time: '19:00', party_size: 2 };
  const r = (await B(env, 'grant.request', { credential: 'fake-mcp', ops: ['book'], constraints: BOOK, mode: 'one_shot', ttl_seconds: 600, purpose: 'Book' })).result;
  assert.deepEqual(r.request, { server: 'fake-reservations', tool: 'book_table' });
  assert.deepEqual((await B(env, 'grant.status', { grant_id: r.grant_id })).result.request, r.request);
}));

// With OPA_BROKER_MODULE, the real broker's own approval page shows these (parts/broker tests); its summary is shorter.
const FIXTURE_ONLY = { skip: process.env.OPA_BROKER_MODULE ? 'the real broker shows these on its approval page, tested in parts/broker' : false };

test('0.4: the approval (the fixture\'s summary) shows the call and every constraint', FIXTURE_ONLY, () => withEnv(async (env) => {
  const BOOK = { venue: 'Casa Verde', date: '2026-12-04', time: '19:00', party_size: 2, notes: 'window seat' };
  const r = (await B(env, 'grant.request', { credential: 'fake-mcp', ops: ['book'], constraints: BOOK, mode: 'one_shot', ttl_seconds: 600, purpose: 'Book' })).result;
  assert.match(r.summary, /Calls fake-reservations\/book_table/);
  assert.match(r.summary, /notes: window seat/);
}));

test('0.4: the passkey covers everything the approval shows', FIXTURE_ONLY, () => withEnv(async (env) => {
  // Change any of it after the request, and it can't be approved.
  env.broker.autoApprove = false;
  for (const [k, v] of [['purpose', 'something else'], ['ttl_seconds', 3600], ['operator_present', true], ['summary', 'Book somewhere else.']]) {
    const p = (await B(env, 'grant.request', { ...LOGIN, credential: 'fake-table' })).result;
    env.broker.grants.get(p.grant_id)[k] = v;
    assert.throws(() => env.broker.approve(p.grant_id), { code: 'constraint_mismatch' }, k);
  }
}));

test('0.4: a binding grant allows exactly the approved call: same tool, every argument the same', () => withEnv(async (env) => {
  const BOOK = { venue: 'Casa Verde', date: '2026-12-04', time: '19:00', party_size: 2 };
  const ask = (extra = {}) => B(env, 'grant.request', { credential: 'fake-mcp', ops: ['book'], constraints: BOOK, mode: 'one_shot', ttl_seconds: 600, purpose: 'Book', ...extra });
  assert.equal((await ask({ call: { server: 'fake-reservations', tool: 'no_such_tool' } })).error, 'bad_request');
  const g = await approved(env, { credential: 'fake-mcp', ops: ['book'], constraints: BOOK, mode: 'one_shot', ttl_seconds: 600, purpose: 'Book' });
  const call = (args) => B(env, 'mcp.call', { grant_id: g.grant_id, server: 'fake-reservations', tool: 'book_table', arguments: args });
  assert.equal((await call({ ...BOOK, notes: 'and a cake' })).error, 'constraint_mismatch');   // a field nobody approved
  assert.equal((await call(Object.fromEntries(Object.entries(BOOK).reverse()))).ok, true);     // same fields, any order
}));
