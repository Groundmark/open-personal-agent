// The core (contracts/core.md): read the message, think, call the other parts, reply.
// It knows the other parts only through their contracts: the router (infer), the broker (grants,
// mcp.call, identity) and the channel adapters (channel.send). It never holds a secret.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConversationLog } from './log.js';
import { call, envelope, infer, ulid } from './wire.js';

const MAX_STEPS = 8;          // model calls per turn, before the core gives up and says so
const KEEP = 60;              // messages of an errand the model sees
const BOOK = { type: 'object', additionalProperties: false, required: ['service', 'date', 'time', 'party_size'], properties: {
  service: { type: 'string', description: 'Which restaurant, by its key' },
  date: { type: 'string', description: 'YYYY-MM-DD' }, time: { type: 'string', description: 'HH:MM, 24-hour' },
  party_size: { type: 'integer', minimum: 1 }, notes: { type: 'string', description: 'Anything the restaurant should know' },
} };

export class Core {
  /**
   * services: { <key>: { name, credential, server, book_tool, search_tool? } }: the places the agent can book,
   *   reached by the broker's mcp.call (contracts/broker.md).
   * channels: { <channel name>: <adapter socket path> }.
   */
  constructor({ stateDir, routerUrl, brokerSocket, channels, services, model = 'default', timezone = 'UTC', idleHours = 6, now = () => new Date() }) {
    Object.assign(this, { stateDir, routerUrl, brokerSocket, channels, services, model, timezone, idleMs: idleHours * 3600_000, now });
    this.log = new ConversationLog(join(stateDir, 'conversation.jsonl'));
    this.file = join(stateDir, 'errands.json');
    this.errands = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : {};
    // What's on disk is each errand's last checkpoint, not the live state: saving one errand never writes
    // another errand's half-finished step.
    this.committed = structuredClone(this.errands);
    this.queues = new Map();
  }

  /** A checkpoint for one errand: its state now becomes what's on disk for it. */
  #save(e) {
    const key = Object.keys(this.errands).find((k) => this.errands[k] === e);
    if (key) this.committed[key] = structuredClone(e);
    writeFileSync(this.file + '.tmp', JSON.stringify(this.committed), { mode: 0o600 });
    renameSync(this.file + '.tmp', this.file);
  }

  /** One thing at a time per errand, in arrival order. */
  #queue(key, fn) {
    const p = (this.queues.get(key) ?? Promise.resolve()).then(fn).catch((e) => console.error(`core: errand ${key}: ${e.stack || e}`));
    this.queues.set(key, p);
    return p;
  }

  handlers() {
    return {
      'channel.inbound': async (a) => {
        if (!this.channels[a.channel]) throw Object.assign(new Error(`no channel ${a.channel}`), { code: 'bad_request' });
        const key = `${a.channel}:${a.from}`;
        this.#queue(key, () => this.#inbound(key, a));
        return {};
      },
      'grant.event': async ({ grant_id, state }) => {
        const key = Object.keys(this.errands).find((k) => this.errands[k].grants?.[grant_id]);
        if (key) this.#queue(key, () => this.#grantEvent(key, grant_id, state));
        return {};
      },
    };
  }

  /** At start: ask the broker about requests still marked pending here, in case a decision was missed. */
  async reconcile() {
    for (const [key, e] of Object.entries(this.errands)) {
      if (e.resume) {   // a turn that a crash interrupted
        // A tool call saved without its result: its outcome is unknown, and the model is told so before going on.
        const last = e.transcript.at(-1);
        const open = last?.role === 'assistant' && Array.isArray(last.content) ? last.content.filter((p) => p.type === 'tool_call') : [];
        if (open.length) e.transcript.push({ role: 'tool', content: open.map((c) => ({ type: 'tool_result', call_id: c.call_id, is_error: true,
          content: { error: 'interrupted', message: 'This step was interrupted by a restart; its outcome is unknown.' } })) });
        this.#queue(key, () => this.#turn(e));
      }
      for (const [id, g] of Object.entries(e.grants ?? {})) {
        if (g.state !== 'pending') continue;
        let st; try { st = await this.#broker(e, 'grant.status', { grant_id: id }); } catch { continue; }
        const state = st.state === 'consumed' ? 'approved' : st.state;
        if (['approved', 'denied', 'expired'].includes(state)) this.#queue(key, () => this.#grantEvent(key, id, state));
      }
    }
  }

  async #inbound(key, a) {
    let e = this.errands[key];
    if (!e || this.now() - Date.parse(e.last_active) > this.idleMs) {
      e = this.errands[key] = { errand_id: ulid(), channel: a.channel, to: a.from, transcript: [], grants: {}, last_active: null };
    }
    e.last_active = this.now().toISOString();
    this.log.append({ errand_id: e.errand_id, type: 'message', direction: 'in', channel: a.channel, message_id: a.message_id, text: a.text, attachments: a.attachments ?? [] });
    e.transcript.push({ role: 'user', content: a.text });
    await this.#turn(e);
  }

  async #grantEvent(key, grantId, state) {
    const e = this.errands[key], g = e.grants[grantId];
    if (!g || g.state !== 'pending') return;
    g.state = state;
    const said = { approved: 'approved', denied: 'declined', expired: 'did not answer in time for' }[state] ?? state;
    e.transcript.push({ role: 'user', content: `(Note from the agent's own system, not the person: the person ${said} this request: "${g.summary}".`
      + `${state === 'approved' && g.kind === 'book' ? ' You can now call complete_booking.' : ''})` });
    // The decision, the note and "a turn is owed" are saved together before the model runs, so a crash anywhere
    // after this is picked up at start (reconcile) rather than lost.
    e.resume = true;
    this.#save(e);
    await this.#turn(e);
  }

  /** Ask the model, run its tools, repeat until it answers; then send the answer. */
  async #turn(e) {
    let text = '';
    for (let step = 0; step < MAX_STEPS; step++) {
      const r = await infer(this.routerUrl, envelope('infer', e.errand_id, { model: this.model, system: this.#system(), messages: e.transcript.slice(-KEEP), tools: this.#tools() }));
      if (!r.ok) { text = `Sorry, I couldn't think that through just now (${r.error}). Please try again in a moment.`; break; }
      const { content, tool_calls: calls, stop } = r.result;
      text = content.map((p) => p.text).join('\n').trim();
      e.transcript.push({ role: 'assistant', content: [...content, ...calls.map((c) => ({ type: 'tool_call', ...c }))] });
      if (!calls.length) { if (stop === 'refused') text ||= "Sorry, I can't help with that."; break; }
      const results = [];
      for (const c of calls) {
        let out;
        try { out = await this.#tool(e, c.name, c.arguments ?? {}); } catch (err) { out = { error: err.code ?? 'failed', message: err.message }; }
        results.push({ type: 'tool_result', call_id: c.call_id, content: out, ...(out?.error ? { is_error: true } : {}) });
      }
      e.transcript.push({ role: 'tool', content: results });
      this.#save(e);   // what the tools did (a booking, say) is kept, with their results, before the model runs again
      if (step === MAX_STEPS - 1) text = 'Sorry, I got stuck on that. Could you say it another way?';
    }
    // An approval asked for in this turn goes out with the agent's words, as one message.
    const ask = e.ask; delete e.ask;
    if (text || ask) await this.#say(e, [text, ask].filter(Boolean).join('\n\n'));
    delete e.resume;
    this.#save(e);
  }

  async #say(e, text) {
    const r = await call(this.channels[e.channel], envelope('channel.send', e.errand_id, { channel: e.channel, to: e.to, text, attachments: [] }));
    if (!r.ok) { console.error(`core: channel.send failed: ${r.error}`); return; }
    this.log.append({ errand_id: e.errand_id, type: 'message', direction: 'out', channel: e.channel, message_id: r.result.message_id, text, attachments: [] });
  }

  async #broker(e, op, args) {
    const r = await call(this.brokerSocket, envelope(op, e.errand_id, args));
    if (!r.ok) throw Object.assign(new Error(r.message || r.error), { code: r.error });
    return r.result;
  }

  #system() {
    const now = this.now();
    const local = new Intl.DateTimeFormat('en-GB', { timeZone: this.timezone, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(now);
    const places = Object.entries(this.services).map(([k, s]) => `- ${k}: ${s.name}`).join('\n');
    return `You are a personal agent working for one person, talking with them by message. Be brief and plain.
It is ${local} (${this.timezone}). Places you can book:
${places}

How bookings work: when the person wants a table and you know the place, date, time and party size, call request_booking. The person then approves it with their passkey; you can't book without that. When you're told it was approved, call complete_booking and tell them the confirmation. If something is missing or unclear, ask first; don't guess. Use search_tables only when the person asks what's available. Never ask for or repeat passwords or one-time codes.`;
  }

  #tools() {
    const t = [
      { name: 'request_booking', description: 'Ask the person to approve one booking (they approve with their passkey).', parameters: BOOK },
      { name: 'complete_booking', description: 'Make the booking the person just approved.', parameters: { type: 'object', properties: {} } },
    ];
    if (Object.values(this.services).some((s) => s.search_tool)) {
      t.push({ name: 'search_tables', description: 'See which times are free at a place.', parameters: { ...BOOK, required: ['service', 'date', 'party_size'] } });
    }
    return t;
  }

  async #tool(e, name, a) {
    if (name === 'request_booking') {
      const s = this.services[a.service];
      if (!s) return { error: 'unknown_service', message: `known: ${Object.keys(this.services).join(', ')}` };
      const constraints = { venue: s.name, date: a.date, time: a.time, party_size: a.party_size, ...(a.notes ? { notes: a.notes } : {}) };
      const g = await this.#broker(e, 'grant.request', { credential: s.credential, ops: ['book'], constraints, mode: 'one_shot', ttl_seconds: 1800, purpose: `Book a table at ${s.name}` });
      e.grants[g.grant_id] = { kind: 'book', state: 'pending', service: a.service, constraints, summary: g.summary };
      e.ask = `${g.summary}\nApprove: ${g.approve_url}`;
      return { status: 'waiting_for_approval', summary: g.summary, note: 'The approval request goes to the person with your reply. Say in one short sentence that it needs their approval; don\'t repeat the details.' };
    }
    if (name === 'complete_booking') {
      const [id, g] = Object.entries(e.grants).reverse().find(([, x]) => x.kind === 'book' && x.state === 'approved') ?? [];
      if (!id) return { error: 'not_approved', message: 'There is no approved booking waiting. Ask the person to approve first.' };
      const s = this.services[g.service];
      await this.#broker(e, 'identity.declaration', { grant_id: id, act: 'book' });   // the broker takes the rest from the grant
      let r;
      try { r = await this.#broker(e, 'mcp.call', { grant_id: id, server: s.server, tool: s.book_tool, arguments: g.constraints }); } catch (err) {
        if (err.code !== 'grant_consumed') throw err;
        // Already used (or being used): whether the booking went through can't be known from here. Say exactly that.
        g.state = 'used';
        return { booked: 'unknown', note: "Say: I couldn't confirm whether the booking went through. Please check with the restaurant before trying again." };
      }
      g.state = 'used';   // saved together with this call's result, at the end of the step
      return { booked: true, result: r.content };
    }
    if (name === 'search_tables') {
      const s = this.services[a.service];
      if (!s?.search_tool) return { error: 'unknown_service', message: `known: ${Object.keys(this.services).join(', ')}` };
      const [id] = Object.entries(e.grants).find(([, x]) => x.kind === 'search' && x.service === a.service && x.state === 'approved') ?? [];
      if (!id) {
        const g = await this.#broker(e, 'grant.request', { credential: s.credential, ops: ['search'], mode: 'standing', ttl_seconds: 7 * 24 * 3600, purpose: `Check availability at ${s.name}` });
        e.grants[g.grant_id] = { kind: 'search', state: 'pending', service: a.service, summary: g.summary };
        e.ask = `${g.summary}\nApprove: ${g.approve_url}`;
        return { status: 'waiting_for_approval', note: 'The approval request goes to the person with your reply. Say in one short sentence that you need their OK to check availability.' };
      }
      return (await this.#broker(e, 'mcp.call', { grant_id: id, server: s.server, tool: s.search_tool, arguments: a })).content;
    }
    return { error: 'unknown_tool', message: name };
  }
}
