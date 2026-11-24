// BitwardenStore: a CredentialStore over a narrow Bitwarden (or Vaultwarden) account that can see only one
// collection (contracts/broker.md: "a bw serve store with a service account: get and find, none").
// For errands the person isn't watching: no prompt on their computer, so approval is "none" and the passkey on
// the grant is the only approval.
//
// It runs the `bw` CLI once per request rather than `bw serve`: bw serve's REST API on loopback has no
// authentication, so every local user (the core included) could read the vault through it. The CLI keeps
// nothing listening. Its state (the account's encrypted data, session settings) lives in the broker's own
// directory (0700, files 0600), as the contract asks; the session key is in memory only.
import { execFile } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CredentialStore, Secret, StoreError } from './credential-store.js';

const hostMatches = (host, domain) => host === domain || host.endsWith('.' + domain);
const hostOf = (u) => { try { return new URL(/^[a-z]+:\/\//i.test(u) ? u : `https://${u}`).hostname.toLowerCase(); } catch { return null; } };

function checkState(dir) {
  const st = statSync(dir);
  if ((st.mode & 0o077) !== 0) throw new StoreError('unavailable', `${dir} must be 0700`);
  for (const f of readdirSync(dir, { recursive: true })) {
    const s = statSync(join(dir, f));
    if (s.isFile() && (s.mode & 0o077) !== 0) throw new StoreError('unavailable', `${join(dir, f)} must be 0600`);
  }
}

function run(bw, args, env) {
  return new Promise((resolve) => {
    execFile(bw, args, { env, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr });
    });
  });
}

/**
 * Logs the account in (API key) and unlocks it; returns the session key. Inputs are file paths, read here and
 * passed to bw by environment or file, never on the command line (where `ps` would show them).
 */
export async function bwUnlock({ bw = 'bw', appDataDir, serverUrl, caFile, clientIdFile, clientSecretFile, passwordFile }) {
  checkState(appDataDir);
  const env = { PATH: process.env.PATH, HOME: appDataDir, BITWARDENCLI_APPDATA_DIR: appDataDir, BW_NOINTERACTION: 'true', ...(caFile ? { NODE_EXTRA_CA_CERTS: caFile } : {}) };
  const status = await run(bw, ['status'], env);
  let st = {}; try { st = JSON.parse(status.stdout); } catch {}
  if (st.status === 'unauthenticated') {
    if (serverUrl && st.serverUrl !== serverUrl) await run(bw, ['config', 'server', serverUrl], env);
    const login = await run(bw, ['login', '--apikey'], { ...env, BW_CLIENTID: readFileSync(clientIdFile, 'utf8').trim(), BW_CLIENTSECRET: readFileSync(clientSecretFile, 'utf8').trim() });
    if (login.code !== 0) throw new StoreError('unavailable', 'bw login --apikey failed');
  }
  const unlock = await run(bw, ['unlock', '--passwordfile', passwordFile, '--raw'], env);
  if (unlock.code !== 0 || !unlock.stdout.trim()) throw new StoreError('unavailable', 'bw unlock failed');
  return unlock.stdout.trim();
}

export class BitwardenStore extends CredentialStore {
  #bw; #dir; #collection; #session; #ca;

  /** session: from bwUnlock. collectionId: the one collection this account may use. */
  /** caFile: a certificate to trust for a self-hosted server with its own (e.g. Vaultwarden on loopback). */
  constructor({ bw = 'bw', appDataDir, collectionId, session, caFile }) {
    super();
    if (!collectionId) throw new Error('bitwarden store: collectionId is required');
    this.#bw = bw; this.#dir = appDataDir; this.#collection = collectionId; this.#session = session; this.#ca = caFile;
  }

  get label() { return 'Bitwarden service account (one collection)'; }
  get approval() { return 'none'; }

  async #json(args) {
    checkState(this.#dir);
    const r = await run(this.#bw, args, { PATH: process.env.PATH, HOME: this.#dir, BITWARDENCLI_APPDATA_DIR: this.#dir, BW_SESSION: this.#session, BW_NOINTERACTION: 'true', ...(this.#ca ? { NODE_EXTRA_CA_CERTS: this.#ca } : {}) });
    if (r.code !== 0) {
      if (/not found/i.test(r.stderr)) throw new StoreError('not_found', 'no such item');
      throw new StoreError('unavailable', /locked|not logged in/i.test(r.stderr) ? 'the vault is locked or logged out' : `bw exited ${r.code}`);
    }
    try { return JSON.parse(r.stdout); } catch { throw new StoreError('unavailable', 'bw returned output that is not JSON'); }   // never quote it
  }

  #record(it) {
    const uris = (it.login?.uris ?? []).map((u) => u.uri).filter(Boolean);
    const first = uris.map(hostOf).find(Boolean);
    return { ref: it.id, kind: 'login', name: it.name, username: it.login?.username ?? null, uris, origin: first ? `https://${first}` : null, has_totp: Boolean(it.login?.totp) };
  }

  #mine(it) { return it?.type === 1 && (it.collectionIds ?? []).includes(this.#collection); }

  /** Logins in the collection saved for this site (same registrable domain, like a password manager). */
  async find({ domain, username }) {
    const items = await this.#json(['list', 'items', '--collectionid', this.#collection, '--url', `https://${domain}`]);
    return items.filter((it) => this.#mine(it))
      .filter((it) => (it.login?.uris ?? []).some((u) => { const h = hostOf(u.uri); return h && (hostMatches(h, domain) || hostMatches(domain, h)); }))
      .filter((it) => !username || it.login?.username === username)
      .map((it) => ({ ref: it.id, record: this.#record(it) }));
  }

  async get(ref) {
    if (!/^[0-9a-f-]{36}$/i.test(ref ?? '')) return null;
    let it;
    try { it = await this.#json(['get', 'item', ref]); } catch (e) { if (e.kind === 'not_found') return null; throw e; }
    if (!this.#mine(it)) return null;   // outside the collection: as if it weren't there
    return { record: this.#record(it), secret: new Secret({ username: it.login?.username ?? '', password: it.login?.password ?? '' }) };
  }

  async totp(ref) {
    const c = await this.get(ref);
    if (!c?.record.has_totp) return null;
    const r = await run(this.#bw, ['get', 'totp', ref], { PATH: process.env.PATH, HOME: this.#dir, BITWARDENCLI_APPDATA_DIR: this.#dir, BW_SESSION: this.#session, BW_NOINTERACTION: 'true', ...(this.#ca ? { NODE_EXTRA_CA_CERTS: this.#ca } : {}) });
    const code = r.stdout.trim();
    return r.code === 0 && /^\d{6,8}$/.test(code) ? new Secret({ totp: code }) : null;
  }
}

/**
 * The broker's store: login-free web services (relying parties like the demo restaurant, no secret) plus at most
 * one vault. A web service's own approval is always "none"; the vault's is its own.
 */
export class CombinedStore extends CredentialStore {
  constructor({ services = {}, vault = null }) {
    super();
    this.services = new Map(Object.values(services).map((s) => [s.credential, s]));
    this.vault = vault;
    if (vault?.find) this.find = (q) => vault.find(q);
    if (vault?.fetch) this.fetch = (q) => vault.fetch(q);
    if (vault?.totp) this.totp = (ref) => vault.totp(ref);
  }
  get label() { return this.vault ? `web services + ${this.vault.label}` : 'web services only (no vault)'; }
  get approval() { return this.vault?.approval ?? 'none'; }
  async get(ref) {
    const s = this.services.get(ref);
    if (s) return { record: { ref, kind: 'service', origin: new URL(s.base_url).origin, approval: 'none' }, secret: null };
    return this.vault?.get ? this.vault.get(ref).catch((e) => { if (e.kind === 'not_found') return null; throw e; }) : null;
  }
}
