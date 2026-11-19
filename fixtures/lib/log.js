// Append-only, hash-chained, optionally signed JSONL logs. See contracts/history.md.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { canonical, nowIso } from './wire.js';

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function newKeyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const kid = sha256(publicKey.export({ type: 'spki', format: 'der' })).slice(0, 16);
  return { privateKey, publicKey, kid };
}

export const signB64 = (key, bytes) => crypto.sign(null, Buffer.from(bytes), key.privateKey).toString('base64');
export const verifyB64 = (publicKey, bytes, sigB64) => crypto.verify(null, Buffer.from(bytes), publicKey, Buffer.from(sigB64, 'base64'));

export class Log {
  /** key: { privateKey, kid } to sign lines, or null for unsigned (conversation log). */
  constructor(path, key = null) {
    this.path = path;
    this.key = key;
    this.seq = 0;
    this.prev = '';
    if (fs.existsSync(path)) {
      const lines = fs.readFileSync(path, 'utf8').split('\n').filter(Boolean);
      if (lines.length) {
        const last = lines[lines.length - 1];
        this.seq = JSON.parse(last).seq + 1;
        this.prev = sha256(last);
      }
    }
  }

  append(entry) {
    const line = { seq: this.seq, ts: nowIso(), errand_id: entry.errand_id ?? null, ...entry, prev_hash: this.prev };
    if (this.key) line.sig = signB64(this.key, canonical(line));
    const text = canonical(line);
    fs.appendFileSync(this.path, text + '\n', { mode: 0o600 });
    this.seq += 1;
    this.prev = sha256(text);
    return line;
  }
}

/** Verify a log's chain and, if publicKey is given, every signature. Returns { ok, lines, break? }. */
export function verifyLog(path, publicKey = null) {
  const lines = fs.existsSync(path) ? fs.readFileSync(path, 'utf8').split('\n').filter(Boolean) : [];
  let prev = '';
  for (let i = 0; i < lines.length; i++) {
    let obj;
    try { obj = JSON.parse(lines[i]); } catch { return { ok: false, lines: i, break: { line: i, reason: 'not JSON' } }; }
    if (obj.seq !== i) return { ok: false, lines: i, break: { line: i, reason: 'seq out of order' } };
    if (obj.prev_hash !== prev) return { ok: false, lines: i, break: { line: i, reason: 'hash chain broken' } };
    if (publicKey) {
      const { sig, ...rest } = obj;
      if (!sig || !verifyB64(publicKey, canonical(rest), sig)) return { ok: false, lines: i, break: { line: i, reason: 'bad signature' } };
    }
    prev = sha256(lines[i]);
  }
  return { ok: true, lines: lines.length };
}

export const readLog = (path) => fs.existsSync(path)
  ? fs.readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
