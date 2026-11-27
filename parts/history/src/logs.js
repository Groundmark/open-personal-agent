// Reading and checking the three logs (contracts/history.md), offline, with every other part stopped.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalize } from './jcs.js';

export const LOGS = {
  actions: { file: 'actions.jsonl', signer: 'broker',
    types: ['grant.requested', 'grant.approved', 'grant.denied', 'grant.used', 'grant.refused', 'grant.revoked',
      'grant.expired', 'browser.closed_on_grant_end', 'identity.declaration'] },
  context: { file: 'context-reads.jsonl', signer: 'context', types: ['context.read'] },
  conversation: { file: 'conversation.jsonl', signer: null, types: ['message', 'pairing'] },
};

// Field names that would mean a secret got into a log. The contract: secrets and one-time codes never appear.
const SECRET_KEYS = new Set(['password', 'passwd', 'secret', 'otp', 'totp', 'code', 'one_time_code', 'token', 'api_key', 'apikey', 'private_key', 'cookie']);

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

/** The file's lines as raw bytes (the hash chain is over bytes, not parsed JSON). */
function rawLines(file) {
  if (!fs.existsSync(file)) return [];
  const buf = fs.readFileSync(file);
  const out = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) { out.push(buf.subarray(start, i)); start = i + 1; }
  if (start < buf.length) out.push(buf.subarray(start));   // no final newline: an interrupted write
  return out;
}

export const readLog = (file) => rawLines(file).flatMap((b) => { try { return [JSON.parse(b.toString('utf8'))]; } catch { return []; } });

/** Public keys from keys.json: { broker, context } as PEM strings or JWK objects. */
export function loadKeys(file) {
  if (!file || !fs.existsSync(file)) return {};
  return Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(file, 'utf8'))).map(([who, k]) => [who,
    typeof k === 'string' ? crypto.createPublicKey(k) : crypto.createPublicKey({ key: k, format: 'jwk' })]));
}

function secretField(v, at = '') {
  if (!v || typeof v !== 'object') return null;
  for (const [k, x] of Object.entries(v)) {
    if (SECRET_KEYS.has(k.toLowerCase())) return at + k;
    const deeper = secretField(x, `${at}${k}.`);
    if (deeper) return deeper;
  }
  return null;
}

/**
 * Checks one log. Returns { ok, lines, break?: { line, reason }, warnings: [] }.
 * Stops at the first break, as the contract asks. publicKey null on a signed log means "can't check
 * signatures": that's a break, not a pass, unless the log is empty.
 */
export function verifyLog(file, kind, publicKey = null) {
  const spec = LOGS[kind];
  const lines = rawLines(file);
  const warnings = [];
  const fail = (i, reason) => ({ ok: false, lines: lines.length, break: { line: i + 1, reason }, warnings });
  if (spec.signer && lines.length && !publicKey) return fail(0, `no ${spec.signer} public key to check signatures`);
  let prev = '';
  let prevTs = '';
  for (let i = 0; i < lines.length; i++) {
    let o;
    try { o = JSON.parse(lines[i].toString('utf8')); } catch {
      return fail(i, i === lines.length - 1 ? 'last line is incomplete (a write was interrupted?)' : 'not JSON');
    }
    if (!o || typeof o !== 'object' || Array.isArray(o)) return fail(i, 'not a JSON object');
    if (o.seq !== i) return fail(i, `seq is ${o.seq}, expected ${i} (a line was removed, added or moved)`);
    if (o.prev_hash !== prev) return fail(i, 'prev_hash does not match the line before (a line was changed, removed or moved)');
    if (!spec.types.includes(o.type)) return fail(i, `unknown type ${o.type}`);
    if (!('errand_id' in o) || typeof o.ts !== 'string' || Number.isNaN(Date.parse(o.ts))) return fail(i, 'missing errand_id or ts');
    if (spec.signer) {
      const { sig, ...rest } = o;
      let good = false;
      try { good = typeof sig === 'string' && crypto.verify(null, Buffer.from(canonicalize(rest)), publicKey, Buffer.from(sig, 'base64')); } catch {}
      if (!good) return fail(i, `bad or missing ${spec.signer} signature`);
    }
    const leak = secretField(kind === 'conversation' ? o.attachments : o.detail ?? o);
    if (leak) return fail(i, `secret-looking field "${leak}" (secrets and codes must never be logged)`);
    if (o.ts < prevTs) warnings.push(`line ${i + 1}: time goes backwards (${prevTs} then ${o.ts})`);
    prevTs = o.ts;
    prev = sha256(lines[i]);
  }
  return { ok: true, lines: lines.length, warnings };
}

export function verifyAll(dir, keys = loadKeys(path.join(dir, 'keys.json'))) {
  return Object.fromEntries(Object.entries(LOGS).map(([kind, spec]) =>
    [kind, verifyLog(path.join(dir, spec.file), kind, spec.signer ? keys[spec.signer] ?? null : null)]));
}
