// FixtureCredentialStore: the CredentialStore seam (contracts/broker.md) with fake values.
// Real deployments swap this for a vault-backed store with the same one method.
import { inspect } from 'node:util';

/** Wraps a secret so it can't be printed, logged or serialised by accident. */
export class Secret {
  #value;
  constructor(v) { this.#value = v; }
  reveal() { return this.#value; }
  toString() { return '[secret]'; }
  toJSON() { return '[secret]'; }
  [inspect.custom]() { return '[secret]'; }
}

const FAKE = {
  // Fixture values only. Obviously fake; never real credentials.
  'fake-table': {
    record: { name: 'fake-table', kind: 'login', origin: 'http://127.0.0.1', username: 'diner@example.test' },
    secret: 'FIXTURE-pa55word-not-real',
  },
  'fake-mcp': {
    record: { name: 'fake-mcp', kind: 'oauth_token', server: 'fake-reservations' },
    secret: 'FIXTURE-token-not-real',
  },
};

/** Logins found by site (contracts 0.3, "Credentials by site"). Fixture values only. */
const SITE_LOGINS = {
  'item-table': {
    record: { name: 'Table site', kind: 'login', username: 'diner@example.test', uris: ['https://table.example/login'], origin: 'https://table.example', has_totp: true },
    secret: 'FIXTURE-site-pass-not-real', totp: '493817',
  },
  'item-shop-a': {
    record: { name: 'Shop (a)', kind: 'login', username: 'a@example.test', uris: ['https://www.shop.example/'], origin: 'https://www.shop.example', has_totp: false },
    secret: 'FIXTURE-shop-a-not-real',
  },
  'item-shop-b': {
    record: { name: 'Shop (b)', kind: 'login', username: 'b@example.test', uris: ['https://shop.example/account'], origin: 'https://shop.example', has_totp: false },
    secret: 'FIXTURE-shop-b-not-real',
  },
};

/** A store failure, as the seam reports it: not_found | no_answer | unavailable. */
export class StoreError extends Error {
  constructor(kind, message) { super(message || kind); this.kind = kind; }
}

/** Same registrable domain, the way a password manager matches a page (fixture: suffix match). */
export function hostMatches(host, domain) { return host === domain || host.endsWith('.' + domain); }

export class FixtureCredentialStore {
  /**
   * opts.approval: 'none' (default) | 'device_local' | 'remote'.
   * opts.listable: true (default) offers find(); false stands in for a fetch-only store such as Agent Access.
   * opts.prompt: for a store that asks the person, { refuse: Set<domain>, noAnswer: Set<domain> }.
   */
  constructor(overrides = {}, { approval = 'none', listable = true, prompt = {} } = {}) {
    this.items = { ...FAKE, ...overrides };
    this.site = structuredClone(SITE_LOGINS);
    this.approval = approval;
    this.listable = listable;
    this.prompt = { refuse: new Set(), noAnswer: new Set(), ...prompt };
    this.fetches = 0;
  }
  label() { return 'fixture'; }
  async get(name) {
    const it = this.items[name] ?? this.site[name];
    if (!it) return null;
    return { record: { ref: name, ...it.record }, secret: new Secret(it.secret) };
  }
  #matches(domain, username) {
    return Object.entries(this.site)
      .filter(([, it]) => it.record.uris.some((u) => hostMatches(new URL(u).hostname, domain)))
      .filter(([, it]) => !username || it.record.username === username)
      .map(([ref, it]) => ({ ref, record: { ref, ...it.record } }));
  }
  /** Lists matches without fetching. Only offered by a listable store. */
  get find() { return this.listable ? async ({ domain, username }) => this.#matches(domain, username) : undefined; }
  /** Fetches one login by site. A store that asks the person refuses or times out here. */
  async fetch({ domain, username }) {
    this.fetches++;
    if (this.prompt.noAnswer.has(domain)) throw new StoreError('no_answer');
    if (this.prompt.refuse.has(domain)) throw new StoreError('not_found');
    const m = this.#matches(domain, username);
    if (!m.length) throw new StoreError('not_found');
    return this.get(m[0].ref); // a fetch-only store's own prompt picks; the fixture takes the first
  }
  async totp(ref) { const t = this.site[ref]?.totp; return t ? new Secret(t) : null; }
  /** Every secret value, for the broker's "type refuses secrets" check and the leak tests. */
  allSecretValues() {
    return [...Object.values(this.items).map((i) => i.secret), ...Object.values(this.site).flatMap((i) => [i.secret, i.totp].filter(Boolean))];
  }
  setOrigin(name, origin) {
    const it = this.items[name] ?? this.site[name];
    it.record.origin = origin;
    if (it.record.uris) it.record.uris = [origin + '/login'];
  }
}
