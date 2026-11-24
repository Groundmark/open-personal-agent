// node --test test/   (from fixtures/)
// Contracts 0.3 and 0.4: credentials by site, stores that ask the person themselves, one-time codes, identity.sign.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startAll, checkedCall, violations } from '../errand/run.js';
import { ulid } from '../lib/wire.js';
import { PERSON } from '../channel/terminal.js';

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
  env.store.prompt.refuse.add('table.example');
  env.store.prompt.noAnswer.add('shop.example');
  const g = await approved(env, { ...LOGIN, credential: { domain: 'table.example' }, operator_present: true });
  const r = await B(env, 'browser.fill_login', { grant_id: g.grant_id, session_id: 'any' });
  assert.equal(r.error, 'credential_not_found');
  assert.equal(env.store.fetches, 1);
  const logs = fs.readFileSync(path.join(env.dir, 'actions.jsonl'), 'utf8');
  assert.match(logs, /"status":"not_found","store_approval":"device_local"/);
  assert.match(logs, /"type":"grant.refused"/);
  const g2 = await approved(env, { ...LOGIN, credential: { domain: 'shop.example', username: 'a@example.test' }, operator_present: true });
  const r2 = await B(env, 'browser.fill_login', { grant_id: g2.grant_id, session_id: 'any' });
  assert.equal(r2.error, 'store_no_answer');
}, { approval: 'device_local', listable: false }));

test('one-time code from the person: the channel hands it to the broker, the core sees only a placeholder', () => withEnv(async (env) => {
  await env.channel.inbound('482913'); // pair
  env.store.setOrigin('item-table', env.site.origin);
  const g = await approved(env, { ...LOGIN, credential: { domain: '127.0.0.1' } });
  const { result: { session_id } } = await B(env, 'browser.open', { grant_id: g.grant_id, url: env.site.origin + '/login' });
  const pending = B(env, 'browser.fill_code', { grant_id: g.grant_id, session_id, source: 'person', timeout_seconds: 30 });
  while (!env.channel.codeSlot) await new Promise((r) => setTimeout(r, 5));
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
  const g = await approved(env, { ...LOGIN, credential: { domain: 'table.example' } });
  const r = await B(env, 'browser.fill_code', { grant_id: g.grant_id, session_id: 's', source: 'person', timeout_seconds: 1 });
  assert.equal(r.error, 'code_timeout');
}));

test('0.4: the adapter hears of a code slot by asking (code.slots), and only on its own socket', () => withEnv(async (env) => {
  env.store.setOrigin('item-table', env.site.origin);
  const C = (op, args) => checkedCall(env.sock('broker-channel-terminal'), op, 'channel-terminal', null, args);
  assert.deepEqual((await C('code.slots', { wait_seconds: 0 })).result, { slots: [] });
  const g = await approved(env, { ...LOGIN, credential: { domain: '127.0.0.1' } });
  const { result: { session_id } } = await B(env, 'browser.open', { grant_id: g.grant_id, url: env.site.origin + '/login' });
  const waiting = C('code.slots', { wait_seconds: 10 });
  const pending = B(env, 'browser.fill_code', { grant_id: g.grant_id, session_id, source: 'person', timeout_seconds: 30 });
  const { result: { slots } } = await waiting;
  assert.equal(slots.length, 1);
  assert.equal((await C('code.deliver', { slot_id: slots[0].slot_id, code: '771204' })).result.accepted, true);
  assert.deepEqual((await pending).result, { filled: true });
  assert.equal((await B(env, 'code.slots', { wait_seconds: 0 })).error, 'unauthorized_caller');
}));

test('0.4: identity.sign signs declarations only; the core can\'t get an HTTP request signed', () => withEnv(async (env) => {
  const b64 = (s) => Buffer.from(s).toString('base64');
  const ok = await B(env, 'identity.sign', { purpose: 'declaration', payload_b64: b64('{"act":"book"}') });
  assert.equal(ok.result.alg, 'Ed25519');
  assert.equal((await B(env, 'identity.sign', { purpose: 'http_request', payload_b64: b64('"@method": POST') })).error, 'bad_request');
  assert.equal((await B(env, 'identity.sign', { purpose: 'declaration', payload_b64: b64('"@method": POST') })).error, 'bad_request');
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
