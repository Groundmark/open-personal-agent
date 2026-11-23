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
    const args = { channel: this.name, message_id: `in-${ulid()}`, from: who.account, from_display: who.display, text, attachments: [], received_at: nowIso() };
    return call(this.coreSocket, request('channel.inbound', `channel-${this.name}`, null, args));
  }
}
