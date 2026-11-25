// Broker fixture (contracts/broker.md). Real grant rules, a fixture store, throwaway
// keys, and approvals that happen automatically (standing in for the person's passkey).
// It fronts a fake reservations MCP server and the browser-worker fixture.
import crypto from 'node:crypto';
import { ContractError, ulid, nowIso, canonical, serve } from '../lib/wire.js';
import { Log, newKeyPair, signB64 } from '../lib/log.js';
import { Secret } from '../store/fixture-store.js';
import { BrowserWorker } from '../browser-worker/worker.js';
import { StoreError, hostMatches } from '../store/fixture-store.js';

const MAX_TTL = { standing: 7 * 24 * 3600, one_shot: 3600 };
const BINDING_OPS = new Set(['book', 'edit_order', 'pay']);
const BROWSE_OPS = ['read', 'search'];

/** Tests: set `next` to 'unknown' or 'refused' and the next fake MCP tool call fails that way (definite or not). */
export const MCP_FAULT = { next: null };
const fault = () => {
  const f = MCP_FAULT.next; MCP_FAULT.next = null;
  if (f) throw Object.assign(new Error(f === 'refused' ? 'the service refused (HTTP 409)' : 'no answer from the service (timeout)'), { definite: f === 'refused' });
};

/** A fake reservations MCP server: tools and the op each maps to. */
export const FAKE_MCP = {
  'fake-reservations': {
    credential: 'fake-mcp',
    tools: {
      search_restaurants: {
        op: 'search',
        run: ({ term = '' }) => ({ results: ['Harbour Grill', 'Casa Verde', 'Noodle House'].filter((n) => n.toLowerCase().includes(term.toLowerCase())) }),
      },
      book_table: {
        op: 'book',
        run: (a) => { fault(); return { confirmation: 'FM-' + crypto.randomBytes(3).toString('hex').toUpperCase(), ...a }; },
      },
    },
  },
};

export class BrokerFixture {
  /**
   * opts.store: CredentialStore. opts.logPath: actions.jsonl path.
   * opts.autoApprove: true (default) approves every grant after approveDelayMs.
   * opts.onGrantEvent(grant_id, state): how the core hears about approvals.
   */
  constructor({ store, logPath, autoApprove = true, approveDelayMs = 20, onGrantEvent = () => {}, browserMode = 'agent_browser' }) {
    this.store = store;
    this.brokerKey = newKeyPair();
    this.agentKey = newKeyPair();
    this.log = new Log(logPath, this.brokerKey);
    this.autoApprove = autoApprove;
    this.approveDelayMs = approveDelayMs;
    this.onGrantEvent = onGrantEvent;
    this.grants = new Map();
    this.codeSlots = new Map(); // slot_id -> { session_id, channel, seq, resolve, timer, expires_at }
    this.slotSeq = 0;           // code.slots cursors count slots opened since this broker started
    this.bootId = crypto.randomBytes(4).toString('hex');
    this.channels = new Set();  // channel adapters this broker serves (from listen())
    this.worker = new BrowserWorker({ store, mode: browserMode, getBookGrant: (id) => this.#usableBookGrant(id) });
  }

  // ---- grants ----

  #grant(id) {
    const g = this.grants.get(id);
    if (!g) throw new ContractError('grant_not_found', id);
    if (g.state === 'approved' && g.expires_at && Date.parse(g.expires_at) < Date.now()) {
      g.state = 'expired';
      this.log.append({ errand_id: g.errand_id, type: 'grant.expired', grant_id: g.grant_id });
      this.#endSessions(g);
    }
    return g;
  }

  /** A session lives no longer than its grant, and neither does a code slot waiting under it. */
  #endSessions(g) {
    this.#cancelSlots((s) => s.grant_id === g.grant_id, new ContractError(g.state === 'revoked' ? 'grant_revoked' : 'grant_expired', `${g.grant_id} is ${g.state}`));
    // ...and one waiting on a session this grant opened, though the slot is under another grant.
    const ids = [...this.worker.sessions].filter(([, s]) => s.grantId === g.grant_id).map(([id]) => id);
    this.#cancelSlots((s) => ids.includes(s.session_id), new ContractError('bad_request', 'the session closed'));
    const n = this.worker.closeForGrant(g.grant_id);
    if (n) this.log.append({ errand_id: g.errand_id, type: 'browser.closed_on_grant_end', grant_id: g.grant_id, detail: { sessions: n, state: g.state } });
  }

  #cancelSlots(match, err) {
    for (const [slot_id, s] of this.codeSlots) {
      if (!match(s)) continue;
      this.codeSlots.delete(slot_id);
      clearTimeout(s.timer);
      s.reject(err);
    }
  }

  /** ops: one op, or a list of which any one will do. */
  #requireUsable(id, ops) {
    const g = this.#grant(id);
    const bad = { pending: 'grant_not_approved', denied: 'grant_denied', expired: 'grant_expired', revoked: 'grant_revoked', consumed: 'grant_consumed' }[g.state];
    if (bad) throw new ContractError(bad, `${id} is ${g.state}`);
    if (g.in_flight) throw new ContractError('grant_consumed', `${id} is being used right now`);
    const want = ops ? [].concat(ops) : [];
    if (want.length && !want.some((o) => g.ops.includes(o))) throw new ContractError('op_not_granted', `${want.join('|')} not in [${g.ops}]`);
    return g;
  }

  /** Store failures, mapped to the broker's errors (contracts/broker.md, Store seam). */
  #storeError(e) {
    if (!(e instanceof StoreError)) return e;
    return new ContractError({ not_found: 'credential_not_found', no_answer: 'store_no_answer', unavailable: 'store_unavailable' }[e.kind], e.message);
  }

  /** The login behind a credential-by-site grant. Fetch-only stores ask the person here; the grant binds to the first item. */
  async #siteLogin(g) {
    let c;
    if (g.credential_ref && this.store.find) c = await this.store.get(g.credential_ref);
    else {
      try { c = await this.store.fetch({ domain: g.domain, username: g.credential.username }); } catch (e) { throw this.#storeError(e); }
    }
    if (!c) throw new ContractError('credential_not_found', g.domain);
    if (g.credential_ref && c.record.ref !== g.credential_ref) throw new ContractError('constraint_mismatch', 'the store returned a different login than this grant is bound to');
    g.credential_ref = c.record.ref;
    return c;
  }

  /** The origin a grant's browser sessions are held to. */
  async #origin(g) {
    if (g.session) return new URL(g.session.origin).origin;
    if (g.domain) return { host: g.domain };
    const c = await this.store.get(g.credential);
    return c?.record.origin ? new URL(c.record.origin).origin : null;
  }

  #mode(g) { return g.session ? 'operator_browser' : this.worker.mode; }

  /** Who a declaration under this grant is for: the site the grant is held to, or else the server or credential. */
  async #relyingParty(g) {
    const o = await this.#origin(g);
    if (o) return typeof o === 'string' ? o : o.host;
    return g.request?.server ?? (typeof g.credential === 'string' ? g.credential : 'unknown');
  }

  #usableBookGrant(id) {
    try { return this.#requireUsable(id, 'book'); } catch { return null; }
  }

  #refuse(errandId, grantId, e) {
    this.log.append({ errand_id: errandId, type: 'grant.refused', grant_id: grantId, detail: { error: e.code, message: e.message } });
    return e;
  }

  #consume(g, detail) {
    delete g.in_flight;
    g.uses += 1;
    g.last_used_at = nowIso();
    if (g.mode === 'one_shot' && g.state === 'approved') g.state = 'consumed';   // revoked meanwhile stays revoked
    this.log.append({ errand_id: g.errand_id, type: 'grant.used', grant_id: g.grant_id, detail });
  }

  /** What the passkey signs: everything the approval page shows. */
  #hash(g) {
    return crypto.createHash('sha256').update(canonical({
      grant_id: g.grant_id, credential: g.credential, session: g.session, credential_ref: g.credential_ref, operator_present: g.operator_present,
      ops: g.ops, constraints: g.constraints ?? null, mode: g.mode, ttl_seconds: g.ttl_seconds, purpose: g.purpose, summary: g.summary, request: g.request,
    })).digest('hex');
  }

  /** Stand-in for the person approving on the passkey page. The approval is bound to the hash shown when it was asked for. */
  approve(grantId, approve = true) {
    const g = this.#grant(grantId);
    if (g.state !== 'pending') return;
    if (approve && this.#hash(g) !== g.hash) throw new ContractError('constraint_mismatch', 'the grant changed after it was shown to the person');
    g.state = approve ? 'approved' : 'denied';
    g.approved_at = approve ? nowIso() : null;
    g.expires_at = approve ? new Date(Date.now() + g.ttl_seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') : null;
    this.log.append({
      errand_id: g.errand_id, type: approve ? 'grant.approved' : 'grant.denied', grant_id: g.grant_id,
      detail: approve ? { passkey_credential_id: 'fixture-passkey', bound_hash: g.hash } : {},
    });
    this.onGrantEvent(g.grant_id, g.state);
  }

  handlers() {
    return {
      'grant.request': async (a, req) => {
        if (!!a.credential === !!a.session) throw new ContractError('bad_request', 'exactly one of credential or session');
        const bySite = a.credential && typeof a.credential === 'object';
        if (a.credential && this.store.approval === 'device_local' && !a.operator_present) {
          throw new ContractError('store_needs_operator', 'this store asks the person on their computer; they must be at it (operator_present)');
        }
        let credential_ref = null, found = null;
        if (bySite && this.store.find) {
          const m = await this.store.find(a.credential);
          if (!m.length) throw new ContractError('credential_not_found', a.credential.domain);
          if (m.length > 1) {
            const e = new ContractError('credential_ambiguous', `${m.length} logins for ${a.credential.domain}: ${m.map((x) => x.record.username).join(', ')}`);
            e.detail = { usernames: m.map((x) => x.record.username) };
            throw e;
          }
          [found] = m; credential_ref = found.ref;
        }
        if (a.credential && !bySite && !(await this.store.get(a.credential))) throw new ContractError('credential_not_found', a.credential);
        if (a.session) {
          try { new URL(a.session.origin); } catch { throw new ContractError('bad_request', 'session.origin is not a URL'); }
          if (a.session.browser !== 'operator') throw new ContractError('bad_request', 'session.browser must be "operator"');
        }
        if (a.ops.some((o) => BINDING_OPS.has(o)) && a.mode !== 'one_shot') throw new ContractError('one_shot_required', 'binding ops need a one-shot grant');
        if (a.ttl_seconds > MAX_TTL[a.mode]) throw new ContractError('bad_request', `ttl over ${MAX_TTL[a.mode]}s for ${a.mode}`);
        if (a.ops.includes('book')) {
          const c = a.constraints || {};
          if (!c.venue || !c.date || !c.time || !c.party_size) throw new ContractError('bad_request', 'book needs venue, date, time, party_size');
        }
        if (a.ops.includes('edit_order') && !(a.constraints?.changes?.length)) throw new ContractError('bad_request', 'edit_order needs constraints.changes');
        // 0.4: a binding grant on a credential with tools is for exactly one call, fixed now and approved.
        let request = null;
        if (typeof a.credential === 'string' && a.ops.some((o) => BINDING_OPS.has(o))) {
          const found = Object.entries(FAKE_MCP).filter(([, srv]) => srv.credential === a.credential)
            .flatMap(([server, srv]) => Object.entries(srv.tools).filter(([tool, t]) => BINDING_OPS.has(t.op) && a.ops.includes(t.op)
              && (!a.call || (a.call.server === server && a.call.tool === tool))).map(([tool]) => ({ server, tool })));
          if (a.call && !found.length) throw new ContractError('bad_request', `no binding tool ${a.call.server}/${a.call.tool}`);
          if (found.length > 1) throw new ContractError('bad_request', 'several tools could do this: name one in call');
          request = found[0] ?? null;
        }
        const grant_id = ulid();
        const target = bySite
          ? (found ? `your login ${found.record.username} for ${a.credential.domain}` : `a login for ${a.credential.domain} from your vault (your vault will ask you which)`)
          : a.credential ?? `your signed-in ${new URL(a.session.origin).host} session`;
        // The approval page (here, its summary) shows every constraint and the call, as well as the familiar fields.
        const every = Object.entries(a.constraints ?? {}).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join('; ');
        const summary = (a.ops.includes('book')
          ? `Book ${a.constraints.venue}, ${a.constraints.date} at ${a.constraints.time}, ${a.constraints.party_size} people, using ${target}.`
          : `Let the agent ${a.ops.join(' and ')} with ${target} for ${Math.round(a.ttl_seconds / 3600)} h: ${a.purpose}`)
          + (request ? ` Calls ${request.server}/${request.tool}.` : '') + (every ? ` Everything it may send: ${every}.` : '');
        const g = {
          grant_id, errand_id: req.errand_id, credential: a.credential ?? null, session: a.session ?? null,
          domain: bySite ? a.credential.domain : null, credential_ref, operator_present: !!a.operator_present, ops: a.ops, constraints: a.constraints, mode: a.mode,
          ttl_seconds: a.ttl_seconds, purpose: a.purpose, state: 'pending', uses: 0, approved_at: null, expires_at: null, last_used_at: null, request,
        };
        g.summary = summary;
        g.hash = this.#hash(g);
        this.grants.set(grant_id, g);
        this.log.append({ errand_id: req.errand_id, type: 'grant.requested', grant_id, detail: { credential: g.credential, session: g.session, ops: a.ops, constraints: a.constraints, mode: a.mode, purpose: a.purpose } });
        if (this.autoApprove) setTimeout(() => this.approve(grant_id), this.approveDelayMs);
        return { grant_id, state: 'pending', approve_url: `http://127.0.0.1/approve/${grant_id}`, summary, ...(credential_ref ? { credential_ref } : {}), ...(request ? { request } : {}) };
      },

      'grant.status': async ({ grant_id }) => {
        const g = this.#grant(grant_id);
        return { grant_id, state: g.state, approved_at: g.approved_at, expires_at: g.expires_at, uses: g.uses, last_used_at: g.last_used_at, ...(g.request ? { request: g.request } : {}) };
      },

      'grant.revoke': async ({ grant_id, reason }) => {
        const g = this.#grant(grant_id);
        g.state = 'revoked';
        this.log.append({ errand_id: g.errand_id, type: 'grant.revoked', grant_id, detail: { reason } });
        this.#endSessions(g);
        return { grant_id, state: 'revoked' };
      },

      'mcp.call': async ({ grant_id, server, tool, arguments: args }, req) => {
        const srv = FAKE_MCP[server];
        const t = srv?.tools[tool];
        if (!t) throw new ContractError('upstream_error', `no tool ${server}/${tool}`);
        let g;
        try {
          g = this.#requireUsable(grant_id, t.op);
          if (g.credential !== srv.credential) throw new ContractError('op_not_granted', `grant is for ${g.credential}`);
          if (BINDING_OPS.has(t.op)) {
            // 0.4: exactly the approved call: this server and tool, and the same arguments (every field, nothing added).
            if (!g.request || g.request.server !== server || g.request.tool !== tool) throw new ContractError('constraint_mismatch', 'not the call that was approved');
            if (canonical(args ?? {}) !== canonical(g.constraints ?? {})) throw new ContractError('constraint_mismatch', 'arguments differ from the approved grant');
          }
          if (g.mode === 'one_shot') g.in_flight = true;   // taken before anything is awaited: a concurrent call gets grant_consumed
        } catch (e) { throw this.#refuse(req.errand_id, grant_id, e); }
        try { await this.store.get(srv.credential); } catch (e) { delete g.in_flight; throw e; }   // the token is used here and goes no further
        let content;
        try { content = t.run(args); } catch (e) {
          // An unknown outcome (timeout, lost connection, 5xx) might have gone through: a one-shot grant counts as used,
          // and the core tells the person instead of retrying. Only a definite refusal gives the grant back.
          if (!e.definite && g.mode === 'one_shot') this.#consume(g, { op: t.op, server, tool, status: 'unknown', reason: e.message });
          else {
            delete g.in_flight;   // nothing happened: the grant is free again
            this.log.append({ errand_id: g.errand_id, type: 'grant.used', grant_id: g.grant_id, detail: { op: t.op, server, tool, status: e.definite ? 'refused' : 'unknown', reason: e.message } });
          }
          throw new ContractError('upstream_error', `${server}/${tool}: ${e.message}`);
        }
        this.#consume(g, { op: t.op, server, tool, args, status: 'ok' });
        return { content };
      },

      'browser.open': async (a, req) => {
        let g, read_only = !!a.read_only;
        try {
          g = this.#requireUsable(a.grant_id, BROWSE_OPS);
          const origin = await this.#origin(g);
          const u = new URL(a.url);
          const inside = !origin || (typeof origin === 'string' ? u.origin === origin : hostMatches(u.hostname, origin.host));
          if (!inside) throw new ContractError('origin_mismatch', `${u.origin} is outside this grant (${origin.host ?? origin})`);
          // A grant that only allows reading opens read-only sessions, whatever the caller asked.
          if (!g.ops.includes('search') && !g.ops.includes('login')) read_only = true;
        } catch (e) { throw this.#refuse(req.errand_id, a.grant_id, e); }
        const r = await this.worker.open({ ...a, read_only, grant_id: g.grant_id });
        const op = g.ops.includes('read') ? 'read' : 'search';
        this.#consume(g, { op, browser: 'open', url: a.url, read_only, mode: this.#mode(g), conforming: true, status: 'ok' });
        return r;
      },

      'browser.extract': async (a, req) => {
        let g;
        try { g = this.#requireUsable(a.grant_id, BROWSE_OPS); } catch (e) { throw this.#refuse(req.errand_id, a.grant_id, e); }
        const r = await this.worker.extract(a);
        this.#consume(g, { op: g.ops.includes('read') ? 'read' : 'search', browser: 'extract', target: a.target, mode: this.#mode(g), conforming: true, status: 'ok' });
        return r;
      },

      'browser.await_login': async (a, req) => {
        let g;
        try { g = this.#requireUsable(a.grant_id, 'login'); } catch (e) { throw this.#refuse(req.errand_id, a.grant_id, e); }
        const r = await this.worker.await_login(a);
        this.#consume(g, { op: 'login', login_mode: 'operator_filled', mode: this.#mode(g), conforming: true, status: 'ok' });
        return r;
      },

      'browser.act': async (a, req) => {
        try { this.#requireUsable(a.grant_id, BROWSE_OPS); } catch (e) { throw this.#refuse(req.errand_id, a.grant_id, e); }
        let r;
        try { r = await this.worker.act(a); } catch (e) {
          if (e instanceof ContractError && e.code === 'constraint_mismatch') throw this.#refuse(req.errand_id, a.book_grant_id || a.grant_id, e);
          throw e;
        }
        if (r.binding) {
          const conf = /Confirmation (\S+)/.exec(r.page.text)?.[1];
          this.#consume(r.binding, { op: 'book', browser: 'act', target: a.target, mode: this.worker.mode, confirmation: conf, page_title: r.page.title, status: 'ok' });
        }
        return { page: r.page };
      },

      'browser.fill_login': async (a, req) => {
        try {
          const g = this.#requireUsable(a.grant_id, 'login');
          if (g.domain) {
            const store_approval = this.store.approval;
            let c;
            try { c = await this.#siteLogin(g); } catch (e) {
              if (store_approval !== 'none') this.log.append({ errand_id: g.errand_id, type: 'grant.used', grant_id: g.grant_id, detail: { op: 'login', domain: g.domain, store_approval, status: e.code === 'store_no_answer' ? 'no_answer' : 'not_found' } });
              throw e;
            }
            const r = await this.worker.fill_login({ ...a, credential: c.record.ref });
            this.#consume(g, { op: 'login', domain: g.domain, credential_ref: c.record.ref, login_mode: 'broker_filled', store_approval, mode: this.#mode(g), conforming: true, status: 'ok' });
            return r;
          }
          if (g.credential !== a.credential) throw new ContractError('op_not_granted', `grant is for ${g.credential}`);
          const r = await this.worker.fill_login(a);
          this.#consume(g, { op: 'login', credential: a.credential, login_mode: 'broker_filled', mode: this.#mode(g), conforming: true, status: 'ok' });
          return r;
        } catch (e) { throw this.#refuse(req.errand_id, a.grant_id, e); }
      },

      'browser.fill_code': async (a, req) => {
        let g;
        try { g = this.#requireUsable(a.grant_id, 'login'); } catch (e) { throw this.#refuse(req.errand_id, a.grant_id, e); }
        let code;
        if (a.source === 'store_totp') {
          const ref = g.credential_ref ?? g.credential;
          code = ref && this.store.totp ? await this.store.totp(ref) : null;
          if (!code) throw this.#refuse(req.errand_id, a.grant_id, new ContractError('op_not_granted', 'this login has no TOTP in the store'));
        } else {
          if ([...this.codeSlots.values()].some((s) => s.session_id === a.session_id)) throw new ContractError('bad_request', 'a code slot is already open for this session');
          // The slot is for the channel the person is talking on; with more than one adapter, the core must say which.
          if (a.channel === undefined && this.channels.size > 1) throw new ContractError('bad_request', 'more than one channel adapter: name the one the person is on (channel)');
          if (a.channel !== undefined && !this.channels.has(a.channel)) throw new ContractError('bad_request', `no channel adapter ${a.channel}`);
          const channel = a.channel ?? [...this.channels][0] ?? null;
          const slot_id = ulid();
          const ms = (a.timeout_seconds ?? 300) * 1000;
          code = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => { this.codeSlots.delete(slot_id); reject(new ContractError('code_timeout', 'no code from the person')); }, ms);
            const expires_at = new Date(Date.now() + ms).toISOString();
            this.codeSlots.set(slot_id, { session_id: a.session_id, grant_id: g.grant_id, channel, seq: ++this.slotSeq, resolve, reject, timer, expires_at });
          }).catch((e) => { throw this.#refuse(req.errand_id, a.grant_id, e); });
        }
        // Waiting may have taken minutes: the grant must still be live when the code is filled.
        try { this.#requireUsable(a.grant_id, 'login'); } catch (e) { throw this.#refuse(req.errand_id, a.grant_id, e); }
        const r = await this.worker.fill_code({ grant_id: a.grant_id, session_id: a.session_id, code });
        this.#consume(g, { op: 'login', browser: 'fill_code', source: a.source, mode: this.#mode(g), conforming: true, status: 'ok' });
        return r;
      },

      // A long poll, with a cursor so the adapter hears of each slot once, and only of slots for its own channel.
      'code.slots': async ({ wait_seconds = 50, cursor } = {}, req) => {
        if (!Number.isInteger(wait_seconds) || wait_seconds < 0 || wait_seconds > 60) throw new ContractError('bad_request', 'wait_seconds is an integer from 0 to 60');
        if (cursor !== undefined && typeof cursor !== 'string') throw new ContractError('bad_request', 'cursor is a string');
        const [boot, n] = (cursor ?? '').split('.');
        const after = boot === this.bootId && /^\d+$/.test(n) ? Number(n) : 0;   // unknown cursor: every open slot
        const channel = req.caller.slice('channel-'.length);
        const fresh = () => [...this.codeSlots].filter(([, s]) => s.seq > after && s.channel === channel)
          .map(([slot_id, s]) => ({ slot_id, expires_at: s.expires_at }));
        for (const until = Date.now() + wait_seconds * 1000; !fresh().length && Date.now() < until;) await new Promise((r) => setTimeout(r, 20));
        const slots = fresh();
        const last = slots.length ? Math.max(...slots.map((x) => this.codeSlots.get(x.slot_id).seq)) : after;
        return { slots, cursor: `${this.bootId}.${last}` };
      },

      'code.deliver': async ({ slot_id, code }, req) => {
        if (typeof code !== 'string' || !/^[A-Za-z0-9]{4,10}$/.test(code)) throw new ContractError('bad_request', 'a code is 4 to 10 letters and digits');
        const s = this.codeSlots.get(slot_id);
        if (!s || s.channel !== req.caller.slice('channel-'.length)) throw new ContractError('bad_request', 'no open code slot ' + slot_id);
        this.codeSlots.delete(slot_id);
        clearTimeout(s.timer);
        s.resolve(new Secret(code));
        return { accepted: true };
      },

      'browser.close': async (a) => {
        this.#cancelSlots((s) => s.session_id === a.session_id, new ContractError('bad_request', 'the session closed'));
        return this.worker.close(a);
      },

      // 0.4: no identity.sign. The broker builds every declaration itself, for an act an approved grant covers,
      // taking the relying party and the constraints from the grant, not from the caller.
      'identity.declaration': async (a, req) => {
        const { grant_id, act } = a;
        if (Object.keys(a).some((k) => k !== 'grant_id' && k !== 'act')) throw new ContractError('bad_request', 'identity.declaration takes grant_id and act; the rest comes from the grant');
        let g;
        try { g = this.#grant(grant_id); } catch (e) { throw this.#refuse(req.errand_id, grant_id, e); }
        const relying_party = await this.#relyingParty(g);
        // Checked just before signing, with nothing awaited in between, so a revocation meanwhile is seen.
        try {
          const spent = g.state === 'consumed' && g.mode === 'one_shot' && Date.parse(g.expires_at) > Date.now();
          if (!spent) this.#requireUsable(grant_id);
          if (!g.ops.includes(act)) throw new ContractError('op_not_granted', `${act} not in [${g.ops}]`);
        } catch (e) { throw this.#refuse(req.errand_id, grant_id, e); }
        const declaration = { format: 'opa-draft-0', operator: 'fixture-operator.example', agent_kid: this.agentKey.kid,
          relying_party, act, grant_id, constraints: g.constraints ?? null, ts: nowIso() };
        const sig_b64 = signB64(this.agentKey, canonical(declaration));
        this.log.append({ errand_id: req.errand_id, type: 'identity.declaration', grant_id, detail: { declaration, sig_b64, presented: false } });
        return { declaration, kid: this.agentKey.kid, sig_b64, presented: false };
      },

      'status': async () => ({ version: '0.1-fixture', store: this.store.label(), agent_kid: this.agentKey.kid, broker_kid: this.brokerKey.kid }),
    };
  }

  /**
   * Caller proof (contracts/broker.md): one socket per caller. The socket a request
   * arrives on is the caller; a different `caller` field is refused. A real broker also
   * gives each socket file to that caller's Unix user (0600) and may check SO_PEERCRED;
   * the fixture runs as one user, so it checks the field against the socket only.
   */
  listen(socketPath, { caller = 'core' } = {}) {
    if (caller.startsWith('channel-')) this.channels.add(caller.slice('channel-'.length));
    return serve(socketPath, this.handlers(), {
      authorize: (req) => {
        if (req.caller !== caller) throw new ContractError('unauthorized_caller', `this socket is for ${caller}, not ${req.caller}`);
        // code.slots and code.deliver are for channel adapters only (contracts/broker.md).
        if ((req.op === 'code.deliver' || req.op === 'code.slots') && !caller.startsWith('channel-')) throw new ContractError('unauthorized_caller', `${req.op} is served only on channel adapters' sockets`);
        // A channel adapter's socket serves only these; everything else is the core's.
        if (caller !== 'core' && !['code.slots', 'code.deliver', 'status'].includes(req.op)) throw new ContractError('unauthorized_caller', `${req.op} is only for the core`);
      },
    });
  }
}
