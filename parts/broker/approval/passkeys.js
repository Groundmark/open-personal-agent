// Registered passkeys: passkeys.json in the broker's state, mode
// 0600, rewritten atomically like grants.json. One record per passkey:
//   { credentialId, rpId, origin, publicKey (JWK, P-256), publicKeyCose,
//     counter, transports, created, label }
// Each registration is also logged as passkey.register, with the public key,
// so broker-verify re-checks approvals from the log and needs no other file.
// A passkey belongs to one relying party: the phone's is the remote origin's,
// the laptop's is localhost's. Public keys are not secrets.

import { readFileSync, existsSync, statSync } from 'node:fs';
import { writeAtomic } from '../src/fsutil.js';

export const PASSKEYS_FILE = 'passkeys.json';

// A credential id, short, for the console, the log tail and broker-verify:
// the first 8 and last 4 characters, enough to tell two passkeys apart on
// screen or in a photo. Credential ids are not secrets.
export const shortCredential = (id) => (typeof id === 'string' && id.length > 16 ? `${id.slice(0, 8)}...${id.slice(-4)}` : String(id ?? ''));

// What a registered passkey is, in the words the console uses: what the
// broker knows of it, and nothing it does not (no device, no biometric).
export const describePasskey = (k) => `passkey ${shortCredential(k.credentialId)} at ${k.rpId}, registered ${k.created}`;
const FILE_VERSION = 1;

export class PasskeyStore {
  #path;
  #log;

  constructor(path, log) {
    this.#path = path;
    this.#log = log;
  }

  list() { return this.#read(); }
  get(credentialId) { return this.#read().find((p) => p.credentialId === credentialId) ?? null; }
  forOrigin(origin) { return this.#read().filter((p) => p.origin === origin); }

  add(rec) {
    const all = this.#read();
    if (all.some((p) => p.credentialId === rec.credentialId)) throw new Error('passkeys: this credential is already registered');
    all.push(rec);
    this.#write(all);
    this.#log.append('passkey.register', {
      credential: rec.credentialId, rpId: rec.rpId, origin: rec.origin, key: rec.publicKey, alg: 'ES256', label: rec.label,
    });
    return rec;
  }

  setCounter(credentialId, counter) {
    const all = this.#read();
    const p = all.find((x) => x.credentialId === credentialId);
    if (!p || p.counter === counter) return;
    p.counter = counter;
    this.#write(all);
  }

  #read() {
    if (!existsSync(this.#path)) return [];
    const mode = statSync(this.#path).mode & 0o777;
    if (mode !== 0o600) throw new Error(`passkeys: ${this.#path} has mode ${mode.toString(8)}, want 600`);
    let data;
    try {
      data = JSON.parse(readFileSync(this.#path, 'utf8'));
    } catch {
      throw new Error(`passkeys: ${this.#path} is not valid JSON`);
    }
    if (data?.version !== FILE_VERSION || !Array.isArray(data.passkeys)) throw new Error(`passkeys: ${this.#path} is not a version ${FILE_VERSION} file`);
    return data.passkeys;
  }

  #write(passkeys) {
    writeAtomic(this.#path, JSON.stringify({ version: FILE_VERSION, passkeys }, null, 2) + '\n');
  }
}
