// Grant store: grants.json in the broker's state, mode 0600,
// rewritten atomically (temp file, fsync, rename, fsync the directory), so a
// crash mid-write leaves the previous file whole.
//
// A grant:
//   { id, nonce, caller, credential, ops: ["solid.release"], items, excluded,
//     recipient: { id, name, endpoint, receiptKey },
//     created, expires,
//     state, states: [{ state, at, reason? }],   one entry per change
//     approval,                                   null until approved (4.9)
//     lastUsed }                                  null until first use
//
// States: pending -> active (approval attached), then active -> revoked or
// expired; pending can also end revoked or expired. An ended grant stays on
// file. Every change is logged: grant.create, approval, revoke, expire.
//
// Expiry is checked on use (checkUse): a use after expires moves the grant to
// expired, logs expire, and is refused. Nothing expires a grant in the
// background, so list() can show an active grant past its time; the CLI says so.
//
// The nonce is random per grant. It and everything the approval page
// shows are in the grant.create body (createBody), and the passkey challenge
// is the hash of that body (approval/binding.js), so an assertion is bound to
// one grant and one recipient. Grants made before nonces have no nonce; their
// create body is the older one, and only a simulated approval fits them.
//
// The file is read fresh for every operation, so the service and the CLI see
// each other's writes. Values never enter a grant: items are ids.

import { randomUUID, randomBytes } from 'node:crypto';
import {
  openSync, writeSync, fsyncSync, closeSync, renameSync, readFileSync,
  existsSync, statSync, unlinkSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { canonicalize } from '../src/jcs.js';
import { sha256Hex } from '../src/log.js';

export const GRANT_STATES = ['pending', 'active', 'revoked', 'expired'];
export const GRANT_OPS = ['solid.release'];
export const DEFAULT_TTL_MS = 30 * 60 * 1000; // the demo design; the scenario may set another
export const GRANTS_FILE = 'grants.json';
const FILE_VERSION = 1;

export class GrantError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export class GrantStore {
  #path;
  #log;
  #now;
  #beforeRename;

  // log: a SignedLog. now: () => Date, for tests.
  // beforeRename: test hook, called with the temp path after it is written.
  constructor(path, log, { now = () => new Date(), beforeRename } = {}) {
    this.#path = path;
    this.#log = log;
    this.#now = now;
    this.#beforeRename = beforeRename;
  }

  get path() { return this.#path; }

  list() {
    return this.#read();
  }

  get(id) {
    return this.#read().find((g) => g.id === id) ?? null;
  }

  // Grants for a caller, newest first.
  forCaller(caller) {
    return this.#read().filter((g) => g.caller === caller).reverse();
  }

  // Makes a pending grant and logs grant.create.
  create({ caller, credential, items, excluded = [], recipient, ttlMs = DEFAULT_TTL_MS }) {
    if (typeof caller !== 'string' || !caller) throw new GrantError('bad_request', 'grant: caller is required');
    if (typeof credential !== 'string' || !credential) throw new GrantError('bad_request', 'grant: credential is required');
    checkIds(items, 'items');
    checkIds(excluded, 'excluded');
    if (items.length === 0) throw new GrantError('bad_request', 'grant: items is empty');
    const overlap = items.filter((i) => excluded.includes(i));
    if (overlap.length) throw new GrantError('bad_request', `grant: excluded items are also in items: ${overlap.join(', ')}`);
    checkRecipient(recipient);
    if (!Number.isInteger(ttlMs) || ttlMs <= 0) throw new GrantError('bad_request', 'grant: ttlMs must be a positive integer');

    const now = this.#now();
    const grant = {
      id: `g-${randomUUID()}`,
      nonce: randomBytes(16).toString('base64url'),
      caller,
      credential,
      ops: [...GRANT_OPS],
      items: [...items],
      excluded: [...excluded],
      recipient: {
        id: recipient.id,
        name: recipient.name,
        endpoint: recipient.endpoint,
        receiptKey: { kty: recipient.receiptKey.kty, crv: recipient.receiptKey.crv, x: recipient.receiptKey.x },
      },
      created: now.toISOString(),
      expires: new Date(now.getTime() + ttlMs).toISOString(),
      state: 'pending',
      states: [{ state: 'pending', at: now.toISOString() }],
      approval: null,
      lastUsed: null,
    };
    const grants = this.#read();
    grants.push(grant);
    this.#write(grants);
    this.#log.append('grant.create', createBody(grant));
    return grant;
  }

  // Attaches an approval and makes the grant active. approval: { method, ... }
  // as approval/binding.js approvalRecord stores it (method "passkey":
  // credential id, rpId, origin, challenge, authenticator data, client data,
  // signature), or { method: "simulated" } on rung 3. The log carries its
  // method and the hash of its canonical form, and for a passkey its
  // credential id, so the log itself says which key approved (an earlier security review).
  approve(id, approval) {
    if (!approval || typeof approval.method !== 'string') {
      throw new GrantError('bad_request', 'grant: approval needs a method');
    }
    const due = this.#expireIfDue(id);
    if (due.state === 'expired') throw new GrantError('expired', `grant ${id} is expired`);
    return this.#change(id, (g, now) => {
      if (g.state !== 'pending') throw new GrantError(g.state, `grant ${id} is ${g.state}, not pending`);
      g.approval = approval;
      setState(g, 'active', now);
      const entry = { grant: g.id, method: approval.method, hash: sha256Hex(canonicalize(approval)) };
      if (approval.method === 'passkey' && typeof approval.credentialId === 'string') entry.credential = approval.credentialId;
      this.#log.append('approval', entry);
      return g;
    });
  }

  // Ends a pending or active grant. It stays on file. caller is
  // who asked, as declared on the socket; the revoke entry records it (spec
  // 4.6, an earlier security review).
  revoke(id, reason = 'revoked by the owner', caller = 'unknown') {
    if (typeof reason !== 'string' || !reason) throw new GrantError('bad_request', 'grant: reason must be a string');
    if (typeof caller !== 'string' || !caller) throw new GrantError('bad_request', 'grant: caller must be a string');
    return this.#change(id, (g, now) => {
      if (g.state === 'revoked' || g.state === 'expired') {
        throw new GrantError(g.state, `grant ${id} is already ${g.state}`);
      }
      setState(g, 'revoked', now, reason);
      this.#log.append('revoke', { grant: g.id, reason, caller });
      return g;
    });
  }

  // Checks a grant for one use: { ok: true, grant } or { ok: false, reason, grant }
  // with reason no_grant, revoked, expired or pending. A use past expiry moves
  // the grant to expired and logs expire. It logs no refusal: the service does,
  // with the caller and items in hand.
  checkUse(id) {
    if (!this.get(id)) return { ok: false, reason: 'no_grant', grant: null };
    const g = this.#expireIfDue(id);
    if (g.state === 'active') return { ok: true, grant: g };
    return { ok: false, reason: g.state, grant: g };
  }

  // Records the time of a use, after a group is delivered and logged.
  markUsed(id) {
    return this.#change(id, (g, now) => {
      g.lastUsed = now.toISOString();
      return g;
    });
  }

  // Moves a pending or active grant past its time to expired and logs expire.
  #expireIfDue(id) {
    return this.#change(id, (g, now) => {
      if ((g.state === 'pending' || g.state === 'active') && now.getTime() >= Date.parse(g.expires)) {
        setState(g, 'expired', now);
        this.#log.append('expire', { grant: g.id, expires: g.expires });
      }
      return g;
    });
  }

  #change(id, fn) {
    const grants = this.#read();
    const g = grants.find((x) => x.id === id);
    if (!g) throw new GrantError('no_grant', `no grant ${id}`);
    const before = canonicalize(g);
    const out = fn(g, this.#now());
    if (canonicalize(g) !== before) this.#write(grants);
    return out;
  }

  #read() {
    if (!existsSync(this.#path)) return [];
    const mode = statSync(this.#path).mode & 0o777;
    if (mode !== 0o600) throw new Error(`grants: ${this.#path} has mode ${mode.toString(8)}, want 600`);
    let data;
    try {
      data = JSON.parse(readFileSync(this.#path, 'utf8'));
    } catch {
      throw new Error(`grants: ${this.#path} is not valid JSON`);
    }
    if (data?.version !== FILE_VERSION || !Array.isArray(data.grants)) {
      throw new Error(`grants: ${this.#path} is not a version ${FILE_VERSION} grants file`);
    }
    return data.grants;
  }

  #write(grants) {
    writeAtomic(this.#path, JSON.stringify({ version: FILE_VERSION, grants }, null, 2) + '\n', this.#beforeRename);
  }
}

// The grant.create entry's body for a grant: what the log fixes at creation,
// and what the passkey challenge hashes (approval/binding.js). broker-verify
// compares each grant on file with it.
export function createBody(g) {
  const body = {
    grant: g.id,
    caller: g.caller,
    credential: g.credential,
    ops: g.ops,
    items: g.items,
    excluded: g.excluded,
    recipient: g.recipient?.id,
    receiptKey: g.recipient?.receiptKey,
    endpoint: g.recipient?.endpoint,
    expires: g.expires,
  };
  if (g.nonce !== undefined) {
    body.nonce = g.nonce;
    body.recipientName = g.recipient?.name;
  }
  return body;
}

// Temp file beside the target, fsync, rename over it, fsync the directory.
// A crash before the rename leaves the old file; after it, the new one.
export function writeAtomic(path, text, beforeRename) {
  const tmp = `${path}.tmp-${process.pid}`;
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    beforeRename?.(tmp);
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch {}
    throw err;
  }
  const dfd = openSync(dirname(path), 'r');
  try { fsyncSync(dfd); } finally { closeSync(dfd); }
}

function setState(g, state, now, reason) {
  g.state = state;
  const change = { state, at: now.toISOString() };
  if (reason !== undefined) change.reason = reason;
  g.states.push(change);
}

function checkIds(ids, name) {
  if (!Array.isArray(ids) || ids.some((i) => typeof i !== 'string' || !i)) {
    throw new GrantError('bad_request', `grant: ${name} must be an array of item ids`);
  }
  if (new Set(ids).size !== ids.length) throw new GrantError('bad_request', `grant: ${name} has duplicates`);
}

function checkRecipient(r) {
  const k = r?.receiptKey;
  if (!r || typeof r.id !== 'string' || !r.id || typeof r.name !== 'string' || !r.name
      || typeof r.endpoint !== 'string' || !/^https?:\/\//.test(r.endpoint)
      || !k || k.kty !== 'OKP' || k.crv !== 'Ed25519' || typeof k.x !== 'string' || !k.x) {
    throw new GrantError('bad_request', 'grant: recipient needs id, name, an http(s) endpoint and an Ed25519 receiptKey JWK');
  }
}
