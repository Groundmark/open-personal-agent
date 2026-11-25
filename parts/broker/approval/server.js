// The passkey approval page (contracts/broker.md, Approval), generalised from from-demo/server.js.
// The broker serves it on loopback; a tunnel publishes it at an HTTPS origin such as
// https://approve.groundmark.fyi. Approving with a registered passkey, user verified, is the grant:
// the assertion's challenge is the grant's hash (grants.createBody + binding.approvalChallenge), so it
// approves that grant, as shown, and nothing else.
//
// Routes (the page is public, so nothing lists grants; a grant's link is its only way in):
//   GET  /a/<code>                     the short link for Signal and texts: the same page (and /options, /decline)
//   GET  /approve/<grant_id>           the page: the summary, what the agent may do, with what, how long, why
//   GET  /approve/<grant_id>/options   WebAuthn request options; challenge = the grant's hash, UV required
//   POST /approve/<grant_id>           the assertion: checked by @simplewebauthn/server and again by
//                                      binding.checkAssertion, then the broker approves the grant
//   POST /approve/<grant_id>/decline   the person says no (no passkey needed to decline)
//   POST /approve/<grant_id>/revoke    the person ends an approved grant, or a spent one-shot one (no passkey, as
//                                      for declining: it only ever stops the agent; contracts/broker.md grant.revoke)
//   GET  /enroll/<token>[/options]     register a passkey, only with a one-time token from `opa-broker enroll`
//   POST /enroll/<token>               (stored as a hash in enroll.json, 15 minutes, spent on first use)
//   GET  /static/...                   the page's script and styles, and @simplewebauthn/browser
// Requests must come for one of the configured origins (Host), and POSTs from it (Origin).
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, linkSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { decodeCredentialPublicKey } from '@simplewebauthn/server/helpers';
import { approvalChallenge, approvalRecord, checkAssertion, coseToJwk, COSE_ES256 } from './binding.js';
import { PasskeyStore } from './passkeys.js';
import { createBody } from '../src/grants.js';
import { SignedLog } from '../src/log.js';

const BODY_LIMIT = 64 * 1024;
const TIMEOUT_MS = 120_000;
const ENROLL_MINUTES = 15;
const ULID = '[0-9A-HJKMNP-TV-Z]{26}';
const STATIC = {
  '/static/approve.js': { file: new URL('./page/approve.js', import.meta.url), type: 'text/javascript' },
  '/static/approve.css': { file: new URL('./page/approve.css', import.meta.url), type: 'text/css' },
  '/static/simplewebauthn-browser.js': { file: new URL('../node_modules/@simplewebauthn/browser/dist/bundle/index.umd.min.js', import.meta.url), type: 'text/javascript' },
};
const HEADERS = {
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cache-control': 'no-store',
};
const sha = (s) => createHash('sha256').update(s).digest('hex');
const REVOCABLE = new Set(['approved', 'consumed']);   // a spent one-shot grant too: that stops declarations of its act

/** Opens enrollment for one passkey: writes enroll.json (the token's hash) and returns the token. */
export function openEnrollment(stateDir, now = Date.now()) {
  const token = randomBytes(24).toString('base64url');
  writeFileSync(join(stateDir, 'enroll.json'), JSON.stringify({ token_sha256: sha(token), until: now + ENROLL_MINUTES * 60_000 }), { mode: 0o600 });
  return token;
}

export class PasskeyApproval {
  #o; #broker = null; #passkeys; #server = null; #static = new Map(); #enrollChallenges = new Map();

  /**
   * origins: where the page is reached, e.g. ["https://approve.groundmark.fyi"] (https, or http://localhost).
   * rpId: the passkey's relying party, the origin's host or a parent domain (e.g. "groundmark.fyi").
   */
  constructor({ stateDir, origins, rpId, rpName = 'Your personal agent', host = '127.0.0.1', port = 8443, now = () => Date.now() }) {
    const os = origins.map((o) => {
      const u = new URL(o);
      if (u.origin !== o.replace(/\/$/, '')) throw new Error(`approval: ${o} is not an origin`);
      if (u.protocol !== 'https:' && u.hostname !== 'localhost') throw new Error(`approval: ${o}: passkeys need https (or localhost)`);
      const h = u.hostname;
      if (rpId && h !== rpId && !h.endsWith('.' + rpId)) throw new Error(`approval: rpId ${rpId} is not ${h} or a parent of it`);
      return u.origin;
    });
    this.#o = { stateDir, origins: os, rpId: rpId ?? new URL(os[0]).hostname, rpName, host, port, now };
    this.#passkeys = new PasskeyStore(join(stateDir, 'passkeys.json'), { append: (type, body) => this.adminLog?.append(type, body) });
  }

  /** The link the core sends the person (the broker's `approvals.url`). */
  url(g) { return g.code ? `${this.#o.origins[0]}/a/${g.code}` : `${this.#o.origins[0]}/approve/${g.grant_id}`; }

  get port() { return this.#o.port; }
  get passkeys() { return this.#passkeys.list(); }

  /** Starts serving for `broker`. Passkey registrations are logged to admin.jsonl, signed with the broker key. */
  async open(broker) {
    this.#broker = broker;
    this.adminLog = SignedLog.open(join(this.#o.stateDir, 'admin.jsonl'), { privateKey: broker.brokerKey.privateKey, publicJwk: broker.brokerKey.publicJwk });
    for (const [p, s] of Object.entries(STATIC)) this.#static.set(p, { body: readFileSync(s.file), type: s.type });
    this.#server = createServer((req, res) => this.#route(req, res).catch((e) => {
      console.error(`approval: ${req.method} ${req.url?.slice(0, 40)} failed: ${e?.message}`);
      if (!res.headersSent) send(res, 500, { ok: false, error: 'internal' });
    }));
    await new Promise((r, j) => { this.#server.once('error', j); this.#server.listen(this.#o.port, this.#o.host, r); });
    this.#o.port = this.#server.address().port;
  }

  async close() {
    if (!this.#server) return;
    const s = this.#server; this.#server = null;
    s.closeAllConnections?.();
    await new Promise((r) => s.close(r));
  }

  async #route(req, res) {
    const origin = this.#o.origins.find((o) => new URL(o).host === req.headers.host);
    if (!origin) return send(res, 421, { ok: false, error: 'wrong_host' });
    if (req.method === 'POST' && req.headers.origin !== origin) return send(res, 403, { ok: false, error: 'wrong_origin' });
    const path = new URL(req.url, origin).pathname;
    if (req.method === 'GET' && this.#static.has(path)) {
      const s = this.#static.get(path);
      res.writeHead(200, { ...HEADERS, 'content-type': `${s.type}; charset=utf-8`, 'cache-control': 'no-cache' });
      return res.end(s.body);
    }
    if (req.method === 'GET' && path === '/') return html(res, 200, page('Approvals', '<h1>Approvals</h1><p>Open the link your agent sent you to see what it is asking for.</p>'));
    // A short link (/a/<code>) is the same page as the long one (/approve/<grant_id>).
    let m = path.match(new RegExp(`^/approve/(${ULID})(/options|/decline|/details|/revoke)?$`)) ?? path.match(/^\/a\/([0-9A-HJKMNP-TV-Z]{10})(\/options|\/decline|\/details|\/revoke)?$/);
    if (m) {
      const [, key, sub] = m;
      const id = key.length === 10 ? (this.#broker.grants.byCode(key)?.grant_id ?? 'unknown') : key;
      if (req.method === 'GET' && !sub) return this.#page(res, id);
      if (req.method === 'GET' && sub === '/options') return this.#options(res, id, origin);
      if (req.method === 'GET' && sub === '/details') return this.#details(res, id);
      if (req.method === 'POST' && !sub) return this.#approve(req, res, id, origin);
      if (req.method === 'POST' && sub === '/decline') return this.#decline(res, id);
      if (req.method === 'POST' && sub === '/revoke') return this.#revoke(res, id);
    }
    m = path.match(/^\/enroll\/([A-Za-z0-9_-]{32})(\/options)?$/);
    if (m) {
      if (!this.#tokenOk(m[1])) return html(res, 404, page('Setup link not valid', '<h1>This setup link is not valid</h1><p>It may have been used already or run out. Ask for a new one.</p>'));
      if (req.method === 'GET' && !m[2]) return html(res, 200, enrollPage(m[1], this.#o.rpId));
      if (req.method === 'GET' && m[2]) return this.#enrollOptions(res, origin);
      if (req.method === 'POST' && !m[2]) {
        // Claim the setup link now, in the same tick as the check, so a second request at the same moment can't
        // also register a passkey with it. A failed registration puts it back.
        const f = join(this.#o.stateDir, 'enroll.json'), claimed = `${f}.claimed-${randomBytes(6).toString('hex')}`;
        try { renameSync(f, claimed); } catch { return html(res, 404, page('Setup link not valid', '<h1>This setup link is not valid</h1>')); }
        return this.#enrollFinish(req, res, origin, claimed);
      }
    }
    return send(res, 404, { ok: false, error: 'not_found' });
  }

  /** The grant, if the broker has it. */
  #grant(id) { try { return this.#broker.grants.get(id); } catch { return null; } }

  #page(res, id) {
    const g = this.#grant(id);
    if (!g) return html(res, 404, page('Not found', '<h1>Nothing to approve here</h1><p>This link is not for a request this agent knows.</p>'));
    if (g.state !== 'pending') return html(res, 410, endedPage(g));
    return html(res, 200, approvePage(g, this.#o.now()));
  }

  /** What the request is, from the broker's own record: what an in-chat approval card shows (never the core's words). */
  #details(res, id) {
    const g = this.#grant(id);
    if (!g) return send(res, 404, { ok: false, error: 'not_found' });
    return send(res, 200, { ok: true, state: g.state, summary: g.summary, facts: facts(g) });
  }

  async #options(res, id, origin) {
    const g = this.#grant(id);
    if (!g || g.state !== 'pending') return send(res, 410, { ok: false, error: 'not_pending', message: `this request is ${g?.state ?? 'unknown'}` });
    const keys = this.#passkeys.list().filter((k) => k.rpId === this.#o.rpId);
    if (!keys.length) return send(res, 409, { ok: false, error: 'no_passkey', message: 'no passkey is set up for this agent yet' });
    return send(res, 200, await generateAuthenticationOptions({
      rpID: this.#o.rpId, challenge: Buffer.from(approvalChallenge(createBody(g)), 'base64url'),
      allowCredentials: keys.map((k) => ({ id: k.credentialId, transports: k.transports })), userVerification: 'required', timeout: TIMEOUT_MS,
    }));
  }

  async #approve(req, res, id, origin) {
    const g = this.#grant(id);
    if (!g || g.state !== 'pending') return send(res, 410, { ok: false, error: 'not_pending', message: `this request is ${g?.state ?? 'unknown'}` });
    const response = await readJson(req);
    if (!response || typeof response.id !== 'string') return send(res, 400, { ok: false, error: 'bad_request' });
    const reg = this.#passkeys.get(response.id);
    if (!reg || reg.rpId !== this.#o.rpId) return send(res, 403, { ok: false, error: 'unknown_passkey' });
    const challenge = approvalChallenge(createBody(g));
    let v;
    try {
      v = await verifyAuthenticationResponse({
        response, expectedChallenge: challenge, expectedOrigin: this.#o.origins, expectedRPID: reg.rpId, expectedType: 'webauthn.get',
        credential: { id: reg.credentialId, publicKey: Buffer.from(reg.publicKeyCose, 'base64url'), counter: reg.counter }, requireUserVerification: true,
      });
    } catch (e) {
      console.error(`approval: assertion for ${id} refused: ${e?.message}`);
      return send(res, 403, { ok: false, error: 'assertion_refused' });
    }
    if (!v.verified || v.authenticationInfo.userVerified !== true) return send(res, 403, { ok: false, error: 'assertion_refused' });
    // The second, independent check (node:crypto only), against the registration for the origin used.
    const record = approvalRecord({ response, registration: { ...reg, origin }, challenge, at: new Date(this.#o.now()).toISOString() });
    const why = checkAssertion(record, { registration: { ...reg, origin }, createBody: createBody(g) });
    if (why) { console.error(`approval: assertion for ${id} refused: ${why}`); return send(res, 403, { ok: false, error: 'assertion_refused' }); }
    try { this.#broker.decide(id, true, { passkey_credential_id: reg.credentialId }); } catch (e) {
      return send(res, 409, { ok: false, error: e?.code ?? 'not_pending', message: e?.message });
    }
    this.#passkeys.setCounter(reg.credentialId, v.authenticationInfo.newCounter);
    return send(res, 200, { ok: true, grant_id: id, state: 'approved' });
  }

  #decline(res, id) {
    const g = this.#grant(id);
    if (!g || g.state !== 'pending') return send(res, 410, { ok: false, error: 'not_pending', message: `this request is ${g?.state ?? 'unknown'}` });
    this.#broker.decide(id, false);
    return send(res, 200, { ok: true, grant_id: id, state: 'denied' });
  }

  async #revoke(res, id) {
    const g = this.#grant(id);
    if (!g || !REVOCABLE.has(g.state)) return send(res, 410, { ok: false, error: 'not_revocable', message: `this request is ${g?.state ?? 'unknown'}` });
    await this.#broker.revoke(id, 'revoked on the approval page', 'person');
    return send(res, 200, { ok: true, grant_id: id, state: 'revoked' });
  }

  #tokenOk(token) {
    const f = join(this.#o.stateDir, 'enroll.json');
    if (!existsSync(f)) return false;
    let e; try { e = JSON.parse(readFileSync(f, 'utf8')); } catch { return false; }
    if (!(e.until > this.#o.now())) return false;
    const a = Buffer.from(sha(token)), b = Buffer.from(String(e.token_sha256));
    return a.length === b.length && timingSafeEqual(a, b);
  }

  async #enrollOptions(res, origin) {
    const existing = this.#passkeys.list().filter((k) => k.rpId === this.#o.rpId);
    const options = await generateRegistrationOptions({
      rpName: this.#o.rpName, rpID: this.#o.rpId, userName: 'owner', userDisplayName: 'Owner', attestationType: 'none',
      excludeCredentials: existing.map((k) => ({ id: k.credentialId, transports: k.transports })),
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' }, supportedAlgorithmIDs: [COSE_ES256], timeout: TIMEOUT_MS,
    });
    const now = this.#o.now();
    for (const [c, v] of this.#enrollChallenges) if (v.until < now) this.#enrollChallenges.delete(c);
    this.#enrollChallenges.set(options.challenge, { origin, until: now + 5 * 60_000 });
    return send(res, 200, options);
  }

  async #enrollFinish(req, res, origin, claimed) {
    // Put the link back after a failure, unless a newer one was issued meanwhile (link() never replaces a file).
    const putBack = () => { try { linkSync(claimed, join(this.#o.stateDir, 'enroll.json')); } catch {} try { unlinkSync(claimed); } catch {} };
    let response;
    try { response = await readJson(req); } catch { putBack(); return; }   // the request went away mid-body
    if (!response || typeof response.id !== 'string') { putBack(); return send(res, 400, { ok: false, error: 'bad_request' }); }
    const now = this.#o.now();
    let v;
    try {
      v = await verifyRegistrationResponse({
        response, expectedOrigin: origin, expectedRPID: this.#o.rpId, requireUserVerification: true, supportedAlgorithmIDs: [COSE_ES256],
        expectedChallenge: (c) => { const x = this.#enrollChallenges.get(c); return Boolean(x && x.origin === origin && x.until >= now); },
      });
    } catch (e) {
      console.error(`approval: registration refused: ${e?.message}`);
      putBack();
      return send(res, 403, { ok: false, error: 'registration_refused' });
    }
    if (!v.verified || v.registrationInfo.userVerified !== true) { putBack(); return send(res, 403, { ok: false, error: 'registration_refused' }); }
    const { credential } = v.registrationInfo;
    const cose = Buffer.from(credential.publicKey);
    const rec = this.#passkeys.add({
      credentialId: credential.id, rpId: this.#o.rpId, origin, publicKey: coseToJwk(decodeCredentialPublicKey(cose)),
      publicKeyCose: cose.toString('base64url'), counter: credential.counter, transports: credential.transports ?? [],
      created: new Date(now).toISOString(), label: `passkey for ${this.#o.rpId}`,
    });
    try { unlinkSync(claimed); } catch {}   // one passkey per setup link
    this.#enrollChallenges.clear();
    return send(res, 200, { ok: true, credentialId: rec.credentialId, rpId: rec.rpId });
  }
}

// ---- pages ----

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const OP_WORDS = { read: 'look at your account', search: 'search and browse', login: 'sign in', book: 'make this booking', edit_order: 'change your order', pay: 'pay' };

function page(title, body, data = '') {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><link rel="stylesheet" href="/static/approve.css"></head>
<body><main id="approval"${data}>
${body}
</main>
<script src="/static/simplewebauthn-browser.js"></script>
<script src="/static/approve.js"></script>
</body></html>
`;
}

function using(g) {
  if (g.session) return `your own browser, signed in at ${esc(new URL(g.session.origin).host)}`;
  if (g.credential && typeof g.credential === 'object') return `your saved login for ${esc(g.credential.domain)}${g.credential.username ? ` (${esc(g.credential.username)})` : ''}`;
  return `your saved credential “${esc(g.credential)}”`;
}

const KNOWN = [['venue', 'Where'], ['date', 'Date'], ['time', 'Time'], ['party_size', 'People'], ['notes', 'Notes'], ['scope', 'What to read']];

/**
 * Every constraint, as label/value pairs: the familiar ones in plain words, then any other field as it is. A binding
 * call sends all of them, so the person must see all of them.
 */
export function constraintRows(c) {
  if (!c || typeof c !== 'object') return [];
  const show = (v) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v));
  // The friendly list only when it says everything each change carries; otherwise the change in full.
  const plain = (x) => x && typeof x === 'object' && (Object.keys(x).every((k) => k === 'skip') || Object.keys(x).every((k) => k === 'item' || k === 'quantity'))
    && Object.values(x).every((v) => v === null || typeof v !== 'object');
  const rows = [];
  for (const [k, label] of KNOWN) if (c[k] !== undefined) rows.push([label, show(c[k])]);
  if (c.changes !== undefined) {
    rows.push(['Changes', Array.isArray(c.changes) && c.changes.every(plain)
      ? c.changes.map((x) => ('skip' in x ? `skip ${x.skip}` : `${x.item}: ${x.quantity}`)).join('; ') : show(c.changes)]);
  }
  for (const [k, v] of Object.entries(c)) {
    if (KNOWN.some(([n]) => n === k) || k === 'changes' || v === undefined) continue;
    rows.push([k.replace(/_/g, ' '), show(v)]);
  }
  return rows;
}

/** The call a binding grant allows: the HTTP request for a relying party, or the MCP server and tool. */
function callRow(g) {
  if (g.request?.url) return ['Sends', `${g.request.method} ${g.request.url}`];
  if (g.request?.server) return ['Calls', `${g.request.server} / ${g.request.tool}`];
  return null;
}

function details(c) {
  const rows = constraintRows(c);
  return rows.length ? `<dl class="details">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>` : '';
}

/** The request in plain words, as label/value pairs (the in-chat card shows these). */
export function facts(g) {
  const out = constraintRows(g.constraints);
  const mins = Math.round(g.ttl_seconds / 60);
  out.push(['It may', g.ops.map((o) => OP_WORDS[o] ?? o).join(', ')]);
  out.push(['Using', g.session ? `your own browser, signed in at ${new URL(g.session.origin).host}`
    : g.credential && typeof g.credential === 'object' ? `your saved login for ${g.credential.domain}${g.credential.username ? ` (${g.credential.username})` : ''}`
      : String(g.credential)]);
  const call = callRow(g);
  if (call) out.push(call);
  out.push(['How long', g.mode === 'one_shot' ? `Once, within ${mins} minutes` : `For ${mins >= 120 ? `${Math.round(mins / 60)} hours` : `${mins} minutes`}`]);
  out.push(['Why', g.purpose]);
  return out;
}

export function approvePage(g, now) {
  const mins = Math.round(g.ttl_seconds / 60);
  const howLong = g.mode === 'one_shot' ? `Once, within ${mins} minutes of your approval.`
    : `As often as needed for ${mins >= 120 ? `${Math.round(mins / 60)} hours` : `${mins} minutes`} after your approval, until you revoke it.`;
  const waited = Math.max(0, Math.round((now - Date.parse(g.created_at)) / 60_000));
  const body = `
<p class="eyebrow">Your agent is asking${waited ? ` (${waited} min ago)` : ''}</p>
<h1>${esc(g.summary)}</h1>
${details(g.constraints)}
<dl class="facts">
<dt>It may</dt><dd>${g.ops.map((o) => esc(OP_WORDS[o] ?? o)).join(', ')}</dd>
<dt>Using</dt><dd>${using(g)}</dd>
${callRow(g) ? `<dt>${callRow(g)[0]}</dt><dd><code>${esc(callRow(g)[1])}</code></dd>\n` : ''}<dt>How long</dt><dd>${esc(howLong)}</dd>
<dt>Why</dt><dd>${esc(g.purpose)}</dd>
</dl>
<button id="go" type="button">Approve with your passkey</button>
<button id="no" type="button" class="secondary">Decline</button>
<p id="status" role="status"></p>
<p class="grant">Request <code>${esc(g.grant_id)}</code>. Your passkey signs <code>${esc(g.hash)}</code>, a fingerprint of exactly what is shown here.</p>`;
  return page('Approve?', body, ` data-mode="approve" data-grant="${esc(g.grant_id)}"`);
}

function endedPage(g) {
  const said = { approved: 'You approved this.', denied: 'You declined this.', expired: 'This request ran out before it was approved, or its time is up.',
    revoked: 'This was revoked.', consumed: 'This was approved and has been used.' }[g.state] ?? `This request is ${g.state}.`;
  const revoke = !REVOCABLE.has(g.state) ? '' : `
<button id="revoke" type="button" class="secondary">${g.state === 'consumed' ? 'Revoke (your agent can no longer say it did this for you)' : 'Revoke now'}</button>
<p id="status" role="status"></p>`;
  return page('Nothing to approve', `<h1>${esc(said)}</h1><p>${esc(g.summary)}</p>${revoke}<p class="grant">Request <code>${esc(g.grant_id)}</code></p>`,
    revoke ? ` data-mode="revoke" data-grant="${esc(g.grant_id)}"` : '');
}

function enrollPage(token, rpId) {
  return page('Set up your passkey', `
<h1>Set up your passkey</h1>
<p>This passkey is how you approve what your agent does for you on ${esc(rpId)}. It stays on your phone or computer; nothing secret is sent here.</p>
<button id="go" type="button">Create passkey</button>
<p id="status" role="status"></p>`, ` data-mode="enroll" data-token="${esc(token)}"`);
}

// ---- http ----

async function readJson(req) {
  if (!/^application\/json\b/.test(req.headers['content-type'] ?? '')) return null;
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > BODY_LIMIT) return null; chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return null; }
}
function send(res, status, obj) { res.writeHead(status, { ...HEADERS, 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); }
function html(res, status, text) { res.writeHead(status, { ...HEADERS, 'content-type': 'text/html; charset=utf-8' }); res.end(text); }
