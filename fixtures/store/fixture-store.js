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

export class FixtureCredentialStore {
  constructor(overrides = {}) { this.items = { ...FAKE, ...overrides }; }
  label() { return 'fixture'; }
  async get(name) {
    const it = this.items[name];
    if (!it) return null;
    return { record: { ...it.record }, secret: new Secret(it.secret) };
  }
  /** Every secret value, for the broker's "type refuses secrets" check. */
  allSecretValues() { return Object.values(this.items).map((i) => i.secret); }
  setOrigin(name, origin) { this.items[name].record.origin = origin; }
}
