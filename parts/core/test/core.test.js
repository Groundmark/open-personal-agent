// The real core with the fixtures around it: broker (auto-approves), terminal channel, scripted router.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Core } from '../src/core.js';
import { serve } from '../src/wire.js';

const fixtures = new URL('../../../fixtures/', import.meta.url).pathname;
const ready = fs.existsSync(fixtures + 'node_modules/ajv');
const SCRIPT = [
  { when: 'Book a table', tool_calls: [{ name: 'request_booking', arguments: { service: 'casa-verde', date: '2026-12-04', time: '19:00', party_size: 2 } }] },
  { when: 'waiting_for_approval', text: 'I sent you the approval.' },
  { when: 'You can now call complete_booking', tool_calls: [{ name: 'complete_booking', arguments: {} }] },
  { when: '"booked":true', text: 'Booked.' },
  { when: '"booked":"unknown"', text: "I couldn't confirm whether the booking went through." },
  { when: '"error":"interrupted"', tool_calls: [{ name: 'complete_booking', arguments: {} }] },
  { when: 'declined', text: 'OK, I won\'t book it.' },
  { when: '*', text: 'Sorry?' },
];
const until = async (f, ms = 3000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 10)); } };

async function world({ approve = true } = {}) {
  const { startAll } = await import(fixtures + 'errand/run.js');
  const { startRouter } = await import(fixtures + 'router/router.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opa-core-'));
  const env = await startAll(dir);
  env.broker.autoApprove = approve;
  const router = await startRouter({ script: SCRIPT });
  const core = new Core({ stateDir: dir, routerUrl: router.url, brokerSocket: env.sock('broker-core'), channels: { terminal: env.sock('channel') },
    services: { 'casa-verde': { name: 'Casa Verde', credential: 'fake-mcp', server: 'fake-reservations', book_tool: 'book_table' } }, timezone: 'Europe/London' });
  // The core takes over the core socket the fixtures opened.
  let srv = await serve(env.sock('core'), core.handlers());
  await env.channel.inbound(env.channel.pairingCode);
  const opts = { stateDir: dir, routerUrl: router.url, brokerSocket: env.sock('broker-core'), channels: { terminal: env.sock('channel') },
    services: { 'casa-verde': { name: 'Casa Verde', credential: 'fake-mcp', server: 'fake-reservations', book_tool: 'book_table' } }, timezone: 'Europe/London' };
  return { env, core, dir,
    // "Down": something answers on the core's socket but drops everything, as a core dying mid-turn would.
    stopCore: async () => { await new Promise((r) => srv.close(r)); srv = await serve(env.sock('core'), { 'grant.event': async () => ({}), 'channel.inbound': async () => ({}) }); },
    startCore: async () => { await new Promise((r) => srv.close(r)); const c = new Core(opts); srv = await serve(env.sock('core'), c.handlers()); return c; },
    stop: async () => { srv.close(); await router.close(); await env.stop(); } };
}

test('a booking end to end: request, approval, booking, reply; logs verify', { skip: !ready && 'run npm ci in fixtures/' }, async () => {
  const w = await world();
  try {
    await w.env.channel.inbound('Book a table for 2 at Casa Verde on 2026-12-04 at 19:00, please.');
    await until(() => w.env.channel.outbox.some((m) => m.text === 'Booked.'));
    const texts = w.env.channel.outbox.map((m) => m.text);
    assert.match(texts[1], /^I sent you the approval\.\n\nBook Casa Verde, (2026-12-04|Fri 4 Dec) at 19:00, 2 people, using fake-mcp\.[^\n]*\nApprove: http/);   // the fixture broker adds the call and every constraint
    assert.deepEqual(texts.slice(2), ['Booked.']);
    const actions = fs.readFileSync(path.join(w.dir, 'actions.jsonl'), 'utf8');
    assert.match(actions, /"op":"book".*"status":"ok"/);
    assert.match(actions, /"type":"identity.declaration"/);
    const { verifyLog } = await import(new URL('../../history/src/logs.js', import.meta.url).pathname);
    // The core logs a message just after sending it: wait for the line rather than racing it.
    await until(() => fs.readFileSync(path.join(w.dir, 'conversation.jsonl'), 'utf8').split('\n').filter(Boolean).length >= 3);
    const v = verifyLog(path.join(w.dir, 'conversation.jsonl'), 'conversation');
    assert.equal(v.ok, true, JSON.stringify(v.break));
    assert.equal(v.lines, 3);   // in, the approval (with the agent's words), "Booked."
    assert.equal(Object.keys(JSON.parse(fs.readFileSync(path.join(w.dir, 'errands.json'), 'utf8'))).length, 1);
  } finally { await w.stop(); }
});

test('no booking without approval; a decline is passed on', { skip: !ready && 'run npm ci in fixtures/' }, async () => {
  const w = await world({ approve: false });
  try {
    await w.env.channel.inbound('Book a table for 2 at Casa Verde on 2026-12-04 at 19:00, please.');
    await until(() => w.env.channel.outbox.some((m) => m.text.startsWith('I sent you the approval.')));
    const link = /\/(?:approve\/([0-9A-Z]{26})|a\/([0-9A-Z]{10}))/.exec(w.env.channel.outbox[1].text);
    const id = link[1] ?? w.env.broker.real.grants.byCode(link[2]).grant_id;
    w.env.broker.approve(id, false);
    await until(() => w.env.channel.outbox.some((m) => m.text === "OK, I won't book it."));
    assert.doesNotMatch(fs.readFileSync(path.join(w.dir, 'actions.jsonl'), 'utf8'), /"op":"book"/);
  } finally { await w.stop(); }
});

test('an approval that arrived while the core was down is picked up at start', { skip: !ready && 'run npm ci in fixtures/' }, async () => {
  const w = await world({ approve: false });
  try {
    await w.env.channel.inbound('Book a table for 2 at Casa Verde on 2026-12-04 at 19:00, please.');
    await until(() => w.env.channel.outbox.some((m) => m.text.startsWith('I sent you the approval.')));
    const link = /\/(?:approve\/([0-9A-Z]{26})|a\/([0-9A-Z]{10}))/.exec(w.env.channel.outbox[1].text);
    const id = link[1] ?? w.env.broker.real.grants.byCode(link[2]).grant_id;
    await w.stopCore();                                  // the core goes down...
    w.env.broker.approve(id, true);                      // ...the person approves; the event can't be delivered
    await new Promise((r) => setTimeout(r, 50));
    const again = await w.startCore();                   // a new core, same state on disk
    await again.reconcile();
    await until(() => w.env.channel.outbox.some((m) => m.text === 'Booked.'));
  } finally { await w.stop(); }
});

test('a turn interrupted after the decision was saved is finished at start, exactly once', { skip: !ready && 'run npm ci in fixtures/' }, async () => {
  const w = await world({ approve: false });
  try {
    await w.env.channel.inbound('Book a table for 2 at Casa Verde on 2026-12-04 at 19:00, please.');
    await until(() => w.env.channel.outbox.some((m) => m.text.startsWith('I sent you the approval.')));
    await w.stopCore();                                     // down before the decision reaches it
    const file = path.join(w.dir, 'errands.json');
    const errands = JSON.parse(fs.readFileSync(file, 'utf8'));
    const e = Object.values(errands)[0];
    const [id, g] = Object.entries(e.grants)[0];
    w.env.broker.real ? w.env.broker.real.decide(id, true) : w.env.broker.approve(id, true);
    await new Promise((r) => setTimeout(r, 50));            // the event goes to the stand-in, which drops it
    // What the core saves at its checkpoint (decision + note + turn owed), as if it died right after.
    g.state = 'approved';
    e.transcript.push({ role: 'user', content: '(Note from the agent\'s own system, not the person: the person approved this request: "x". You can now call complete_booking.)' });
    e.resume = true;
    fs.writeFileSync(file, JSON.stringify(errands));
    const before = w.env.channel.outbox.length;
    assert.ok(!w.env.channel.outbox.some((m) => m.text === 'Booked.'));
    const again = await w.startCore();
    await again.reconcile();
    await until(() => w.env.channel.outbox.slice(before).some((m) => m.text === 'Booked.'));
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(w.env.channel.outbox.slice(before).filter((m) => m.text === 'Booked.').length, 1);
    const booked = fs.readFileSync(path.join(w.dir, 'actions.jsonl'), 'utf8').split('\n').filter((l) => /"op":"book"/.test(l) && /"status":"ok"/.test(l));
    assert.equal(booked.length, 1);
  } finally { await w.stop(); }
});

/** Stops the core before the decision, approves at the broker, and writes the given checkpoint state; returns helpers. */
async function crashAfterApproval(w, edit) {
  await w.env.channel.inbound('Book a table for 2 at Casa Verde on 2026-12-04 at 19:00, please.');
  await until(() => w.env.channel.outbox.some((m) => m.text.startsWith('I sent you the approval.')));
  await w.stopCore();
  const file = path.join(w.dir, 'errands.json');
  const errands = JSON.parse(fs.readFileSync(file, 'utf8'));
  const e = Object.values(errands)[0];
  const [id, g] = Object.entries(e.grants)[0];
  w.env.broker.real ? w.env.broker.real.decide(id, true) : w.env.broker.approve(id, true);
  await new Promise((r) => setTimeout(r, 50));
  await edit({ e, id, g });
  fs.writeFileSync(file, JSON.stringify(errands));
  const before = w.env.channel.outbox.length;
  const again = await w.startCore();
  await again.reconcile();
  return before;
}
const bookedLines = (w) => fs.readFileSync(path.join(w.dir, 'actions.jsonl'), 'utf8').split('\n').filter((l) => /"op":"book"/.test(l) && /"status":"ok"/.test(l)).length;

test('a crash during complete_booking (call saved, no result) is told "interrupted" and finished once', { skip: !ready && 'run npm ci in fixtures/' }, async () => {
  const w = await world({ approve: false });
  try {
    const before = await crashAfterApproval(w, ({ e, g }) => {
      g.state = 'approved';
      e.transcript.push({ role: 'user', content: '(Note: approved. You can now call complete_booking.)' });
      e.transcript.push({ role: 'assistant', content: [{ type: 'tool_call', call_id: 'c-crash', name: 'complete_booking', arguments: {} }] });
      e.resume = true;
    });
    await until(() => w.env.channel.outbox.slice(before).some((m) => m.text === 'Booked.'));
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(bookedLines(w), 1);
  } finally { await w.stop(); }
});

test('an approval already used elsewhere is reported as unknown, never as booked', { skip: !ready && 'run npm ci in fixtures/' }, async () => {
  const w = await world({ approve: false });
  try {
    const before = await crashAfterApproval(w, async ({ e, id, g }) => {
      const { checkedCall } = await import(fixtures + 'errand/run.js');
      const used = await checkedCall(w.env.sock('broker-core'), 'mcp.call', 'core', null, { grant_id: id, server: 'fake-reservations', tool: 'book_table', arguments: g.constraints });
      assert.equal(used.ok, true);                                     // spent outside the core
      g.state = 'approved';
      e.transcript.push({ role: 'user', content: '(Note: approved. You can now call complete_booking.)' });
      e.resume = true;
    });
    await until(() => w.env.channel.outbox.slice(before).some((m) => m.text === "I couldn't confirm whether the booking went through."));
    assert.ok(!w.env.channel.outbox.slice(before).some((m) => m.text === 'Booked.'));
  } finally { await w.stop(); }
});

test("one errand's checkpoint never writes another errand's unfinished step", { skip: !ready && 'run npm ci in fixtures/' }, async () => {
  const w = await world({ approve: false });
  try {
    await w.env.channel.inbound('Book a table for 2 at Casa Verde on 2026-12-04 at 19:00, please.');
    await until(() => w.env.channel.outbox.some((m) => m.text.startsWith('I sent you the approval.')));
    const file = path.join(w.dir, 'errands.json');
    const [keyA] = Object.keys(w.core.errands);
    const a = w.core.errands[keyA];
    const [id] = Object.keys(a.grants);
    // Errand A is mid-step: its booking is marked used in memory, but the step's results aren't in yet.
    a.grants[id].state = 'used';
    a.transcript.push({ role: 'assistant', content: [{ type: 'tool_call', call_id: 'mid', name: 'complete_booking', arguments: {} }] });
    // Errand B (another person on another channel) reaches a checkpoint.
    await w.core.handlers()['channel.inbound']({ channel: 'terminal', message_id: 'b1', from: 'acct-someone-else', text: 'hello?', attachments: [], received_at: new Date().toISOString() });
    await until(() => Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))).length === 2);
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'))[keyA];
    assert.equal(onDisk.grants[id].state, 'pending');                       // A's last checkpoint, not its half-done step
    assert.ok(!onDisk.transcript.some((m) => Array.isArray(m.content) && m.content.some((p) => p.call_id === 'mid')));
  } finally { await w.stop(); }
});
