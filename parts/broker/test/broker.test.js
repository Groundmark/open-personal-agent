import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Broker } from '../src/broker.js';
import { checkRequest, GrantStore } from '../src/grants.js';
import { dispatch, listen, systemdSockets } from '../src/sockets.js';

const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'opa-broker-')); fs.chmodSync(d, 0o700); return d; };
const BOOK = { venue: 'Casa Verde', date: '2026-12-04', time: '19:00', party_size: 2 };
const store = { approval: 'none', label: 'test', async get(ref) { return ref === 'fake-table' ? { record: { ref, origin: 'https://table.example' }, secret: {} } : null; } };
const env = (op, args, caller = 'core') => ({ op, id: '01JD0000000000000000000000', caller, errand_id: '01M85AFY69WCYA5HD84FXVN2RF', ts: new Date().toISOString(), args });

function mk(dir = tmp(), extra = {}) {
  const events = [];
  const b = new Broker({ stateDir: dir, store, approvals: { url: (g) => `https://approve.test/g/${g.grant_id}` }, onGrantEvent: (id, s) => events.push([id, s]), ...extra });
  return { b, dir, events, h: b.handlers() };
}

test('grant requests are checked against the contract', () => {
  const ok = { credential: 'fake-table', ops: ['book'], constraints: BOOK, mode: 'one_shot', ttl_seconds: 600, purpose: 'Book it' };
  assert.doesNotThrow(() => checkRequest(ok));
  const code = (a) => { try { checkRequest(a); return 'ok'; } catch (e) { return e.code; } };
  assert.equal(code({ ...ok, mode: 'standing' }), 'one_shot_required');
  assert.equal(code({ ...ok, ttl_seconds: 7200 }), 'bad_request');                     // one-shot max 1 h
  assert.equal(code({ ...ok, ops: ['steal'] }), 'bad_request');
  assert.equal(code({ ...ok, constraints: { venue: 'x' } }), 'bad_request');
  assert.equal(code({ ...ok, session: { origin: 'https://a.example', browser: 'operator' } }), 'bad_request');   // both
  assert.equal(code({ ...ok, credential: undefined, session: { origin: 'https://a.example/path', browser: 'operator' } }), 'bad_request');
  assert.equal(code({ ...ok, purpose: ' ' }), 'bad_request');
  assert.equal(code({ ...ok, credential: { domain: 'bad domain' } }), 'bad_request');
});

test('grants survive a restart; the approval is bound to what was asked', async () => {
  const { b, dir } = mk();
  const r = await b.handlers()['grant.request']({ credential: 'fake-table', ops: ['book'], constraints: BOOK, mode: 'one_shot', ttl_seconds: 600, purpose: 'Book it' }, env('grant.request', {}));
  assert.match(r.approve_url, /^https:\/\/approve\.test\/g\//);
  assert.equal(r.summary, 'Book Casa Verde, Fri 4 Dec at 19:00, 2 people, using fake-table.');
  const again = new GrantStore(path.join(dir, 'grants.json'));
  assert.equal(again.get(r.grant_id).state, 'pending');
  b.decide(r.grant_id, true, { passkey_credential_id: 'pk1' });
  const after = new GrantStore(path.join(dir, 'grants.json')).get(r.grant_id);
  assert.equal(after.state, 'approved');
  assert.match(after.hash, /^[A-Za-z0-9_-]{43}$/);   // base64url SHA-256: the passkey challenge
  assert.throws(() => b.decide(r.grant_id, true), { code: 'bad_request' });           // can't approve twice
  const b2 = new Broker({ stateDir: dir, store, approvals: { url: () => '' } });       // same keys after restart
  assert.equal(b2.brokerKey.kid, b.brokerKey.kid);
  assert.notEqual(b2.agentKey.kid, b2.brokerKey.kid);
});

test('expiry: approved grants run out, unanswered ones too, and the core hears about both', async () => {
  let now = Date.parse('2026-11-23T10:00:00Z');
  const { b, events } = mk(tmp(), { now: () => now, pendingSeconds: 60 });
  const req = (ttl) => b.handlers()['grant.request']({ credential: 'fake-table', ops: ['search'], mode: 'standing', ttl_seconds: ttl, purpose: 'look' }, env('grant.request', {}));
  const a = await req(120), p = await req(120);
  b.decide(a.grant_id, true);
  now += 61_000; await b.sweep();          // p waited too long for the person
  assert.equal(b.grants.get(p.grant_id).state, 'expired');
  assert.equal(b.grants.get(a.grant_id).state, 'approved');
  now += 60_000; await b.sweep();          // a's two minutes are up
  assert.equal(b.grants.get(a.grant_id).state, 'expired');
  assert.deepEqual(events.map(([id, s]) => [id === a.grant_id ? 'a' : 'p', s]), [['a', 'approved'], ['p', 'expired'], ['a', 'expired']]);
});

test('sockets: the socket is the caller; codes only from channel adapters', async () => {
  const { h } = mk();
  assert.equal((await dispatch(h, 'core', env('status', {}, 'channel-signal'))).error, 'unauthorized_caller');
  assert.equal((await dispatch(h, 'core', env('code.deliver', { slot_id: 'x', code: '123456' }))).error, 'unauthorized_caller');
  assert.equal((await dispatch(h, 'channel-signal', env('grant.request', {}, 'channel-signal'))).error, 'unauthorized_caller');
  assert.equal((await dispatch(h, 'channel-signal', env('code.deliver', { slot_id: 'x', code: '12' }, 'channel-signal'))).error, 'bad_request');
  assert.equal((await dispatch(h, 'core', env('nope', {}))).error, 'unknown_op');
  assert.equal((await dispatch(h, 'core', { op: 'status' })).error, 'bad_request');
  const st = await dispatch(h, 'core', env('status', {}));
  assert.equal(st.ok, true);
  assert.equal(st.result.version, '0.4.0');
});

test('sockets: made 0600 at a path; handed over by systemd by name', async () => {
  const { b, dir } = mk();
  const p = path.join(dir, 'broker-core.sock');
  const [srv] = await listen(b, [{ caller: 'core', path: p }]);
  try {
    assert.equal(fs.statSync(p).mode & 0o777, 0o600);
    const res = await new Promise((resolve) => {
      const c = net.createConnection(p, () => c.write(JSON.stringify(env('status', {})) + '\n'));
      let buf = ''; c.on('data', (d) => { buf += d; }); c.on('end', () => resolve(JSON.parse(buf)));
    });
    assert.equal(res.ok, true);
  } finally { srv.close(); }
  assert.deepEqual(systemdSockets({ LISTEN_PID: String(process.pid), LISTEN_FDS: '2', LISTEN_FDNAMES: 'core:channel-signal' }),
    [{ caller: 'core', fd: 3 }, { caller: 'channel-signal', fd: 4 }]);
  assert.deepEqual(systemdSockets({ LISTEN_PID: '1', LISTEN_FDS: '2' }), []);
  await assert.rejects(listen(b, [{ caller: 'evil', path: p }]), /caller must be/);
});

test('identity: no identity.sign; a declaration is built by the broker, signed with the agent key, only for an approved act', async () => {
  const { b, h } = mk();
  const crypto = await import('node:crypto');
  assert.equal((await dispatch(h, 'core', env('identity.sign', { purpose: 'declaration', payload_b64: Buffer.from('{"act":"book"}').toString('base64') }))).error, 'unknown_op');
  const g = await h['grant.request']({ credential: 'fake-table', ops: ['book'], constraints: BOOK, mode: 'one_shot', ttl_seconds: 600, purpose: 'Book it' }, env('grant.request', {}));
  const D = (args) => h['identity.declaration'](args, env('identity.declaration', args));
  await assert.rejects(D({ grant_id: g.grant_id, act: 'book' }), { code: 'grant_not_approved' });
  b.decide(g.grant_id, true);
  await assert.rejects(D({ grant_id: g.grant_id, act: 'pay' }), { code: 'op_not_granted' });
  await assert.rejects(D({ grant_id: g.grant_id, act: 'book', relying_party: 'https://elsewhere.example' }), { code: 'bad_request' });
  await assert.rejects(D({ grant_id: '01M85AFY92130HVBF4MF40SKBS', act: 'book' }), { code: 'grant_not_found' });
  const d = await D({ grant_id: g.grant_id, act: 'book' });
  assert.equal(d.presented, false);
  assert.equal(d.kid, b.agentKey.kid);
  assert.equal(d.declaration.relying_party, 'https://table.example');   // from the grant (the credential's site), not the caller
  assert.deepEqual(d.declaration.constraints, BOOK);
  const { canonicalize } = await import('../src/jcs.js');
  assert.ok(crypto.verify(null, Buffer.from(canonicalize(d.declaration)), b.agentKey.publicKey, Buffer.from(d.sig_b64, 'base64')));
  // Spent on the act, the one-shot grant still covers declaring it; revoked, a standing one doesn't.
  b.grants.use(b.grants.get(g.grant_id));
  assert.equal((await D({ grant_id: g.grant_id, act: 'book' })).declaration.act, 'book');
  const s = await h['grant.request']({ credential: 'fake-table', ops: ['search'], constraints: {}, mode: 'standing', ttl_seconds: 600, purpose: 'Look' }, env('grant.request', {}));
  b.decide(s.grant_id, true);
  await h['grant.revoke']({ grant_id: s.grant_id, reason: 'test' }, env('grant.revoke', {}));
  await assert.rejects(D({ grant_id: s.grant_id, act: 'search' }), { code: 'grant_revoked' });
});

const root = new URL('../../../', import.meta.url).pathname;
const ready = fs.existsSync(root + 'fixtures/node_modules/ajv');
test('the fixture errand passes with this broker, and its log verifies with parts/history', { skip: !ready && 'run npm ci in fixtures/ first' }, async () => {
  process.env.OPA_BROKER_MODULE = new URL('../src/broker.js', import.meta.url).pathname;
  try {
    const { runErrand } = await import(root + 'fixtures/errand/run.js');
    const r = await runErrand();
    assert.deepEqual(r.violations, []);
    assert.match(r.confirmation, /^FT-/);
    if (fs.existsSync(root + 'parts/history/src/logs.js')) {   // parts/history lands in its own PR
      const { verifyLog } = await import(root + 'parts/history/src/logs.js');
      const v = verifyLog(path.join(r.dir, 'actions.jsonl'), 'actions', (await import('node:crypto')).createPublicKey(fs.readFileSync(path.join(r.dir, 'broker.pub'))));
      assert.equal(v.ok, true, JSON.stringify(v.break));
      assert.equal(v.lines, 8);
    }
  } finally { delete process.env.OPA_BROKER_MODULE; }
});

test('identity: revoking a spent grant stops declarations; a revocation during the lookup is seen before signing', async () => {
  const { b, h } = mk();
  const D = (args) => h['identity.declaration'](args, env('identity.declaration', args));
  const g = await h['grant.request']({ credential: 'fake-table', ops: ['book'], constraints: BOOK, mode: 'one_shot', ttl_seconds: 600, purpose: 'Book it' }, env('grant.request', {}));
  b.decide(g.grant_id, true);
  b.grants.use(b.grants.get(g.grant_id));
  assert.equal((await h['grant.revoke']({ grant_id: g.grant_id, reason: 'changed my mind' }, env('grant.revoke', {}))).state, 'revoked');
  await assert.rejects(D({ grant_id: g.grant_id, act: 'book' }), { code: 'grant_revoked' });
  // A store slow to answer (the relying party's lookup); the grant is revoked meanwhile.
  let release = null, slowNow = false;
  const slow = { ...store, async get(ref) { if (slowNow) await new Promise((r) => { release = r; }); return store.get(ref); } };
  const s = mk(tmp(), { store: slow });
  const r = await s.h['grant.request']({ credential: 'fake-table', ops: ['book'], constraints: BOOK, mode: 'one_shot', ttl_seconds: 600, purpose: 'Book it' }, env('grant.request', {}));
  s.b.decide(r.grant_id, true);
  slowNow = true;
  const pending = s.h['identity.declaration']({ grant_id: r.grant_id, act: 'book' }, env('identity.declaration', {}));
  while (!release) await new Promise((x) => setTimeout(x, 5));
  s.b.grants.revoke(r.grant_id);
  release();
  await assert.rejects(pending, { code: 'grant_revoked' });
});

test('a grant revoked while in flight stays revoked when the call finishes', () => {
  const dir = tmp();
  const gs = new GrantStore(path.join(dir, 'grants.json'));
  const g = gs.create({ credential: 'x', ops: ['book'], constraints: BOOK, mode: 'one_shot', ttl_seconds: 600, purpose: 'p' });
  gs.decide(g.grant_id, true);
  gs.reserve(g);
  gs.revoke(g.grant_id);
  gs.use(g);
  assert.equal(g.state, 'revoked');
  assert.equal(g.uses, 1);
});

test('browser.fill_code: a code slot ends with its grant, and the grant is checked again before the code is filled', async () => {
  const { b, h } = mk();
  b.channels.add('signal');
  const ask = async (ops) => { const g = await h['grant.request']({ credential: 'fake-table', ops, constraints: {}, mode: 'standing', ttl_seconds: 600, purpose: 'Sign in' }, env('grant.request', {})); b.decide(g.grant_id, true); return g.grant_id; };
  const search = await ask(['search']), login = await ask(['login']);
  b.sessions.set('s1', { grant_id: search, url: 'https://table.example/' });   // opened under another grant
  const pending = h['browser.fill_code']({ grant_id: login, session_id: 's1', source: 'person', timeout_seconds: 30 }, env('browser.fill_code', {})).catch((e) => e.code);
  const { slots } = await h['code.slots']({ wait_seconds: 2 }, env('code.slots', {}, 'channel-signal'));
  assert.equal(slots.length, 1);
  await h['grant.revoke']({ grant_id: login, reason: 'test' }, env('grant.revoke', {}));
  assert.equal(await pending, 'grant_revoked');
  await assert.rejects(h['code.deliver']({ slot_id: slots[0].slot_id, code: '771204' }, env('code.deliver', {}, 'channel-signal')), { code: 'bad_request' });
});

test('browser.fill_code: a slot ends with the grant that opened its session; no slot opens after a revocation', async () => {
  const { b, h } = mk();
  b.channels.add('signal');
  const ask = async (hh, bb, ops) => { const g = await hh['grant.request']({ credential: 'fake-table', ops, constraints: {}, mode: 'standing', ttl_seconds: 600, purpose: 'Sign in' }, env('grant.request', {})); bb.decide(g.grant_id, true); return g.grant_id; };
  const search = await ask(h, b, ['search']), login = await ask(h, b, ['login']);
  b.sessions.set('s1', { grant_id: search, url: 'https://table.example/' });
  const pending = h['browser.fill_code']({ grant_id: login, session_id: 's1', source: 'person', timeout_seconds: 30 }, env('browser.fill_code', {})).catch((e) => e.code);
  const { slots } = await h['code.slots']({ wait_seconds: 2 }, env('code.slots', {}, 'channel-signal'));
  assert.equal(slots.length, 1);
  await h['grant.revoke']({ grant_id: search, reason: 'test' }, env('grant.revoke', {}));   // the session's grant, not the slot's
  assert.equal(await pending, 'bad_request');
  assert.equal(b.codeSlots.size, 0);
  // A revocation while the session's site is looked up: no slot is opened.
  let release = null, slowNow = false;
  const slow = { ...store, async get(ref) { if (slowNow) await new Promise((r) => { release = r; }); return store.get(ref); } };
  const s = mk(tmp(), { store: slow });
  s.b.channels.add('signal');
  const login2 = await ask(s.h, s.b, ['login']);
  s.b.sessions.set('s2', { grant_id: login2, url: 'https://table.example/' });
  slowNow = true;
  const p2 = s.h['browser.fill_code']({ grant_id: login2, session_id: 's2', source: 'person', timeout_seconds: 30 }, env('browser.fill_code', {})).catch((e) => e.code);
  while (!release) await new Promise((x) => setTimeout(x, 5));
  s.b.grants.revoke(login2);
  release();
  assert.equal(await p2, 'grant_revoked');
  assert.equal(s.b.codeSlots.size, 0);
});

test('grant end: every session is closed before the worker cleanup, so no slot opens on one meanwhile', async () => {
  let release = null;
  const worker = { mode: 'agent_browser', async close({ session_id }) { if (session_id === 'a1') await new Promise((r) => { release = r; }); return {}; } };
  const { b, h } = mk(tmp(), { worker });
  b.channels.add('signal');
  const ask = async (ops) => { const g = await h['grant.request']({ credential: 'fake-table', ops, constraints: {}, mode: 'standing', ttl_seconds: 600, purpose: 'Sign in' }, env('grant.request', {})); b.decide(g.grant_id, true); return g.grant_id; };
  const A = await ask(['search']), B2 = await ask(['login']);
  b.sessions.set('a1', { grant_id: A, url: 'https://table.example/' });
  b.sessions.set('a2', { grant_id: A, url: 'https://table.example/' });
  const revoking = h['grant.revoke']({ grant_id: A, reason: 'test' }, env('grant.revoke', {}));
  while (!release) await new Promise((x) => setTimeout(x, 5));   // the first session's cleanup is under way
  const r = await h['browser.fill_code']({ grant_id: B2, session_id: 'a2', source: 'person', timeout_seconds: 5 }, env('browser.fill_code', {})).catch((e) => e.code);
  assert.equal(r, 'origin_mismatch');
  assert.equal(b.codeSlots.size, 0);
  release();
  await revoking;
});

test('code.slots: an adapter waits, hears of each slot once (cursor), and only of its own channel\'s', async () => {
  const { b, h } = mk();
  b.channels.add('signal'); b.channels.add('web');
  const S = (args, ch = 'signal') => h['code.slots'](args, env('code.slots', args, `channel-${ch}`));
  const first = await S({ wait_seconds: 0 });
  assert.deepEqual(first.slots, []);
  for (const w of [-1, 61, 1.5, '5']) await assert.rejects(S({ wait_seconds: w }), { code: 'bad_request' }, String(w));
  const open = (id, channel) => { b.codeSlots.set(id, { session_id: id, channel, seq: ++b.slotSeq, expires_at: '2099-01-01T00:00:00Z', resolve: () => {}, timer: null }); for (const w of [...b.slotWaiters]) w(); };
  const waiting = S({ wait_seconds: 5, cursor: first.cursor });
  open('01M85SLOTWEB00000000000000', 'web');            // another channel's: doesn't wake this adapter with anything
  open('01M85SLOTSIG00000000000000', 'signal');
  const heard = await waiting;
  assert.deepEqual(heard.slots, [{ slot_id: '01M85SLOTSIG00000000000000', expires_at: '2099-01-01T00:00:00Z' }]);
  assert.deepEqual((await S({ wait_seconds: 0, cursor: heard.cursor })).slots, []);                  // heard once
  assert.equal((await S({ wait_seconds: 0 })).slots.length, 1);                                    // no cursor: every open slot
  assert.equal((await S({ wait_seconds: 0, cursor: 'beforeArestart.9' })).slots.length, 1);        // unknown cursor: the same
  // The web adapter can't fill Signal's slot; codes are 4 to 10 letters and digits, and a bad one leaves the slot open.
  const deliver = (args, ch) => h['code.deliver'](args, env('code.deliver', args, `channel-${ch}`));
  await assert.rejects(deliver({ slot_id: '01M85SLOTSIG00000000000000', code: '771204' }, 'web'), { code: 'bad_request' });
  await assert.rejects(deliver({ slot_id: '01M85SLOTSIG00000000000000', code: '77 12' }, 'signal'), { code: 'bad_request' });
  assert.deepEqual(await deliver({ slot_id: '01M85SLOTSIG00000000000000', code: '771204' }, 'signal'), { accepted: true });
  const onCore = await dispatch(h, 'core', env('code.slots', {}));
  assert.equal(onCore.error, 'unauthorized_caller');
  assert.match(onCore.message, /^code\.slots /);
});

test('browser.fill_code: with two channel adapters, the core names the one the person is on', async () => {
  const { b, h } = mk();
  b.channels.add('signal'); b.channels.add('web');
  const g = await h['grant.request']({ credential: 'fake-table', ops: ['login'], constraints: {}, mode: 'standing', ttl_seconds: 600, purpose: 'Sign in' }, env('grant.request', {}));
  b.decide(g.grant_id, true);
  b.sessions.set('s1', { grant_id: g.grant_id, url: 'https://table.example/' });
  const F = (args) => h['browser.fill_code'](args, env('browser.fill_code', args));
  await assert.rejects(F({ grant_id: g.grant_id, session_id: 's1', source: 'person', timeout_seconds: 1 }), { code: 'bad_request' });
  await assert.rejects(F({ grant_id: g.grant_id, session_id: 's1', source: 'person', channel: 'imessage', timeout_seconds: 1 }), { code: 'bad_request' });
  const r = F({ grant_id: g.grant_id, session_id: 's1', source: 'person', channel: 'web', timeout_seconds: 1 }).catch((e) => e.code);
  const { slots } = await h['code.slots']({ wait_seconds: 2 }, env('code.slots', {}, 'channel-web'));
  assert.equal(slots.length, 1);
  assert.deepEqual((await h['code.slots']({ wait_seconds: 0 }, env('code.slots', {}, 'channel-signal'))).slots, []);
  assert.equal(await r, 'code_timeout');
});

test('a one-shot grant is used once even by concurrent calls; binding arguments must match exactly', async () => {
  let calls = 0;
  const slow = { svc: { credential: 'fake-table', tools: { book: { op: 'book', run: async () => { calls += 1; await new Promise((r) => setTimeout(r, 30)); return { confirmation: 'X' }; } } } } };
  const { b, h } = mk(tmp(), { mcp: slow });
  const g = await h['grant.request']({ credential: 'fake-table', ops: ['book'], constraints: BOOK, mode: 'one_shot', ttl_seconds: 600, purpose: 'Book' }, env('x', {}));
  b.decide(g.grant_id, true);
  const call = (args) => h['mcp.call']({ grant_id: g.grant_id, server: 'svc', tool: 'book', arguments: args }, env('mcp.call', {})).then(() => 'ok', (e) => e.code);
  assert.equal(await call({ ...BOOK, notes: 'and a cake' }), 'constraint_mismatch');            // not what was approved
  assert.equal(await call({ ...BOOK, party_size: '2' }), 'constraint_mismatch');
  assert.deepEqual(await Promise.all([call(BOOK), call(BOOK)]), ['ok', 'grant_consumed']);
  assert.equal(calls, 1);
  assert.equal(b.grants.get(g.grant_id).uses, 1);
});

test('a definite refusal gives the one-shot grant back; an unknown outcome spends it', async () => {
  let mode = 'refuse';
  const rp = { svc: { credential: 'fake-table', tools: { book: { op: 'book', run: async () => { throw Object.assign(new Error(mode === 'refuse' ? 'taken' : mode === '500' ? 'server error' : 'timeout'), mode === 'refuse' ? { upstream: { error: 'not_booked' }, status: 409, definite: true } : mode === '500' ? { upstream: {}, status: 500, definite: false } : {}); } } } } };
  const { b, h } = mk(tmp(), { mcp: rp });
  const g = await h['grant.request']({ credential: 'fake-table', ops: ['book'], constraints: BOOK, mode: 'one_shot', ttl_seconds: 600, purpose: 'Book' }, env('x', {}));
  b.decide(g.grant_id, true);
  const call = () => h['mcp.call']({ grant_id: g.grant_id, server: 'svc', tool: 'book', arguments: BOOK }, env('mcp.call', {})).then(() => 'ok', (e) => e.code);
  assert.equal(await call(), 'upstream_error');
  assert.equal(b.grants.get(g.grant_id).state, 'approved');     // the restaurant said no: still usable
  mode = '500';
  assert.equal(await call(), 'upstream_error');
  assert.equal(b.grants.get(g.grant_id).state, 'consumed');     // a server error might have booked: spent
});

test('timeouts spend a one-shot grant too', async () => {
  const rp = { svc: { credential: 'fake-table', tools: { book: { op: 'book', run: async () => { throw new Error('timeout'); } } } } };
  const { b, h } = mk(tmp(), { mcp: rp });
  const g = await h['grant.request']({ credential: 'fake-table', ops: ['book'], constraints: BOOK, mode: 'one_shot', ttl_seconds: 600, purpose: 'Book' }, env('x', {}));
  b.decide(g.grant_id, true);
  await h['mcp.call']({ grant_id: g.grant_id, server: 'svc', tool: 'book', arguments: BOOK }, env('mcp.call', {})).catch(() => {});
  assert.equal(b.grants.get(g.grant_id).state, 'consumed');
});

test('browser binding click: a second call can\'t free the first call\'s hold, and a lost answer spends the grant', async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const worker = { mode: 'agent_browser', open: async () => ({ session_id: 's1', page: {} }),
    act: async (a) => { if (a.target === 'hang') { await gate; throw Object.assign(new Error('the POST lost its answer'), { code: 'navigation_failed' }); } return { page: { title: 'x', text: '' }, binding: null }; } };
  const store2 = { approval: 'none', label: 't', async get(ref) { return ref === 'fake-table' ? { record: { ref, origin: 'https://table.example' }, secret: {} } : null; } };
  const { b, h } = mk(tmp(), { worker, store: store2 });
  const look = await h['grant.request']({ credential: 'fake-table', ops: ['search'], mode: 'standing', ttl_seconds: 600, purpose: 'Look' }, env('x', {}));
  const book = await h['grant.request']({ credential: 'fake-table', ops: ['book'], constraints: BOOK, mode: 'one_shot', ttl_seconds: 600, purpose: 'Book' }, env('x', {}));
  b.decide(look.grant_id, true); b.decide(book.grant_id, true);
  const { session_id } = await h['browser.open']({ grant_id: look.grant_id, url: 'https://table.example/' }, env('x', {}));
  const act = (target) => h['browser.act']({ grant_id: look.grant_id, session_id, action: 'click', target, book_grant_id: book.grant_id }, env('x', {})).then(() => 'ok', (e) => e.code);
  const first = act('hang');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(await act('Complete reservation'), 'grant_consumed');   // held by the first call
  assert.ok(b.grants.get(book.grant_id).in_flight);                     // ...and still held
  release();
  assert.equal(await first, 'navigation_failed');
  assert.equal(b.grants.get(book.grant_id).state, 'consumed');          // the answer was lost: spent
});


test('web services: only a 4xx other than 408/429 counts as a definite refusal', async () => {
  const { webServices } = await import('../src/groundmark-http.js');
  const { generateKeyPairSync } = await import('node:crypto');
  const key = generateKeyPairSync('ed25519').privateKey;
  const reply = (status) => async () => ({ status, headers: { get: () => null }, json: async () => ({ error: 'x', message: `status ${status}` }) });
  const run = async (fetchImpl) => {
    const tools = webServices({ t: { credential: 'c', base_url: 'https://rp.example', tools: { book: { op: 'book', method: 'POST', path: '/b' } } } }, { key, keyid: 'agent.example#k1', fetchImpl });
    try { await tools.t.tools.book.run({ a: 1 }); return 'ok'; } catch (e) { return e.definite; }
  };
  assert.equal(await run(reply(409)), true);
  assert.equal(await run(reply(400)), true);
  assert.equal(await run(reply(500)), false);
  assert.equal(await run(reply(503)), false);
  assert.equal(await run(reply(408)), false);
  assert.equal(await run(reply(429)), false);
  assert.equal(await run(async () => { throw new Error('connection reset'); }), undefined);   // no answer at all: not definite
  assert.equal(await run(reply(201)), 'ok');
});

test('a binding grant at a relying party covers the exact request: tool, method, URL and body', async () => {
  const { webServices } = await import('../src/groundmark-http.js');
  const { generateKeyPairSync } = await import('node:crypto');
  const key = generateKeyPairSync('ed25519').privateKey;
  const sent = [];
  const fetchImpl = async (url, o) => { sent.push({ url, method: o.method, body: o.body, digest: o.headers['content-digest'] }); return { status: 201, ok: true, headers: { get: () => null }, json: async () => ({ confirmation: 'CV-1' }) }; };
  const cfg = (base) => ({ table: { credential: 'table.example', base_url: base, tools: {
    find_tables: { op: 'search', method: 'GET', path: '/api/availability' },
    book_table: { op: 'book', method: 'POST', path: '/api/bookings' } } } });
  const svc = { approval: 'none', label: 't', async get(ref) { return ref === 'table.example' ? { record: { ref, kind: 'service' }, secret: null } : null; } };
  const { b, h } = mk(tmp(), { store: svc, mcp: webServices(cfg('https://table.example'), { key, keyid: 'agent.example#k1', fetchImpl }) });
  const g = await h['grant.request']({ credential: 'table.example', ops: ['book'], constraints: BOOK, mode: 'one_shot', ttl_seconds: 600, purpose: 'Book' }, env('x', {}));
  const r = b.grants.get(g.grant_id).request;
  assert.equal(r.server, 'table'); assert.equal(r.tool, 'book_table');
  assert.equal(r.method, 'POST'); assert.equal(r.url, 'https://table.example/api/bookings');
  assert.match(r.content_digest, /^sha-256=:[A-Za-z0-9+/]+=*:$/);
  const { createBody } = await import('../src/grants.js');
  assert.deepEqual(createBody(b.grants.get(g.grant_id)).request, r);   // the passkey signs it
  const { facts } = await import('../approval/server.js');
  assert.deepEqual(facts(b.grants.get(g.grant_id)).find(([k]) => k === 'Sends'), ['Sends', 'POST https://table.example/api/bookings']);
  b.decide(g.grant_id, true);
  // The configuration changed after the approval: the same tool would now send elsewhere, so it's refused.
  b.mcp = webServices(cfg('https://elsewhere.example'), { key, keyid: 'agent.example#k1', fetchImpl });
  const call = (args) => h['mcp.call']({ grant_id: g.grant_id, server: 'table', tool: 'book_table', arguments: args }, env('mcp.call', {})).then(() => 'ok', (e) => e.code);
  assert.equal(await call(BOOK), 'constraint_mismatch');
  assert.equal(sent.length, 0);
  b.mcp = webServices(cfg('https://table.example'), { key, keyid: 'agent.example#k1', fetchImpl });
  // The same arguments in another order are the same request (canonical JSON body).
  assert.equal(await call(Object.fromEntries(Object.entries(BOOK).reverse())), 'ok');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, r.url); assert.equal(sent[0].digest, r.content_digest);
});

test('web services: a non-binding tool must be GET; several binding tools need call: { server, tool }', async () => {
  const { webServices } = await import('../src/groundmark-http.js');
  const { generateKeyPairSync } = await import('node:crypto');
  const key = generateKeyPairSync('ed25519').privateKey;
  assert.throws(() => webServices({ t: { credential: 'c', base_url: 'https://rp.example', tools: { look: { op: 'search', method: 'POST', path: '/x' } } } }, { key, keyid: 'k' }), /must use GET/);
  const two = webServices({ t: { credential: 'c', base_url: 'https://rp.example', tools: {
    book: { op: 'book', method: 'POST', path: '/b' }, rebook: { op: 'book', method: 'PUT', path: '/b' } } } }, { key, keyid: 'k' });
  const { b, h } = mk(tmp(), { mcp: two, store: { approval: 'none', label: 't', async get(ref) { return ref === 'c' ? { record: { ref, kind: 'service' }, secret: null } : null; } } });
  const ask = (extra) => h['grant.request']({ credential: 'c', ops: ['book'], constraints: BOOK, mode: 'one_shot', ttl_seconds: 600, purpose: 'Book', ...extra }, env('x', {}));
  await assert.rejects(ask({}), { code: 'bad_request' });
  await assert.rejects(ask({ call: { server: 't', tool: 'nope' } }), { code: 'bad_request' });
  const g = await ask({ call: { server: 't', tool: 'rebook' } });
  assert.equal(b.grants.get(g.grant_id).request.method, 'PUT');
  b.decide(g.grant_id, true);
  const r = await h['mcp.call']({ grant_id: g.grant_id, server: 't', tool: 'book', arguments: BOOK }, env('mcp.call', {})).then(() => 'ok', (e) => e.code);
  assert.equal(r, 'constraint_mismatch');   // approved for rebook, not book
});

test('a binding call needs the exact request it was approved for: none recorded, or a tool that changed kind, is refused', async () => {
  const mcpTool = { svc: { credential: 'fake-table', tools: { book: { op: 'book', run: async () => ({ confirmation: 'X' }) } } } };
  const { b, h } = mk(tmp(), { mcp: {} });   // no tool yet: the grant gets no exact request
  const g = await h['grant.request']({ credential: 'fake-table', ops: ['book'], constraints: BOOK, mode: 'one_shot', ttl_seconds: 600, purpose: 'Book' }, env('x', {}));
  assert.equal(b.grants.get(g.grant_id).request, null);
  b.decide(g.grant_id, true);
  b.mcp = mcpTool;
  const call = (id) => h['mcp.call']({ grant_id: id, server: 'svc', tool: 'book', arguments: BOOK }, env('mcp.call', {})).then(() => 'ok', (e) => e.code);
  assert.equal(await call(g.grant_id), 'constraint_mismatch');
  // Approved for an MCP tool; the same name is now a relying party that would sign an HTTP request nobody saw.
  const g2 = await h['grant.request']({ credential: 'fake-table', ops: ['book'], constraints: BOOK, mode: 'one_shot', ttl_seconds: 600, purpose: 'Book' }, env('x', {}));
  b.decide(g2.grant_id, true);
  b.mcp = { svc: { credential: 'fake-table', tools: { book: { op: 'book', describe: () => ({ method: 'POST', url: 'https://x.example/b' }), run: async () => ({}) } } } };
  assert.equal(await call(g2.grant_id), 'constraint_mismatch');
  b.mcp = mcpTool;
  assert.equal(await call(g2.grant_id), 'ok');
});

test('web services: arguments can\'t replace a query parameter fixed in the configured path', async () => {
  const { webServices } = await import('../src/groundmark-http.js');
  const { generateKeyPairSync } = await import('node:crypto');
  const sent = [];
  const fetchImpl = async (url) => { sent.push(url); return { status: 200, ok: true, headers: { get: () => null }, json: async () => ({}) }; };
  const t = webServices({ rp: { credential: 'c', base_url: 'https://rp.example', tools: { look: { op: 'search', method: 'GET', path: '/rpc?action=search' } } } },
    { key: generateKeyPairSync('ed25519').privateKey, keyid: 'k', fetchImpl }).rp.tools.look;
  await assert.rejects(t.run({ action: 'pay', amount: 1000 }), (e) => e.local === true && /fixed query parameter/.test(e.message));
  const empty = webServices({ rp: { credential: 'c', base_url: 'https://rp.example', tools: { look: { op: 'search', method: 'GET', path: '/rpc?=search' } } } },
    { key: generateKeyPairSync('ed25519').privateKey, keyid: 'k', fetchImpl }).rp.tools.look;
  await assert.rejects(empty.run({ '': 'pay' }), /fixed query parameter/);   // an empty name is a name too
  assert.equal(sent.length, 0);
  // Through the broker it's a bad_request, and the standing grant is untouched.
  const svc = { approval: 'none', label: 't', async get(ref) { return ref === 'c' ? { record: { ref, kind: 'service' }, secret: null } : null; } };
  const { b, h } = mk(tmp(), { store: svc, mcp: { rp: { credential: 'c', tools: { look: t } } } });
  const g = await h['grant.request']({ credential: 'c', ops: ['search'], mode: 'standing', ttl_seconds: 600, purpose: 'Look' }, env('x', {}));
  b.decide(g.grant_id, true);
  await assert.rejects(h['mcp.call']({ grant_id: g.grant_id, server: 'rp', tool: 'look', arguments: { action: 'pay' } }, env('mcp.call', {})), { code: 'bad_request' });
  assert.equal(b.grants.get(g.grant_id).state, 'approved');
  await t.run({ date: '2026-12-04' });
  assert.equal(sent[0], 'https://rp.example/rpc?action=search&date=2026-12-04');
});

test('the approval page and the chat card show every constraint a binding call will send, and the call', async () => {
  const { facts, approvePage } = await import('../approval/server.js');
  const g = { grant_id: '01M85AFY92130HVBF4MF40SKBS', ops: ['pay'], mode: 'one_shot', ttl_seconds: 600, purpose: 'Pay the deposit', credential: 'shop', created_at: new Date().toISOString(),
    summary: 'Pay', hash: 'h', constraints: { amount: '25.00', currency: 'CAD', recipient: { name: 'Casa Verde', account: 'cv-1' }, notes: 'deposit' },
    request: { server: 'shop', tool: 'pay', method: 'POST', url: 'https://shop.example/pay', content_digest: 'sha-256=:x:' } };
  const f = Object.fromEntries(facts(g));
  assert.equal(f.amount, '25.00');
  assert.equal(f.currency, 'CAD');
  assert.equal(f.recipient, '{"name":"Casa Verde","account":"cv-1"}');
  assert.equal(f.Notes, 'deposit');
  assert.equal(f.Sends, 'POST https://shop.example/pay');
  const html = approvePage(g, Date.now());
  for (const s of ['amount', '25.00', 'recipient', 'cv-1', 'POST https://shop.example/pay']) assert.ok(html.includes(s.replace(/"/g, '&quot;')), s);
  assert.equal(Object.fromEntries(facts({ ...g, request: { server: 'fake-reservations', tool: 'book_table' } })).Calls, 'fake-reservations / book_table');
  // Objects inside familiar fields, and changes carrying more than item and quantity, are shown in full.
  const { constraintRows } = await import('../approval/server.js');
  const rows = Object.fromEntries(constraintRows({ notes: { amount: 1000, recipient: 'hidden' }, changes: [{ item: 'coffee', quantity: 1, price: 1000 }] }));
  assert.equal(rows.Notes, '{"amount":1000,"recipient":"hidden"}');
  assert.equal(rows.Changes, '[{"item":"coffee","quantity":1,"price":1000}]');
  assert.equal(Object.fromEntries(constraintRows({ changes: [{ item: 'coffee', quantity: 2 }, { skip: '2026-12-04' }] })).Changes, 'coffee: 2; skip 2026-12-04');
});

test('browser binding click: the book or pay grant must be for the session\'s site and carry what the page is checked against', async () => {
  let acts = 0;
  const worker = { mode: 'agent_browser', open: async () => ({ session_id: 'o1', page: {} }), act: async () => { acts += 1; return { page: { title: 'x', text: '' }, binding: null }; } };
  const sites = { 'fake-table': 'https://table.example', 'other-site': 'https://other.example' };
  const store2 = { approval: 'none', label: 't', async get(ref) { return sites[ref] ? { record: { ref, origin: sites[ref] }, secret: {} } : null; } };
  const { b, h } = mk(tmp(), { worker, store: store2 });
  const ask = async (a) => { const g = await h['grant.request']({ mode: 'one_shot', ttl_seconds: 600, purpose: 'p', ...a }, env('x', {})); b.decide(g.grant_id, true); return g.grant_id; };
  const look = await ask({ credential: 'other-site', ops: ['search'], mode: 'standing' });
  const { session_id } = await h['browser.open']({ grant_id: look, url: 'https://other.example/' }, env('x', {}));
  const act = (book_grant_id) => h['browser.act']({ grant_id: look, session_id, action: 'click', target: 'Complete reservation', book_grant_id }, env('x', {})).then(() => 'ok', (e) => e.code);
  // Approved for table.example, clicked on other.example: refused before the worker runs, and the grant is untouched.
  const elsewhere = await ask({ credential: 'fake-table', ops: ['book'], constraints: BOOK });
  assert.equal(await act(elsewhere), 'origin_mismatch');
  assert.equal(acts, 0);
  assert.equal(b.grants.get(elsewhere).state, 'approved');
  assert.equal(b.grants.get(elsewhere).in_flight, undefined);
  // A pay grant has to carry the booking the page is checked against (browser-worker.md), like book.
  const bare = await ask({ credential: 'other-site', ops: ['pay'] });
  assert.equal(await act(bare), 'constraint_mismatch');
  assert.equal(acts, 0);
  const pay = await ask({ credential: 'other-site', ops: ['pay'], constraints: BOOK });
  assert.equal(await act(pay), 'ok');
  assert.equal(acts, 1);
  // edit_order is checked against its changes, not a booking's details: it reaches the worker, which checks the page.
  const edit = await ask({ credential: 'other-site', ops: ['edit_order'], constraints: { changes: [{ item: 'milk', quantity: 2 }] } });
  assert.equal(await act(edit), 'ok');
  assert.equal(acts, 2);
});

test('a failed log write doesn\'t skip the clean-up: sessions close and the core hears, on revoke, decide and sweep', async () => {
  const closed = [];
  const worker = { mode: 'agent_browser', open: async () => ({ session_id: `w${closed.length}`, page: {} }), close: async ({ session_id }) => { closed.push(session_id); } };
  const store2 = { approval: 'none', label: 't', async get(ref) { return ref === 'fake-table' ? { record: { ref, origin: 'https://table.example' }, secret: {} } : null; } };
  const { b, h, events } = mk(tmp(), { worker, store: store2 });
  const ask = async () => (await h['grant.request']({ credential: 'fake-table', ops: ['search'], mode: 'standing', ttl_seconds: 600, purpose: 'Look' }, env('x', {}))).grant_id;
  const open = async (g) => (await h['browser.open']({ grant_id: g, url: 'https://table.example/' }, env('x', {}))).session_id;
  const g1 = await ask(), g2 = await ask();
  b.decide(g1, true);
  const s1 = await open(g1);
  const append = b.log.append.bind(b.log);
  b.log.append = () => { throw new Error('disk full'); };
  // The person revokes from the page; the log write fails, and the session still closes and the core is told.
  await assert.rejects(b.revoke(g1, 'stop', 'person'), /disk full/);
  assert.deepEqual(closed, [s1]);
  assert.equal(b.sessions.size, 0);
  assert.deepEqual(events.at(-1), [g1, 'revoked']);
  // A decision stands once stored: the core hears of it even if the log write fails.
  assert.throws(() => b.decide(g2, true), /disk full/);
  assert.deepEqual(events.at(-1), [g2, 'approved']);
  b.log.append = append;
  const s2 = await open(g2);
  // Expiry: the grant runs out, the log write fails, and the session still closes.
  b.grants.get(g2).expires_at = new Date(Date.now() - 1000).toISOString();
  b.log.append = () => { throw new Error('disk full'); };
  await assert.rejects(b.sweep(), /disk full/);
  assert.ok(closed.includes(s2));
  assert.deepEqual(events.at(-1), [g2, 'expired']);
});

test('the actions log takes text that isn\'t well-formed, and still refuses a secret', async () => {
  const { ActionsLog, clip } = await import('../src/actions-log.js');
  const { generateKeyPairSync } = await import('node:crypto');
  const file = path.join(tmp(), 'actions.jsonl');
  const log = new ActionsLog(file, generateKeyPairSync('ed25519').privateKey);
  const half = '🍽️ table'.slice(0, 1);                      // half an emoji: a lone surrogate
  const line = log.append({ type: 'grant.refused', detail: { message: `page says ${half}`, [half]: [half] } });
  assert.equal(line.detail.message, 'page says \ufffd');
  assert.ok(fs.readFileSync(file, 'utf8').includes('page says'));
  assert.equal(clip('ab🍽️cd', 3), 'ab🍽');                    // cut between characters, not inside one
  class Secret { constructor(v) { this.v = v; } }
  assert.throws(() => log.append({ type: 'grant.refused', detail: { s: new Secret('x') } }), /not a plain object/);
});

test('a broker connection outlasts the longest wait for a one-time code', async () => {
  const { IDLE_MS } = await import('../src/sockets.js');
  const { MAX_CODE_WAIT_S } = await import('../src/grants.js');
  assert.ok(IDLE_MS >= MAX_CODE_WAIT_S * 1000 + 60_000);
});

test('web services: a signed request never follows a redirect, and a redirect is not a success', async (t) => {
  const http = await import('node:http');
  const { webServices } = await import('../src/groundmark-http.js');
  const { generateKeyPairSync } = await import('node:crypto');
  const key = generateKeyPairSync('ed25519').privateKey;
  const reached = [];
  const serve = (fn) => new Promise((ok) => { const s = http.createServer(fn).listen(0, '127.0.0.1', () => ok(s)); t.after(() => s.close()); });
  const other = await serve((req, res) => { reached.push(req.headers); res.end('{}'); });
  const rp = await serve((req, res) => { req.resume(); res.writeHead(req.url.startsWith('/after') ? 303 : 307, { location: `http://127.0.0.1:${other.address().port}/x` }); res.end(); });
  const tools = webServices({ rp: { credential: 'c', base_url: `http://127.0.0.1:${rp.address().port}`, tools: {
    book: { op: 'book', method: 'POST', path: '/b' }, booked: { op: 'book', method: 'POST', path: '/after' }, look: { op: 'search', path: '/l' } } } }, { key, keyid: 'agent.example#k1' });
  const outcome = (p) => p.then(() => 'ok', (e) => `${e.status} definite=${e.definite}`);
  assert.equal(await outcome(tools.rp.tools.book.run({ a: 1 })), '307 definite=false');    // might have been done before the redirect
  assert.equal(await outcome(tools.rp.tools.booked.run({ a: 1 })), '303 definite=false');  // post/redirect/get: very likely done
  assert.equal(await outcome(tools.rp.tools.look.run({ q: 1 })), '307 definite=false');
  assert.equal(reached.length, 0);   // the signature never went to the other host
});

// A store or worker call that waits until the test lets it go.
const gate = () => { let open; const p = new Promise((r) => { open = r; }); const g = { waiting: false, wait: () => { g.waiting = true; return p; }, open }; return g; };
const until = async (f) => { while (!f()) await new Promise((x) => setTimeout(x, 5)); };

test('a revocation while a call waits on the store or the worker is seen before the broker acts', async () => {
  const done = [];
  let g1 = null, g2 = null;
  const worker = { mode: 'agent_browser',
    open: async () => { if (g2) await g2.wait(); done.push('open'); return { session_id: `w${done.length}`, page: {} }; },
    close: async ({ session_id }) => { done.push(`close ${session_id}`); return {}; },
    extract: async () => { done.push('extract'); return { page: {} }; },
    fill_login: async () => { done.push('fill_login'); return { filled: 2 }; } };
  const login = { ref: 'aaaaaaaa-0000-4000-8000-000000000001', record: { ref: 'aaaaaaaa-0000-4000-8000-000000000001', username: 'diner@example.test', origin: 'https://table.example' }, secret: {} };
  const slowStore = { ...store, async find() { return [login]; }, async get(ref) { if (g1) await g1.wait(); return ref === login.ref ? login : store.get(ref); } };
  const mcp = { svc: { credential: 'fake-table', tools: { look: { op: 'search', run: async () => { done.push('mcp'); return {}; } } } } };
  const { b, h } = mk(tmp(), { worker, store: slowStore, mcp });
  const ask = async (a) => { const g = await h['grant.request']({ mode: 'standing', ttl_seconds: 600, purpose: 'p', ...a }, env('x', {})); b.decide(g.grant_id, true); return g.grant_id; };
  const code = (p) => p.then(() => 'ok', (e) => e.code);
  const revokeWhile = async (gt, grant_id, call) => {
    const p = code(call());
    await until(() => gt.waiting);
    await h['grant.revoke']({ grant_id, reason: 'test' }, env('grant.revoke', {}));
    gt.open();
    return p;
  };
  // fill_login under a credential-by-site grant: revoked while the vault is asked.
  const site = await ask({ credential: { domain: 'table.example' }, ops: ['login'] });
  b.sessions.set('s1', { grant_id: site, url: 'https://table.example/' });
  assert.equal(await revokeWhile(g1 = gate(), site, () => h['browser.fill_login']({ grant_id: site, session_id: 's1' }, env('x', {}))), 'grant_revoked');
  // mcp.call: revoked while the store is read.
  g1 = null;
  const rp = await ask({ credential: 'fake-table', ops: ['search'] });
  assert.equal(await revokeWhile(g1 = gate(), rp, () => h['mcp.call']({ grant_id: rp, server: 'svc', tool: 'look', arguments: {} }, env('x', {}))), 'grant_revoked');
  // extract: revoked while the session's site is looked up.
  g1 = null;
  const look = await ask({ credential: 'fake-table', ops: ['search'] });
  b.sessions.set('s2', { grant_id: look, url: 'https://table.example/' });
  assert.equal(await revokeWhile(g1 = gate(), look, () => h['browser.extract']({ grant_id: look, session_id: 's2', target: 'x' }, env('x', {}))), 'grant_revoked');
  g1 = null;
  assert.deepEqual(done, ['close s1', 'close s2']);   // nothing filled, called or read (the revoked grants' sessions closed)
  done.length = 0;
  // open: revoked while the worker opens the page. The session it opened is closed, not left behind.
  const look2 = await ask({ credential: 'fake-table', ops: ['search'] });
  assert.equal(await revokeWhile(g2 = gate(), look2, () => h['browser.open']({ grant_id: look2, url: 'https://table.example/' }, env('x', {}))), 'grant_revoked');
  assert.deepEqual(done, ['open', 'close w1']);
  assert.equal([...b.sessions.values()].filter((s) => s.grant_id === look2).length, 0);
});

test('a one-shot grant is used once by concurrent browser calls too', async () => {
  let opens = 0, fills = 0;
  const worker = { mode: 'agent_browser', close: async () => ({}),
    open: async () => { opens += 1; await new Promise((r) => setTimeout(r, 20)); return { session_id: `o${opens}`, page: {} }; },
    fill_login: async () => { fills += 1; await new Promise((r) => setTimeout(r, 20)); return { filled: 2 }; } };
  const { b, h } = mk(tmp(), { worker });
  const ask = async (ops) => { const g = await h['grant.request']({ credential: 'fake-table', ops, mode: 'one_shot', ttl_seconds: 600, purpose: 'p' }, env('x', {})); b.decide(g.grant_id, true); return g.grant_id; };
  const code = (p) => p.then(() => 'ok', (e) => e.code);
  const read = await ask(['read']);
  const open = () => code(h['browser.open']({ grant_id: read, url: 'https://table.example/' }, env('x', {})));
  assert.deepEqual(await Promise.all([open(), open()]), ['ok', 'grant_consumed']);
  assert.equal(opens, 1);
  assert.equal(b.grants.get(read).uses, 1);
  const login = await ask(['login']);
  b.sessions.set('s1', { grant_id: login, url: 'https://table.example/' });
  const fill = () => code(h['browser.fill_login']({ grant_id: login, session_id: 's1' }, env('x', {})));
  assert.deepEqual(await Promise.all([fill(), fill()]), ['ok', 'grant_consumed']);
  assert.equal(fills, 1);
  // A call refused before it acts gives the one-shot grant back.
  const read2 = await ask(['read']);
  assert.equal(await code(h['browser.open']({ grant_id: read2, url: 'https://elsewhere.example/' }, env('x', {}))), 'origin_mismatch');
  assert.equal(b.grants.get(read2).in_flight, undefined);
  assert.equal(await code(h['browser.open']({ grant_id: read2, url: 'https://table.example/' }, env('x', {}))), 'ok');
});

test('a spent one-shot grant\'s sessions close with it, and the sweep closes any left over', async () => {
  const closed = [];
  const worker = { mode: 'agent_browser', open: async () => ({ session_id: 'o1', page: { title: 'Bookings' } }), close: async ({ session_id }) => { closed.push(session_id); return {}; } };
  const { b, h } = mk(tmp(), { worker });
  const ask = async (ops, mode = 'one_shot') => { const g = await h['grant.request']({ credential: 'fake-table', ops, mode, ttl_seconds: 600, purpose: 'p' }, env('x', {})); b.decide(g.grant_id, true); return g.grant_id; };
  const once = await ask(['read']);
  const r = await h['browser.open']({ grant_id: once, url: 'https://table.example/' }, env('x', {}));
  assert.equal(r.page.title, 'Bookings');                  // the open was the grant's one use, and the core has its page
  assert.equal(b.grants.get(once).state, 'consumed');
  assert.deepEqual(closed, ['o1']);
  assert.equal(b.sessions.size, 0);                       // no other grant can drive it now
  const standing = await ask(['search'], 'standing');
  await assert.rejects(h['browser.extract']({ grant_id: standing, session_id: 'o1', target: 'x' }, env('x', {})), { code: 'origin_mismatch' });
  // Spent some other way (an unknown outcome at a tool, say) with a session still open under it: the sweep closes it.
  const other = await ask(['read']);
  b.sessions.set('left', { grant_id: other, url: 'https://table.example/' });
  b.grants.use(b.grants.get(other));
  await b.sweep();
  assert.deepEqual(closed, ['o1', 'left']);
  assert.equal(b.sessions.size, 0);
});
