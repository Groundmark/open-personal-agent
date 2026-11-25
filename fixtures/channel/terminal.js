// Terminal channel fixture (contracts/channel.md). Serves channel.send (prints, and keeps
// an outbox for tests) and turns lines of input into channel.inbound for the core.
// Pairing: until someone sends the one-time code, nothing is forwarded. After that, only
// the paired account with its pinned identity key reaches the core; anything else is
// dropped and counted, and a changed identity key stops forwarding until re-paired.
import { ContractError, serve, call, request, ulid, nowIso } from '../lib/wire.js';

/** The simulated person: an account id, an identity key, and a display name anyone could copy. */
export const PERSON = { account: 'acct-person-0001', key: 'idkey-person-AAAA', display: 'Person' };

export class TerminalChannel {
  constructor({ name = 'terminal', coreSocket = null, print = true, pairingCode = '482913' }) {
    this.name = name;
    this.coreSocket = coreSocket;
    this.print = print;
    this.pairingCode = pairingCode;
    this.codeSpent = false;
    this.pairing = null; // { channel, account_id, identity_key, paired_at }
    this.outbox = [];
    this.dropped = 0;
    this.identityChanged = 0;
    this.slots = new Map();     // code slots the broker told us of: slot_id -> { slot_id, expires_at }
    this.brokerSocket = null;
    this.watching = null;
  }

  /**
   * One-time codes (contracts/channel.md): wait on the broker for code slots, for as long as the channel runs.
   * A long poll on this adapter's own broker socket, passing back the cursor so each slot is heard of once.
   */
  watchSlots(brokerSocket) {
    this.brokerSocket = brokerSocket;
    this.stopped = false;
    const loop = async () => {
      let cursor;
      while (!this.stopped) {
        const r = await call(this.brokerSocket, request('code.slots', `channel-${this.name}`, null, { wait_seconds: 1, ...(cursor ? { cursor } : {}) })).catch(() => null);
        if (this.stopped) break;
        if (!r?.ok) { await new Promise((x) => setTimeout(x, 200)); continue; }
        cursor = r.result.cursor;
        for (const slot of r.result.slots) this.slots.set(slot.slot_id, slot);
      }
    };
    this.watching = loop();
    return this.watching;
  }

  async stop() { this.stopped = true; await this.watching; }

  /** The open slot a code goes to: the oldest one not yet expired. */
  #openSlot() {
    const now = Date.now();
    for (const [id, s] of this.slots) if (Date.parse(s.expires_at) < now) this.slots.delete(id);
    return this.slots.values().next().value ?? null;
  }

  /** The paired account id: the only recipient channel.send accepts. */
  get sender() { return this.pairing?.account_id ?? null; }

  #out(to, text) {
    const msg = { message_id: `out-${ulid()}`, sent_at: nowIso() };
    this.outbox.push({ channel: this.name, to, text, ...msg });
    if (this.print) process.stdout.write(`agent> ${text}\n`);
    return msg;
  }

  handlers() {
    return {
      'channel.send': async (a) => {
        if (!this.pairing) throw new ContractError('not_paired', 'no account is paired yet');
        if (a.to !== this.pairing.account_id) throw new ContractError('recipient_not_allowed', a.to);
        return this.#out(a.to, a.text);
      },
    };
  }

  listen(socketPath) { return serve(socketPath, this.handlers()); }

  /**
   * Simulate a message arriving from `who` ({ account, key, display }).
   * Returns 'paired' for an accepted pairing code, the core's response for a forwarded
   * message, or null if dropped.
   */
  async inbound(text, who = PERSON) {
    if (!this.pairing) {
      if (!this.codeSpent && text.trim() === this.pairingCode) {
        this.codeSpent = true;
        this.pairing = { channel: this.name, account_id: who.account, identity_key: who.key, paired_at: nowIso() };
        this.#out(who.account, 'Paired.');
        return 'paired';
      }
      this.dropped += 1;
      return null;
    }
    if (who.account !== this.pairing.account_id) { this.dropped += 1; return null; }
    if (who.key !== this.pairing.identity_key) { this.identityChanged += 1; this.dropped += 1; return null; }
    // One-time codes (contracts/channel.md): while a slot is open, a message that is only a code goes to the
    // broker, and the core gets a placeholder. Codes are never stored or logged here.
    const slot = this.brokerSocket ? this.#openSlot() : null;
    const code = text.replace(/[\s-]/g, '');
    if (slot && /^[A-Za-z0-9]{4,10}$/.test(code)) {
      this.slots.delete(slot.slot_id);
      const r = await call(this.brokerSocket, request('code.deliver', `channel-${this.name}`, null, { slot_id: slot.slot_id, code }));
      // Never forward the code itself, even if the slot closed meanwhile.
      text = r.ok ? '[one-time code delivered]' : '[one-time code not delivered: the request for it had closed]';
    }
    const args = { channel: this.name, message_id: `in-${ulid()}`, from: who.account, from_display: who.display, text, attachments: [], received_at: nowIso() };
    return call(this.coreSocket, request('channel.inbound', `channel-${this.name}`, null, args));
  }
}
