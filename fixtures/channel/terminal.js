// Terminal channel fixture (contracts/channel.md). Serves channel.send (prints, and keeps
// an outbox for tests) and turns lines of input into channel.inbound for the core.
// Only the allowlisted sender reaches the core; anything else is dropped and counted.
import { ContractError, serve, call, request, ulid, nowIso } from '../lib/wire.js';

export class TerminalChannel {
  constructor({ name = 'terminal', sender = 'person@fixture', coreSocket = null, print = true }) {
    this.name = name;
    this.sender = sender;
    this.allow = new Set([sender]);
    this.coreSocket = coreSocket;
    this.print = print;
    this.outbox = [];
    this.dropped = 0;
  }

  handlers() {
    return {
      'channel.send': async (a) => {
        if (!this.allow.has(a.to)) throw new ContractError('recipient_not_allowed', a.to);
        const msg = { message_id: `out-${ulid()}`, sent_at: nowIso() };
        this.outbox.push({ ...a, ...msg });
        if (this.print) process.stdout.write(`agent> ${a.text}\n`);
        return msg;
      },
    };
  }

  listen(socketPath) { return serve(socketPath, this.handlers()); }

  /** Simulate a message arriving. Returns the core's response, or null if dropped. */
  async inbound(text, from = this.sender) {
    if (!this.allow.has(from)) { this.dropped += 1; return null; }
    const args = { channel: this.name, message_id: `in-${ulid()}`, from, text, attachments: [], received_at: nowIso() };
    return call(this.coreSocket, request('channel.inbound', `channel-${this.name}`, null, args));
  }
}
