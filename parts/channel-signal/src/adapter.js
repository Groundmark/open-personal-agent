// The Signal channel adapter (contracts/channel.md): the person texts the agent's own Signal number.
// signal-cli runs as the account's only receiver, in JSON-RPC mode on stdin/stdout ("one adapter owns the account").
//
// Pairing: `opa-channel-signal pair` makes a six-digit code (15 minutes, once), shown on the machine. The first
// message that is exactly that code pins the sender: their account id (ACI) and their current identity key
// fingerprint. After that only the pinned account with the pinned key is forwarded; anything else is dropped,
// counted, and gets no reply. A changed identity key stops forwarding until the person pairs again.
//
// One-time codes: while the broker has a code slot open (code.slots, waited on over the adapter's own broker
// socket), a message from the person that is only a code goes to the broker (code.deliver) and the core gets
// "[one-time code delivered]". Codes never touch disk or the adapter's logs.
import { spawn } from 'node:child_process';
import { createHash, randomInt } from 'node:crypto';
import { createConnection, createServer } from 'node:net';
import { chmodSync, existsSync, lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const sha = (s) => createHash('sha256').update(s).digest('hex');
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ulid = () => { let t = ''; for (let i = 0, n = Date.now(); i < 10; i++, n = Math.floor(n / 32)) t = B32[n % 32] + t; return t + Array.from({ length: 16 }, () => B32[randomInt(32)]).join(''); };
// A site's one-time code: letters, digits, spaces (any kind, so one pasted from an SMS counts) and dashes, which
// strip to 4 to 10 letters and digits with at least one digit. Narrower than contracts/channel.md (no digit needed
// there): without it, "ok thanks" sent while a code is awaited would go to the site as the code.
export function asCode(text) {
  const t = text.trim();
  if (!/^[A-Za-z0-9\s-]+$/.test(t)) return null;
  const stripped = t.replace(/[\s-]/g, '');
  return /^[A-Za-z0-9]{4,10}$/.test(stripped) && /\d/.test(stripped) ? stripped : null;
}
const CALL_TIMEOUT_MS = 30_000;

/** Makes a pairing code and stores only its hash. Returns the code, for the installer to show. */
export function newPairingCode(stateDir, now = Date.now()) {
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  writeFileSync(join(stateDir, 'pair-code.json'), JSON.stringify({ sha256: sha(code), until: now + 15 * 60_000 }), { mode: 0o600 });
  return code;
}

/**
 * JSON-RPC to signal-cli over its stdin/stdout. `onReceive(envelope)` gets incoming messages; `onDead(why)` is called
 * once if signal-cli can't start or stops (the adapter is no use without it: main.js exits and systemd restarts it).
 */
export function signalRpc(command, args, onReceive, onDead = () => {}) {
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = new Map();
  let next = 1, dead = false;
  const die = (why) => {
    if (dead) return;
    dead = true;
    for (const p of pending.values()) p.reject(new Error(`signal-cli ${why}`));
    pending.clear();
    onDead(why);
  };
  child.on('error', (e) => die(`couldn't start: ${e.code || e.message}`));
  child.on('exit', (code, sig) => die(`exited (${sig || code})`));
  child.stdin.on('error', () => die('closed its input'));
  createInterface({ input: child.stdout }).on('line', (line) => {
    let m; try { m = JSON.parse(line); } catch { return; }
    if (m.id !== undefined && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      return m.error ? p.reject(Object.assign(new Error(m.error.message), { rpc: m.error })) : p.resolve(m.result);
    }
    if (m.method === 'receive' && m.params?.envelope) onReceive(m.params.envelope);
  });
  return {
    child,
    call: (method, params = {}) => new Promise((resolve, reject) => {
      if (dead) return reject(new Error('signal-cli is not running'));
      const id = next++;
      const t = setTimeout(() => { pending.delete(id); reject(new Error(`signal-cli: no answer to ${method}`)); }, CALL_TIMEOUT_MS);
      pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params, id }) + '\n');
    }),
    close: () => { child.stdin.end(); child.kill(); },
  };
}

export class SignalChannel {
  /** cfg: { state_dir, core_socket, broker_socket, name? } ; rpc: from signalRpc (or a test double). */
  constructor(cfg, { now = () => Date.now(), log = (m) => console.log(m) } = {}) {
    this.cfg = { name: 'signal', ...cfg };
    this.now = now; this.log = log;
    this.pairingFile = join(cfg.state_dir, 'pairing.json');
    this.pairing = existsSync(this.pairingFile) ? JSON.parse(readFileSync(this.pairingFile, 'utf8')) : null;
    this.counts = { from_strangers: 0, from_changed_key: 0 };
    this.slots = [];          // open code slots, from the broker
    this.stopped = false;
  }

  attach(rpc) { this.rpc = rpc; }

  #savePairing() { writeFileSync(this.pairingFile + '.tmp', JSON.stringify(this.pairing), { mode: 0o600 }); renameSync(this.pairingFile + '.tmp', this.pairingFile); }

  async #fingerprint(uuid) {
    const ids = await this.rpc.call('listIdentities');
    const mine = (ids ?? []).filter((i) => i.uuid === uuid);
    return mine.at(-1)?.fingerprint ?? null;
  }

  async #reply(to, text) {
    try { await this.rpc.call('send', { recipient: [to], message: text }); } catch (e) { this.log(`signal: send failed: ${e.message}`); }
  }

  /** Whether `text` is the live pairing code. Doesn't spend it: that's done once the pairing is saved. */
  #pairCodeOk(text) {
    const f = join(this.cfg.state_dir, 'pair-code.json');
    if (!existsSync(f)) return false;
    const c = JSON.parse(readFileSync(f, 'utf8'));
    return c.until > this.now() && sha(text.trim()) === c.sha256;
  }

  /** One incoming Signal message. */
  async onEnvelope(env) {
    const text = env.dataMessage?.message;
    if (typeof text !== 'string' || !text.trim() || env.dataMessage?.groupInfo) return;   // only direct text messages
    const from = env.sourceUuid;
    if (!from) return;

    if (!this.pairing || this.pairing.needs_repair) {
      if (this.#pairCodeOk(text)) {
        // The key first: without one there's nothing to pin, so the code stays good for another try.
        let key = null;
        try { key = await this.#fingerprint(from); } catch (e) { this.log(`signal: can't read identity keys: ${e.message}`); }
        if (!key) { this.log('signal: pairing refused: no identity key for the sender yet; the code is still good'); return; }
        if (!this.#pairCodeOk(text)) return;   // spent by another message meanwhile
        const again = this.pairing?.needs_repair && this.pairing.account_id === from;
        const dropped = again ? this.counts.from_changed_key : 0;
        this.pairing = { channel: this.cfg.name, account_id: from, identity_key: key, paired_at: new Date(this.now()).toISOString() };
        this.#savePairing();
        try { unlinkSync(join(this.cfg.state_dir, 'pair-code.json')); } catch {}   // single use
        this.log(`signal: paired with ${from.slice(0, 8)}…`);
        await this.#reply(from, again && dropped ? `Paired again. While we were unpaired, ${dropped} message${dropped === 1 ? ' from your account was' : 's from your account were'} dropped.` : 'Paired.');
        this.counts.from_changed_key = 0;
        return;
      }
      if (this.pairing?.needs_repair && from === this.pairing.account_id) this.counts.from_changed_key += 1; else this.counts.from_strangers += 1;
      return;
    }
    if (from !== this.pairing.account_id) { this.counts.from_strangers += 1; return; }
    const key = await this.#fingerprint(from);
    if (key !== this.pairing.identity_key) {
      this.counts.from_changed_key += 1;
      if (!this.pairing.needs_repair) {
        this.pairing.needs_repair = true; this.#savePairing();
        this.log(`signal: identity_changed for the paired account (old ${String(this.pairing.identity_key).slice(0, 12)}…, new ${String(key).slice(0, 12)}…); forwarding stopped until a new pairing`);
      }
      return;
    }

    // A one-time code while the broker waits for one: to the broker, never the core.
    const code = asCode(text);
    this.slots = this.slots.filter((s) => s.expires_at > new Date(this.now()).toISOString());
    if (this.slots.length && code) {
      const slot = this.slots[0];
      const r = await this.#broker('code.deliver', { slot_id: slot.slot_id, code });
      // The slot goes only when the broker says it's done (filled, or gone: the format was checked, so bad_request
      // means that); after a hiccup the person can send the code again to the same slot.
      const done = r.ok || r.error === 'bad_request' || r.error === 'code_timeout';
      if (done) this.slots = this.slots.filter((s) => s.slot_id !== slot.slot_id);
      if (r.ok) return this.#toCore('[one-time code delivered]', env);
      this.log(`signal: code.deliver failed: ${r.error}`);
      // Once taken for a code, it never goes on as text.
      return this.#toCore(done ? '[one-time code not delivered: the request for it had ended]' : "[one-time code not delivered: the agent couldn't pass it on just now; the person can send it again]", env);
    }
    await this.#toCore(text, env);
  }

  #ask(socket, op, args, caller, timeoutMs = 15_000) {
    return new Promise((resolve) => {
      const req = { op, id: ulid(), caller, errand_id: null, ts: new Date(this.now()).toISOString(), args };
      const c = createConnection(socket, () => c.write(JSON.stringify(req) + '\n'));
      let b = '', done = false;
      const end = (r) => { if (!done) { done = true; c.destroy(); resolve(r); } };
      c.setEncoding('utf8');
      c.setTimeout(timeoutMs, () => end({ ok: false, error: 'timeout' }));
      c.on('data', (d) => { b += d; });
      c.on('end', () => { try { end(JSON.parse(b)); } catch { end({ ok: false, error: 'bad_answer' }); } });
      c.on('error', (e) => end({ ok: false, error: e.code }));
    });
  }
  #broker(op, args, timeoutMs) { return this.#ask(this.cfg.broker_socket, op, args, `channel-${this.cfg.name}`, timeoutMs); }

  async #toCore(text, env) {
    const r = await this.#ask(this.cfg.core_socket, 'channel.inbound', {
      channel: this.cfg.name, message_id: `sig-${env.timestamp ?? Date.now()}`, from: env.sourceUuid, from_display: env.sourceName ?? '',
      text, attachments: [], received_at: new Date(env.timestamp ?? this.now()).toISOString(),
    }, `channel-${this.cfg.name}`);
    if (!r.ok) this.log(`signal: core did not take the message: ${r.error}`);
  }

  /**
   * Waits on the broker for code slots, for as long as the adapter runs: a long poll that passes back the cursor,
   * so each slot is heard of once. A slot stays here until it's used or its expires_at passes.
   */
  async watchSlots() {
    let cursor;
    while (!this.stopped && this.cfg.broker_socket) {
      const started = Date.now();
      const r = await this.#broker('code.slots', { wait_seconds: 50, ...(cursor ? { cursor } : {}) }, 65_000);
      if (r.ok && !Array.isArray(r.result?.slots)) r.ok = false, r.error = 'bad_answer';
      if (!r.ok) {
        if (r.error === 'unknown_op') { this.log('signal: the broker has no code slots: one-time codes are off'); return; }
        await new Promise((x) => setTimeout(x, 5000)); continue;
      }
      cursor = r.result.cursor;
      const now = new Date(this.now()).toISOString(), known = new Set(this.slots.map((s) => s.slot_id));
      const fresh = r.result.slots.filter((s) => !known.has(s.slot_id));
      this.slots = [...this.slots, ...fresh].filter((s) => s.expires_at > now);
      // A broker that answers at once with nothing new (one without a cursor, say) shouldn't be asked in a tight loop.
      if (!fresh.length && Date.now() - started < 1000) await new Promise((x) => setTimeout(x, 1000));
    }
  }

  /** channel.send from the core: only to the paired account. */
  async send(a) {
    if (!this.pairing || this.pairing.needs_repair) throw Object.assign(new Error('no account is paired'), { code: 'not_paired' });
    if (a.to !== this.pairing.account_id) throw Object.assign(new Error(a.to), { code: 'recipient_not_allowed' });
    let r;
    try { r = await this.rpc.call('send', { recipient: [a.to], message: a.text }); } catch (e) {
      if (/untrusted|identity/i.test(e.message)) this.#keyChanged();
      throw Object.assign(new Error(`signal: ${e.message}`), { code: this.pairing.needs_repair ? 'not_paired' : 'channel_unavailable' });
    }
    // signal-cli runs with on-first-use trust, so it won't send to a changed key (someone who took over the number).
    if ((r?.results ?? []).some((x) => x?.type === 'UNTRUSTED_IDENTITY')) {
      this.#keyChanged();
      throw Object.assign(new Error('the person\'s identity key changed'), { code: 'not_paired' });
    }
    return { message_id: `sig-${r?.timestamp ?? Date.now()}`, sent_at: new Date(this.now()).toISOString() };
  }

  #keyChanged() {
    if (this.pairing.needs_repair) return;
    this.pairing.needs_repair = true; this.#savePairing();
    this.log('signal: identity_changed for the paired account (on send); nothing more is sent until a new pairing');
  }

  status() {
    return { channel: this.cfg.name, paired: Boolean(this.pairing && !this.pairing.needs_repair), needs_repair: Boolean(this.pairing?.needs_repair), dropped: { ...this.counts } };
  }

  /** The adapter's own socket, for the core: channel.send and status. */
  async listen(where) {
    if (!where) throw new Error('signal: no socket for the core: set "socket" in the config, or run under systemd');
    if (typeof where === 'string') await clearStaleSocket(where);
    this.server = createServer((c) => {
      let b = '', done = false;
      c.setEncoding('utf8');
      c.on('error', () => {});
      c.on('data', async (d) => {
        if (done) return;
        b += d;
        const nl = b.indexOf('\n'); if (nl < 0) return;
        done = true;
        let req = null; try { req = JSON.parse(b.slice(0, nl)); } catch {}
        const id = req?.id ?? null;
        if (req?.caller !== 'core') return c.end(JSON.stringify({ id, ok: false, error: req ? 'unauthorized_caller' : 'bad_request' }) + '\n');
        try {
          const result = req.op === 'channel.send' ? await this.send(req.args ?? {}) : req.op === 'status' ? this.status() : null;
          c.end(JSON.stringify(result ? { id, ok: true, result } : { id, ok: false, error: 'unknown_op' }) + '\n');
        } catch (e) { c.end(JSON.stringify({ id, ok: false, error: e.code ?? 'internal', message: e.message }) + '\n'); }
      });
    });
    await new Promise((r, j) => { this.server.once('error', j); this.server.listen(where, r); });
    if (typeof where === 'string') chmodSync(where, 0o600);
  }

  close() { this.stopped = true; this.server?.close(); this.rpc?.close?.(); }
}

/** A socket file left by an adapter that died is removed; one still answering (another adapter running) is an error. */
async function clearStaleSocket(path) {
  let st;
  try { st = lstatSync(path); } catch { return; }
  if (!st.isSocket()) throw new Error(`signal: ${path} exists and is not a socket`);
  const live = await new Promise((resolve, reject) => {
    const c = createConnection(path, () => { c.destroy(); resolve(true); });
    c.on('error', (e) => (e.code === 'ECONNREFUSED' ? resolve(false) : reject(new Error(`signal: can't check ${path}: ${e.code}`))));
  });
  if (live) throw new Error(`signal: ${path} is in use: is another Signal adapter running?`);
  unlinkSync(path);
}
