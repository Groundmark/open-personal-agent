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

// Durable state, per errand (errands.json, written at checkpoints):
//   inbox   messages accepted from a channel and not yet answered. Saved before the channel is told "got it".
//   transcript, grants, asks   the conversation so far, the approvals asked for, the links still to send.
//   resume  model work is owed (a turn was running). At start the turn is finished, never started twice.
//   outbox  replies decided but not yet delivered, oldest first. Sent at least once: a crash between the send
//           and the next checkpoint can repeat a message, but never loses one.
//   seen    ids of the last 200 messages taken into a turn; with the ids in the inbox, a message sent twice is
//           answered once. (A repeat of a message older than that would be answered again.)
// If a checkpoint or the conversation log can't be written, the core stops (onFatal) rather than carry on from
// state it can't keep; systemd restarts it from the last checkpoint.

const SEEN = 200;
const RETRY_MS = [5_000, 30_000, 120_000];   // a failed send is retried after these, then every last one, while anything is owed
const SEND_TIMEOUT_MS = 30_000;              // a channel that takes the connection but never answers doesn't hold up the errand
// Refusals that a retry can't change: the message is logged as undeliverable and dropped, so it doesn't block later ones.
const UNDELIVERABLE = ['recipient_not_allowed', 'not_paired', 'attachment_too_large', 'bad_request', 'unauthorized_caller'];
const toolCalls = (m) => (m?.role === 'assistant' && Array.isArray(m.content) ? m.content.filter((p) => p.type === 'tool_call') : []);

export class Core {
  /**
   * services: { <key>: { name, credential, server, book_tool, search_tool? } }: the places the agent can book,
   *   reached by the broker's mcp.call (contracts/broker.md).
   * channels: { <channel name>: <adapter socket path> }.
   */
  constructor({ stateDir, routerUrl, brokerSocket, channels, services, model = 'default', timezone = 'UTC', idleHours = 6, now = () => new Date(),
    retryMs = RETRY_MS, reconcileRetryMs = 30_000, sendTimeoutMs = SEND_TIMEOUT_MS, onFatal = (err) => { console.error(`core: can't keep state, stopping: ${err.message}`); process.exit(70); } }) {
    Object.assign(this, { stateDir, routerUrl, brokerSocket, channels, services, model, timezone, idleMs: idleHours * 3600_000, now, retryMs, reconcileRetryMs, sendTimeoutMs, onFatal });
    this.log = new ConversationLog(join(stateDir, 'conversation.jsonl'));
    this.file = join(stateDir, 'errands.json');
    this.errands = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : {};
    for (const e of Object.values(this.errands)) {   // state from before these fields existed
      e.inbox ??= []; e.outbox ??= []; e.seen ??= [];
      e.transcript = e.transcript.filter((m) => !(m.role === 'assistant' && Array.isArray(m.content) && !m.content.length));   // empty replies kept by earlier versions
      // An approval link saved by the first version, whose reply never went out: a turn is owed to send it.
      if (typeof e.ask === 'string') { e.asks = [...(e.asks ?? []), e.ask]; delete e.ask; e.resume = true; }
    }
    // What's on disk is each errand's last checkpoint, not the live state: saving one errand never writes
    // another errand's half-finished step.
    this.committed = structuredClone(this.errands);
    this.queues = new Map();
    this.retries = new Map();   // errand -> failed sends in a row
    this.timers = new Map();    // errand -> its one pending retry
    this.dead = false;
    this.resumed = false;
  }

  /** Stops everything: no more jobs, no more "got it" to channels. */
  #fatal(err) {
    this.dead = true;
    this.onFatal(err);
    throw Object.assign(err, { fatal: true });
  }

  /**
   * A checkpoint. With an errand, its live state becomes what's on disk for it. Every errand's inbox, seen and
   * last_active are always saved as they are now (they only change where that's safe), so a message accepted
   * during another step's checkpoint is never dropped. The new state counts only once it's on disk.
   */
  #save(e = null) {
    const next = { ...this.committed };
    const key = e && Object.keys(this.errands).find((k) => this.errands[k] === e);
    if (key) next[key] = structuredClone(e);
    for (const [k, x] of Object.entries(this.errands)) {
      if (next[k]?.errand_id === x.errand_id) next[k] = { ...next[k], inbox: structuredClone(x.inbox), seen: [...x.seen], last_active: x.last_active };
    }
    try {
      writeFileSync(this.file + '.tmp', JSON.stringify(next), { mode: 0o600 });
      renameSync(this.file + '.tmp', this.file);
    } catch (err) { this.#fatal(err); }
    this.committed = next;
  }

  #append(entry) {
    try { this.log.append(entry); } catch (err) { this.#fatal(err); }
  }

  /** One thing at a time per errand, in arrival order. */
  #queue(key, fn) {
    const p = (this.queues.get(key) ?? Promise.resolve()).then(() => (this.dead ? undefined : fn()))
      .catch((err) => console.error(`core: errand ${key}: ${err.stack || err}`));
    this.queues.set(key, p);
    return p;
  }

  handlers() {
    return {
      'channel.inbound': async (a) => {
        if (this.dead) throw Object.assign(new Error('core is stopping'), { code: 'unavailable' });
        if (!this.channels[a.channel]) throw Object.assign(new Error(`no channel ${a.channel}`), { code: 'bad_request' });
        const key = `${a.channel}:${a.from}`;
        if (this.#accept(key, a)) this.#queue(key, () => this.#nextInbound(key));
        return {};
      },
      'grant.event': async ({ grant_id, state }) => {
        if (this.dead) throw Object.assign(new Error('core is stopping'), { code: 'unavailable' });
        const key = Object.keys(this.errands).find((k) => this.errands[k].grants?.[grant_id]);
        if (key) this.#queue(key, () => this.#grantEvent(key, grant_id, state));
        return {};
      },
    };
  }

  /** Nothing owed and nothing waiting: a new message after the idle time starts a new errand. */
  #finished(e) {
    // A pending approval ends when the broker says so (approved, denied, or expired after its own waiting time).
    return !e.resume && !e.inbox.length && !e.outbox.length && !e.asks?.length && !Object.values(e.grants ?? {}).some((g) => g.state === 'pending');
  }

  /** Records an arriving message and saves it, before the channel hears "got it". Synchronous. False if it's a repeat. */
  #accept(key, a) {
    let e = this.errands[key];
    if (a.message_id && (e?.seen.includes(a.message_id) || e?.inbox.some((m) => m.message_id === a.message_id))) return false;   // sent twice: already taken
    if (!e || (this.now() - Date.parse(e.last_active) > this.idleMs && this.#finished(e))) {
      e = this.errands[key] = { errand_id: ulid(), channel: a.channel, to: a.from, transcript: [], grants: {}, inbox: [], outbox: [], seen: e?.seen ?? [], last_active: null };
      this.#save(e);
    }
    e.last_active = this.now().toISOString();
    this.#append({ errand_id: e.errand_id, type: 'message', direction: 'in', channel: a.channel, message_id: a.message_id, text: a.text, attachments: a.attachments ?? [] });
    e.inbox.push({ text: a.text, message_id: a.message_id ?? null });
    this.#save();
    return true;
  }

  /**
   * At start, before the socket opens: queue what a crash interrupted, ahead of anything new. Each job looks at
   * the errand's state when it runs, so nothing is done twice.
   */
  resume() {
    if (this.resumed) return;
    this.resumed = true;
    for (const [key, e] of Object.entries(this.errands)) {
      if (e.resume) {
        this.#queue(key, async () => {
          if (!e.resume) return;
          this.#closeCalls(e, 'interrupted', 'This step was interrupted by a restart; its outcome is unknown.');
          this.#save(e);
          await this.#turn(e);
        });
      } else if (e.outbox.length) this.#queue(key, () => this.#flush(key));
      for (let i = 0; i < e.inbox.length; i++) this.#queue(key, () => this.#nextInbound(key));
    }
  }

  /** At start: resume, then ask the broker about requests still marked pending here, in case a decision was missed. */
  async reconcile() {
    this.resume();
    let unreachable = false;
    for (const [key, e] of Object.entries(this.errands)) {
      for (const [id, g] of Object.entries(e.grants ?? {})) {
        if (g.state !== 'pending') continue;
        let st;
        try { st = await this.#broker(e, 'grant.status', { grant_id: id }); } catch (err) {
          if (err.code === 'grant_not_found') st = { state: 'expired' };   // the broker no longer has it: it can't be approved now
          else { if (!/^[a-z_]+$/.test(err.code ?? '')) unreachable = true; continue; }   // a broker error has a contract code; anything else is the transport
        }
        const state = st.state === 'consumed' ? 'approved' : st.state;
        if (['approved', 'denied', 'expired'].includes(state)) this.#queue(key, () => this.#grantEvent(key, id, state));
      }
    }
    // The broker may not be up yet: try again until it answers, so a decision made while we were down isn't missed.
    if (unreachable && !this.dead) setTimeout(() => this.reconcile().catch((err) => console.error('core: reconcile failed:', err.message)), this.reconcileRetryMs).unref();
  }

  async #nextInbound(key) {
    const e = this.errands[key];
    const m = e.inbox[0];
    if (!m) return;
    e.inbox.shift();
    if (m.message_id) e.seen = [...e.seen, m.message_id].slice(-SEEN);   // only ever evicts messages already answered
    e.transcript.push({ role: 'user', content: m.text });
    e.resume = true;
    this.#save(e);   // the message is now the turn's, and the turn is owed
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
    // after this is picked up at start (resume) rather than lost.
    e.resume = true;
    this.#save(e);
    await this.#turn(e);
  }

  /** Gives every tool call in the last step that has no result an error result, so the transcript stays whole. */
  #closeCalls(e, error, message) {
    const t = e.transcript;
    const i = t.findLastIndex((m) => m.role === 'assistant');
    if (i < t.length - 2) return;
    const calls = toolCalls(t[i]);
    if (!calls.length) return;
    let results = t[i + 1];
    if (!results) t.push(results = { role: 'tool', content: [] });
    const have = new Set(results.content.map((p) => p.call_id));
    for (const c of calls) if (!have.has(c.call_id)) results.content.push({ type: 'tool_result', call_id: c.call_id, is_error: true, content: { error, message } });
  }

  /** What the model sees: the last KEEP messages, widened back to the user message that starts that turn. */
  #window(e) {
    const t = e.transcript;
    let i = Math.max(0, t.length - KEEP);
    while (i > 0 && t[i].role !== 'user') i--;
    return t.slice(i);
  }

  /** Ask the model, run its tools, repeat until it answers; then queue the answer and send it. */
  async #turn(e) {
    await this.#flush(this.#keyOf(e));   // a reply already owed goes before this turn's thinking
    let text;
    try { text = await this.#think(e); } catch (err) {
      if (err.fatal) throw err;
      console.error(`core: errand ${e.errand_id}: turn failed: ${err.stack || err}`);
      this.#closeCalls(e, 'failed', 'This step failed; its outcome is unknown.');
      text = "Sorry, something went wrong on my side, so I can't tell whether that worked. Please check before trying again.";
    }
    // The approvals asked for in this turn go out with the agent's words, as one message.
    const msg = [text, ...(e.asks ?? [])].filter(Boolean).join('\n\n');
    delete e.asks;
    if (msg) e.outbox.push(msg);
    delete e.resume;
    this.#save(e);   // the reply is decided: from here it's owed until sent
    await this.#flush(this.#keyOf(e));
  }

  async #think(e) {
    for (let step = 0; step < MAX_STEPS; step++) {
      const r = await infer(this.routerUrl, envelope('infer', e.errand_id, { model: this.model, system: this.#system(), messages: this.#window(e), tools: this.#tools() }));
      if (!r.ok) {
        // Once a tool has run this turn (a booking, say), "try again" could mean doing it twice.
        return this.#actedThisTurn(e)
          ? `Sorry, I couldn't finish that just now (${r.error}), so I can't tell whether it worked. Please check before trying again.`
          : `Sorry, I couldn't think that through just now (${r.error}). Please try again in a moment.`;
      }
      const { content, tool_calls: calls, stop } = r.result;
      const text = content.map((p) => p.text).join('\n').trim();
      // An empty reply (no text, no calls) isn't kept: a message with no parts is refused by the router.
      if (content.length || calls.length) e.transcript.push({ role: 'assistant', content: [...content, ...calls.map((c) => ({ type: 'tool_call', ...c }))] });
      if (!calls.length) {
        return stop === 'refused' ? text || "Sorry, I can't help with that." : text;
      }
      const results = { role: 'tool', content: [] };
      e.transcript.push(results);
      if (step === MAX_STEPS - 1) {
        // Out of steps: what the model asked for now is not done, since it would never see the outcome to report it.
        for (const c of calls) results.content.push({ type: 'tool_result', call_id: c.call_id, is_error: true, content: { error: 'not_run', message: 'Too many steps in one turn; this was not done.' } });
        this.#save(e);
        return "Sorry, I got stuck on that and stopped before doing the last thing I was about to do. Could you say it another way?";
      }
      this.#save(e);   // the calls are saved before they run, so a crash mid-call is known to be one
      for (const c of calls) {
        let out;
        try { out = await this.#tool(e, c.name, c.arguments ?? {}); } catch (err) {
          if (err.fatal) throw err;
          out = { error: err.code ?? 'failed', message: err.message };
        }
        results.content.push({ type: 'tool_result', call_id: c.call_id, content: out, ...(out?.error ? { is_error: true } : {}) });
        this.#save(e);   // each result (a booking, say) is kept as soon as it's known
      }
    }
  }

  /** True if a tool ran (or may have run) since the message that started this turn. */
  #actedThisTurn(e) {
    const t = e.transcript;
    for (let i = t.length - 1; i >= 0 && t[i].role !== 'user'; i--) {
      if (t[i].role === 'tool' && t[i].content.some((p) => p.content?.error !== 'not_run')) return true;
    }
    return false;
  }

  #keyOf(e) { return Object.keys(this.errands).find((k) => this.errands[k] === e); }

  /** One retry timer per errand: after 5 s, 30 s, then every 2 min for as long as a reply is owed. */
  #retryLater(key) {
    if (this.timers.has(key) || this.dead) return;
    const n = this.retries.get(key) ?? 0;
    this.retries.set(key, n + 1);
    const t = setTimeout(() => { this.timers.delete(key); this.#queue(key, () => this.#flush(key)); }, this.retryMs[Math.min(n, this.retryMs.length - 1)]);
    t.unref();
    this.timers.set(key, t);
  }

  /** Sends what's owed, oldest first, stopping at the first failure (retried later). */
  async #flush(key) {
    const e = this.errands[key];
    while (e?.outbox.length) {
      const text = e.outbox[0];
      let r;
      try {
        r = await call(this.channels[e.channel], envelope('channel.send', e.errand_id, { channel: e.channel, to: e.to, text, attachments: [] }), { timeoutMs: this.sendTimeoutMs });
      } catch (err) { r = { ok: false, error: 'channel_unavailable', message: err.message }; }   // no answer at all: try again later
      if (!r?.ok && !UNDELIVERABLE.includes(r?.error)) {
        console.error(`core: channel.send failed (${r?.error}), will retry`);
        this.#retryLater(key);
        return;
      }
      this.retries.delete(key);   // it got through: the next failure starts the retries afresh
      clearTimeout(this.timers.get(key));
      this.timers.delete(key);
      e.outbox.shift();
      if (r.ok) this.#append({ errand_id: e.errand_id, type: 'message', direction: 'out', channel: e.channel, message_id: r.result?.message_id ?? null, text, attachments: [] });
      else console.error(`core: channel.send refused (${r.error}); this message can't be delivered and is dropped`);
      this.#save(e);
    }
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
      (e.asks ??= []).push(`${g.summary}\nApprove: ${g.approve_url}`);
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
        (e.asks ??= []).push(`${g.summary}\nApprove: ${g.approve_url}`);
        return { status: 'waiting_for_approval', note: 'The approval request goes to the person with your reply. Say in one short sentence that you need their OK to check availability.' };
      }
      return (await this.#broker(e, 'mcp.call', { grant_id: id, server: s.server, tool: s.search_tool, arguments: a })).content;
    }
    return { error: 'unknown_tool', message: name };
  }
}
