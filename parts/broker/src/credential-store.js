// CredentialStore: the seam the vault later sits behind.
//
// One method, get(ref), resolving to { record, secret }:
//   record  the credential record, no secret in it:
//           { ref, owner, counterparty, scope, expires, secretRef }
//   secret  a Secret. Its fields come out only through reveal(). It prints,
//           inspects and JSON-serializes as "[secret]", and canonicalize()
//           refuses it, so it cannot reach a log line, an error or a test
//           failure message by accident.
//
// The fixture implementation is a JSON file in the broker's state, mode 0600:
//   { "records": { "<ref>": { owner, counterparty, scope, expires, secretRef } },
//     "secrets": { "<secretRef>": { ...opaque string fields... } } }
// The console labels it "fixture store, stands in for the vault".

import { readFileSync, writeFileSync, renameSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { inspect } from 'node:util';

export class CredentialStore {
  async get(ref) {
    throw new Error('CredentialStore.get is not implemented');
  }
}

const REDACTED = '[secret]';

export class Secret {
  #fields;
  constructor(fields) {
    this.#fields = Object.freeze({ ...fields });
    Object.freeze(this);
  }
  reveal() {
    return this.#fields;
  }
  // SHA-256 of one field, for debugging by hash.
  sha256(field) {
    return createHash('sha256').update(String(this.#fields[field])).digest('hex');
  }
  toString() { return REDACTED; }
  toJSON() { return REDACTED; }
  [inspect.custom]() { return REDACTED; }
}

const RECORD_FIELDS = ['owner', 'counterparty', 'scope', 'expires', 'secretRef'];

export class FixtureCredentialStore extends CredentialStore {
  #path;
  constructor(path) {
    super();
    this.#path = path;
  }

  get label() {
    return 'fixture store, stands in for the vault';
  }

  async get(ref) {
    const data = readStoreFile(this.#path);
    const rec = Object.hasOwn(data.records, ref) ? data.records[ref] : null;
    if (!rec) throw new Error(`credential store: no record ${JSON.stringify(ref)}`);
    const fields = Object.hasOwn(data.secrets, rec.secretRef) ? data.secrets[rec.secretRef] : null;
    if (!fields) throw new Error(`credential store: record ${JSON.stringify(ref)} points to a missing secret`);
    const record = { ref };
    for (const f of RECORD_FIELDS) record[f] = rec[f];
    return { record, secret: new Secret(fields) };
  }

  // Writes the whole store atomically, mode 0600. The seed script uses this.
  static write(path, { records, secrets }) {
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify({ records, secrets }) + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(tmp, path);
  }
}

function readStoreFile(path) {
  const mode = statSync(path).mode & 0o777;
  if (mode !== 0o600) throw new Error(`credential store: ${path} has mode ${mode.toString(8)}, want 600`);
  let data;
  try {
    data = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // Never pass the parser's message on: it can quote the file's contents.
    throw new Error(`credential store: ${path} is not valid JSON`);
  }
  if (!data || typeof data.records !== 'object' || typeof data.secrets !== 'object') {
    throw new Error(`credential store: ${path} lacks records or secrets`);
  }
  return data;
}
