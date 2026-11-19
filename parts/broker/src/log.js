// Signed log: JSON Lines, one entry per line,
//   { seq, ts, type, body, prev, sig }
// Each line is the entry's RFC 8785 canonical form, so a line's bytes are
// its canonical bytes.
//   prev  SHA-256 (hex) of the previous line's bytes; 64 zeros for the first.
//   sig   Ed25519 (base64url) over the canonical bytes of the entry without sig.
// The first entry is `identity`, whose body carries the broker's public key.
// passkey.register records a passkey the approval page accepts, with its
// public key, so broker-verify can re-check approvals from the log alone.
// Append-only: nothing here rewrites or truncates the file.

import { createHash, sign } from 'node:crypto';
import { openSync, writeSync, fsyncSync, closeSync, readFileSync, existsSync } from 'node:fs';
import { canonicalize } from './jcs.js';

export const ENTRY_TYPES = ['identity', 'grant.create', 'approval', 'use', 'refusal', 'revoke', 'expire', 'passkey.register'];
export const REFUSAL_REASONS = ['no_grant', 'locked', 'out_of_scope', 'revoked', 'expired'];
export const ZERO_HASH = '0'.repeat(64);

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export class SignedLog {
  #path;
  #privateKey;
  #seq;
  #prev;

  constructor(path, privateKey, seq, prev) {
    this.#path = path;
    this.#privateKey = privateKey;
    this.#seq = seq;
    this.#prev = prev;
  }

  // Opens the log, writing the identity entry if the file is new or empty.
  // identity: { publicJwk, locked } where locked is the locked item ids.
  static open(path, { privateKey, publicJwk, locked = [] }) {
    const lines = existsSync(path) ? splitLines(readFileSync(path)) : [];
    const log = new SignedLog(path, privateKey, 0, ZERO_HASH);
    if (lines.length === 0) {
      log.append('identity', { key: publicJwk, locked: [...locked].sort() });
    } else {
      const last = lines[lines.length - 1];
      log.#seq = JSON.parse(last.toString('utf8')).seq + 1;
      log.#prev = sha256Hex(last);
    }
    return log;
  }

  get path() { return this.#path; }
  get nextSeq() { return this.#seq; }

  append(type, body) {
    if (!ENTRY_TYPES.includes(type)) throw new Error(`log: unknown entry type ${type}`);
    if (type === 'identity' && this.#seq !== 0) throw new Error('log: identity must be the first entry');
    if (type !== 'identity' && this.#seq === 0) throw new Error('log: the first entry must be identity');
    if (type === 'refusal' && !REFUSAL_REASONS.includes(body?.reason)) {
      throw new Error(`log: unknown refusal reason ${body?.reason}`);
    }
    const unsigned = { seq: this.#seq, ts: new Date().toISOString(), type, body, prev: this.#prev };
    const sig = sign(null, Buffer.from(canonicalize(unsigned), 'utf8'), this.#privateKey).toString('base64url');
    const entry = { ...unsigned, sig };
    const line = Buffer.from(canonicalize(entry), 'utf8');

    const fd = openSync(this.#path, 'a', 0o600);
    try {
      writeSync(fd, Buffer.concat([line, Buffer.from('\n')]));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.#seq += 1;
    this.#prev = sha256Hex(line);
    return entry;
  }
}

// Splits a log file's bytes into lines (Buffers), dropping the final newline.
export function splitLines(buf) {
  const lines = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) {
      lines.push(buf.subarray(start, i));
      start = i + 1;
    }
  }
  if (start < buf.length) lines.push(buf.subarray(start));
  return lines;
}
