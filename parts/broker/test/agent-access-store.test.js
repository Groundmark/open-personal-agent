import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { AgentAccessStore } from '../src/agent-access-store.js';
import { StoreError } from '../src/credential-store.js';
import { tempDir } from './helpers.js';

// A fake `aac` that behaves like v0.11.0 did in the live spike, keyed on the domain asked for.
const FAKE_AAC = `#!/usr/bin/env node
const a = process.argv.slice(2);
const domain = a[a.indexOf('--domain') + 1];
const pw = 'test-only-fake-pw-' + process.pid;
if (domain === 'ok.example') { process.stdout.write(JSON.stringify({ success: true, credential: { credentialId: 'item-1', domain, username: 'test', password: pw, uri: 'https://ok.example' } })); process.exit(0); }
if (domain === 'totp.example') { process.stdout.write(JSON.stringify({ success: true, credential: { credentialId: 'item-2', domain, username: 'u', password: pw, totp: '123456', uri: 'https://totp.example' } })); process.exit(0); }
if (domain === 'refused.example') { process.stdout.write(JSON.stringify({ success: false, error: { code: 'credential_not_found', message: 'Credential request failed: Request denied' } })); process.exit(4); }
if (domain === 'silent.example') { process.stdout.write(JSON.stringify({ success: false, error: { code: 'auth_handshake_failed', message: 'Timeout' } })); process.exit(3); }
if (domain === 'garbled.example') { process.stdout.write('password=' + pw); process.exit(0); }
process.exit(2);
`;

function setup(t) {
  const dir = tempDir(t);
  const aacPath = join(dir, 'aac');
  writeFileSync(aacPath, FAKE_AAC, { mode: 0o755 });
  const stateHome = join(dir, 'home');
  mkdirSync(stateHome, { mode: 0o700 });
  return { aacPath, stateHome, store: new AgentAccessStore({ aacPath, session: 'fdb3e907', stateHome, timeoutSeconds: 5 }) };
}

test('agent access: fetch-only, device_local; a login comes back wrapped', async (t) => {
  const { store } = setup(t);
  assert.equal(store.approval, 'device_local');
  await assert.rejects(store.get('x'), /fetch-only/);
  const { record, secret } = await store.fetch({ domain: 'ok.example' });
  assert.deepEqual(record, { ref: 'item-1', kind: 'login', username: 'test', uris: ['https://ok.example'], has_totp: false });
  assert.match(secret.reveal().password, /^test-only-fake-pw-/);
  assert.equal(inspect(secret), '[secret]');
  const t2 = await store.fetch({ domain: 'totp.example' });
  assert.equal(t2.record.has_totp, true);
  assert.equal(t2.secret.reveal().totp, '123456');
});

test('agent access: exit codes map to the seam\'s failures, with no secret in any message', async (t) => {
  const { store } = setup(t);
  const kind = async (domain, extra = {}) => {
    try { await store.fetch({ domain, ...extra }); return 'ok'; } catch (e) {
      assert.ok(e instanceof StoreError);
      assert.ok(!/test-only-fake-pw/.test(e.message));
      return e.kind;
    }
  };
  assert.equal(await kind('refused.example'), 'not_found');
  assert.equal(await kind('silent.example'), 'no_answer');
  assert.equal(await kind('down.example'), 'unavailable');
  assert.equal(await kind('garbled.example'), 'unavailable');
  assert.equal(await kind('ok.example', { username: 'someone-else' }), 'not_found');
  assert.equal(await kind('Not A Domain'), 'not_found');
});

test('agent access: refuses to run when aac\'s state is readable by others', async (t) => {
  const { store, stateHome } = setup(t);
  const ap = join(stateHome, '.access-protocol');
  mkdirSync(ap, { mode: 0o700 });
  writeFileSync(join(ap, 'remote_client.key'), 'test-only', { mode: 0o664 });
  chmodSync(join(ap, 'remote_client.key'), 0o664); // what aac v0.11.0 actually writes
  await assert.rejects(store.fetch({ domain: 'ok.example' }), (e) => e.kind === 'unavailable' && /want 600/.test(e.message));
  chmodSync(join(ap, 'remote_client.key'), 0o600);
  chmodSync(stateHome, 0o755);
  await assert.rejects(store.fetch({ domain: 'ok.example' }), (e) => e.kind === 'unavailable' && /want 700/.test(e.message));
  chmodSync(stateHome, 0o700);
  assert.equal((await store.fetch({ domain: 'ok.example' })).record.ref, 'item-1');
});
