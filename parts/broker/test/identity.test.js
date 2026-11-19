import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statSync, readFileSync, chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sign, verify } from 'node:crypto';
import { loadOrCreateIdentity, readPublicKey } from '../src/identity.js';
import { tempDir } from './helpers.js';

test('first run makes an Ed25519 keypair, key 0600, broker.pub beside it', (t) => {
  const dir = tempDir(t);
  const id = loadOrCreateIdentity(dir);
  assert.equal(id.privateKey.asymmetricKeyType, 'ed25519');
  assert.equal(statSync(join(dir, 'broker.key')).mode & 0o777, 0o600);
  const pub = readPublicKey(join(dir, 'broker.pub'));
  const sig = sign(null, Buffer.from('x'), id.privateKey);
  assert.ok(verify(null, Buffer.from('x'), pub, sig));
  assert.equal(id.publicJwk.kty, 'OKP');
  assert.equal(id.publicJwk.crv, 'Ed25519');
  assert.equal(Object.keys(id.publicJwk).length, 3);
});

test('second run loads the same key', (t) => {
  const dir = tempDir(t);
  const a = loadOrCreateIdentity(dir);
  const pubBefore = readFileSync(join(dir, 'broker.pub'));
  const b = loadOrCreateIdentity(dir);
  assert.deepEqual(a.publicJwk, b.publicJwk);
  assert.ok(readFileSync(join(dir, 'broker.pub')).equals(pubBefore));
});

test('refuses a private key readable by others', (t) => {
  const dir = tempDir(t);
  loadOrCreateIdentity(dir);
  chmodSync(join(dir, 'broker.key'), 0o644);
  assert.throws(() => loadOrCreateIdentity(dir), /mode 644/);
});

test('refuses a broker.pub that does not match the key', (t) => {
  const dir = tempDir(t);
  const other = tempDir(t);
  loadOrCreateIdentity(dir);
  loadOrCreateIdentity(other);
  writeFileSync(join(dir, 'broker.pub'), readFileSync(join(other, 'broker.pub')));
  assert.throws(() => loadOrCreateIdentity(dir), /does not match/);
});
