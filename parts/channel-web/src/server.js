// The web channel adapter (contracts/channel.md, channel "web"): the person talks to the agent from a
// page on their phone. Pairing maps onto passkeys: the account id is the person's passkey credential id and
// the "identity key" is its public key, pinned at install (pinned.json, copied from the broker's passkeys.json).
// Signing in is one Face ID, or, where the config turns it on (password_signin), a password the person sets once
// signed in, for a computer with no passkey. It's off by default: whoever is in the chat can read its history and use
// any standing grants that are live, so a password is a real way in.
// A session cookie lasts 30 days. Signing in only lets the person talk to the agent; approvals still need the passkey.
//
//   HTTP (behind the tunnel):  GET /  the chat page    POST /api/signin/options, /api/signin, /api/signout
//                              POST /api/signin/password, /api/password (set it, signed in)
//                              POST /api/send          GET /api/events (server-sent events: the agent's messages)
//                              /approve/*  passed to the broker's approval page, so approvals happen in the chat
//   Socket (from the core):    channel.send            only to the paired account (recipient_not_allowed otherwise)
//
// The adapter keeps no conversation history (the core does): only a delivery buffer in memory, the last 100
// messages for at most 24 hours, so every signed-in device (phone and computer) gets them. Each page keeps its
// own copy on the device.
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { createConnection, createServer as createNetServer } from 'node:net';
import { join } from 'node:path';
import { checkSignIn, newChallenge } from './webauthn.js';
import { pushHostOk, sendPush, vapidKeys } from './push.js';

const PAGE = new URL('../page/', import.meta.url);
const FILES = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/app.css': ['app.css', 'text/css'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'], '/icon.svg': ['icon.svg', 'image/svg+xml'], '/sw.js': ['sw.js', 'text/javascript'] };
const HEADERS = {
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
};
const MAX_TEXT = 4000;
const SESSION_DAYS = 30;
const sha = (s) => createHash('sha256').update(s).digest('hex');
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ulid = () => { let t = ''; for (let i = 0, n = Date.now(); i < 10; i++, n = Math.floor(n / 32)) t = B32[n % 32] + t; return t + [...randomBytes(16)].map((b) => B32[b % 32]).join(''); };

export class WebChannel {
  /**
   * cfg: { state_dir, origins: ["https://chat.groundmark.fyi"], rp_id, pinned: { credentialId, publicKey },
   *        core_socket, approval_upstream?: "http://127.0.0.1:8443", name?: "web",
   *        password_signin?: false (true lets the person set a password for a computer with no passkey) }
   */
  constructor(cfg, { now = () => Date.now() } = {}) {
    this.cfg = { name: 'web', ...cfg };
    this.now = now;
    this.challenges = new Map();     // challenge -> expiry
    this.recent = [];                // the last messages both ways (100, at most 24 h), so every device can catch up
    this.seq = 0;
    this.streams = new Map();        // open page -> its session, so a notification goes only to devices without the chat open
    this.pushFile = join(cfg.state_dir, 'push.json');
    this.subs = existsSync(this.pushFile) ? JSON.parse(readFileSync(this.pushFile, 'utf8')) : {};   // session -> push subscription
    this.vapid = vapidKeys(join(cfg.state_dir, 'vapid.json'));
    this.sessionsFile = join(cfg.state_dir, 'sessions.json');
    this.sessions = existsSync(this.sessionsFile) ? JSON.parse(readFileSync(this.sessionsFile, 'utf8')) : {};   // sha256(token) -> expiry
    this.passwordFile = join(cfg.state_dir, 'password.json');   // { salt, hash } (scrypt), set by the person once signed in
    this.failures = [];                                          // times of wrong passwords, for the lockout
  }

  get passwordOn() { return this.cfg.password_signin === true; }
  get hasPassword() { return this.passwordOn && existsSync(this.passwordFile); }

  /** A password sign-in, for a computer with no passkey. 10 wrong tries in 15 minutes locks it for 15 minutes. */
  #passwordOk(pw) {
    const now = this.now();
    this.failures = this.failures.filter((t) => t > now - 15 * 60_000);
    if (this.failures.length >= 10) return 'locked';
    if (typeof pw !== 'string' || !this.hasPassword) return 'wrong';
    const { salt, hash } = JSON.parse(readFileSync(this.passwordFile, 'utf8'));
    const got = scryptSync(pw, Buffer.from(salt, 'base64'), 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    if (timingSafeEqual(got, Buffer.from(hash, 'base64'))) { this.failures = []; return null; }
    this.failures.push(now);
    return 'wrong';
  }

  #setPassword(pw) {
    const salt = randomBytes(16);
    const hash = scryptSync(pw, salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    writeFileSync(this.passwordFile + '.tmp', JSON.stringify({ salt: salt.toString('base64'), hash: hash.toString('base64') }), { mode: 0o600 });
    renameSync(this.passwordFile + '.tmp', this.passwordFile);
  }

  #startSession(res) {
    const token = randomBytes(32).toString('base64url');
    this.sessions[sha(token)] = this.now() + SESSION_DAYS * 86400_000;
    for (const [k, e] of Object.entries(this.sessions)) if (e < this.now()) delete this.sessions[k];
    this.#saveSessions();
    res.setHeader('set-cookie', `sid=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}`);
  }

  get account() { return this.cfg.pinned.credentialId; }

  #saveSessions() { writeFileSync(this.sessionsFile + '.tmp', JSON.stringify(this.sessions), { mode: 0o600 }); renameSync(this.sessionsFile + '.tmp', this.sessionsFile); }

  /** The session (sha256 of the cookie's token) if signed in, else false. */
  #signedIn(req) {
    const m = /(?:^|;\s*)sid=([A-Za-z0-9_-]{43})/.exec(req.headers.cookie || '');
    if (!m) return false;
    const k = sha(m[1]), exp = this.sessions[k];
    return exp && exp > this.now() ? k : false;
  }

  #savePush() { writeFileSync(this.pushFile + '.tmp', JSON.stringify(this.subs), { mode: 0o600 }); renameSync(this.pushFile + '.tmp', this.pushFile); }

  /** A notification to each device that has turned them on and doesn't have the chat open right now. */
  #notify(text) {
    const open = new Set(this.streams.values());
    const ask = /\n*Approve: \S+\s*$/.exec(text);
    const body = (ask ? text.slice(0, ask.index).split('\n\n').pop() : text).trim().slice(0, 160) || 'Your agent needs you.';
    for (const [sess, sub] of Object.entries(this.subs)) {
      if (open.has(sess) || !(this.sessions[sess] > this.now())) continue;
      sendPush(sub, { title: ask ? 'Your agent needs your OK' : 'Your agent', body, url: '/' }, this.vapid, this.cfg.push_subject ?? this.cfg.origins[0], { fetchImpl: this.cfg.push_fetch })
        .then((status) => { if (status === 404 || status === 410) { delete this.subs[sess]; this.#savePush(); } })
        .catch((e) => console.error(`web: push failed: ${e.message}`));
    }
  }

  // ---- the core's side ----

  /** channel.send: the agent speaks. */
  send(a) {
    if (a.to !== this.account) throw Object.assign(new Error(a.to), { code: 'recipient_not_allowed' });
    if (typeof a.text !== 'string') throw Object.assign(new Error('text is required'), { code: 'bad_request' });
    const msg = { message_id: `out-${ulid()}`, sent_at: new Date(this.now()).toISOString() };
    this.#publish({ who: 'them', text: a.text, message_id: msg.message_id, at: msg.sent_at });
    return msg;
  }

  /** Every open page gets it now; a page that opens later catches up from `recent`. */
  #publish(ev) {
    ev.seq = ++this.seq;
    this.recent.push(ev);
    const cutoff = new Date(this.now() - 24 * 3600_000).toISOString();
    while (this.recent.length > 100 || (this.recent.length && this.recent[0].at < cutoff)) this.recent.shift();
    for (const [s, sess] of this.streams) {
      // A page whose session was signed out or ran out stops getting messages.
      if (!(this.sessions[sess] > this.now())) { s.end(); this.streams.delete(s); continue; }
      s.write(`id: ${ev.seq}\ndata: ${JSON.stringify(ev)}\n\n`);
    }
    if (ev.who === 'them') this.#notify(ev.text);
  }

  /** Listens for the core on `path` (or an fd from systemd). */
  async listenSocket(where) {
    const srv = createNetServer((c) => {
      let buf = '', done = false;
      c.on('error', () => {});
      c.on('data', (d) => {
        if (done) return;
        buf += d;
        const nl = buf.indexOf('\n');
        if (nl < 0) return;
        done = true;
        let req = null; try { req = JSON.parse(buf.slice(0, nl)); } catch {}
        const id = req?.id ?? null;
        if (req?.op !== 'channel.send' || req.caller !== 'core') return c.end(JSON.stringify({ id, ok: false, error: req?.op ? 'unauthorized_caller' : 'bad_request' }) + '\n');
        try { c.end(JSON.stringify({ id, ok: true, result: this.send(req.args ?? {}) }) + '\n'); } catch (e) {
          c.end(JSON.stringify({ id, ok: false, error: e.code ?? 'internal', message: e.message }) + '\n');
        }
      });
    });
    await new Promise((r, j) => { srv.once('error', j); srv.listen(where, r); });
    this.socketServer = srv;
    return srv;
  }

  /** channel.inbound to the core. */
  #inbound(text) {
    const args = { channel: this.cfg.name, message_id: `in-${ulid()}`, from: this.account, from_display: 'You', text, attachments: [], received_at: new Date(this.now()).toISOString() };
    const req = { op: 'channel.inbound', id: ulid(), caller: `channel-${this.cfg.name}`, errand_id: null, ts: args.received_at, args };
    return new Promise((resolve) => {
      const c = createConnection(this.cfg.core_socket, () => c.write(JSON.stringify(req) + '\n'));
      let b = ''; c.on('data', (d) => { b += d; }); c.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve({ ok: false }); } });
      c.on('error', () => resolve({ ok: false, error: 'core_unavailable' }));
    });
  }

  // ---- the person's side ----

  async listenHttp(port, host = '127.0.0.1') {
    this.http = createServer((req, res) => this.#route(req, res).catch((e) => {
      console.error(`web: ${req.method} ${req.url?.slice(0, 40)}: ${e.message}`);
      if (!res.headersSent) json(res, 500, { ok: false, error: 'internal' });
    }));
    await new Promise((r) => this.http.listen(port, host, r));
    return this.http.address().port;
  }

  async #route(req, res) {
    const origin = this.cfg.origins.find((o) => new URL(o).host === req.headers.host);
    if (!origin) return json(res, 421, { ok: false, error: 'wrong_host' });
    if (req.method === 'POST' && req.headers.origin !== origin) return json(res, 403, { ok: false, error: 'wrong_origin' });
    const path = new URL(req.url, origin).pathname;
    if ((path.startsWith('/approve/') || path.startsWith('/a/')) && this.cfg.approval_upstream) return this.#toApproval(req, res);
    if (req.method === 'GET' && FILES[path]) {
      const [f, type] = FILES[path];
      res.writeHead(200, { ...HEADERS, 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-cache' });
      return res.end(readFileSync(new URL(f, PAGE)));
    }
    if (req.method === 'GET' && path === '/api/me') { const sess = this.#signedIn(req); return json(res, 200, { signed_in: Boolean(sess), has_password: this.hasPassword, password_signin: this.passwordOn, push: Boolean(sess && this.subs[sess]) }); }
    if (req.method === 'POST' && (path === '/api/signin/password' || path === '/api/password') && !this.passwordOn) {
      return json(res, 404, { ok: false, error: 'password_signin_off', message: 'Signing in with a password is turned off here. Use your passkey.' });
    }
    if (req.method === 'POST' && path === '/api/signin/password') {
      const why = this.#passwordOk((await readJson(req))?.password);
      if (why === 'locked') return json(res, 429, { ok: false, error: 'locked', message: 'Too many wrong passwords. Try again in 15 minutes.' });
      if (why) return json(res, 403, { ok: false, error: 'wrong_password', message: 'That password is not right.' });
      this.#startSession(res);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && path === '/api/signin/options') {
      const challenge = newChallenge(), now = this.now();
      for (const [c, exp] of this.challenges) if (exp < now) this.challenges.delete(c);
      this.challenges.set(challenge, now + 5 * 60_000);
      return json(res, 200, { challenge, rpId: this.cfg.rp_id, allowCredentials: [{ type: 'public-key', id: this.account }], userVerification: 'required', timeout: 120000 });
    }
    if (req.method === 'POST' && path === '/api/signin') {
      const body = await readJson(req);
      let challenge = null;
      try { challenge = JSON.parse(Buffer.from(body?.response?.clientDataJSON ?? '', 'base64url').toString()).challenge; } catch {}
      const exp = this.challenges.get(challenge);
      if (!exp || exp < this.now()) return json(res, 403, { ok: false, error: 'stale_challenge' });
      this.challenges.delete(challenge);
      const why = checkSignIn(body, { pinned: this.cfg.pinned, challenge, origins: this.cfg.origins, rpId: this.cfg.rp_id });
      if (why) { console.error(`web: sign-in refused: ${why}`); return json(res, 403, { ok: false, error: 'not_you' }); }
      this.#startSession(res);
      return json(res, 200, { ok: true });
    }
    if (!this.#signedIn(req)) return json(res, 401, { ok: false, error: 'sign_in' });
    if (req.method === 'GET' && path === '/api/push/key') return json(res, 200, { publicKey: this.vapid.publicKey });
    if (req.method === 'POST' && path === '/api/push/subscribe') {
      const sub = await readJson(req);
      const extra = (this.cfg.push_hosts ?? []).map((h) => new RegExp(h));
      if (!pushHostOk(sub?.endpoint, extra) || typeof sub?.keys?.p256dh !== 'string' || typeof sub?.keys?.auth !== 'string') return json(res, 400, { ok: false, error: 'bad_subscription' });
      this.subs[this.#signedIn(req)] = { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } };
      this.#savePush();
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && path === '/api/signout') {
      const m = /(?:^|;\s*)sid=([A-Za-z0-9_-]{43})/.exec(req.headers.cookie || '');
      if (m) {
        const k = sha(m[1]);
        delete this.sessions[k]; delete this.subs[k]; this.#saveSessions(); this.#savePush();
        for (const [st, sess] of this.streams) if (sess === k) { st.end(); this.streams.delete(st); }
      }
      res.setHeader('set-cookie', 'sid=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0');
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && path === '/api/password') {
      const pw = (await readJson(req))?.password;
      if (typeof pw !== 'string' || pw.length < 12 || pw.length > 200) return json(res, 400, { ok: false, error: 'bad_request', message: 'Use at least 12 characters.' });
      this.#setPassword(pw);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && path === '/api/send') {
      const body = await readJson(req);
      const text = typeof body?.text === 'string' ? body.text.trim() : '';
      if (!text || text.length > MAX_TEXT) return json(res, 400, { ok: false, error: 'bad_request', message: `1 to ${MAX_TEXT} characters` });
      const r = await this.#inbound(text);
      if (r.ok) this.#publish({ who: 'me', text, at: new Date(this.now()).toISOString(), client: String(body.client ?? '').slice(0, 40) });
      return json(res, r.ok ? 200 : 503, r.ok ? { ok: true } : { ok: false, error: 'agent_unavailable' });
    }
    if (req.method === 'GET' && path === '/api/events') {
      res.writeHead(200, { ...HEADERS, 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(': hello\n\n');
      // Catch up: everything after what this device last saw (Last-Event-ID on reconnect, ?after= on load).
      const after = Number(req.headers['last-event-id'] ?? new URL(req.url, 'http://x').searchParams.get('after') ?? 0) || 0;
      const since = after > this.seq ? 0 : after;   // the server restarted: send what it has
      for (const ev of this.recent) if (ev.seq > since) res.write(`id: ${ev.seq}\ndata: ${JSON.stringify(ev)}\n\n`);
      this.streams.set(res, this.#signedIn(req));
      const ping = setInterval(() => res.write(': ping\n\n'), 25_000).unref();
      req.on('close', () => { clearInterval(ping); this.streams.delete(res); });
      return;
    }
    return json(res, 404, { ok: false, error: 'not_found' });
  }

  /** /approve/* goes to the broker's approval page unchanged (it checks Host and Origin itself). */
  #toApproval(req, res) {
    const up = new URL(this.cfg.approval_upstream);
    const p = httpRequest({ host: up.hostname, port: up.port, method: req.method, path: req.url,
      headers: { host: req.headers.host, ...(req.headers.origin ? { origin: req.headers.origin } : {}), ...(req.headers['content-type'] ? { 'content-type': req.headers['content-type'] } : {}) } }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    p.on('error', () => json(res, 502, { ok: false, error: 'approval_unavailable' }));
    req.pipe(p);
  }

  close() { for (const s of this.streams.keys()) s.end(); this.http?.closeAllConnections?.(); this.http?.close(); this.socketServer?.close(); }
}

async function readJson(req) {
  let n = 0; const chunks = [];
  for await (const c of req) { n += c.length; if (n > 64 * 1024) return null; chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return null; }
}
function json(res, status, obj) { res.writeHead(status, { ...HEADERS, 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); }
