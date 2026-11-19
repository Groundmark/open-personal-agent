import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statSync, chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { CredentialStore, FixtureCredentialStore, Secret } from '../src/credential-store.js';
import { canonicalize } from '../src/jcs.js';
import { tempDir, fakeSecret } from './helpers.js';

function makeStore(t) {
  const dir = tempDir(t);
  const path = join(dir, 'credentials.json');
  const secret = fakeSecret();
  FixtureCredentialStore.write(path, {
    records: {
      'css-demo-owner': {
        owner: 'test-owner',
        counterparty: 'css-demo-pod',
        scope: 'example.read',
        expires: '2026-11-30T00:00:00.000Z',
        secretRef: 's1',
      },
    },
    secrets: { s1: secret },
  });
  return { path, secret, store: new FixtureCredentialStore(path) };
}

test('fixture store is a CredentialStore, file mode 0600', (t) => {
  const { path, store } = makeStore(t);
  assert.ok(store instanceof CredentialStore);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(store.label, 'fixture store, stands in for the vault');
});

test('get(ref) returns the record apart from the secret', async (t) => {
  const { store, secret } = makeStore(t);
  const { record, secret: s } = await store.get('css-demo-owner');
  assert.deepEqual(Object.keys(record).sort(), ['counterparty', 'expires', 'owner', 'ref', 'scope', 'secretRef']);
  assert.equal(record.owner, 'test-owner');
  assert.ok(s instanceof Secret);
  // Compare by equality without putting the value in a failure message.
  assert.ok(s.reveal().clientSecret === secret.clientSecret, 'revealed secret matches');
});

test('a Secret never prints, inspects, serializes or canonicalizes its value', async (t) => {
  const { store, secret } = makeStore(t);
  const { secret: s } = await store.get('css-demo-owner');
  for (const shown of [String(s), `${s}`, JSON.stringify({ s }), inspect(s), inspect({ s }, { depth: 5 })]) {
    assert.ok(!shown.includes(secret.clientSecret), 'secret not shown');
    assert.ok(!shown.includes(secret.clientId), 'id not shown');
  }
  assert.throws(() => canonicalize({ s }), TypeError);
  assert.match(s.sha256('clientSecret'), /^[0-9a-f]{64}$/);
});

test('unknown ref and dangling secret pointer throw without values', async (t) => {
  const { path, store, secret } = makeStore(t);
  await assert.rejects(store.get('nope'), /no record/);
  FixtureCredentialStore.write(path, {
    records: { r: { owner: 'o', counterparty: 'c', scope: 's', expires: 'e', secretRef: 'missing' } },
    secrets: { other: secret },
  });
  await assert.rejects(store.get('r'), (err) => !err.message.includes(secret.clientSecret) && /missing secret/.test(err.message));
});

test('refuses a store file readable by others, or corrupt, without quoting it', async (t) => {
  const { path, store, secret } = makeStore(t);
  chmodSync(path, 0o644);
  await assert.rejects(store.get('css-demo-owner'), /mode 644/);
  writeFileSync(path, `{"records":{},"secrets":{"x":"${secret.clientSecret}"`, { mode: 0o600 });
  chmodSync(path, 0o600);
  await assert.rejects(store.get('css-demo-owner'), (err) => !err.message.includes(secret.clientSecret) && /not valid JSON/.test(err.message));
});
