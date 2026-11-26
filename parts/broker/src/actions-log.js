// actions.jsonl in the contract's format (contracts/history.md):
//   { seq, ts, errand_id, type, grant_id?, detail?, prev_hash, sig }
// prev_hash is SHA-256 of the previous line's bytes ("" for the first); sig is Ed25519 (base64) by the
// broker's key over the line without sig, in RFC 8785 canonical JSON. parts/history verifies it.
// (src/log.js is the earlier demo's format, kept for reference.)
import { createHash, sign } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeSync } from 'node:fs';
import { canonicalize } from './jcs.js';
import { splitLines } from './log.js';

export const ACTION_TYPES = ['grant.requested', 'grant.approved', 'grant.denied', 'grant.used', 'grant.refused',
  'grant.revoked', 'grant.expired', 'browser.closed_on_grant_end', 'identity.declaration'];

export class ActionsLog {
  #path; #key; #seq = 0; #prev = '';

  /** key: the broker's private KeyObject. */
  constructor(path, key) {
    this.#path = path;
    this.#key = key;
    const lines = existsSync(path) ? splitLines(readFileSync(path)) : [];
    if (lines.length) {
      const last = lines[lines.length - 1];
      this.#seq = JSON.parse(last.toString('utf8')).seq + 1;
      this.#prev = createHash('sha256').update(last).digest('hex');
    }
  }

  append({ errand_id = null, type, grant_id, detail }) {
    if (!ACTION_TYPES.includes(type)) throw new Error(`actions log: unknown type ${type}`);
    const line = { seq: this.#seq, ts: new Date().toISOString(), errand_id, type, prev_hash: this.#prev,
      ...(grant_id ? { grant_id } : {}), ...(detail ? { detail } : {}) };
    // canonicalize() refuses a Secret, so one can never reach this file.
    line.sig = sign(null, Buffer.from(canonicalize(line)), this.#key).toString('base64');
    const bytes = Buffer.from(canonicalize(line));
    const fd = openSync(this.#path, 'a', 0o600);
    try { writeSync(fd, Buffer.concat([bytes, Buffer.from('\n')])); fsyncSync(fd); } finally { closeSync(fd); }
    this.#seq += 1;
    this.#prev = createHash('sha256').update(bytes).digest('hex');
    return line;
  }
}
