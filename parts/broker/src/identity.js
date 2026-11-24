// An Ed25519 keypair made on first run: the broker's own (broker.key, signs the log) and the
// agent's (agent.key, signs declarations and requests to relying parties), kept apart.
// The private key is <name>.key in the state directory, mode 0600; the public key is
// <name>.pub (PEM, SPKI) beside it.

import { generateKeyPairSync, createPrivateKey, createPublicKey } from 'node:crypto';
import { readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const PRIVATE_KEY_FILE = 'broker.key';
export const PUBLIC_KEY_FILE = 'broker.pub';

export function loadOrCreateIdentity(stateDir, name = 'broker') {
  const keyPath = join(stateDir, `${name}.key`);
  const pubPath = join(stateDir, `${name}.pub`);

  if (!existsSync(keyPath)) {
    const { privateKey } = generateKeyPairSync('ed25519');
    // 'wx' refuses to overwrite a key another process wrote first.
    writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
  }

  const mode = statSync(keyPath).mode & 0o777;
  if (mode !== 0o600) throw new Error(`${keyPath} has mode ${mode.toString(8)}, want 600`);

  const privateKey = createPrivateKey(readFileSync(keyPath));
  const publicKey = createPublicKey(privateKey);
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' });

  if (!existsSync(pubPath)) {
    writeFileSync(pubPath, pubPem, { mode: 0o644 });
  } else if (readFileSync(pubPath, 'utf8') !== pubPem) {
    throw new Error(`${pubPath} does not match ${keyPath}`);
  }

  return { privateKey, publicKey, publicJwk: publicJwk(publicKey) };
}

export function readPublicKey(pubPath) {
  return createPublicKey(readFileSync(pubPath));
}

// The form the identity entry carries: { kty, crv, x }.
export function publicJwk(publicKey) {
  const { kty, crv, x } = publicKey.export({ format: 'jwk' });
  return { kty, crv, x };
}
