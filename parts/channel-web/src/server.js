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
//                              POST /api/here          the page is open and in view (and what it has shown), for notifications
//                              /approve/*  passed to the broker's approval page, so approvals happen in the chat
//   Socket (from the core):    channel.send            only to the paired account (recipient_not_allowed otherwise)
//   Broker socket (optional):  code.slots, code.deliver a site's one-time code typed in the chat goes to the broker,
//                                                       never to the core or the model (contracts/channel.md)
//
// The adapter keeps no conversation history (the core does): only a delivery buffer in memory, the last 100
// messages for at most 24 hours, so every signed-in device (phone and computer) gets them. Each page keeps its
// own copy on the device.
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { createConnection, createServer as createNetServer } from 'node:net';
import { join } from 'node:path';
import { checkSignIn, newChallenge } from './webauthn.js';
import { pushHostOk, sendPush, vapidKeys } from './push.js';

const PAGE = new URL('../page/', import.meta.url);
const FILES = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/app.css': ['app.css', 'text/css'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'], '/icon.svg': ['icon.svg', 'image/svg+xml'], '/sw.js': ['sw.js', 'text/javascript'] };
const HEADERS = {
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
};
const MAX_TEXT = 4000;
const SESSION_DAYS = 30;
const MAX_CHALLENGES = 1000;     // sign-in challenges waiting at once; more are refused (not evicted: one may be in use)
const CORE_TIMEOUT_MS = 15_000;
const HERE_MS = 35_000;          // a page that said "here" this recently is taken as in view
const ACK_WAIT_MS = 10_000;      // ...and gets this long to say it showed a message before a notification goes anyway
const APPROVAL_TIMEOUT_MS = 30_000;
// A site's one-time code, as the Signal adapter reads one: letters, digits, spaces (any kind) and dashes, which strip
// to 4 to 10 letters and digits with at least one digit. Narrower than contracts/channel.md (no digit needed there):
// without it, "ok thanks" sent while a code is awaited would go to the site as the code.
function asCode(text) {
  if (!/^[A-Za-z0-9\s-]+$/.test(text)) return null;
  const stripped = text.replace(/[\s-]/g, '');
  return /^[A-Za-z0-9]{4,10}$/.test(stripped) && /\d/.test(stripped) ? stripped : null;
}
// What the chat shows (on every device, and in the page's saved copy) in place of a code.
const CODE_SHOWN = {
  delivered: '(one-time code, sent to the site)',
  late: '(one-time code, not sent: the request for it had ended)',
  refused: '(one-time code, not sent)',
  unknown: "(one-time code: couldn't confirm it reached the site)",
};
const CODE_TO_CORE = {
  delivered: '[one-time code delivered]',
  late: '[one-time code not delivered: the request for it had ended]',
  refused: '[one-time code not delivered: the agent refused it]',
  unknown: "[one-time code: couldn't confirm it reached the site]",
};
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
    this.boot = randomBytes(6).toString('base64url');   // this run: event ids are <boot>.<seq>, so a page can tell a restart
    this.seq = 0;
    this.streams = new Map();        // open stream -> its session
    this.pages = new Map();          // page id -> { sess, here: time it last said it's in view (0 when away), seen: seq it has shown }
    this.timers = new Set();         // notifications waiting to see if an open page showed the message
    this.slots = [];                 // open one-time-code slots, from the broker (kept until filled, ended or expired)
    this.codeQueue = Promise.resolve();   // codes go to the broker one at a time
    this.codesInFlight = 0;
    this.brokerConns = new Set();
    this.pushFile = join(cfg.state_dir, 'push.json');
    this.subs = existsSync(this.pushFile) ? JSON.parse(readFileSync(this.pushFile, 'utf8')) : {};   // session -> push subscription
    this.vapid = vapidKeys(join(cfg.state_dir, 'vapid.json'));
    this.sessionsFile = join(cfg.state_dir, 'sessions.json');
    // sha256(token) -> { exp, how: 'passkey' | 'password' } (a bare expiry from the first version: how unknown)
    this.sessions = existsSync(this.sessionsFile) ? JSON.parse(readFileSync(this.sessionsFile, 'utf8')) : {};
    for (const [k, v] of Object.entries(this.sessions)) if (typeof v === 'number') this.sessions[k] = { exp: v, how: 'unknown' };
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

  #live(sess) { return Boolean(this.sessions[sess] && this.sessions[sess].exp > this.now()); }

  #startSession(res, how) {
    const token = randomBytes(32).toString('base64url');
    this.sessions[sha(token)] = { exp: this.now() + SESSION_DAYS * 86400_000, how };
    for (const [k, e] of Object.entries(this.sessions)) if (e.exp < this.now()) delete this.sessions[k];
    this.#saveSessions();
    res.setHeader('set-cookie', `sid=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}`);
  }

  get account() { return this.cfg.pinned.credentialId; }

  #saveSessions() { writeFileSync(this.sessionsFile + '.tmp', JSON.stringify(this.sessions), { mode: 0o600 }); renameSync(this.sessionsFile + '.tmp', this.sessionsFile); }

  /** The session (sha256 of the cookie's token) if signed in, else false. */
  #signedIn(req) {
    const m = /(?:^|;\s*)sid=([A-Za-z0-9_-]{43})/.exec(req.headers.cookie || '');
    if (!m) return false;
    const k = sha(m[1]);
    return this.#live(k) ? k : false;
  }

  /** Ends sessions: their cookies stop working, their notifications stop, their open pages close. */
  #endSessions(keys) {
    for (const k of keys) { delete this.sessions[k]; delete this.subs[k]; }
    for (const [st, sess] of this.streams) if (keys.includes(sess)) { st.end(); this.streams.delete(st); }
    for (const [id, pg] of this.pages) if (keys.includes(pg.sess)) this.pages.delete(id);
    this.#saveSessions(); this.#savePush();
  }

  #savePush() { writeFileSync(this.pushFile + '.tmp', JSON.stringify(this.subs), { mode: 0o600 }); renameSync(this.pushFile + '.tmp', this.pushFile); }

  /**
   * A notification to each device that has turned them on, unless it has the chat in view and shows the message.
   * A device with a page in view gets ACK_WAIT_MS to say it showed it (a stream can be half-open after a phone
   * locks); if it doesn't, the notification goes anyway.
   */
  #notify(ev) {
    const ask = /\n*Approve: \S+\s*$/.exec(ev.text);
    const body = (ask ? ev.text.slice(0, ask.index).split('\n\n').pop() : ev.text).trim().slice(0, 160) || 'Your agent needs you.';
    const msg = { title: ask ? 'Your agent needs your OK' : 'Your agent', body, url: '/' };
    const now = this.now();
    for (const sess of Object.keys(this.subs)) {
      if (!this.#live(sess)) continue;
      const inView = [...this.pages.values()].some((p) => p.sess === sess && now - p.here < HERE_MS);
      if (!inView) { this.#push(sess, msg); continue; }
      const t = setTimeout(() => {
        this.timers.delete(t);
        const shown = [...this.pages.values()].some((p) => p.sess === sess && p.seen >= ev.seq);
        if (!shown && this.#live(sess) && this.subs[sess]) this.#push(sess, msg);
      }, this.cfg.ack_wait_ms ?? ACK_WAIT_MS);
      t.unref?.();
      this.timers.add(t);
    }
  }

  #push(sess, msg) {
    sendPush(this.subs[sess], msg, this.vapid, this.cfg.push_subject ?? this.cfg.origins[0], { fetchImpl: this.cfg.push_fetch })
      .then((status) => { if (status === 404 || status === 410) { delete this.subs[sess]; this.#savePush(); } })
      .catch((e) => console.error(`web: push failed: ${e.message}`));
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
    ev.id = `${this.boot}.${ev.seq}`;
    this.recent.push(ev);
    this.#prune();
    for (const [s, sess] of this.streams) {
      // A page whose session was signed out or ran out stops getting messages.
      if (!this.#live(sess)) { s.end(); this.streams.delete(s); continue; }
      s.write(`id: ${ev.id}\ndata: ${JSON.stringify(ev)}\n\n`);
    }
    if (ev.who === 'them') this.#notify(ev);
  }

  #prune() {
    const cutoff = new Date(this.now() - 24 * 3600_000).toISOString();
    while (this.recent.length > 100 || (this.recent.length && this.recent[0].at < cutoff)) this.recent.shift();
  }

  /** Listens for the core on `path` (or an fd from systemd). */
  async listenSocket(where) {
    if (!where) throw new Error('web: no socket for the core: set "socket" in the config, or run under systemd');
    if (typeof where === 'string') await clearStaleSocket(where);
    const srv = createNetServer((c) => {
      let buf = '', done = false;
      c.setEncoding('utf8');
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
    return ask(this.cfg.core_socket, { op: 'channel.inbound', id: ulid(), caller: `channel-${this.cfg.name}`, errand_id: null, ts: args.received_at, args }, this.cfg.core_timeout_ms ?? CORE_TIMEOUT_MS)
      .then((r) => (r.transport ? { ok: false, error: 'core_unavailable' } : r));
  }

  #broker(op, args, timeoutMs) {
    return ask(this.cfg.broker_socket, { op, id: ulid(), caller: `channel-${this.cfg.name}`, errand_id: null, ts: new Date(this.now()).toISOString(), args }, timeoutMs, this.brokerConns);
  }

  /**
   * Waits on the broker for one-time-code slots for as long as the adapter runs (a long poll that passes back the
   * cursor, so each slot is heard of once), when the config gives a broker socket.
   */
  async watchSlots() {
    let cursor;
    while (!this.stopped && this.cfg.broker_socket) {
      const started = Date.now();
      const r = await this.#broker('code.slots', { wait_seconds: 50, ...(cursor ? { cursor } : {}) }, 65_000);
      if (this.stopped) return;
      if (!r.ok) { if (r.error === 'unknown_op') return; await sleep(5000); continue; }
      cursor = r.result.cursor;
      const now = new Date(this.now()).toISOString(), known = new Set(this.slots.map((x) => x.slot_id));
      const fresh = r.result.slots.filter((x) => !known.has(x.slot_id));
      this.slots = [...this.slots, ...fresh].filter((x) => x.expires_at > now);
      if (!fresh.length && Date.now() - started < 1000) await sleep(1000);   // a broker that answers at once: not a tight loop
    }
  }

  /**
   * If `text` is only a code while a slot is open (or another code is on its way to the broker), it goes to the
   * broker, never on as text: returns how that went, else null. A slot stays until the broker says it's filled or
   * ended, or it expires: if the broker couldn't be reached, the next try goes to the same slot.
   */
  #maybeCode(text) {
    const stripped = asCode(text);
    if (!stripped) return null;
    const open = () => { const now = new Date(this.now()).toISOString(); this.slots = this.slots.filter((x) => x.expires_at > now); return this.slots[0]; };
    if (!open() && !this.codesInFlight) return null;
    this.codesInFlight += 1;
    const run = this.codeQueue.then(async () => {
      const slot = open();
      if (!slot) return 'late';   // the one it was meant for was filled or ended while this waited
      const r = await this.#broker('code.deliver', { slot_id: slot.slot_id, code: stripped }, 15_000);
      if (r.transport) return 'unknown';
      // Only an answer that says the slot is done removes it: filled, or (the format was checked above, so
      // bad_request means it's gone) ended. Any other refusal leaves it for the next try, until it expires.
      if (r.ok || r.error === 'bad_request' || r.error === 'code_timeout') this.slots = this.slots.filter((x) => x !== slot);
      if (r.ok) return 'delivered';
      if (r.error === 'bad_request' || r.error === 'code_timeout') return 'late';
      console.error(`web: code.deliver refused: ${r.error}`);
      return 'refused';
    }).finally(() => { this.codesInFlight -= 1; });
    this.codeQueue = run.catch(() => {});
    return run;
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
    if (req.method === 'GET' && path === '/api/me') { const sess = this.#signedIn(req); return json(res, 200, { signed_in: Boolean(sess), how: sess ? this.sessions[sess].how : null, has_password: this.hasPassword, password_signin: this.passwordOn, push: Boolean(sess && this.subs[sess]) }); }
    if (req.method === 'POST' && (path === '/api/signin/password' || path === '/api/password') && !this.passwordOn) {
      return json(res, 404, { ok: false, error: 'password_signin_off', message: 'Signing in with a password is turned off here. Use your passkey.' });
    }
    if (req.method === 'POST' && path === '/api/signin/password') {
      const why = this.#passwordOk((await readJson(req))?.password);
      if (why === 'locked') return json(res, 429, { ok: false, error: 'locked', message: 'Too many wrong passwords. Try again in 15 minutes.' });
      if (why) return json(res, 403, { ok: false, error: 'wrong_password', message: 'That password is not right.' });
      this.#startSession(res, 'password');
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && path === '/api/signin/options') {
      const challenge = newChallenge(), now = this.now();
      for (const [c, exp] of this.challenges) if (exp < now) this.challenges.delete(c);
      if (this.challenges.size >= MAX_CHALLENGES) return json(res, 429, { ok: false, error: 'busy', message: 'Too many sign-ins at once. Try again in a few minutes.' });
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
      this.#startSession(res, 'passkey');
      return json(res, 200, { ok: true });
    }
    if (!this.#signedIn(req)) return json(res, 401, { ok: false, error: 'sign_in' });
    if (req.method === 'GET' && path === '/api/push/key') return json(res, 200, { publicKey: this.vapid.publicKey });
    if (req.method === 'POST' && path === '/api/push/subscribe') {
      const sub = await readJson(req);
      if (!this.#signedIn(req)) return json(res, 401, { ok: false, error: 'sign_in' });   // signed out while the body came in
      const extra = (this.cfg.push_hosts ?? []).map((h) => new RegExp(h));
      if (!pushHostOk(sub?.endpoint, extra) || typeof sub?.keys?.p256dh !== 'string' || typeof sub?.keys?.auth !== 'string') return json(res, 400, { ok: false, error: 'bad_subscription' });
      this.subs[this.#signedIn(req)] = { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } };
      this.#savePush();
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && path === '/api/signout') {
      const m = /(?:^|;\s*)sid=([A-Za-z0-9_-]{43})/.exec(req.headers.cookie || '');
      if (m) this.#endSessions([sha(m[1])]);
      res.setHeader('set-cookie', 'sid=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0');
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && path === '/api/password') {
      // Only the passkey can change the password, and a change signs out everyone else: someone who got in with
      // the old password (or guessed it) is out, and can't change it themselves.
      const pw = (await readJson(req))?.password;
      const me = this.#signedIn(req);   // checked after the body: a session ended meanwhile can't change it
      if (!me) return json(res, 401, { ok: false, error: 'sign_in' });
      if (this.sessions[me].how !== 'passkey') return json(res, 403, { ok: false, error: 'passkey_needed', message: 'Sign in with your passkey to change the password.' });
      if (typeof pw !== 'string' || pw.length < 12 || pw.length > 200) return json(res, 400, { ok: false, error: 'bad_request', message: 'Use at least 12 characters.' });
      this.#setPassword(pw);
      this.#endSessions(Object.keys(this.sessions).filter((k) => k !== me));
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && path === '/api/here') {
      const b = await readJson(req);
      if (!this.#signedIn(req)) return json(res, 401, { ok: false, error: 'sign_in' });
      const page = typeof b?.page === 'string' ? b.page.slice(0, 40) : '';
      if (!page) return json(res, 400, { ok: false, error: 'bad_request' });
      const pg = this.pages.get(page) ?? { sess: this.#signedIn(req), here: 0, seen: 0 };
      pg.sess = this.#signedIn(req);
      if (b.away) pg.here = 0; else pg.here = this.now();
      const [boot, seq] = String(b.cursor ?? '').split('.');
      if (boot === this.boot && Number(seq) > pg.seen) pg.seen = Number(seq);   // seqs compare only within this run
      this.pages.set(page, pg);
      if (this.pages.size > 200) this.pages.delete(this.pages.keys().next().value);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && path === '/api/send') {
      const body = await readJson(req);
      if (!this.#signedIn(req)) return json(res, 401, { ok: false, error: 'sign_in' });
      const text = typeof body?.text === 'string' ? body.text.trim() : '';
      if (!text || text.length > MAX_TEXT) return json(res, 400, { ok: false, error: 'bad_request', message: `1 to ${MAX_TEXT} characters` });
      const client = String(body.client ?? '').slice(0, 40);
      const code = await this.#maybeCode(text);
      if (code) {
        // The code never goes further than the broker: the core, the other devices and this page's saved copy get a
        // placeholder. How the code went is answered whatever the core does, so the page doesn't send it again.
        this.#publish({ who: 'me', text: CODE_SHOWN[code], at: new Date(this.now()).toISOString(), client });
        const r = await this.#inbound(CODE_TO_CORE[code]);
        return json(res, 200, { ok: true, display: CODE_SHOWN[code], code, ...(r.ok ? {} : { agent: 'unavailable' }) });
      }
      const r = await this.#inbound(text);
      if (r.ok) this.#publish({ who: 'me', text, at: new Date(this.now()).toISOString(), client });
      return json(res, r.ok ? 200 : 503, r.ok ? { ok: true, display: text } : { ok: false, error: 'agent_unavailable' });
    }
    if (req.method === 'GET' && path === '/api/events') {
      res.writeHead(200, { ...HEADERS, 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(': hello\n\n');
      // Catch up: everything after what this device last saw (Last-Event-ID on reconnect, ?after= on load). A cursor
      // from another run (the server restarted) or none: everything it has. The page drops what it already shows.
      const after = String(req.headers['last-event-id'] ?? new URL(req.url, 'http://x').searchParams.get('after') ?? '');
      const [boot, n] = after.split('.');
      const since = boot === this.boot && Number.isInteger(Number(n)) ? Number(n) : 0;
      this.#prune();
      for (const ev of this.recent) if (ev.seq > since) res.write(`id: ${ev.id}\ndata: ${JSON.stringify(ev)}\n\n`);
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
    let failed = false;
    // Whatever breaks (the broker restarting mid-answer, the person closing the page), only this request ends.
    const fail = () => {
      if (failed) return;
      failed = true;
      p.destroy();
      if (!res.headersSent && !res.destroyed) json(res, 502, { ok: false, error: 'approval_unavailable' });
      else res.destroy();
    };
    const p = httpRequest({ host: up.hostname, port: up.port, method: req.method, path: req.url, timeout: APPROVAL_TIMEOUT_MS,
      headers: { host: req.headers.host, ...(req.headers.origin ? { origin: req.headers.origin } : {}), ...(req.headers['content-type'] ? { 'content-type': req.headers['content-type'] } : {}) } }, (r) => {
      r.on('error', fail);
      r.on('aborted', fail);
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    p.on('error', fail);
    p.on('timeout', fail);
    req.on('error', fail);
    res.on('close', () => { if (!res.writableFinished) fail(); });
    req.pipe(p);
  }

  close() {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    for (const c of this.brokerConns) c.destroy();
    for (const s of this.streams.keys()) s.end();
    this.http?.closeAllConnections?.(); this.http?.close(); this.socketServer?.close();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms).unref?.());

/** One request on a Unix socket, answered or not within timeoutMs. A failure to connect or answer is { transport: true }. */
function ask(socket, req, timeoutMs, track) {
  return new Promise((resolve) => {
    const c = createConnection(socket, () => c.write(JSON.stringify(req) + '\n'));
    track?.add(c);
    let b = '', done = false;
    const end = (r) => { if (done) return; done = true; track?.delete(c); c.destroy(); resolve(r); };
    c.setEncoding('utf8');
    c.setTimeout(timeoutMs, () => end({ ok: false, error: 'timeout', transport: true }));
    c.on('data', (d) => { b += d; });
    c.on('end', () => { try { end(JSON.parse(b)); } catch { end({ ok: false, error: 'bad_answer', transport: true }); } });
    c.on('error', () => end({ ok: false, error: 'unreachable', transport: true }));
    c.on('close', () => end({ ok: false, error: 'closed', transport: true }));
  });
}

/** A socket file left by an adapter that died: removed. One still answering (another adapter running) is an error. */
async function clearStaleSocket(path) {
  let st;
  try { st = lstatSync(path); } catch { return; }
  if (!st.isSocket()) throw new Error(`web: ${path} exists and is not a socket`);
  const live = await new Promise((resolve, reject) => {
    const c = createConnection(path, () => { c.destroy(); resolve(true); });
    c.on('error', (e) => (e.code === 'ECONNREFUSED' ? resolve(false) : reject(new Error(`web: can't check ${path}: ${e.code}`))));
  });
  if (live) throw new Error(`web: ${path} is in use: is another web channel running?`);
  unlinkSync(path);
}

async function readJson(req) {
  let n = 0; const chunks = [];
  for await (const c of req) { n += c.length; if (n > 64 * 1024) return null; chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return null; }
}
function json(res, status, obj) { res.writeHead(status, { ...HEADERS, 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); }
