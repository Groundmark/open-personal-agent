// The passkey approval hook and its page (the demo design, rungs 1 and 2). The
// broker serves a small page on 127.0.0.1:8443. Confirming the offer with
// a registered passkey, user verified, is the grant:
// the assertion's challenge is the hash of the pending grant's grant.create
// body (approval/binding.js), recipient included, so it approves that grant
// for that recipient and nothing else.
//
// Rungs. Each origin is one relying party with its own passkey:
//   http://localhost:8443                   rung 2, the laptop (WebAuthn treats
//                                           localhost as secure; the default)
//   https://<remote origin>                 rung 1, the phone, through a private
//                                           network the deployment provides
// The page must be opened at a listed origin: requests whose Host is not one
// of them are refused, and so are POSTs whose Origin is not.
//
// Routes:
//   GET  /approve                   the one stable address (the phone's
//                                   bookmark, the enrollment page's next link):
//                                   redirects to the grant waiting here, lists
//                                   them if several, or waits and reloads
//   GET  /approve/<grant>           the page: insurer, items by group, the
//                                   excluded items by name, the expiry
//   GET  /approve/<grant>/options   WebAuthn request options; the challenge
//                                   is the grant's, userVerification required
//   POST /approve/<grant>           the assertion. Checked by
//                                   @simplewebauthn/server (requireUserVerification)
//                                   and again by binding.checkAssertion; then
//                                   stored with the grant, which goes active
//   GET  /approve/<grant>/qr.svg    QR code of the page's URL (the console's)
//   GET  /enroll/<token>[/options]  registration, only while enrollment is
//   POST /enroll/<token>            open (enroll: true): one passkey, then closed.
//                                   Never in the table run (--table refuses
//                                   --enroll): the phone is enrolled in a
//                                   separate step before it (an earlier security review)
//   GET  /static/...                the page script, its styles and the
//                                   @simplewebauthn/browser 14.0.0 bundle,
//                                   served from node_modules so it works offline
//
// Registration is the one door that adds a key able to approve grants, so it
// is closed unless the service starts with enrollment open. The enrollment
// URL carries a random one-time token and is printed only at start, on the
// broker's own output, which goes to the terminal of whoever started it
// (the operator), never to the console or its feed: the console is open to every
// local account (an earlier security review). After one passkey registers, the token is
// spent. The caller's socket cannot reach any of this. What a caller could
// do is read the token from somewhere it is shown and register its own
// passkey over loopback, since the page trusts Host and Origin headers (the
// private network is how the phone gets here, not something the page checks;
// a reverse proxy to a Unix socket may need root). So the token is shown
// nowhere another account can read it, and the table run opens no enrollment.
//
// Which grants are approvable: a grant the store says is pending and in
// date. The page, /approve, the options and the POST all read its state from
// the store, so a grant revoked or expired while pending shows as ended
// (an earlier security review). At open(), pending in-date grants on file are taken up
// again, so a broker restart mid-run leaves the waiting grant approvable
// (an earlier security review).
//
// The page shows ids and labels, never a value: the broker holds no values.

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { decodeCredentialPublicKey } from '@simplewebauthn/server/helpers';
import qrcode from 'qrcode-generator';
import { ApprovalHook } from './approval.js';
import { createBody } from './grants.js';
import { approvalChallenge, approvalRecord, checkAssertion, coseToJwk, COSE_ES256 } from '../approval/binding.js';
import { PasskeyStore, PASSKEYS_FILE } from '../approval/passkeys.js';

export const DEFAULT_PORT = 8443;
export const DEFAULT_HOST = '127.0.0.1';
// Rung 1's origin: the HTTPS origin the person's phone reaches the page at, set by the deployment.
export const TAILNET_ORIGIN = process.env.BROKER_REMOTE_ORIGIN || null;
const BODY_LIMIT = 64 * 1024;
const TIMEOUT_MS = 120_000;
const ENROLL_CHALLENGE_MS = 5 * 60_000;
const RP_NAME = 'Personal credential broker';
const USER_NAME = 'owner';

const STATIC = {
  '/static/approve.js': { file: new URL('./page/approve.js', import.meta.url), type: 'text/javascript' },
  '/static/approve.css': { file: new URL('./page/approve.css', import.meta.url), type: 'text/css' },
  '/static/simplewebauthn-browser.js': {
    file: new URL('../node_modules/@simplewebauthn/browser/dist/bundle/index.umd.min.js', import.meta.url), type: 'text/javascript',
  },
};
const HEADERS = {
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
};

export const PASSKEY_LABEL = (origins) => `passkey approval (userVerification required) on ${origins.join(', ')}`;

export class PasskeyApproval extends ApprovalHook {
  #host;
  #port;
  #origins;
  #enroll;
  #enrollToken = null;
  #enrollChallenges = new Map(); // challenge -> { origin, until }
  #pending = new Map(); // grant id -> { grant, attach }
  #grants = null;
  #catalog = null;
  #passkeys = null;
  #server = null;
  #static = new Map();
  #now;

  // origins: the page's origins, first one in the QR code. Default
  // http://localhost:<port> (the port it listens on, so port 0 works in tests).
  // enroll: open registration for one passkey at start (true), or not.
  constructor({ host = DEFAULT_HOST, port = DEFAULT_PORT, origins, enroll = false, now = () => new Date() } = {}) {
    super();
    if (typeof enroll !== 'boolean') throw new Error('approval: enroll is true or false');
    this.#host = host;
    this.#port = port;
    this.#origins = origins ? origins.map(normalOrigin) : null;
    this.#enroll = enroll;
    this.#now = now;
  }

  get method() { return 'passkey'; }
  get autoApproves() { return false; }
  get label() { return PASSKEY_LABEL(this.#origins ?? [`http://localhost:${this.#port}`]); }
  get origins() { return [...this.#origins]; }
  get port() { return this.#port; }
  // The page's one stable address, for the console's QR code.
  get approveUrl() { return `${this.#origins[0]}/approve`; }
  // The one-time registration URL. For the broker's own start lines only:
  // never put it on the console or anywhere another account can read.
  get enrollUrl() { return this.#enrollToken ? `${this.#origins[0]}/enroll/${this.#enrollToken}` : null; }
  get enrollOpen() { return this.#enrollToken !== null; }
  get passkeys() { return this.#passkeys; }

  // Called by startService once the log is open. Listens, takes up the
  // pending in-date grants on file (a restart mid-run), and opens enrollment
  // if asked. grants: the GrantStore.
  async open({ log, stateDir, catalog, grants }) {
    this.#catalog = catalog;
    this.#grants = grants;
    this.#passkeys = new PasskeyStore(join(stateDir, PASSKEYS_FILE), log);
    for (const [path, s] of Object.entries(STATIC)) this.#static.set(path, { body: readFileSync(s.file), type: s.type });
    this.#server = createServer((req, res) => {
      this.#route(req, res).catch((err) => {
        console.error(`approval: ${req.method} failed: ${err?.message}`);
        if (!res.headersSent) send(res, 500, { ok: false, error: 'internal' });
      });
    });
    await new Promise((resolve, reject) => {
      this.#server.once('error', reject);
      this.#server.listen(this.#port, this.#host, () => resolve());
    });
    this.#port = this.#server.address().port;
    this.#origins ??= [`http://localhost:${this.#port}`];
    const now = this.#now().getTime();
    for (const g of grants?.list() ?? []) {
      if (g.state === 'pending' && Date.parse(g.expires) > now && g.nonce !== undefined) {
        this.#pending.set(g.id, { grant: g, attach: (record) => grants.approve(g.id, record) });
      }
    }
    if (this.#enroll) this.#enrollToken = randomBytes(24).toString('base64url');
  }

  // Ids of the grants taken up again at open() (for the start lines).
  get reloaded() { return [...this.#pending.keys()]; }

  requested(grant, attach) {
    this.#pending.set(grant.id, { grant, attach });
    return { method: 'passkey', url: this.urlFor(grant.id) };
  }

  urlFor(id) { return `${this.#origins[0]}/approve/${id}`; }

  // The QR code for a grant's page, as SVG (the demo design: the console shows it).
  qrSvg(id) { return qrSvg(this.urlFor(id)); }

  async close() {
    this.#pending.clear();
    this.#enrollToken = null;
    if (this.#server) {
      const s = this.#server;
      this.#server = null;
      s.closeAllConnections?.();
      await new Promise((resolve) => s.close(() => resolve()));
    }
  }

  async #route(req, res) {
    const origin = this.#originOf(req);
    if (!origin) return send(res, 421, { ok: false, error: 'wrong_host', message: `open the page at ${this.#origins.join(' or ')}` });
    const url = new URL(req.url, origin);
    const path = url.pathname;
    if (req.method === 'POST' && req.headers.origin !== origin) {
      return send(res, 403, { ok: false, error: 'wrong_origin' });
    }

    if (req.method === 'GET' && this.#static.has(path)) {
      const s = this.#static.get(path);
      res.writeHead(200, { ...HEADERS, 'content-type': `${s.type}; charset=utf-8`, 'cache-control': 'no-cache' });
      return res.end(s.body);
    }
    if (req.method === 'GET' && path === '/approve') return this.#waiting(res);
    let m = path.match(/^\/approve\/(g-[0-9a-f-]{36})(\/options|\/qr\.svg)?$/);
    if (m) {
      const [, id, sub] = m;
      if (req.method === 'GET' && !sub) return this.#approvePage(res, id);
      if (req.method === 'GET' && sub === '/options') return this.#approveOptions(res, id, origin);
      if (req.method === 'GET' && sub === '/qr.svg') {
        res.writeHead(200, { ...HEADERS, 'content-type': 'image/svg+xml' });
        return res.end(this.qrSvg(id));
      }
      if (req.method === 'POST' && !sub) return this.#approve(req, res, id, origin);
    }
    m = path.match(/^\/enroll\/([A-Za-z0-9_-]{1,64})(\/options)?$/);
    if (m) {
      if (!this.#tokenOk(m[1])) return send(res, 404, { ok: false, error: 'enrollment_closed', message: 'enrollment is closed' });
      if (req.method === 'GET' && !m[2]) return html(res, 200, enrollPage(m[1]));
      if (req.method === 'GET' && m[2]) return this.#enrollOptions(res, origin);
      if (req.method === 'POST' && !m[2]) return this.#enrollFinish(req, res, origin);
    }
    return send(res, 404, { ok: false, error: 'not_found' });
  }

  // The request's origin, if its Host is one of the page's origins.
  #originOf(req) {
    const host = req.headers.host;
    return this.#origins.find((o) => new URL(o).host === host) ?? null;
  }

  #tokenOk(token) {
    if (!this.#enrollToken) return false;
    const a = Buffer.from(token);
    const b = Buffer.from(this.#enrollToken);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  // A grant, with its state from the store: { p } if it waits here, pending
  // and in date; { ended: grant } if the store has it and it is no longer
  // approvable (revoked, expired, or already active), and it is dropped from
  // #pending; null if the broker has no such grant.
  #lookup(id) {
    const p = this.#pending.get(id);
    const g = this.#grants?.get(id) ?? p?.grant ?? null;
    if (!g) return null;
    const inDate = Date.parse(g.expires) > this.#now().getTime();
    if (g.state === 'pending' && inDate) return p ? { p } : null;
    this.#pending.delete(id);
    return { ended: { ...g, state: g.state === 'pending' ? 'expired' : g.state } };
  }

  // Grants waiting here, still pending and in date.
  #waiting(res) {
    const ids = [...this.#pending.keys()].filter((id) => this.#lookup(id)?.p);
    if (ids.length === 1) {
      res.writeHead(302, { ...HEADERS, location: `/approve/${ids[0]}` });
      return res.end();
    }
    if (ids.length === 0) {
      return html(res, 200, page('Waiting for a grant', `<h1>No grant is waiting yet</h1>
<p>This page checks again every few seconds and opens the grant when the agent asks for one.</p>`, '', '<meta http-equiv="refresh" content="3">'));
    }
    return html(res, 200, page('Grants waiting', `<h1>${ids.length} grants are waiting</h1>
<ul>${ids.map((id) => `<li><a href="/approve/${esc(id)}">${esc(id)}</a></li>`).join('')}</ul>`));
  }

  #approvePage(res, id) {
    const l = this.#lookup(id);
    if (!l) return html(res, 404, page('No such approval', `<p>No grant ${esc(id)} is waiting for approval here.</p>`));
    if (l.ended) return html(res, 410, endedPage(l.ended));
    return html(res, 200, approvePage(l.p.grant, this.#catalog, approvalChallenge(createBody(l.p.grant)), this.#now()));
  }

  async #approveOptions(res, id, origin) {
    const l = this.#lookup(id);
    if (!l) return send(res, 404, { ok: false, error: 'not_pending' });
    if (l.ended) return send(res, 410, { ok: false, error: l.ended.state, message: `grant is ${l.ended.state}` });
    const { p } = l;
    const keys = this.#passkeys.forOrigin(origin);
    if (keys.length === 0) return send(res, 409, { ok: false, error: 'no_passkey', message: `no passkey is registered for ${origin}` });
    const options = await generateAuthenticationOptions({
      rpID: new URL(origin).hostname,
      challenge: Buffer.from(approvalChallenge(createBody(p.grant)), 'base64url'),
      allowCredentials: keys.map((k) => ({ id: k.credentialId, transports: k.transports })),
      userVerification: 'required',
      timeout: TIMEOUT_MS,
    });
    return send(res, 200, options);
  }

  async #approve(req, res, id, origin) {
    const l = this.#lookup(id);
    if (!l) return send(res, 404, { ok: false, error: 'not_pending' });
    if (l.ended) return send(res, 410, { ok: false, error: l.ended.state, message: `grant is ${l.ended.state}` });
    const { p } = l;
    const response = await readJson(req);
    if (!response || typeof response.id !== 'string') return send(res, 400, { ok: false, error: 'bad_request' });
    const registration = this.#passkeys.get(response.id);
    if (!registration || registration.origin !== origin) return send(res, 403, { ok: false, error: 'unknown_passkey' });

    const challenge = approvalChallenge(createBody(p.grant));
    let verified;
    try {
      verified = await verifyAuthenticationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: registration.origin,
        expectedRPID: registration.rpId,
        expectedType: 'webauthn.get',
        credential: { id: registration.credentialId, publicKey: Buffer.from(registration.publicKeyCose, 'base64url'), counter: registration.counter },
        requireUserVerification: true,
      });
    } catch (err) {
      console.error(`approval: assertion for ${id} refused: ${err?.message}`);
      return send(res, 403, { ok: false, error: 'assertion_refused' });
    }
    if (!verified.verified || verified.authenticationInfo.userVerified !== true) return send(res, 403, { ok: false, error: 'assertion_refused' });

    const record = approvalRecord({ response, registration, challenge, at: this.#now().toISOString() });
    const why = checkAssertion(record, { registration, createBody: createBody(p.grant) });
    if (why) {
      console.error(`approval: assertion for ${id} refused: ${why}`);
      return send(res, 403, { ok: false, error: 'assertion_refused' });
    }
    let g;
    try {
      g = p.attach(record);
    } catch (err) {
      this.#pending.delete(id);
      return send(res, 409, { ok: false, error: err?.code ?? 'not_pending', message: `grant is ${err?.code ?? 'not pending'}` });
    }
    this.#pending.delete(id);
    this.#passkeys.setCounter(registration.credentialId, verified.authenticationInfo.newCounter);
    return send(res, 200, { ok: true, grant: g.id, state: g.state, method: 'passkey' });
  }

  async #enrollOptions(res, origin) {
    const existing = this.#passkeys.forOrigin(origin);
    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: new URL(origin).hostname,
      userName: USER_NAME,
      userDisplayName: 'Owner',
      attestationType: 'none',
      excludeCredentials: existing.map((k) => ({ id: k.credentialId, transports: k.transports })),
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
      supportedAlgorithmIDs: [COSE_ES256],
      timeout: TIMEOUT_MS,
    });
    const now = this.#now().getTime();
    for (const [c, v] of this.#enrollChallenges) if (v.until < now) this.#enrollChallenges.delete(c);
    this.#enrollChallenges.set(options.challenge, { origin, until: now + ENROLL_CHALLENGE_MS });
    return send(res, 200, options);
  }

  async #enrollFinish(req, res, origin) {
    const response = await readJson(req);
    if (!response || typeof response.id !== 'string') return send(res, 400, { ok: false, error: 'bad_request' });
    const now = this.#now().getTime();
    let verified;
    try {
      verified = await verifyRegistrationResponse({
        response,
        expectedChallenge: (c) => {
          const v = this.#enrollChallenges.get(c);
          return Boolean(v && v.origin === origin && v.until >= now);
        },
        expectedOrigin: origin,
        expectedRPID: new URL(origin).hostname,
        requireUserVerification: true,
        supportedAlgorithmIDs: [COSE_ES256],
      });
    } catch (err) {
      console.error(`approval: registration refused: ${err?.message}`);
      return send(res, 403, { ok: false, error: 'registration_refused' });
    }
    if (!verified.verified || verified.registrationInfo.userVerified !== true) return send(res, 403, { ok: false, error: 'registration_refused' });
    const { credential } = verified.registrationInfo;
    const cose = Buffer.from(credential.publicKey);
    const rec = this.#passkeys.add({
      credentialId: credential.id,
      rpId: new URL(origin).hostname,
      origin,
      publicKey: coseToJwk(decodeCredentialPublicKey(cose)),
      publicKeyCose: cose.toString('base64url'),
      counter: credential.counter,
      transports: credential.transports ?? [],
      created: this.#now().toISOString(),
      label: `passkey for ${new URL(origin).hostname}`,
    });
    this.#enrollToken = null; // one passkey per enrollment
    this.#enrollChallenges.clear();
    return send(res, 200, { ok: true, credentialId: rec.credentialId, rpId: rec.rpId });
  }
}

export function qrSvg(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 6, margin: 4, scalable: true });
}

// The same QR code for a terminal: two modules per character (upper half
// block), black on white set explicitly, so it scans on a dark or a light
// terminal. For the enroll step, which shows the one-time URL only where it
// is run (an earlier security review).
export function qrTerminal(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const margin = 2;
  const dark = (r, c) => r >= 0 && c >= 0 && r < n && c < n && qr.isDark(r, c);
  const lines = [];
  for (let r = -margin; r < n + margin; r += 2) {
    let line = '';
    for (let c = -margin; c < n + margin; c++) {
      line += `\x1b[${dark(r, c) ? 30 : 97};${dark(r + 1, c) ? 40 : 107}m\u2580`;
    }
    lines.push(`${line}\x1b[0m`);
  }
  return lines.join('\n');
}

function normalOrigin(o) {
  const u = new URL(o);
  if (u.origin !== o.replace(/\/$/, '')) throw new Error(`approval: ${o} is not an origin (scheme, host and port only)`);
  if (u.protocol !== 'https:' && u.hostname !== 'localhost') throw new Error(`approval: ${o}: WebAuthn needs https, or localhost`);
  return u.origin;
}

async function readJson(req) {
  if (!/^application\/json\b/.test(req.headers['content-type'] ?? '')) return null;
  const chunks = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > BODY_LIMIT) return null;
    chunks.push(c);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}

function send(res, status, obj) {
  res.writeHead(status, { ...HEADERS, 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function html(res, status, text) {
  res.writeHead(status, { ...HEADERS, 'content-type': 'text/html; charset=utf-8' });
  res.end(text);
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function page(title, body, data = '', head = '') {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${head}
<title>${esc(title)}</title><link rel="stylesheet" href="/static/approve.css"></head>
<body><main id="approval"${data}>
${body}
</main>
<script src="/static/simplewebauthn-browser.js"></script>
<script src="/static/approve.js"></script>
</body></html>
`;
}

const labelOf = (catalog, id) => catalog?.labels?.get(id) ?? id;

export function approvePage(grant, catalog, challenge, now) {
  const inGrant = new Set(grant.items);
  const groups = (catalog?.groups ?? [{ id: 'items', items: grant.items }])
    .map((g) => ({ id: g.id, items: g.items.filter((i) => inGrant.has(i)) }))
    .filter((g) => g.items.length);
  const mins = Math.max(0, Math.round((Date.parse(grant.expires) - now.getTime()) / 60_000));
  const body = `
<h1>Release to ${esc(grant.recipient.name)}?</h1>
<p class="who">Recipient <b>${esc(grant.recipient.name)}</b> (<code>${esc(grant.recipient.id)}</code>), delivered to <code>${esc(grant.recipient.endpoint)}</code>. Only this recipient: the broker sends it, not the agent.</p>
<p class="exp">Expires <b>${esc(grant.expires)}</b> (in about ${mins} minutes), or sooner if you revoke it.</p>
<h2>${grant.items.length} items, by group</h2>
<ul class="groups">
${groups.map((g) => `<li><details><summary>${esc(labelOf(catalog, g.id))}: ${g.items.length}</summary><ul>${g.items.map((i) => `<li>${esc(labelOf(catalog, i))}</li>`).join('')}</ul></details></li>`).join('\n')}
</ul>
<h2>Not released: ${grant.excluded.length} locked items</h2>
<ul class="excluded">
${grant.excluded.map((i) => `<li>${esc(labelOf(catalog, i))}</li>`).join('\n')}
</ul>
<p class="grant">Grant <code>${esc(grant.id)}</code>, caller <code>${esc(grant.caller)}</code>. Your passkey signs challenge <code>${esc(challenge)}</code>, the SHA-256 of this grant and its recipient.</p>
<button id="go" type="button">Approve with Face ID or Touch ID</button>
<p id="status" role="status"></p>`;
  return page(`Approve release to ${grant.recipient.name}`, body, ` data-mode="approve" data-grant="${esc(grant.id)}"`);
}

// A grant that was waiting here and has ended (revoked, or expired while
// pending): said plainly, with no button.
function endedPage(grant) {
  const at = grant.states?.at(-1)?.at ?? grant.expires;
  const body = `
<h1>${grant.state === 'active' ? 'This grant is already approved' : 'This grant has ended'}</h1>
<p class="ended">Grant <code>${esc(grant.id)}</code> to ${esc(grant.recipient?.name ?? '')} is <b>${esc(grant.state)}</b>${grant.state === 'expired' ? ` (it expired at ${esc(grant.expires)})` : ` (since ${esc(at)})`}. It is not waiting for approval, and there is nothing to approve here.</p>
<p><a href="/approve">Back to the approval page</a></p>`;
  return page(`Grant ${grant.state}`, body);
}

function enrollPage(token) {
  const body = `
<h1>Register a passkey</h1>
<p>This adds the passkey that approves the broker's grants on this address. One passkey, then this page closes.</p>
<button id="go" type="button">Register with Face ID or Touch ID</button>
<p id="status" role="status"></p>`;
  return page('Register a passkey', body, ` data-mode="enroll" data-token="${esc(token)}"`);
}
