import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { SignalChannel, newPairingCode } from '../src/adapter.js';

const PERSON = 'aaaaaaaa-1111-4111-8111-111111111111', STRANGER = 'bbbbbbbb-2222-4222-8222-222222222222';

/** A Unix-socket server answering one JSON line per connection with handler(req). */
async function fakeServer(file, handler) {
  const seen = [];
  const srv = net.createServer((c) => { let b = ''; c.on('data', async (d) => { b += d; if (b.includes('\n')) { const r = JSON.parse(b); seen.push(r); c.end(JSON.stringify(await handler(r)) + '\n'); } }); });
  await new Promise((r) => srv.listen(file, r));
  return { seen, close: () => srv.close() };
}

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opa-signal-'));
  const core = await fakeServer(path.join(dir, 'core.sock'), (r) => ({ id: r.id, ok: true, result: {} }));
  let slots = [];
  const broker = await fakeServer(path.join(dir, 'broker.sock'), (r) => {
    if (r.op === 'code.slots') return { id: r.id, ok: true, result: { slots, cursor: 'c' } };
    if (r.op === 'code.deliver') { slots = []; return { id: r.id, ok: true, result: { accepted: true } }; }
    return { id: r.id, ok: false, error: 'unknown_op' };
  });
  const identities = { [PERSON]: 'fp-person-1', [STRANGER]: 'fp-stranger' };
  const sent = [];
  const rpc = { call: async (method, params) => {
    if (method === 'listIdentities') return Object.entries(identities).map(([uuid, fingerprint]) => ({ uuid, fingerprint }));
    if (method === 'send') { sent.push(params); return { timestamp: 1 }; }
    throw new Error(method);
  } };
  const logs = [];
  const ch = new SignalChannel({ state_dir: dir, core_socket: path.join(dir, 'core.sock'), broker_socket: path.join(dir, 'broker.sock') }, { log: (m) => logs.push(m) });
  ch.attach(rpc);
  const msg = (from, text, extra = {}) => ch.onEnvelope({ sourceUuid: from, sourceName: 'Person', timestamp: Date.now(), dataMessage: { message: text, ...extra } });
  const inbound = () => core.seen.map((r) => r.args.text);
  return { dir, ch, core, broker, sent, identities, msg, inbound, logs, openSlot: (id) => { slots = [{ slot_id: id, expires_at: new Date(Date.now() + 60000).toISOString() }]; },
    stop: () => { ch.close(); core.close(); broker.close(); } };
}

test('pairing: only the code pairs, once; strangers are dropped and get no reply', async () => {
  const s = await setup();
  try {
    const code = newPairingCode(s.dir);
    await s.msg(STRANGER, 'hello?');
    await s.msg(PERSON, '000000');
    assert.equal(s.sent.length, 0);
    await s.msg(PERSON, code);
    assert.deepEqual(s.sent, [{ recipient: [PERSON], message: 'Paired.' }]);
    assert.equal(JSON.parse(fs.readFileSync(path.join(s.dir, 'pairing.json'), 'utf8')).identity_key, 'fp-person-1');
    assert.equal(fs.existsSync(path.join(s.dir, 'pair-code.json')), false);                     // spent
    await s.msg(PERSON, 'Book Casa Verde Friday at 7 for two');
    await s.msg(STRANGER, 'me too');                                                            // a stranger, after pairing
    await s.msg(STRANGER, 'Book', { groupInfo: { groupId: 'x' } });                              // groups are ignored
    assert.deepEqual(s.inbound(), ['Book Casa Verde Friday at 7 for two']);
    assert.equal(s.core.seen[0].caller, 'channel-signal');
    assert.equal(s.core.seen[0].args.from, PERSON);
    assert.deepEqual(s.ch.status().dropped, { from_strangers: 3, from_changed_key: 0 });   // before pairing, everyone is a stranger
    assert.equal(s.core.seen.length, 1);
  } finally { s.stop(); }
});

test('an expired pairing code does nothing', async () => {
  const s = await setup();
  try {
    const code = newPairingCode(s.dir, Date.now() - 16 * 60_000);
    await s.msg(PERSON, code);
    assert.equal(s.ch.status().paired, false);
  } finally { s.stop(); }
});

test('a changed identity key stops forwarding until a new pairing, which says what was dropped', async () => {
  const s = await setup();
  try {
    await s.msg(PERSON, newPairingCode(s.dir));
    s.identities[PERSON] = 'fp-person-NEW-PHONE';
    await s.msg(PERSON, 'are you there?');
    await s.msg(PERSON, 'hello??');
    assert.deepEqual(s.inbound(), []);
    assert.equal(s.ch.status().needs_repair, true);
    await assert.rejects(s.ch.send({ to: PERSON, text: 'x' }), { code: 'not_paired' });
    assert.ok(s.logs.some((l) => /identity_changed/.test(l)));
    await s.msg(PERSON, newPairingCode(s.dir));
    assert.equal(s.sent.at(-1).message, 'Paired again. While we were unpaired, 2 messages from your account were dropped.');
    await s.msg(PERSON, 'back');
    assert.deepEqual(s.inbound(), ['back']);
  } finally { s.stop(); }
});

test('a one-time code goes to the broker, never the core; other text goes as usual', async () => {
  const s = await setup();
  try {
    await s.msg(PERSON, newPairingCode(s.dir));
    s.openSlot('01M85SLOT00000000000000000');
    s.ch.slots = [{ slot_id: '01M85SLOT00000000000000000', expires_at: new Date(Date.now() + 60000).toISOString() }];
    await s.msg(PERSON, 'the code is 771204');            // not only a code: forwarded, slot stays open
    await s.msg(PERSON, '771 204');
    assert.deepEqual(s.inbound(), ['the code is 771204', '[one-time code delivered]']);
    const deliver = s.broker.seen.find((r) => r.op === 'code.deliver');
    assert.deepEqual(deliver.args, { slot_id: '01M85SLOT00000000000000000', code: '771204' });
    assert.equal(deliver.caller, 'channel-signal');
    assert.ok(!s.logs.join('\n').includes('771204'));
    await s.msg(PERSON, '123456');                         // no slot open now: an ordinary message
    assert.equal(s.inbound().at(-1), '123456');
  } finally { s.stop(); }
});

test('code slots: the adapter long-polls with the cursor it was given, and hears of each slot once', async () => {
  const s = await setup();
  try {
    s.openSlot('01M85SLOT00000000000000000');
    const watching = s.ch.watchSlots();
    while (s.broker.seen.filter((r) => r.op === 'code.slots').length < 2) await new Promise((r) => setTimeout(r, 20));
    const asks = s.broker.seen.filter((r) => r.op === 'code.slots');
    assert.equal(asks[0].args.cursor, undefined);
    assert.equal(asks[1].args.cursor, 'c');                  // passed back
    assert.equal(asks[0].caller, 'channel-signal');
    assert.deepEqual(s.ch.slots.map((x) => x.slot_id), ['01M85SLOT00000000000000000']);   // not duplicated
    s.ch.close();
    await watching;
  } finally { s.stop(); }
});

test('channel.send goes only to the paired account; the socket only serves the core', async () => {
  const s = await setup();
  try {
    await s.msg(PERSON, newPairingCode(s.dir));
    await assert.rejects(s.ch.send({ to: STRANGER, text: 'x' }), { code: 'recipient_not_allowed' });
    const r = await s.ch.send({ to: PERSON, text: 'Booked. Casa Verde, Fri 27 Nov at 19:00.' });
    assert.match(r.message_id, /^sig-/);
    const sock = path.join(s.dir, 'signal.sock');
    await s.ch.listen(sock);
    const ask = (caller) => new Promise((resolve) => {
      const c = net.createConnection(sock, () => c.write(JSON.stringify({ op: 'status', id: '1', caller, args: {} }) + '\n'));
      let b = ''; c.on('data', (d) => { b += d; }); c.on('end', () => resolve(JSON.parse(b)));
    });
    assert.equal((await ask('core')).result.paired, true);
    assert.equal((await ask('channel-web')).error, 'unauthorized_caller');
  } finally { s.stop(); }
});

test('a code the broker no longer wants is not passed on as text', async () => {
  const s = await setup();
  try {
    await s.msg(PERSON, newPairingCode(s.dir));
    s.ch.slots = [{ slot_id: 'gone', expires_at: new Date(Date.now() + 60000).toISOString() }];
    s.broker.close();   // the broker can't take it (here: unreachable)
    await s.msg(PERSON, '123456');
    assert.deepEqual(s.inbound(), ['[one-time code not delivered: the request for it had ended]']);
  } finally { s.stop(); }
});
