// The broker (contracts/broker.md): grants, the agent's identity, and every use of a credential.
// The parts around it are plugged in, so tests can use fixtures and a deployment the real ones:
//   store      CredentialStore seam: get(ref), find?({domain,username}), fetch?({domain,username}),
//              approval ('none'|'device_local'|'remote'), totp?(ref), label
//   worker     browser worker: open, act, extract, fill_login, await_login, fill_code, close; mode
//   mcp        { <server>: { credential, tools: { <tool>: { op, run(args, secret) } } } }
//   approvals  { url(grant) } -> the link the person opens; decisions come back via decide()
import { createHash, createPublicKey, randomBytes, sign } from 'node:crypto';
import { join } from 'node:path';
import { ActionsLog } from './actions-log.js';
import { BINDING_OPS, BrokerError, GrantStore, checkRequest, ulid } from './grants.js';
import { canonicalize } from './jcs.js';
import { loadOrCreateIdentity } from './identity.js';

const BROWSE = ['read', 'search'];
const kidOf = (publicKey) => createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16);
const hostMatches = (host, domain) => host === domain || host.endsWith('.' + domain);
const STORE_ERR = { not_found: 'credential_not_found', no_answer: 'store_no_answer', unavailable: 'store_unavailable' };

export class Broker {
  /**
   * stateDir: keys, grants.json and actions.jsonl live here (0700, the broker's user only).
   * operator: who runs this agent, for declarations (e.g. "agent.groundmark.fyi").
   * pendingSeconds: how long a grant may wait for the person before it expires.
   * onGrantEvent(grant_id, state, errand_id): tells the core. Channel adapters hear of code slots by asking (code.slots).
   */
  constructor({ stateDir, store, worker = null, mcp = {}, approvals, operator = 'opa.local', pendingSeconds = 1800,
    onGrantEvent = () => {}, now = Date.now }) {
    const b = loadOrCreateIdentity(stateDir, 'broker'), a = loadOrCreateIdentity(stateDir, 'agent');
    this.brokerKey = { ...b, kid: kidOf(b.publicKey) };
    this.agentKey = { ...a, kid: kidOf(a.publicKey) };
    this.log = new ActionsLog(join(stateDir, 'actions.jsonl'), b.privateKey);
    this.grants = new GrantStore(join(stateDir, 'grants.json'), { now });
    Object.assign(this, { store, worker, mcp, approvals, operator, pendingSeconds, onGrantEvent, now });
    // Until a browser worker is configured, browser calls say so plainly.
    this.worker ??= new Proxy({ mode: 'agent_browser' }, { get: (t, k) => (k in t ? t[k] : async () => { throw new BrokerError('upstream_error', 'no browser worker is configured'); }) });
    this.sessions = new Map();    // session_id -> { grant_id, url }: a session lives no longer than the grant it was opened under
    this.codeSlots = new Map();   // slot_id -> { session_id, channel, seq, resolve, timer, expires_at }
    this.slotWaiters = new Set(); // channel adapters waiting in code.slots for a slot to open
    this.slotSeq = 0;             // code.slots cursors are <bootId>.<seq>: slots opened since this broker started
    this.bootId = randomBytes(4).toString('hex');
    this.channels = new Set();    // the channel adapters this broker serves (listen() adds them)
  }

  // ---- lifecycle ----

  /** The person's decision, from the approval page (after the passkey check) or a test. */
  decide(grantId, approve, evidence = {}) {
    const g = this.grants.decide(grantId, approve);
    this.log.append({ errand_id: g.errand_id, type: approve ? 'grant.approved' : 'grant.denied', grant_id: g.grant_id,
      detail: approve ? { passkey_credential_id: evidence.passkey_credential_id ?? null, bound_hash: g.hash } : {} });
    this.onGrantEvent(g.grant_id, g.state, g.errand_id);
    return g;
  }

  /** Expires what has run out. Call it on a timer; the grant store also refuses expired grants on use. */
  async sweep() {
    for (const g of this.grants.sweep(this.pendingSeconds * 1000)) {
      this.log.append({ errand_id: g.errand_id, type: 'grant.expired', grant_id: g.grant_id, detail: { was: g.prev_state } });
      await this.#endSessions(g);
      this.onGrantEvent(g.grant_id, 'expired', g.errand_id);
    }
  }

  async #endSessions(g) {
    // A code slot waiting under this grant ends with it (and so can't be filled after a revocation).
    this.#cancelSlots((s) => s.grant_id === g.grant_id, new BrokerError(g.state === 'revoked' ? 'grant_revoked' : 'grant_expired', `${g.grant_id} is ${g.state}`));
    const ids = [...this.sessions].filter(([, s]) => s.grant_id === g.grant_id).map(([sid]) => sid);
    // ...and so does one waiting on a session this grant opened (the slot may be under another grant).
    this.#cancelSlots((s) => ids.includes(s.session_id), new BrokerError('bad_request', 'the session closed'));
    // Every session is gone from the broker before the first await, so no new slot can open on one meanwhile.
    for (const session_id of ids) this.sessions.delete(session_id);
    for (const session_id of ids) {
      try { await this.worker?.close({ grant_id: g.grant_id, session_id }); } catch {}
    }
    if (ids.length) this.log.append({ errand_id: g.errand_id, type: 'browser.closed_on_grant_end', grant_id: g.grant_id, detail: { sessions: ids.length, state: g.state } });
  }

  // ---- helpers ----

  #cancelSlots(match, err) {
    for (const [slot_id, s] of this.codeSlots) {
      if (!match(s)) continue;
      this.codeSlots.delete(slot_id);
      clearTimeout(s.timer);
      s.reject(err);
    }
  }

  #refuse(errandId, grantId, e) {
    if (e instanceof BrokerError) this.log.append({ errand_id: errandId, type: 'grant.refused', ...(grantId ? { grant_id: grantId } : {}), detail: { error: e.code, message: e.message } });
    return e;
  }

  #use(g, detail) {
    this.grants.use(g);
    this.log.append({ errand_id: g.errand_id, type: 'grant.used', grant_id: g.grant_id, detail });
  }

  /**
   * Takes a grant for one call: checks it and, if it's one-shot, reserves it, in one tick before anything is awaited,
   * so a concurrent call can't use it too. Every handler that spends a grant starts here and ends with #use or release.
   */
  #take(req, id, ops) {
    try { const g = this.grants.usable(id, ops); return { g, token: this.grants.reserve(g) }; }
    catch (e) { throw this.#refuse(req.errand_id, id, e); }
  }

  /** After any wait, just before acting (nothing awaited in between): the grant is still live, the session still open. */
  #still(req, h, ops, session_id) {
    try {
      this.grants.usable(h.g.grant_id, ops, h.token);
      if (session_id !== undefined && !this.sessions.has(session_id)) throw new BrokerError('origin_mismatch', 'the session closed');
    } catch (e) { throw this.#refuse(req.errand_id, h.g.grant_id, e); }
  }

  #storeError(e) { return e?.kind && STORE_ERR[e.kind] ? new BrokerError(STORE_ERR[e.kind], e.message) : e; }

  #mode(g) { return g.session ? 'operator_browser' : this.worker?.mode ?? 'agent_browser'; }

  async #originOf(g) {
    if (g.session) return { origin: g.session.origin };
    if (g.domain) return { host: g.domain };
    const c = await this.store.get(g.credential).catch(() => null);
    return c?.record.origin ? { origin: new URL(c.record.origin).origin } : null;
  }

  /** Who a declaration under this grant is for: the exact request's site, the grant's site, or else the server or credential. */
  async #relyingParty(g) {
    if (g.request?.url) return new URL(g.request.url).origin;
    const o = await this.#originOf(g);
    if (o) return o.origin ?? o.host;
    return g.request?.server ?? (typeof g.credential === 'string' ? g.credential : 'unknown');
  }

  async #inside(g, url) {
    const o = await this.#originOf(g);
    let u; try { u = new URL(url); } catch { throw new BrokerError('bad_request', 'url is not a URL'); }
    if (!o) throw new BrokerError('origin_mismatch', 'this grant has no recorded origin');
    const ok = o.origin ? u.origin === o.origin : hostMatches(u.hostname, o.host);
    if (!ok) throw new BrokerError('origin_mismatch', `${u.origin} is outside this grant (${o.origin ?? o.host})`);
  }

  /** A session opened through this broker, on this grant's site (it may have been opened under another grant). */
  async #session(g, session_id) {
    const s = this.sessions.get(session_id);
    if (!s) throw new BrokerError('origin_mismatch', 'no session with that id was opened through the broker');
    await this.#inside(g, s.url);
  }

  /** For the browser worker's binding click: an approved one-shot grant for a binding op, or null. */
  /** For the browser worker's binding click: the one-shot grant browser.act has taken for this call, or null. */
  usableBookGrant(id) {
    let g; try { g = this.grants.get(id); } catch { return null; }
    const live = g.state === 'approved' && Date.parse(g.expires_at) > Date.now();
    return live && g.in_flight && g.mode === 'one_shot' && g.ops.some((o) => BINDING_OPS.has(o)) ? g : null;
  }

  /** The login behind a credential-by-site grant. A fetch-only store asks the person here. */
  async #siteLogin(g) {
    let c;
    try {
      c = g.credential_ref && this.store.find ? await this.store.get(g.credential_ref)
        : await this.store.fetch({ domain: g.domain, username: g.credential.username });
    } catch (e) { throw this.#storeError(e); }
    if (!c) throw new BrokerError('credential_not_found', g.domain);
    this.grants.bind(g, c.record.ref);
    return c;
  }

  /**
   * For a binding grant on a credential that has tools (an MCP server or a relying party in web_services): the one
   * call it allows, fixed now so the person approves exactly that. `call: { server, tool }` picks one where several
   * could make the act. A relying party's tool also gives the exact HTTP request. null when no tool makes the act
   * (a booking through the browser, held by book_grant_id instead).
   */
  #exactRequest(a) {
    if (typeof a.credential !== 'string' || !a.ops.some((o) => BINDING_OPS.has(o))) return null;
    const found = [];
    for (const [server, srv] of Object.entries(this.mcp ?? {})) {
      if (srv.credential !== a.credential) continue;
      for (const [tool, t] of Object.entries(srv.tools ?? {})) {
        if (BINDING_OPS.has(t.op) && a.ops.includes(t.op) && (!a.call || (a.call.server === server && a.call.tool === tool))) found.push({ server, tool, t });
      }
    }
    if (a.call && !found.length) throw new BrokerError('bad_request', `no binding tool ${a.call.server}/${a.call.tool} for ${a.credential}`);
    if (!found.length) return null;
    if (found.length > 1) throw new BrokerError('bad_request', `several tools could do this (${found.map((f) => `${f.server}/${f.tool}`).join(', ')}): name one in call`);
    const [{ server, tool, t }] = found;
    let http = {};
    try { if (t.describe) http = t.describe(a.constraints ?? {}); } catch (e) { throw new BrokerError('bad_request', e.message); }
    return { server, tool, ...http };
  }

  // ---- operations ----

  handlers() {
    const guard = async (req, grantId, fn) => { try { return await fn(); } catch (e) { throw this.#refuse(req.errand_id, grantId, e); } };

    return {
      'grant.request': async (a, req) => {
        checkRequest(a);
        const bySite = a.credential && typeof a.credential === 'object';
        if (bySite && this.store.approval === 'device_local' && !a.operator_present) {
          throw new BrokerError('store_needs_operator', 'this store asks the person on their computer, so they must be at it (operator_present)');
        }
        let credential_ref = null, found = null;
        if (bySite && this.store.find) {
          let m;
          try { m = await this.store.find(a.credential); } catch (e) { throw this.#storeError(e); }
          if (!m.length) throw new BrokerError('credential_not_found', a.credential.domain);
          if (m.length > 1) throw new BrokerError('credential_ambiguous', `${m.length} logins for ${a.credential.domain}`, { usernames: m.map((x) => x.record.username) });
          [found] = m; credential_ref = found.ref;
        }
        const named = a.credential && !bySite ? await this.store.get(a.credential).catch(() => null) : null;
        if (a.credential && !bySite && !named) throw new BrokerError('credential_not_found', a.credential);
        // The store holding the credential decides whether the person must be at their computer.
        if (a.credential && (named?.record?.approval ?? this.store.approval) === 'device_local' && !a.operator_present) {
          throw new BrokerError('store_needs_operator', 'this store asks the person on their computer, so they must be at it (operator_present)');
        }
        const domain = bySite ? a.credential.domain.toLowerCase() : null;
        const target = bySite
          ? (found ? `your login ${found.record.username} for ${domain}` : `a login for ${domain} from your vault (your vault will ask you which)`)
          : a.credential ? (named?.record.kind === 'service' ? null : a.credential) : `your signed-in ${new URL(a.session.origin).host} session`;
        const c = a.constraints;
        const day = (d) => { const t = new Date(`${d}T12:00:00Z`); return Number.isNaN(t.getTime()) ? d : t.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }); };
        const summary = a.ops.includes('book') ? `Book ${c.venue}, ${day(c.date)} at ${c.time}, ${c.party_size} ${c.party_size === 1 ? 'person' : 'people'}${target ? `, using ${target}` : ''}.`
          : a.ops.includes('edit_order') ? `Change your standing order (${c.changes.length} change(s)) using ${target}.`
            : `Let the agent ${a.ops.map((o) => ({ read: 'look at your account', search: 'search', login: 'sign in' })[o] ?? o).join(' and ')}${target ? ` with ${target}` : ` at ${a.credential}`} for ${a.ttl_seconds >= 3600 ? Math.round(a.ttl_seconds / 3600) + ' h' : Math.round(a.ttl_seconds / 60) + ' min'}: ${a.purpose}`;
        const request = this.#exactRequest(a);
        const g = this.grants.create({
          errand_id: req.errand_id ?? null, credential: a.credential ?? null, session: a.session ?? null,
          domain, credential_ref, operator_present: !!a.operator_present, summary, request,
          ops: a.ops, constraints: a.constraints ?? null, mode: a.mode, ttl_seconds: a.ttl_seconds, purpose: a.purpose,
        });
        this.log.append({ errand_id: g.errand_id, type: 'grant.requested', grant_id: g.grant_id,
          detail: { credential: g.credential, session: g.session, ops: g.ops, constraints: g.constraints, mode: g.mode, ttl_seconds: g.ttl_seconds, purpose: g.purpose, ...(request ? { request } : {}) } });
        const approve_url = this.approvals.url(g);
        return { grant_id: g.grant_id, state: 'pending', approve_url, summary: g.summary, ...(credential_ref ? { credential_ref } : {}), ...(request ? { request } : {}) };
      },

      'grant.status': async ({ grant_id }) => {
        const g = this.grants.get(grant_id);
        return { grant_id, state: g.state, approved_at: g.approved_at, expires_at: g.expires_at, uses: g.uses, last_used_at: g.last_used_at, ...(g.request ? { request: g.request } : {}) };
      },

      'grant.revoke': async ({ grant_id, reason = '' }) => {
        const before = this.grants.get(grant_id).state;
        const g = this.grants.revoke(grant_id);
        if (g.state === 'revoked' && before !== 'revoked') {
          this.log.append({ errand_id: g.errand_id, type: 'grant.revoked', grant_id, detail: { reason } });
          await this.#endSessions(g);
        }
        return { grant_id, state: g.state };
      },

      'mcp.call': async ({ grant_id, server, tool, arguments: args = {} }, req) => {
        const srv = this.mcp[server], t = srv?.tools?.[tool];
        if (!t) throw new BrokerError('upstream_error', `no tool ${server}/${tool}`);
        let token = null;
        const g = await guard(req, grant_id, async () => {
          const g = this.grants.usable(grant_id, t.op);
          if (g.credential !== srv.credential) throw new BrokerError('op_not_granted', `grant is for ${g.credential}`);
          if (BINDING_OPS.has(t.op)) {
            if (g.mode !== 'one_shot') throw new BrokerError('one_shot_required', 'binding tool needs a one-shot grant');
            // Exactly what was approved: the same fields (notes included) with the same values, nothing added.
            let same = false;
            try { same = canonicalize(args ?? {}) === canonicalize(g.constraints ?? {}); } catch {}
            if (!same) throw new BrokerError('constraint_mismatch', 'the arguments differ from the approved grant');
            // The call the person approved: this server and tool, and for a relying party the very request (method, URL,
            // body digest), so a changed configuration can't send anything else under the approval.
            // No exact request recorded (a grant from before 0.4, or made before any tool could do this): ask again.
            const r = g.request;
            if (!r?.server) throw new BrokerError('constraint_mismatch', 'this grant was not approved for a specific call; ask for a new one');
            if (r.server !== server || r.tool !== tool) throw new BrokerError('constraint_mismatch', `the grant is for ${r.server}/${r.tool}`);
            // A tool that became a relying party (or stopped being one) since the approval is not the approved call.
            if (Boolean(r.url) !== Boolean(t.describe)) throw new BrokerError('constraint_mismatch', 'the tool changed since the approval');
            if (r.url) {
              let now = null; try { now = t.describe(args); } catch {}
              if (!now || now.method !== r.method || now.url !== r.url || now.content_digest !== r.content_digest) throw new BrokerError('constraint_mismatch', 'the request differs from the one approved');
            }
          }
          token = this.grants.reserve(g);   // same tick as usable(): a concurrent call now gets grant_consumed
          return g;
        });
        // Nothing has been sent yet: a store failure or a revocation while the store was read gives the grant back.
        let secret;
        try {
          secret = (await this.store.get(srv.credential))?.secret ?? null;
          this.#still(req, { g, token }, t.op);
        } catch (e) { this.grants.release(g, token); throw e; }
        let content;
        try { content = await t.run(args, secret); } catch (e) {
          // Refused here, before anything was sent (an argument that would replace a fixed query parameter).
          if (e.local) { this.grants.release(g, token); throw this.#refuse(req.errand_id, grant_id, new BrokerError('bad_request', e.message)); }
          // Only a definite refusal (the tool says nothing happened, e.g. HTTP 4xx) gives the grant back; anything
          // else (5xx, timeout, connection lost) might have gone through, so a one-shot grant counts as used.
          if (e.definite) this.grants.release(g, token); else if (g.mode === 'one_shot') this.grants.use(g);
          // The relying party's own explanation (never a secret: it's what the site sent back), so the agent can act on it.
          this.log.append({ errand_id: req.errand_id ?? null, type: 'grant.used', grant_id, detail: { op: t.op, server, tool, status: e.definite ? 'refused' : 'unknown', reason: String(e.message).slice(0, 200) } });
          throw new BrokerError('upstream_error', `${server}/${tool}: ${String(e.message).slice(0, 300)}`, e.upstream ? { upstream: e.upstream } : undefined);
        }
        this.#use(g, { op: t.op, server, tool, status: 'ok' });
        return { content };
      },

      // Each of these takes its grant first (#take), checks it again just before the worker acts (#still), and gives a
      // one-shot grant back if it ends without spending it (release after #use does nothing).
      'browser.open': async (a, req) => {
        const h = this.#take(req, a.grant_id, BROWSE), g = h.g;
        try {
          await guard(req, a.grant_id, () => this.#inside(g, a.url));
          const read_only = !!a.read_only || (!g.ops.includes('search') && !g.ops.includes('login'));   // read-only grant, read-only session
          this.#still(req, h, BROWSE);
          const r = await this.worker.open({ ...a, read_only, grant_id: g.grant_id });
          // Revoked or expired while the worker opened it: nothing would ever close this session, so close it now.
          try { this.#still(req, h, BROWSE); } catch (e) {
            try { await this.worker.close({ grant_id: g.grant_id, session_id: r.session_id }); } catch {}
            throw e;
          }
          this.sessions.set(r.session_id, { grant_id: g.grant_id, url: a.url });
          this.#use(g, { op: g.ops.includes('read') ? 'read' : 'search', browser: 'open', url: a.url, read_only, mode: this.#mode(g), conforming: true, status: 'ok' });
          return r;
        } finally { this.grants.release(g, h.token); }
      },

      'browser.extract': async (a, req) => {
        const h = this.#take(req, a.grant_id, BROWSE), g = h.g;
        try {
          await guard(req, a.grant_id, () => this.#session(g, a.session_id));
          this.#still(req, h, BROWSE, a.session_id);
          const r = await this.worker.extract(a);
          this.#use(g, { op: g.ops.includes('read') ? 'read' : 'search', browser: 'extract', target: a.target, mode: this.#mode(g), conforming: true, status: 'ok' });
          return r;
        } finally { this.grants.release(g, h.token); }
      },

      'browser.act': async (a, req) => {
        // A binding click: take its one-shot grant for this call before anything is awaited.
        let held = null;
        if (a.book_grant_id) {
          held = this.#take(req, a.book_grant_id);
          try {
            if (held.g.mode !== 'one_shot' || !held.g.ops.some((o) => BINDING_OPS.has(o))) throw new BrokerError('one_shot_required', 'a binding click needs a one-shot grant');
            // The worker checks the page against these (browser-worker.md), for a pay click as for a booking.
            const c = held.g.constraints ?? {};
            if (!(c.venue && c.date && c.time && Number.isInteger(c.party_size))) throw new BrokerError('constraint_mismatch', 'a binding click needs a grant with venue, date, time and party_size to check the page against');
          } catch (e) { this.grants.release(held.g, held.token); throw this.#refuse(req.errand_id, a.book_grant_id, e); }
        }
        try {
          // The browse grant isn't spent by a click, so it's only checked, not taken.
          const look = await guard(req, a.grant_id, async () => { const g = this.grants.usable(a.grant_id, BROWSE); await this.#session(g, a.session_id); return g; });
          // Approved for one site, spent on that site: the session must be on the book grant's origin too.
          if (held) await guard(req, a.book_grant_id, () => this.#session(held.g, a.session_id));
          this.#still(req, { g: look, token: null }, BROWSE, a.session_id);
          if (held) this.#still(req, held, [], a.session_id);
        } catch (e) { if (held) this.grants.release(held.g, held.token); throw e; }
        let r;
        try { r = await this.worker.act(a); } catch (e) {
          // Refused before anything was submitted: the grant goes back. Anything else may have submitted: spent.
          // (Not navigation_failed or blocked_by_site: a submit can lose its answer or be redirected after it commits.)
          const before = ['constraint_mismatch', 'target_not_found', 'session_not_found', 'read_only_session', 'origin_mismatch'].includes(e?.code);
          if (held) { if (before) this.grants.release(held.g, held.token); else this.#use(held.g, { op: 'book', browser: 'act', target: a.target, status: 'unknown', reason: String(e?.message).slice(0, 200) }); }
          if (e?.code === 'constraint_mismatch') throw this.#refuse(req.errand_id, a.book_grant_id || a.grant_id, new BrokerError('constraint_mismatch', e.message));
          throw e;
        }
        if (held && !r.binding) this.grants.release(held.g, held.token);
        if (r.binding) {
          const conf = /Confirmation (\S+)/.exec(r.page.text)?.[1];
          this.#use(r.binding, { op: r.binding.ops.find((o) => BINDING_OPS.has(o)), browser: 'act', target: a.target, mode: this.#mode(r.binding),
            conforming: true, ...(conf ? { confirmation: conf } : {}), page_title: r.page.title, status: 'ok' });
        }
        return { page: r.page };
      },

      'browser.await_login': async (a, req) => {
        const h = this.#take(req, a.grant_id, 'login'), g = h.g;
        try {
          await guard(req, a.grant_id, () => this.#session(g, a.session_id));
          this.#still(req, h, 'login', a.session_id);
          const r = await this.worker.await_login(a);
          this.#use(g, { op: 'login', login_mode: 'operator_filled', mode: this.#mode(g), conforming: true, status: 'ok' });
          return r;
        } finally { this.grants.release(g, h.token); }
      },

      'browser.fill_login': async (a, req) => {
        const h = this.#take(req, a.grant_id, 'login'), g = h.g;
        const store_approval = this.store.approval;
        try {
          // The login to fill: for a credential-by-site grant, the store's item (a fetch-only store asks the person).
          const c = await guard(req, a.grant_id, async () => {
            await this.#session(g, a.session_id);
            if (!g.domain) {
              if (a.credential !== undefined && a.credential !== g.credential) throw new BrokerError('op_not_granted', `grant is for ${g.credential}`);
              return null;
            }
            try { return await this.#siteLogin(g); } catch (e) {
              if (store_approval !== 'none') this.log.append({ errand_id: g.errand_id, type: 'grant.used', grant_id: g.grant_id,
                detail: { op: 'login', domain: g.domain, store_approval, status: e.code === 'store_no_answer' ? 'no_answer' : 'not_found' } });
              throw e;
            }
          });
          this.#still(req, h, 'login', a.session_id);
          const r = await this.worker.fill_login({ grant_id: a.grant_id, session_id: a.session_id, credential: c ? c.record.ref : g.credential });
          this.#use(g, c ? { op: 'login', domain: g.domain, credential_ref: c.record.ref, login_mode: 'broker_filled', store_approval, mode: this.#mode(g), conforming: true, status: 'ok' }
            : { op: 'login', credential: g.credential, login_mode: 'broker_filled', mode: this.#mode(g), conforming: true, status: 'ok' });
          return r;
        } finally { this.grants.release(g, h.token); }
      },

      'browser.fill_code': async (a, req) => {
        const h = this.#take(req, a.grant_id, 'login'), g = h.g;
        try {
          await guard(req, a.grant_id, () => this.#session(g, a.session_id));
          let code;
          if (a.source === 'store_totp') {
            const ref = g.credential_ref ?? g.credential;
            code = ref && this.store.totp ? await this.store.totp(ref) : null;
            if (!code) throw this.#refuse(req.errand_id, a.grant_id, new BrokerError('op_not_granted', 'this login has no TOTP in the store'));
          } else if (a.source === 'person') {
            if ([...this.codeSlots.values()].some((s) => s.session_id === a.session_id)) throw new BrokerError('bad_request', 'a code slot is already open for this session');
            // The slot is for the channel the person is talking on: only that adapter hears of it or can fill it.
            if (a.channel === undefined && this.channels.size > 1) throw new BrokerError('bad_request', 'more than one channel adapter: name the one the person is on (channel)');
            if (a.channel !== undefined && !this.channels.has(a.channel)) throw new BrokerError('bad_request', `no channel adapter ${a.channel}`);
            const channel = a.channel ?? [...this.channels][0] ?? null;
            // The session check above awaited the store: check again, with nothing awaited before the slot opens.
            this.#still(req, h, 'login', a.session_id);
            const slot_id = ulid(), ms = Math.min(a.timeout_seconds ?? 300, 900) * 1000;
            code = await new Promise((resolve, reject) => {
              const timer = setTimeout(() => { this.codeSlots.delete(slot_id); reject(new BrokerError('code_timeout', 'no code from the person')); }, ms);
              const expires_at = new Date(Date.now() + ms).toISOString();
              this.codeSlots.set(slot_id, { session_id: a.session_id, grant_id: g.grant_id, channel, seq: ++this.slotSeq, resolve, reject, timer, expires_at });
              for (const w of [...this.slotWaiters]) w();
            }).catch((e) => { throw this.#refuse(req.errand_id, a.grant_id, e); });
          } else throw new BrokerError('bad_request', 'source must be store_totp or person');
          // Waiting may have taken minutes: the grant and the session must still be live when the code is filled.
          this.#still(req, h, 'login', a.session_id);
          const r = await this.worker.fill_code({ grant_id: a.grant_id, session_id: a.session_id, code });
          this.#use(g, { op: 'login', browser: 'fill_code', source: a.source, mode: this.#mode(g), conforming: true, status: 'ok' });
          return r;
        } finally { this.grants.release(g, h.token); }
      },

      // contracts 0.4: how a channel adapter learns a slot opened. It waits here (long poll) on its own broker socket,
      // since the broker can't call the adapter. The cursor means each slot is heard of once; an unknown cursor (from
      // before a restart) lists every open slot. Only slots for the asking adapter's channel are listed.
      'code.slots': async (a = {}, req) => {
        const { wait_seconds = 50, cursor } = a;
        if (!Number.isInteger(wait_seconds) || wait_seconds < 0 || wait_seconds > 60) throw new BrokerError('bad_request', 'wait_seconds is an integer from 0 to 60');
        if (cursor !== undefined && typeof cursor !== 'string') throw new BrokerError('bad_request', 'cursor is a string');
        const [boot, n] = (cursor ?? '').split('.');
        const after = boot === this.bootId && /^\d+$/.test(n ?? '') ? Number(n) : 0;
        const channel = String(req?.caller ?? '').replace(/^channel-/, '');
        const fresh = () => [...this.codeSlots].filter(([, s]) => s.seq > after && (s.channel === channel || s.channel === null));
        for (const until = Date.now() + wait_seconds * 1000; !fresh().length && Date.now() < until;) {
          await new Promise((resolve) => {
            const done = () => { clearTimeout(t); this.slotWaiters.delete(done); resolve(); };
            const t = setTimeout(done, Math.max(until - Date.now(), 0));
            this.slotWaiters.add(done);
          });
        }
        const found = fresh();
        const last = found.reduce((m, [, s]) => Math.max(m, s.seq), after);
        return { slots: found.map(([slot_id, s]) => ({ slot_id, expires_at: s.expires_at })), cursor: `${this.bootId}.${last}` };
      },

      'code.deliver': async ({ slot_id, code }, req) => {
        if (typeof code !== 'string' || !/^[A-Za-z0-9]{4,10}$/.test(code)) throw new BrokerError('bad_request', 'a code is 4 to 10 letters and digits');
        const s = this.codeSlots.get(slot_id);
        const channel = String(req?.caller ?? '').replace(/^channel-/, '');
        if (!s || (s.channel !== null && s.channel !== channel)) throw new BrokerError('bad_request', 'no open code slot ' + slot_id);
        this.codeSlots.delete(slot_id);
        clearTimeout(s.timer);
        s.resolve(code);
        return { accepted: true };
      },

      'browser.close': async (a, req) => {
        await guard(req, a.grant_id, async () => {
          await this.#session(this.grants.get(a.grant_id), a.session_id);
        });
        this.sessions.delete(a.session_id);
        this.#cancelSlots((s) => s.session_id === a.session_id, new BrokerError('bad_request', 'the session closed'));
        return this.worker.close(a);
      },

      // The agent key signs what relying parties trust, so the broker signs only what it builds itself, under a grant:
      // requests to relying parties (web_services) and declarations (here). There is no identity.sign (contracts 0.4):
      // a compromised core could have had "the agent did X" signed for something nobody approved.
      'identity.declaration': async (a, req) => {
        if (Object.keys(a).some((k) => k !== 'grant_id' && k !== 'act')) throw new BrokerError('bad_request', 'identity.declaration takes grant_id and act; the rest comes from the grant');
        if (typeof a.act !== 'string') throw new BrokerError('bad_request', 'act is required');
        let g;
        try { g = this.grants.get(a.grant_id); } catch (e) { throw this.#refuse(req.errand_id, a.grant_id, e); }
        const relying_party = await this.#relyingParty(g);
        // The checks and the signature happen together, with nothing awaited in between, so a revocation or expiry
        // that lands while the relying party is looked up is seen here.
        try {
          // A one-shot grant spent on the act still covers declaring it, until it would have expired or is revoked.
          const spent = g.state === 'consumed' && g.mode === 'one_shot' && Date.parse(g.expires_at) > this.now();
          if (!spent) this.grants.usable(a.grant_id);
          if (!g.ops.includes(a.act)) throw new BrokerError('op_not_granted', `${a.act} not in [${g.ops}]`);
        } catch (e) { throw this.#refuse(req.errand_id, a.grant_id, e); }
        const declaration = { format: 'opa-draft-0', operator: this.operator, agent_kid: this.agentKey.kid, relying_party,
          act: a.act, grant_id: g.grant_id, constraints: g.constraints ?? null, ts: new Date(this.now()).toISOString() };
        const sig_b64 = sign(null, Buffer.from(canonicalize(declaration)), this.agentKey.privateKey).toString('base64');
        this.log.append({ errand_id: req.errand_id ?? null, type: 'identity.declaration', grant_id: g.grant_id, detail: { declaration, sig_b64, presented: false } });
        return { declaration, kid: this.agentKey.kid, sig_b64, presented: false };
      },

      'status': async () => ({ version: '0.4.0', store: (typeof this.store.label === 'function' ? this.store.label() : this.store.label) ?? 'store', agent_kid: this.agentKey.kid, broker_kid: this.brokerKey.kid }),
    };
  }

  /** Public keys for parts/history's keys.json. */
  publicKeys() {
    return { broker: this.brokerKey.publicKey.export({ type: 'spki', format: 'pem' }), agent: createPublicKey(this.agentKey.privateKey).export({ type: 'spki', format: 'pem' }) };
  }
}
