import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BitwardenStore, CombinedStore, bwUnlock } from '../src/bw-store.js';
import { Broker } from '../src/broker.js';

const BW = new URL('./fake-bw.mjs', import.meta.url).pathname;
const C = '11111111-1111-4111-8111-111111111111';
function dirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opa-bw-'));
  const app = path.join(root, 'bw'); fs.mkdirSync(app, { mode: 0o700 });
  const creds = path.join(root, 'creds'); fs.mkdirSync(creds, { mode: 0o700 });
  for (const [f, v] of [['bw-client-id', 'user.client'], ['bw-client-secret', 'FAKE-client-secret'], ['bw-password', 'FAKE-master-password']]) fs.writeFileSync(path.join(creds, f), v, { mode: 0o600 });
  return { root, app, creds };
}
const store = (d, session = 'test-session') => new BitwardenStore({ bw: BW, appDataDir: d.app, collectionId: C, session });

test('unlock: logs in with the API key and unlocks; no secret ever on a command line', async () => {
  const d = dirs();
  const session = await bwUnlock({ bw: BW, appDataDir: d.app, clientIdFile: path.join(d.creds, 'bw-client-id'), clientSecretFile: path.join(d.creds, 'bw-client-secret'), passwordFile: path.join(d.creds, 'bw-password') });
  assert.equal(session, 'test-session');
  const calls = fs.readFileSync(path.join(d.root, 'calls.log'), 'utf8');
  assert.doesNotMatch(calls, /FAKE-master-password|FAKE-client-secret/);
});

test('find: logins in the one collection for this site; nothing secret in the records', async () => {
  const d = dirs();
  const m = await store(d).find({ domain: 'table.example' });
  assert.deepEqual(m.map((x) => x.record.username), ['diner@example.test']);       // not the bank login in another collection
  assert.equal(m[0].record.has_totp, true);
  assert.equal(m[0].record.origin, 'https://www.table.example');
  assert.doesNotMatch(JSON.stringify(m), /FAKE-pass|JBSWY/);
  assert.equal((await store(d).find({ domain: 'shop.example', username: 'b@example.test' })).length, 0);
  assert.equal((await store(d).find({ domain: 'nowhere.example' })).length, 0);
});

test('get and totp: the secret is wrapped; items outside the collection are as if missing', async () => {
  const d = dirs();
  const c = await store(d).get('aaaaaaaa-0000-4000-8000-000000000001');
  assert.equal(c.secret.reveal().password, 'FAKE-pass-1');
  assert.equal(JSON.stringify(c), '{"record":{"ref":"aaaaaaaa-0000-4000-8000-000000000001","kind":"login","name":"Table","username":"diner@example.test","uris":["https://www.table.example/login"],"origin":"https://www.table.example","has_totp":true},"secret":"[secret]"}');
  assert.equal(await store(d).get('aaaaaaaa-0000-4000-8000-000000000003'), null);   // the bank, not shared
  assert.equal(await store(d).get('not-an-id'), null);
  assert.equal((await store(d).totp('aaaaaaaa-0000-4000-8000-000000000001')).reveal().totp, '492731');
  assert.equal(await store(d).totp('aaaaaaaa-0000-4000-8000-000000000002'), null);
});

test('refuses to run with readable state, and a locked vault is store_unavailable without detail', async () => {
  const d = dirs();
  fs.chmodSync(d.app, 0o755);
  await assert.rejects(store(d).find({ domain: 'table.example' }), (e) => e.kind === 'unavailable' && /0700/.test(e.message));
  fs.chmodSync(d.app, 0o700);
  await assert.rejects(store(d, 'wrong').find({ domain: 'table.example' }), (e) => e.kind === 'unavailable' && /locked/.test(e.message));
});

test('combined: a login-free service never needs the person at their computer, a vault login may', async () => {
  const d = dirs();
  const deviceLocal = { approval: 'device_local', label: 'asks on the computer', async fetch() { return null; } };
  const s = new CombinedStore({ services: { table: { credential: 'table.groundmark.fyi', base_url: 'https://table.groundmark.fyi', tools: {} } }, vault: deviceLocal });
  const b = new Broker({ stateDir: d.root, store: s, approvals: { url: () => 'https://approve.test/a/X' } });
  const h = b.handlers();
  const ok = await h['grant.request']({ credential: 'table.groundmark.fyi', ops: ['book'], constraints: { venue: 'Casa Verde', date: '2026-12-04', time: '19:00', party_size: 2 }, mode: 'one_shot', ttl_seconds: 600, purpose: 'Book' }, {});
  assert.equal(ok.summary, 'Book Casa Verde, Fri 4 Dec at 19:00, 2 people.');
  await assert.rejects(h['grant.request']({ credential: { domain: 'shop.example' }, ops: ['login'], mode: 'standing', ttl_seconds: 600, purpose: 'Sign in' }, {}), { code: 'store_needs_operator' });
});
