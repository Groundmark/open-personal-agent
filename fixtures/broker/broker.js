// Broker fixture (contracts/broker.md). Real grant rules, a fixture store, throwaway
// keys, and approvals that happen automatically (standing in for the person's passkey).
// It fronts a fake reservations MCP server and the browser-worker fixture.
import crypto from 'node:crypto';
import { ContractError, ulid, nowIso, canonical, serve } from '../lib/wire.js';
import { Log, newKeyPair, signB64 } from '../lib/log.js';
import { BrowserWorker } from '../browser-worker/worker.js';

const MAX_TTL = { standing: 7 * 24 * 3600, one_shot: 3600 };
const BINDING_OPS = new Set(['book', 'pay']);

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
        run: (a) => ({ confirmation: 'FM-' + crypto.randomBytes(3).toString('hex').toUpperCase(), ...a }),
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
    this.worker = new BrowserWorker({ store, mode: browserMode, getBookGrant: (id) => this.#usableBookGrant(id) });
  }

  // ---- grants ----

  #grant(id) {
    const g = this.grants.get(id);
    if (!g) throw new ContractError('grant_not_found', id);
    if (g.state === 'approved' && g.expires_at && Date.parse(g.expires_at) < Date.now()) {
      g.state = 'expired';
      this.log.append({ errand_id: g.errand_id, type: 'grant.expired', grant_id: g.grant_id });
    }
    return g;
  }

  #requireUsable(id, op) {
    const g = this.#grant(id);
    const bad = { pending: 'grant_not_approved', denied: 'grant_denied', expired: 'grant_expired', revoked: 'grant_revoked', consumed: 'grant_consumed' }[g.state];
    if (bad) throw new ContractError(bad, `${id} is ${g.state}`);
    if (op && !g.ops.includes(op)) throw new ContractError('op_not_granted', `${op} not in [${g.ops}]`);
    return g;
  }

  #usableBookGrant(id) {
    try { return this.#requireUsable(id, 'book'); } catch { return null; }
  }

  #refuse(errandId, grantId, e) {
    this.log.append({ errand_id: errandId, type: 'grant.refused', grant_id: grantId, detail: { error: e.code, message: e.message } });
    return e;
  }

  #consume(g, detail) {
    g.uses += 1;
    g.last_used_at = nowIso();
    if (g.mode === 'one_shot') g.state = 'consumed';
    this.log.append({ errand_id: g.errand_id, type: 'grant.used', grant_id: g.grant_id, detail });
  }

  /** Stand-in for the person approving on the passkey page. */
  approve(grantId, approve = true) {
    const g = this.#grant(grantId);
    if (g.state !== 'pending') return;
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
        if (!(await this.store.get(a.credential))) throw new ContractError('credential_not_found', a.credential);
        if (a.ops.some((o) => BINDING_OPS.has(o)) && a.mode !== 'one_shot') throw new ContractError('one_shot_required', 'binding ops need a one-shot grant');
        if (a.ttl_seconds > MAX_TTL[a.mode]) throw new ContractError('bad_request', `ttl over ${MAX_TTL[a.mode]}s for ${a.mode}`);
        if (a.ops.includes('book')) {
          const c = a.constraints || {};
          if (!c.venue || !c.date || !c.time || !c.party_size) throw new ContractError('bad_request', 'book needs venue, date, time, party_size');
        }
        const grant_id = ulid();
        const summary = a.ops.includes('book')
          ? `Book ${a.constraints.venue}, ${a.constraints.date} at ${a.constraints.time}, ${a.constraints.party_size} people, using ${a.credential}.`
          : `Let the agent ${a.ops.join(' and ')} with ${a.credential} for ${Math.round(a.ttl_seconds / 3600)} h: ${a.purpose}`;
        const g = {
          grant_id, errand_id: req.errand_id, credential: a.credential, ops: a.ops, constraints: a.constraints, mode: a.mode,
          ttl_seconds: a.ttl_seconds, purpose: a.purpose, state: 'pending', uses: 0, approved_at: null, expires_at: null, last_used_at: null,
        };
        g.hash = crypto.createHash('sha256').update(canonical({ grant_id, credential: a.credential, ops: a.ops, constraints: a.constraints, mode: a.mode })).digest('hex');
        this.grants.set(grant_id, g);
        this.log.append({ errand_id: req.errand_id, type: 'grant.requested', grant_id, detail: { credential: a.credential, ops: a.ops, constraints: a.constraints, mode: a.mode, purpose: a.purpose } });
        if (this.autoApprove) setTimeout(() => this.approve(grant_id), this.approveDelayMs);
        return { grant_id, state: 'pending', approve_url: `http://127.0.0.1/approve/${grant_id}`, summary };
      },

      'grant.status': async ({ grant_id }) => {
        const g = this.#grant(grant_id);
        return { grant_id, state: g.state, approved_at: g.approved_at, expires_at: g.expires_at, uses: g.uses, last_used_at: g.last_used_at };
      },

      'grant.revoke': async ({ grant_id, reason }) => {
        const g = this.#grant(grant_id);
        g.state = 'revoked';
        this.log.append({ errand_id: g.errand_id, type: 'grant.revoked', grant_id, detail: { reason } });
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
            const c = g.constraints;
            if (args.venue !== c.venue || args.date !== c.date || args.time !== c.time || args.party_size !== c.party_size) {
              throw new ContractError('constraint_mismatch', 'arguments differ from the approved grant');
            }
          }
        } catch (e) { throw this.#refuse(req.errand_id, grant_id, e); }
        await this.store.get(srv.credential); // the token is used here and goes no further
        const content = t.run(args);
        this.#consume(g, { op: t.op, server, tool, args, status: 'ok' });
        return { content };
      },

      'browser.open': async (a, req) => {
        try { this.#requireUsable(a.grant_id, 'search'); } catch (e) { throw this.#refuse(req.errand_id, a.grant_id, e); }
        const r = await this.worker.open(a);
        this.#consume(this.#grant(a.grant_id), { op: 'search', browser: 'open', url: a.url, mode: this.worker.mode, status: 'ok' });
        return r;
      },

      'browser.act': async (a, req) => {
        try { this.#requireUsable(a.grant_id, 'search'); } catch (e) { throw this.#refuse(req.errand_id, a.grant_id, e); }
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
          if (g.credential !== a.credential) throw new ContractError('op_not_granted', `grant is for ${g.credential}`);
          const r = await this.worker.fill_login(a);
          this.#consume(g, { op: 'login', credential: a.credential, mode: this.worker.mode, status: 'ok' });
          return r;
        } catch (e) { throw this.#refuse(req.errand_id, a.grant_id, e); }
      },

      'browser.close': async (a) => this.worker.close(a),

      'identity.sign': async ({ purpose, payload_b64 }) => ({
        kid: this.agentKey.kid, alg: 'Ed25519', sig_b64: signB64(this.agentKey, Buffer.from(payload_b64, 'base64')),
      }),

      'identity.declaration': async ({ relying_party, act, grant_id }, req) => {
        const declaration = { format: 'opa-draft-0', operator: 'fixture-operator.example', agent_kid: this.agentKey.kid, relying_party, act, grant_id, ts: nowIso() };
        const sig_b64 = signB64(this.agentKey, canonical(declaration));
        this.log.append({ errand_id: req.errand_id, type: 'identity.declaration', grant_id, detail: { declaration, sig_b64, presented: false } });
        return { declaration, kid: this.agentKey.kid, sig_b64, presented: false };
      },

      'status': async () => ({ version: '0.1-fixture', store: this.store.label(), agent_kid: this.agentKey.kid, broker_kid: this.brokerKey.kid }),
    };
  }

  listen(socketPath) { return serve(socketPath, this.handlers()); }
}
