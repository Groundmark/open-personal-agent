// AgentAccessStore: a CredentialStore over Bitwarden Agent Access (`aac`).
//
// The person's vault stays unlocked only on their own computer, where `aac listen`
// runs and asks them to approve each request (y once, a for 10 minutes for that
// domain, n to refuse). The broker runs `aac connect` against a paired session and
// gets one login back. So this store is fetch-only and `device_local`
// (contracts/broker.md, "Stores that ask the person themselves").
//
// Exit codes from `aac` v0.11.0, as observed in a live spike (2026-11-23):
//   0  success, JSON on stdout
//   2  connection failed               -> unavailable
//   3  no answer in time (it says "auth_handshake_failed", but an unanswered prompt
//      is what produces it)            -> no_answer
//   4  not in the vault, OR the person pressed n; aac can't tell them apart
//                                      -> not_found
//
// aac keeps its pairing key and session cache in $HOME/.access-protocol and writes
// them world-readable. The broker gives aac its own HOME (`stateHome`) and refuses to
// run unless that directory is 0700 and every file in it is 0600.

import { execFile } from 'node:child_process';
import { statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { CredentialStore, Secret, StoreError } from './credential-store.js';

const EXIT = { 2: 'unavailable', 3: 'no_answer', 4: 'not_found' };

export class AgentAccessStore extends CredentialStore {
  #aac;
  #session;
  #stateHome;
  #timeout;

  /**
   * aacPath: the aac binary. session: the paired session fingerprint (or a unique prefix).
   * stateHome: the HOME aac runs with; it holds .access-protocol/. timeoutSeconds: how long
   * the person has to answer the prompt.
   */
  constructor({ aacPath = 'aac', session, stateHome, timeoutSeconds = 120 }) {
    super();
    if (!session || !/^[0-9a-f]{6,64}$/.test(session)) throw new Error('agent access store: session must be a hex fingerprint or prefix');
    if (!stateHome) throw new Error('agent access store: stateHome is required');
    this.#aac = aacPath;
    this.#session = session;
    this.#stateHome = stateHome;
    this.#timeout = timeoutSeconds;
  }

  get label() {
    return 'Bitwarden Agent Access (asks on the person\'s computer)';
  }

  get approval() {
    return 'device_local';
  }

  async get(ref) {
    throw new Error('agent access store is fetch-only: use fetch({ domain })');
  }

  async fetch({ domain, username }) {
    if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(domain || '')) throw new StoreError('not_found', 'bad domain');
    checkStateHome(this.#stateHome);
    const args = ['connect', '--session', this.#session, '--domain', domain, '--output', 'json', '--timeout', String(this.#timeout)];
    const { code, stdout } = await run(this.#aac, args, {
      env: { PATH: process.env.PATH, HOME: this.#stateHome },
      timeout: (this.#timeout + 30) * 1000,
    });
    if (code !== 0) throw new StoreError(EXIT[code] ?? 'unavailable', `aac exited ${code}`);
    let out;
    try {
      out = JSON.parse(stdout);
    } catch {
      throw new StoreError('unavailable', 'aac returned output that is not JSON'); // never quote it: it may hold the password
    }
    const c = out?.credential;
    if (!out?.success || !c?.credentialId) throw new StoreError('not_found', 'aac returned no credential');
    if (username && c.username !== username) throw new StoreError('not_found', 'the vault returned a different account');
    const fields = { password: c.password ?? '' };
    if (c.totp) fields.totp = c.totp;
    const record = {
      ref: c.credentialId,
      kind: 'login',
      username: c.username ?? null,
      uris: c.uri ? [c.uri] : [],
      has_totp: !!c.totp,
    };
    return { record, secret: new Secret(fields) };
  }
}

/** aac's state must be the broker's alone: HOME 0700, .access-protocol 0700, files 0600. */
export function checkStateHome(home) {
  const bad = (p, m, want) => new StoreError('unavailable', `${p} has mode ${m.toString(8)}, want ${want.toString(8)}`);
  const hm = statSync(home).mode & 0o777;
  if (hm !== 0o700) throw bad(home, hm, 0o700);
  const dir = join(home, '.access-protocol');
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return; // not paired yet; aac will create it under our 0700 HOME
  }
  const dm = statSync(dir).mode & 0o777;
  if (dm !== 0o700) throw bad(dir, dm, 0o700);
  for (const f of entries) {
    const fm = statSync(join(dir, f)).mode & 0o777;
    if (fm !== 0o600) throw bad(join(dir, f), fm, 0o600);
  }
}

function run(cmd, args, opts) {
  return new Promise((resolve) => {
    execFile(cmd, args, { ...opts, maxBuffer: 64 * 1024 }, (err, stdout) => {
      if (err && typeof err.code !== 'number') return resolve({ code: -1, stdout: '' }); // not found, killed, timed out
      resolve({ code: err ? err.code : 0, stdout: String(stdout) });
    });
  });
}
