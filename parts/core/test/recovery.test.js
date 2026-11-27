// What happens around the happy path: crashes mid-turn, a channel or router that's down, two approvals at once,
// repeated messages, long errands, a log cut off mid-write. Stand-ins for the router, broker and channel are
// built here, so these run without the fixtures. Crash tests run the real core as a process and kill -9 it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Core } from '../src/core.js';
import { ConversationLog } from '../src/log.js';
import { call, envelope, serve } from '../src/wire.js';

const MAIN = fileURLToPath(new URL('../src/main.js', import.meta.url));
const SERVICES = { 'casa-verde': { name: 'Casa Verde', credential: 'fake-mcp', server: 'fake-reservations', book_tool: 'book_table' } };
const BOOK = { service: 'casa-verde', date: '2026-12-04', time: '19:00', party_size: 2 };
const until = async (f, ms = 5000) => { const t = Date.now(); while (!(await f())) { if (Date.now() - t > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 10)); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hang = () => new Promise(() => {});

const last = (args) => args.messages.at(-1);
const lastText = (args) => { const m = last(args); return typeof m.content === 'string' ? m.content : JSON.stringify(m.content); };
const say = (text) => ({ content: [{ type: 'text', text }], tool_calls: [], stop: 'end' });
let n = 0;
const use = (...calls) => ({ content: [], tool_calls: calls.map(([name, args]) => ({ call_id: `c${++n}`, name, arguments: args })), stop: 'tool_calls' });

/** Stand-in router, broker and channel around a state dir. route(args) returns a result, or a promise. */
async function world(route) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opa-core-rec-'));
  const w = { dir, infers: [], sent: [], grants: [], channelDown: false, route };
  w.router = http.createServer(async (req, res) => {
    let b = ''; for await (const c of req) b += c;
    const env = JSON.parse(b);
    w.infers.push(env.args);
    const r = await w.route(env.args, w);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(r?.raw ?? { id: env.id, ok: true, result: { usage: { input_tokens: 1, output_tokens: 1 }, ...r } }));
  });
  await new Promise((r) => w.router.listen(0, '127.0.0.1', r));
  w.routerUrl = `http://127.0.0.1:${w.router.address().port}/infer`;
  w.brokerSock = path.join(dir, 'broker.sock');
  w.channelSock = path.join(dir, 'channel.sock');
  w.coreSock = path.join(dir, 'core.sock');
  w.broker = await serve(w.brokerSock, {
    'grant.request': async (a) => { const id = `G${w.grants.length + 1}`; w.grants.push(id); if (w.onGrant) await w.onGrant(id); return { grant_id: id, summary: `Approve request ${id}`, approve_url: `https://approve.test/a/${id}` }; },
    'grant.status': async () => ({ state: 'pending' }),
  });
  w.channel = await serve(w.channelSock, {
    'channel.send': async (a) => {
      if (w.channelDown) throw Object.assign(new Error('down'), { code: 'unavailable' });
      w.sent.push(a.text);
      return { message_id: `m${w.sent.length}`, sent_at: new Date().toISOString() };
    },
  });
  w.opts = (extra = {}) => ({ stateDir: dir, routerUrl: w.routerUrl, brokerSocket: w.brokerSock, channels: { web: w.channelSock }, services: SERVICES,
    onFatal: (err) => { w.fatal = err; }, ...extra });
  w.inbound = (core, text, message_id = `in-${Math.random()}`) => core.handlers()['channel.inbound']({ channel: 'web', message_id, from: 'person', text, attachments: [], received_at: new Date().toISOString() });
  w.state = () => JSON.parse(fs.readFileSync(path.join(dir, 'errands.json'), 'utf8'));
  /** The real core as a process, on its own socket. */
  w.start = async () => {
    const cfg = path.join(dir, 'core.json');
    fs.writeFileSync(cfg, JSON.stringify({ state_dir: dir, router_url: w.routerUrl, broker_socket: w.brokerSock, channels: { web: w.channelSock }, services: SERVICES, socket: w.coreSock }));
    const child = spawn(process.execPath, [MAIN, cfg], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stderr.on('data', (b) => { w.stderr = (w.stderr ?? '') + b; });
    await new Promise((res, rej) => { let out = ''; child.stdout.on('data', (b) => { out += b; if (out.includes('core: channels')) res(); }); child.on('exit', () => rej(new Error(`core exited: ${w.stderr}`))); });
    w.child = child;
    return child;
  };
  w.kill = () => new Promise((r) => { if (!w.child || w.child.exitCode !== null) return r(); w.child.once('exit', r); w.child.kill('SIGKILL'); });
  w.send = (text, message_id = `in-${Math.random()}`) => call(w.coreSock, envelope('channel.inbound', null, { channel: 'web', message_id, from: 'person', text, attachments: [], received_at: new Date().toISOString() }));
  w.stop = async () => { await w.kill(); w.router.closeAllConnections(); w.router.close(); w.broker.close(); w.channel.close(); };
  return w;
}

/** The booking script: ask for approval, then say so; a step told "interrupted" says that. */
const booking = (args) => {
  const t = lastText(args);
  if (t.includes('interrupted')) return say('Something was interrupted.');
  if (t.includes('waiting_for_approval')) return say('That needs your approval.');
  if (t.startsWith('Book')) return use(['request_booking', BOOK]);
  return say('OK.');
};

test('two approvals asked for in one step both go out, with the reply', async () => {
  const w = await world((args) => (lastText(args).startsWith('Book') ? use(['request_booking', BOOK], ['request_booking', { ...BOOK, time: '20:00' }]) : booking(args)));
  try {
    const core = new Core(w.opts());
    await w.inbound(core, 'Book two tables');
    await until(() => w.sent.length === 1);
    assert.match(w.sent[0], /That needs your approval\.[\s\S]*approve\.test\/a\/G1[\s\S]*approve\.test\/a\/G2/);
  } finally { await w.stop(); }
});

test('a router that is down, or answers nonsense, gets the person a reply', async () => {
  const w = await world(() => ({ raw: { ok: true, result: { content: 'not a list' } } }));
  try {
    const core = new Core(w.opts());
    await w.inbound(core, 'hello');
    await until(() => w.sent.length === 1);
    assert.match(w.sent[0], /couldn't think that through.*router_unavailable/);
    const down = new Core(w.opts({ routerUrl: 'http://127.0.0.1:9/infer' }));
    await w.inbound(down, 'hello again');
    await until(() => w.sent.length === 2);
    assert.match(w.sent[1], /router_unavailable/);
    assert.equal(w.state()['web:person'].resume, undefined);
  } finally { await w.stop(); }
});

test('a channel that is down: the reply waits, in order, and is delivered once when it is back', async () => {
  const w = await world(booking);
  try {
    w.channelDown = true;
    const core = new Core(w.opts({ retryMs: [100, 100, 100] }));
    await w.inbound(core, 'Book a table');
    await until(() => w.state()['web:person'].outbox.length === 1);
    await w.inbound(core, 'thanks');                         // another turn while the first reply is stuck
    await until(() => w.state()['web:person'].outbox.length === 2);
    assert.match(w.state()['web:person'].outbox[0], /approve\.test\/a\/G1/);   // the link is kept on disk
    w.channelDown = false;
    await until(() => w.sent.length === 2);
    await sleep(300);
    assert.equal(w.sent.length, 2);
    assert.match(w.sent[0], /approve\.test\/a\/G1/);
    assert.equal(w.sent[1], 'OK.');
    assert.deepEqual(w.state()['web:person'].outbox, []);
  } finally { await w.stop(); }
});

test('a message sent twice (same message_id) is answered once, before and after it is handled', async () => {
  const w = await world(() => say('Hi.'));
  try {
    const core = new Core(w.opts());
    await w.inbound(core, 'hello', 'dup-1');
    await w.inbound(core, 'hello', 'dup-1');
    await until(() => w.sent.length === 1);
    await w.inbound(core, 'hello', 'dup-1');
    await sleep(100);
    assert.equal(w.infers.length, 1);
    assert.equal(w.sent.length, 1);
  } finally { await w.stop(); }
});

test('more than 200 messages: a repeat of one still waiting, or being answered, is not taken again', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const w = await world(async () => { await gate; return say('OK.'); });
  try {
    const core = new Core(w.opts());
    for (let i = 0; i < 202; i++) await w.inbound(core, `m${i}`, `id-${i}`);
    await until(() => w.infers.length === 1);        // id-0 is being answered, the rest wait
    await w.inbound(core, 'm0', 'id-0');
    await w.inbound(core, 'm1', 'id-1');
    assert.equal(w.state()['web:person'].inbox.length, 201);
    release();
    await until(() => w.sent.length === 202, 20000);
    await sleep(100);
    assert.equal(w.sent.length, 202);
  } finally { await w.stop(); }
});

test('a reply already owed at start goes out before the next turn thinks', async () => {
  const w = await world(async () => hang());   // the model never answers
  try {
    fs.writeFileSync(path.join(w.dir, 'errands.json'), JSON.stringify({ 'web:person': { errand_id: 'E1', channel: 'web', to: 'person', resume: true, grants: {}, outbox: ['Owed reply.'],
      last_active: new Date().toISOString(), transcript: [{ role: 'user', content: 'hi' }] } }));
    const core = new Core(w.opts());
    core.resume();
    await until(() => w.sent.length === 1);
    assert.equal(w.sent[0], 'Owed reply.');
  } finally { await w.stop(); }
});

test('state saved by the first version, with an approval link not yet sent, is sent at start', async () => {
  const w = await world(booking);
  try {
    fs.writeFileSync(path.join(w.dir, 'errands.json'), JSON.stringify({ 'web:person': { errand_id: 'E1', channel: 'web', to: 'person', grants: { G1: { kind: 'book', state: 'pending' } },
      ask: 'Approve request G1\nApprove: https://approve.test/a/G1', last_active: new Date().toISOString(),
      transcript: [{ role: 'user', content: 'Book a table' }, { role: 'assistant', content: [{ type: 'tool_call', call_id: 'k', name: 'request_booking', arguments: BOOK }] },
        { role: 'tool', content: [{ type: 'tool_result', call_id: 'k', content: { status: 'waiting_for_approval' } }] }] } }));
    const core = new Core(w.opts());
    core.resume();
    await until(() => w.sent.length === 1);
    assert.match(w.sent[0], /That needs your approval\.[\s\S]*approve\.test\/a\/G1/);
  } finally { await w.stop(); }
});

test('out of steps: the last tools asked for are not run, and the reply says so', async () => {
  const w = await world(() => use(['request_booking', BOOK]));   // a model that never stops asking
  try {
    const core = new Core(w.opts());
    await w.inbound(core, 'Book a table');
    await until(() => w.sent.length === 1);
    assert.equal(w.grants.length, 7);                             // 8 model calls, the 8th's tool not run
    assert.match(w.sent[0], /stopped before doing the last thing/);
    const t = w.state()['web:person'].transcript;
    assert.equal(t.at(-1).content[0].content.error, 'not_run');
  } finally { await w.stop(); }
});

test('a long errand: the model never sees a tool result without its call', async () => {
  const w = await world(() => say('OK.'));
  try {
    const t = [];
    for (let i = 0; i < 25; i++) {   // 75 messages: user, assistant with a call, its result
      t.push({ role: 'user', content: `m${i}` }, { role: 'assistant', content: [{ type: 'tool_call', call_id: `k${i}`, name: 'search_tables', arguments: {} }] },
        { role: 'tool', content: [{ type: 'tool_result', call_id: `k${i}`, content: {} }] });
    }
    t.push({ role: 'assistant', content: [{ type: 'text', text: 'x' }] });   // so the plain last-60 cut lands on a tool result
    fs.writeFileSync(path.join(w.dir, 'errands.json'), JSON.stringify({ 'web:person': { errand_id: 'E1', channel: 'web', to: 'person', transcript: t, grants: {}, last_active: new Date().toISOString() } }));
    const core = new Core(w.opts());
    await w.inbound(core, 'one more');
    await until(() => w.sent.length === 1);
    const seen = w.infers[0].messages;
    assert.equal(t.length + 1 - 60, 17);
    assert.equal(t[17].role, 'tool');                            // where the old cut started
    assert.equal(seen[0].role, 'user');
    const calls = new Set(seen.flatMap((m) => (Array.isArray(m.content) ? m.content.filter((p) => p.type === 'tool_call').map((p) => p.call_id) : [])));
    for (const m of seen.filter((x) => x.role === 'tool')) for (const p of m.content) assert.ok(calls.has(p.call_id), p.call_id);
  } finally { await w.stop(); }
});

test('an errand waiting on an approval is not replaced after the idle time', async () => {
  const w = await world(() => say('OK.'));
  try {
    const old = new Date(Date.now() - 7 * 3600_000).toISOString();
    fs.writeFileSync(path.join(w.dir, 'errands.json'), JSON.stringify({ 'web:person': { errand_id: 'E1', channel: 'web', to: 'person', transcript: [], grants: { G9: { kind: 'book', state: 'pending' } }, last_active: old } }));
    const core = new Core(w.opts());
    await w.inbound(core, 'still there?');
    await until(() => w.sent.length === 1);
    assert.equal(w.state()['web:person'].errand_id, 'E1');
  } finally { await w.stop(); }
});

test('a message arriving while an interrupted turn is finished at start gets its own turn; no call gets two results', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const w = await world(async (args) => { if (lastText(args).includes('interrupted')) { await gate; return say('Recovered.'); } return say('Hi.'); });
  try {
    fs.writeFileSync(path.join(w.dir, 'errands.json'), JSON.stringify({ 'web:person': { errand_id: 'E1', channel: 'web', to: 'person', resume: true, grants: {}, last_active: new Date().toISOString(),
      transcript: [{ role: 'user', content: 'Book' }, { role: 'assistant', content: [{ type: 'tool_call', call_id: 'open', name: 'complete_booking', arguments: {} }] }] } }));
    const core = new Core(w.opts());
    core.resume();
    await w.inbound(core, 'hello?');
    release();
    await until(() => w.sent.length === 2);
    assert.deepEqual(w.sent, ['Recovered.', 'Hi.']);
    const results = w.state()['web:person'].transcript.flatMap((m) => (m.role === 'tool' ? m.content : [])).filter((p) => p.call_id === 'open');
    assert.equal(results.length, 1);
  } finally { await w.stop(); }
});

test('a checkpoint that cannot be written stops the core; nothing more is done or acknowledged', async () => {
  const w = await world(() => say('Hi.'));
  try {
    const core = new Core(w.opts());
    fs.mkdirSync(path.join(w.dir, 'errands.json.tmp'));   // the write will fail
    await assert.rejects(w.inbound(core, 'hello'));
    assert.ok(w.fatal);
    await assert.rejects(w.inbound(core, 'hello again'), /stopping/);
    await sleep(100);
    assert.equal(w.infers.length, 0);
  } finally { await w.stop(); }
});

test('a reply that was sent but could not be logged stops the core, and is not sent again by it', async () => {
  const w = await world(() => say('Hi.'));
  try {
    const core = new Core(w.opts());
    await w.inbound(core, 'hello');   // logged on arrival; then the log becomes unwritable
    const log = path.join(w.dir, 'conversation.jsonl');
    fs.rmSync(log); fs.mkdirSync(log);
    await until(() => w.fatal);
    await sleep(100);
    assert.equal(w.sent.length, 1);
    assert.equal(core.dead, true);
  } finally { await w.stop(); }
});

// The real core, killed with SIGKILL at the worst moments, then started again on the same state.

test('crash after the approval was asked for, before the reply: at start the link still goes out', async () => {
  const w = await world(async (args, w) => {
    if (lastText(args).includes('waiting_for_approval') && !w.restarted) { await w.kill(); return hang(); }
    return booking(args);
  });
  try {
    await w.start();
    await w.send('Book a table');
    await until(() => w.child.exitCode !== null || w.child.signalCode !== null);
    assert.equal(w.sent.length, 0);
    w.restarted = true;
    await w.start();
    await until(() => w.sent.length === 1);
    assert.match(w.sent[0], /approve\.test\/a\/G1/);
    assert.equal(w.grants.length, 1);                      // the booking request was not made twice
  } finally { await w.stop(); }
});

test('crash before the first checkpoint of a new errand: the message is still answered', async () => {
  const w = await world(async (args, w) => { if (!w.restarted) { await w.kill(); return hang(); } return say('Hi there.'); });
  try {
    await w.start();
    await w.send('hello');
    await until(() => w.child.signalCode !== null);
    w.restarted = true;
    await w.start();
    await until(() => w.sent.length === 1);
    assert.equal(w.sent[0], 'Hi there.');
  } finally { await w.stop(); }
});

test('crash between two tools: the first result is kept, the second is "interrupted"', async () => {
  const w = await world((args) => (lastText(args).startsWith('Book') ? use(['request_booking', BOOK], ['request_booking', { ...BOOK, time: '20:00' }]) : booking(args)));
  w.onGrant = async (id) => { if (id === 'G2' && !w.restarted) { await w.kill(); await hang(); } };
  try {
    await w.start();
    await w.send('Book two tables');
    await until(() => w.child.signalCode !== null);
    w.restarted = true;
    await w.start();
    await until(() => w.sent.length === 1);
    assert.match(w.sent[0], /Something was interrupted\.[\s\S]*approve\.test\/a\/G1/);   // G1's link still goes out
    const results = w.state()['web:person'].transcript.filter((m) => m.role === 'tool').flatMap((m) => m.content);
    assert.equal(results[0].content.status, 'waiting_for_approval');
    assert.equal(results[1].content.error, 'interrupted');
  } finally { await w.stop(); }
});

test('a message accepted while another turn is thinking survives a crash after that turn\'s checkpoint', async () => {
  let releaseFirst;
  const first = new Promise((r) => { releaseFirst = r; });
  const w = await world(async (args, w) => {
    const t = lastText(args);
    if (w.restarted) return t.includes('second') ? say('Got the second.') : booking(args);
    if (t.startsWith('Book')) { await first; return use(['request_booking', BOOK]); }
    if (t.includes('waiting_for_approval')) { await w.kill(); return hang(); }   // after the tool checkpoint
    return say('?');
  });
  try {
    await w.start();
    await w.send('Book a table');
    await until(() => w.infers.length === 1);
    assert.equal((await w.send('second message')).ok, true);   // accepted while the first turn is thinking
    releaseFirst();
    await until(() => w.child.signalCode !== null);
    w.restarted = true;
    await w.start();
    await until(() => w.sent.length === 2);
    assert.match(w.sent[0], /approve\.test\/a\/G1/);
    assert.equal(w.sent[1], 'Got the second.');
  } finally { await w.stop(); }
});

// The conversation log after a write was cut off.

test('conversation log: a cut-off last line is set aside and removed; a whole one gets its newline; garbage stops start', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opa-core-log-'));
  const f = path.join(dir, 'conversation.jsonl');
  const log = new ConversationLog(f);
  log.append({ type: 'message', text: 'one' });
  log.append({ type: 'message', text: 'two' });
  const good = fs.readFileSync(f);
  fs.appendFileSync(f, Buffer.from('{"seq":2,"text":"Caf\xc3', 'latin1'));   // cut mid-line, mid-character
  const after = new ConversationLog(f);
  assert.deepEqual(fs.readFileSync(f), good);
  const aside = fs.readdirSync(dir).find((x) => x.startsWith('conversation.jsonl.partial-'));
  assert.deepEqual(fs.readFileSync(path.join(dir, aside)), Buffer.from('{"seq":2,"text":"Caf\xc3', 'latin1'));
  after.append({ type: 'message', text: 'three' });
  const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.seq), [0, 1, 2]);

  const whole = fs.readFileSync(f, 'utf8').trimEnd();   // a complete last entry that only lost its newline
  fs.writeFileSync(f, whole);
  new ConversationLog(f).append({ type: 'message', text: 'four' });
  assert.deepEqual(fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).seq), [0, 1, 2, 3]);

  fs.appendFileSync(f, 'not json\n');
  assert.throws(() => new ConversationLog(f), /last line isn't a log entry/);
});

// The socket transport.

test('a character split across two chunks arrives whole, both ways', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opa-core-utf8-'));
  const raw = net.createServer((c) => {   // a server that answers in two chunks, split inside "é"
    c.once('data', () => { const b = Buffer.from(JSON.stringify({ id: 'x', ok: true, result: { venue: 'Café' } }) + '\n'); const i = b.indexOf(0xc3) + 1; c.write(b.subarray(0, i)); setTimeout(() => c.end(b.subarray(i)), 20); });
  });
  const p1 = path.join(dir, 'raw.sock');
  await new Promise((r) => raw.listen(p1, r));
  try {
    assert.equal((await call(p1, envelope('x', null, {}))).result.venue, 'Café');
    let got;
    const p2 = path.join(dir, 'srv.sock');
    const srv = await serve(p2, { echo: async (a) => { got = a.venue; return {}; } });
    const b = Buffer.from(JSON.stringify(envelope('echo', null, { venue: 'Café' })) + '\n');
    const i = b.indexOf(0xc3) + 1;
    await new Promise((res) => { const c = net.connect(p2, () => { c.write(b.subarray(0, i)); setTimeout(() => c.write(b.subarray(i)), 20); }); c.on('data', () => { c.end(); res(); }); });
    assert.equal(got, 'Café');
    srv.close();
  } finally { raw.close(); }
});
