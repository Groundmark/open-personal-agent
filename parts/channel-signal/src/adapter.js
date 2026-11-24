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
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const sha = (s) => createHash('sha256').update(s).digest('hex');
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ulid = () => { let t = ''; for (let i = 0, n = Date.now(); i < 10; i++, n = Math.floor(n / 32)) t = B32[n % 32] + t; return t + Array.from({ length: 16 }, () => B32[randomInt(32)]).join(''); };
const CODE = /^[A-Za-z0-9](?:[A-Za-z0-9 -]{2,16})[A-Za-z0-9]$/;

/** Makes a pairing code and stores only its hash. Returns the code, for the installer to show. */
export function newPairingCode(stateDir, now = Date.now()) {
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  writeFileSync(join(stateDir, 'pair-code.json'), JSON.stringify({ sha256: sha(code), until: now + 15 * 60_000 }), { mode: 0o600 });
  return code;
}

/** JSON-RPC to signal-cli over its stdin/stdout. `onReceive(envelope)` gets incoming messages. */
export function signalRpc(command, args, onReceive) {
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = new Map();
  let next = 1;
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
      const id = next++;
      pending.set(id, { resolve, reject });
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

  #pairCodeOk(text) {
    const f = join(this.cfg.state_dir, 'pair-code.json');
    if (!existsSync(f)) return false;
    const c = JSON.parse(readFileSync(f, 'utf8'));
    if (!(c.until > this.now()) || sha(text.trim()) !== c.sha256) return false;
    unlinkSync(f);   // single use
    return true;
  }

  /** One incoming Signal message. */
  async onEnvelope(env) {
    const text = env.dataMessage?.message;
    if (typeof text !== 'string' || !text.trim() || env.dataMessage?.groupInfo) return;   // only direct text messages
    const from = env.sourceUuid;
    if (!from) return;

    if (!this.pairing || this.pairing.needs_repair) {
      if (this.#pairCodeOk(text)) {
        const again = this.pairing?.needs_repair && this.pairing.account_id === from;
        const dropped = again ? this.counts.from_changed_key : 0;
        this.pairing = { channel: this.cfg.name, account_id: from, identity_key: await this.#fingerprint(from), paired_at: new Date(this.now()).toISOString() };
        this.#savePairing();
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
    const stripped = text.trim().replace(/[\s-]/g, '');
    this.slots = this.slots.filter((s) => s.expires_at > new Date(this.now()).toISOString());
    if (this.slots.length && CODE.test(text.trim()) && /^[A-Za-z0-9]{4,10}$/.test(stripped)) {
      const slot = this.slots.shift();
      const r = await this.#broker('code.deliver', { slot_id: slot.slot_id, code: stripped });
      if (r.ok) return this.#toCore('[one-time code delivered]', env);
      // Once taken for a code, it never goes on as text: the core hears only that it came too late.
      this.log(`signal: code.deliver refused: ${r.error}`);
      return this.#toCore('[one-time code not delivered: the request for it had ended]', env);
    }
    await this.#toCore(text, env);
  }

  #ask(socket, op, args, caller) {
    return new Promise((resolve) => {
      const req = { op, id: ulid(), caller, errand_id: null, ts: new Date(this.now()).toISOString(), args };
      const c = createConnection(socket, () => c.write(JSON.stringify(req) + '\n'));
      let b = ''; c.on('data', (d) => { b += d; });
      c.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve({ ok: false, error: 'bad_answer' }); } });
      c.on('error', (e) => resolve({ ok: false, error: e.code }));
    });
  }
  #broker(op, args) { return this.#ask(this.cfg.broker_socket, op, args, `channel-${this.cfg.name}`); }

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
      const r = await this.#broker('code.slots', { wait_seconds: 50, ...(cursor ? { cursor } : {}) });
      if (!r.ok) { if (r.error === 'unknown_op') return; await new Promise((x) => setTimeout(x, 5000)); continue; }
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
      throw Object.assign(new Error(`signal: ${e.message}`), { code: 'channel_unavailable' });
    }
    return { message_id: `sig-${r?.timestamp ?? Date.now()}`, sent_at: new Date(this.now()).toISOString() };
  }

  status() {
    return { channel: this.cfg.name, paired: Boolean(this.pairing && !this.pairing.needs_repair), needs_repair: Boolean(this.pairing?.needs_repair), dropped: { ...this.counts } };
  }

  /** The adapter's own socket, for the core: channel.send and status. */
  async listen(where) {
    this.server = createServer((c) => {
      let b = '', done = false;
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
  }

  close() { this.stopped = true; this.server?.close(); this.rpc?.close?.(); }
}
