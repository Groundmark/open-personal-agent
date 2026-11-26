// Grants (contracts/broker.md): validation of a request, the lifecycle, and a store that survives
// a restart. Rules generalised from fixtures/broker and from-demo/grants.js.
//   pending -> approved | denied | expired -> (consumed | revoked | expired)
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { approvalChallenge } from '../approval/binding.js';
import { writeAtomic } from './fsutil.js';

export const OPS = ['read', 'search', 'login', 'book', 'edit_order', 'pay'];
export const BINDING_OPS = new Set(['book', 'edit_order', 'pay']);
export const MAX_TTL = { standing: 7 * 24 * 3600, one_shot: 3600 };
/** The longest browser.fill_code waits for the person's code (contracts/broker.md). */
export const MAX_CODE_WAIT_S = 900;

export class BrokerError extends Error {
  constructor(code, message, detail) { super(message || code); this.code = code; if (detail) this.detail = detail; }
}

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export function ulid(now = Date.now()) {
  let t = '';
  for (let i = 0, n = now; i < 10; i++, n = Math.floor(n / 32)) t = B32[n % 32] + t;
  const r = new Uint8Array(16); crypto.getRandomValues(r);
  return t + [...r].map((b) => B32[b % 32]).join('');
}

/** A short code for the approval link (/a/<code>): 10 characters of Crockford base32, 50 random bits. */
export function shortCode() { return [...randomBytes(10)].map((b) => B32[b % 32]).join(''); }

/** Checks grant.request args against the contract. Throws bad_request / one_shot_required. */
export function checkRequest(a) {
  const bad = (m) => { throw new BrokerError('bad_request', m); };
  if (!a || typeof a !== 'object') bad('args must be an object');
  if (!!a.credential === !!a.session) bad('exactly one of credential or session');
  if (a.credential && typeof a.credential === 'object') {
    if (typeof a.credential.domain !== 'string' || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i.test(a.credential.domain)) bad('credential.domain must be a host name');
  } else if (a.credential && typeof a.credential !== 'string') bad('credential must be a name or { domain }');
  if (a.session) {
    let u; try { u = new URL(a.session.origin); } catch { bad('session.origin is not a URL'); }
    if (u.origin !== a.session.origin) bad('session.origin must be an origin (scheme://host[:port])');
    if (a.session.browser !== 'operator') bad('session.browser must be "operator"');
  }
  if (!Array.isArray(a.ops) || !a.ops.length || !a.ops.every((o) => OPS.includes(o))) bad(`ops must be a non-empty list from ${OPS.join(', ')}`);
  if (!['standing', 'one_shot'].includes(a.mode)) bad('mode must be standing or one_shot');
  if (a.ops.some((o) => BINDING_OPS.has(o)) && a.mode !== 'one_shot') throw new BrokerError('one_shot_required', 'binding ops need a one-shot grant');
  if (!Number.isInteger(a.ttl_seconds) || a.ttl_seconds <= 0 || a.ttl_seconds > MAX_TTL[a.mode]) bad(`ttl_seconds must be 1..${MAX_TTL[a.mode]} for ${a.mode}`);
  if (typeof a.purpose !== 'string' || !a.purpose.trim()) bad('purpose is required');
  if (a.call !== undefined && !(a.call && typeof a.call.server === 'string' && typeof a.call.tool === 'string')) bad('call must be { server, tool }');
  const c = a.constraints ?? {};
  if (a.ops.includes('book') && !(c.venue && c.date && c.time && Number.isInteger(c.party_size))) bad('book needs constraints venue, date, time, party_size');
  if (a.ops.includes('edit_order') && !(Array.isArray(c.changes) && c.changes.length)) bad('edit_order needs constraints.changes');
}

/**
 * What the person approves: every field the approval page shows, plus a random nonce. The passkey signs
 * approvalChallenge(createBody(g)) (approval/binding.js), so an assertion for one grant can't approve another.
 */
export const createBody = (g) => ({
  grant_id: g.grant_id, nonce: g.nonce, errand_id: g.errand_id ?? null, credential: g.credential ?? null, session: g.session ?? null,
  ops: g.ops, constraints: g.constraints ?? null, mode: g.mode, ttl_seconds: g.ttl_seconds, purpose: g.purpose, summary: g.summary ?? null,
  // The exact call a binding grant allows (and for a relying party, its method, URL and body digest). Left out when
  // there is none, so grants approved before 0.4 keep their fingerprints.
  ...(g.request ? { request: g.request } : {}),
  // Shown on the approval page too (contracts 0.4: the passkey covers everything shown). Left out when unset, as above.
  ...(g.operator_present ? { operator_present: true } : {}),
  ...(g.credential_ref ? { credential_ref: g.credential_ref } : {}),
});

const STATE_ERR = { pending: 'grant_not_approved', denied: 'grant_denied', expired: 'grant_expired', revoked: 'grant_revoked', consumed: 'grant_consumed' };

export class GrantStore {
  #path; #grants = new Map(); #now;

  /** path: grants.json in the broker's state directory (no secrets in it). now(): ms clock, for tests. */
  constructor(path, { now = Date.now } = {}) {
    this.#path = path;
    this.#now = now;
    if (path && existsSync(path)) for (const g of JSON.parse(readFileSync(path, 'utf8'))) this.#grants.set(g.grant_id, g);
  }

  #save() { if (this.#path) writeAtomic(this.#path, JSON.stringify([...this.#grants.values()])); }

  create(fields) {
    const g = { ...fields, grant_id: ulid(), nonce: randomBytes(16).toString('base64url'), code: shortCode(), state: 'pending',
      created_at: new Date(this.#now()).toISOString(), uses: 0, approved_at: null, expires_at: null, last_used_at: null };
    g.hash = approvalChallenge(createBody(g));
    this.#grants.set(g.grant_id, g);
    this.#save();
    return g;
  }

  /** The grant a short approval code points to, or null. */
  byCode(code) { for (const g of this.#grants.values()) if (g.code === code) return g; return null; }

  get(id) {
    const g = this.#grants.get(id);
    if (!g) throw new BrokerError('grant_not_found', id);
    return g;
  }

  all() { return [...this.#grants.values()]; }

  /** Grants whose time ran out, moved to `expired` (pending ones after pendingMs). Returns them. */
  sweep(pendingMs) {
    const now = this.#now(), out = [];
    for (const g of this.#grants.values()) {
      const late = (g.state === 'approved' && Date.parse(g.expires_at) <= now)
        || (g.state === 'pending' && Date.parse(g.created_at) + pendingMs <= now);
      if (late) { g.prev_state = g.state; g.state = 'expired'; out.push(g); }
    }
    if (out.length) this.#save();
    return out;
  }

  /** The grant, if live and allowing any of `ops`; else the contract's error. `token`: the caller's own reserve(). */
  usable(id, ops = [], token = null) {
    const g = this.get(id);
    if (g.state === 'approved' && Date.parse(g.expires_at) <= this.#now()) throw new BrokerError('grant_expired', `${id} expired`);
    if (STATE_ERR[g.state]) throw new BrokerError(STATE_ERR[g.state], `${id} is ${g.state}`);
    if (g.in_flight && g.in_flight !== token) throw new BrokerError('grant_consumed', `${id} is being used right now`);
    const want = [].concat(ops);
    if (want.length && !want.some((o) => g.ops.includes(o))) throw new BrokerError('op_not_granted', `${want.join('|')} not in [${g.ops}]`);
    return g;
  }

  decide(id, approve) {
    const g = this.get(id);
    if (g.state !== 'pending') throw new BrokerError(STATE_ERR[g.state] ?? 'bad_request', `${id} is already ${g.state}`);
    const now = this.#now();
    g.state = approve ? 'approved' : 'denied';
    g.approved_at = approve ? new Date(now).toISOString() : null;
    g.expires_at = approve ? new Date(now + g.ttl_seconds * 1000).toISOString() : null;
    this.#save();
    return g;
  }

  /**
   * Takes a one-shot grant for one use before any asynchronous work, so two concurrent calls can't both use it
   * (call it in the same tick as usable()). release() gives it back after a definite failure; use() spends it.
   */
  reserve(g) {
    if (g.mode !== 'one_shot') return null;
    if (g.in_flight) throw new BrokerError('grant_consumed', `${g.grant_id} is being used right now`);
    const token = randomBytes(8).toString('hex');   // only the call holding this can give the grant back
    g.in_flight = token;
    this.#save();
    return token;
  }

  release(g, token) { if (token && g.in_flight === token) { delete g.in_flight; this.#save(); } }

  use(g) {
    delete g.in_flight;
    g.uses += 1;
    g.last_used_at = new Date(this.#now()).toISOString();
    // Revoked or expired while in flight stays so: the use is counted, the state isn't overwritten.
    if (g.mode === 'one_shot' && g.state === 'approved') g.state = 'consumed';
    this.#save();
  }

  /** Binds a credential-by-site grant to the item the store returned; later different items are refused. */
  bind(g, ref) {
    if (g.credential_ref && g.credential_ref !== ref) throw new BrokerError('constraint_mismatch', 'the store returned a different login than this grant is bound to');
    if (!g.credential_ref) { g.credential_ref = ref; this.#save(); }
  }

  revoke(id) {
    const g = this.get(id);
    // A spent one-shot grant can still be revoked: that stops declarations of its act (identity.declaration).
    if (['revoked', 'expired', 'denied'].includes(g.state)) return g;
    g.state = 'revoked';
    this.#save();
    return g;
  }
}
