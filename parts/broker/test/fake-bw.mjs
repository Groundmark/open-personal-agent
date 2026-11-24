#!/usr/bin/env node
// A stand-in for the Bitwarden CLI, for bw-store tests. Fake items only; records each call's argv (never env).
import fs from 'node:fs';
const args = process.argv.slice(2), env = process.env;
fs.appendFileSync(`${env.BITWARDENCLI_APPDATA_DIR}/../calls.log`, JSON.stringify(args) + '\n');
const C = '11111111-1111-4111-8111-111111111111', OTHER = '22222222-2222-4222-8222-222222222222';
const items = [
  { id: 'aaaaaaaa-0000-4000-8000-000000000001', type: 1, name: 'Table', collectionIds: [C], login: { username: 'diner@example.test', password: 'FAKE-pass-1', totp: 'JBSWY3DPEHPK3PXP', uris: [{ uri: 'https://www.table.example/login' }] } },
  { id: 'aaaaaaaa-0000-4000-8000-000000000002', type: 1, name: 'Shop a', collectionIds: [C], login: { username: 'a@example.test', password: 'FAKE-pass-2', uris: [{ uri: 'shop.example' }] } },
  { id: 'aaaaaaaa-0000-4000-8000-000000000003', type: 1, name: 'Bank (not shared)', collectionIds: [OTHER], login: { username: 'me', password: 'FAKE-bank', uris: [{ uri: 'https://table.example' }] } },
];
const out = (v) => { process.stdout.write(typeof v === 'string' ? v : JSON.stringify(v)); process.exit(0); };
const fail = (m, code = 1) => { process.stderr.write(m); process.exit(code); };
const state = `${env.BITWARDENCLI_APPDATA_DIR}/state.json`;
const st = fs.existsSync(state) ? JSON.parse(fs.readFileSync(state, 'utf8')) : { status: 'unauthenticated' };
if (args[0] === 'status') out(st);
if (args[0] === 'config') out('Saved setting `config`.');
if (args[0] === 'login') { if (env.BW_CLIENTID !== 'user.client' || env.BW_CLIENTSECRET !== 'FAKE-client-secret') fail('bad api key'); fs.writeFileSync(state, JSON.stringify({ status: 'locked' }), { mode: 0o600 }); out('You are logged in!'); }
if (args[0] === 'unlock') { if (fs.readFileSync(args[2], 'utf8').trim() !== 'FAKE-master-password') fail('Invalid master password.'); out('test-session'); }
if (env.BW_SESSION !== 'test-session') fail('Vault is locked.');
if (args[0] === 'list') out(items.filter((i) => i.collectionIds.includes(args[3])));
if (args[0] === 'get' && args[1] === 'item') { const i = items.find((x) => x.id === args[2]); i ? out(i) : fail('Not found.'); }
if (args[0] === 'get' && args[1] === 'totp') out('492731');
fail('unknown command');
