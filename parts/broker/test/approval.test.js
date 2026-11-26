import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Broker } from '../src/broker.js';
import { PasskeyApproval, openEnrollment } from '../approval/server.js';
import { SoftAuthenticator } from './soft-authenticator.js';

const ORIGIN = 'https://approve.example.test';
const HOST = 'approve.example.test';
const BOOK = { venue: 'Casa Verde', date: '2026-12-04', time: '19:00', party_size: 2 };
const store = { approval: 'none', label: 'test', async get(ref) { return ref === 'fake-table' ? { record: { ref }, secret: {} } : null; } };

/** One HTTP request to the page as the browser at ORIGIN would make it (Host and Origin set). */
function call(port, method, p, body, { host = HOST, origin = ORIGIN } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: {
      host, ...(method === 'POST' ? { origin, 'content-type': 'application/json' } : {}),
    } }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: /json/.test(res.headers['content-type']) ? JSON.parse(b) : b }));
    });
    r.on('error', reject);
    r.end(data);
  });
}

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opa-approval-'));
  const approval = new PasskeyApproval({ stateDir: dir, origins: [ORIGIN], rpId: 'example.test', port: 0 });
  const events = [];
  const broker = new Broker({ stateDir: dir, store, approvals: approval, onGrantEvent: (id, s) => events.push(s) });
  await approval.open(broker);
  const ask = (constraints = BOOK) => broker.handlers()['grant.request']({ credential: 'fake-table', ops: ['book'], constraints, mode: 'one_shot', ttl_seconds: 600, purpose: 'Book the table' }, { errand_id: null });
  return { dir, approval, broker, events, ask, port: approval.port };
}

async function enroll(s, auth) {
  const token = openEnrollment(s.dir);
  assert.match((await call(s.port, 'GET', `/enroll/${token}`)).body, /Set up your passkey/);
  const opts = (await call(s.port, 'GET', `/enroll/${token}/options`)).body;
  assert.equal(opts.rp.id, 'example.test');
  const r = await call(s.port, 'POST', `/enroll/${token}`, await auth.register(opts, ORIGIN));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return token;
}

const approveWith = async (s, auth, grantId, opts = {}) => {
  const o = (await call(s.port, 'GET', `/approve/${grantId}/options`)).body;
  return call(s.port, 'POST', `/approve/${grantId}`, await auth.assert(o, ORIGIN, opts));
};

test('enroll once with a one-time link, then approve a grant with the passkey', async () => {
  const s = await setup();
  try {
    const auth = new SoftAuthenticator();
    const token = await enroll(s, auth);
    assert.equal((await call(s.port, 'GET', `/enroll/${token}`)).status, 404);           // the link is spent
    assert.equal(s.approval.passkeys.length, 1);
    assert.match(fs.readFileSync(path.join(s.dir, 'admin.jsonl'), 'utf8'), /"type":"passkey.register"/);

    const g = await s.ask();
    const code = s.broker.grants.get(g.grant_id).code;
    assert.equal(g.approve_url, `${ORIGIN}/a/${code}`);                                    // the short link
    assert.match(code, /^[0-9A-HJKMNP-TV-Z]{10}$/);
    assert.match((await call(s.port, 'GET', `/a/${code}`)).body, /Book Casa Verde/);      // same page as /approve/<id>
    assert.equal((await call(s.port, 'GET', '/a/0000000000')).status, 404);
    const pageHtml = (await call(s.port, 'GET', `/approve/${g.grant_id}`)).body;
    assert.match(pageHtml, /Book Casa Verde, Fri 4 Dec at 19:00, 2 people/);
    assert.match(pageHtml, /Once, within 10 minutes/);
    const r = await approveWith(s, auth, g.grant_id);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(s.broker.grants.get(g.grant_id).state, 'approved');
    assert.deepEqual(s.events, ['approved']);
    const log = fs.readFileSync(path.join(s.dir, 'actions.jsonl'), 'utf8');
    assert.match(log, new RegExp(`"passkey_credential_id":"${s.approval.passkeys[0].credentialId}"`));
    assert.equal((await call(s.port, 'GET', `/approve/${g.grant_id}`)).status, 410);      // nothing left to approve
  } finally { await s.approval.close(); }
});

test('an assertion for one grant cannot approve another; no user verification is refused', async () => {
  const s = await setup();
  try {
    const auth = new SoftAuthenticator();
    await enroll(s, auth);
    const a = await s.ask(), b = await s.ask({ ...BOOK, party_size: 12 });
    const oa = (await call(s.port, 'GET', `/approve/${a.grant_id}/options`)).body;
    const forA = await auth.assert(oa, ORIGIN);
    assert.equal((await call(s.port, 'POST', `/approve/${b.grant_id}`, forA)).status, 403);
    assert.equal(s.broker.grants.get(b.grant_id).state, 'pending');
    assert.equal((await approveWith(s, auth, a.grant_id, { uv: false })).status, 403);
    assert.equal(s.broker.grants.get(a.grant_id).state, 'pending');
  } finally { await s.approval.close(); }
});

test('declining needs no passkey; wrong host or origin is refused; no passkey yet says so', async () => {
  const s = await setup();
  try {
    const g = await s.ask();
    assert.equal((await call(s.port, 'GET', `/approve/${g.grant_id}/options`)).body.error, 'no_passkey');
    assert.equal((await call(s.port, 'GET', `/approve/${g.grant_id}`, undefined, { host: 'evil.test' })).status, 421);
    assert.equal((await call(s.port, 'POST', `/approve/${g.grant_id}/decline`, {}, { origin: 'https://evil.test' })).status, 403);
    assert.equal((await call(s.port, 'POST', `/approve/${g.grant_id}/decline`, {})).status, 200);
    assert.equal(s.broker.grants.get(g.grant_id).state, 'denied');
    assert.deepEqual(s.events, ['denied']);
    assert.match((await call(s.port, 'GET', `/approve/${g.grant_id}`)).body, /You declined this/);
    assert.equal((await call(s.port, 'GET', '/enroll/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).status, 404);
    assert.equal((await call(s.port, 'GET', '/approve')).status, 404);                       // nothing lists grants
  } finally { await s.approval.close(); }
});

test('an expired setup link does nothing', async () => {
  const s = await setup();
  try {
    const token = openEnrollment(s.dir, Date.now() - 16 * 60_000);
    assert.equal((await call(s.port, 'GET', `/enroll/${token}/options`)).status, 404);
  } finally { await s.approval.close(); }
});

test('one setup link registers one passkey, even with two tries at the same moment', async () => {
  const s = await setup();
  try {
    const token = openEnrollment(s.dir);
    const a1 = new SoftAuthenticator(), a2 = new SoftAuthenticator();
    const o1 = (await call(s.port, 'GET', `/enroll/${token}/options`)).body, o2 = (await call(s.port, 'GET', `/enroll/${token}/options`)).body;
    const [r1, r2] = await Promise.all([call(s.port, 'POST', `/enroll/${token}`, await a1.register(o1, ORIGIN)), call(s.port, 'POST', `/enroll/${token}`, await a2.register(o2, ORIGIN))]);
    assert.deepEqual([r1.status, r2.status].sort(), [200, 404]);
    assert.equal(s.approval.passkeys.length, 1);
  } finally { await s.approval.close(); }
});

test("a request's details come from the broker's record (what the in-chat card shows)", async () => {
  const s = await setup();
  try {
    const g = await s.ask();
    const code = s.broker.grants.get(g.grant_id).code;
    const d = (await call(s.port, 'GET', `/a/${code}/details`)).body;
    assert.equal(d.state, 'pending');
    assert.equal(d.summary, 'Book Casa Verde, Fri 4 Dec at 19:00, 2 people, using fake-table.');
    assert.deepEqual(d.facts.slice(0, 4), [['Where', 'Casa Verde'], ['Date', '2026-12-04'], ['Time', '19:00'], ['People', '2']]);
    assert.deepEqual(d.facts.find(([k]) => k === 'Using'), ['Using', 'fake-table']);   // which credential, even when the summary omits it
    assert.equal((await call(s.port, 'GET', '/a/ZZZZZZZZZZ/details')).status, 404);
  } finally { await s.approval.close(); }
});

test('a failed registration puts the setup link back (link() never overwrites a newer link)', async () => {
  const s = await setup();
  try {
    const token = openEnrollment(s.dir);
    const opts = (await call(s.port, 'GET', `/enroll/${token}/options`)).body;
    const bad = await new SoftAuthenticator({ uv: false }).register(opts, ORIGIN);   // no user verification: refused
    assert.equal((await call(s.port, 'POST', `/enroll/${token}`, bad)).status, 403);
    assert.equal((await call(s.port, 'GET', `/enroll/${token}`)).status, 200);        // still usable
    assert.equal(fs.readdirSync(s.dir).filter((f) => f.startsWith('enroll.json.claimed')).length, 0);
    const good = await new SoftAuthenticator().register((await call(s.port, 'GET', `/enroll/${token}/options`)).body, ORIGIN);
    assert.equal((await call(s.port, 'POST', `/enroll/${token}`, good)).status, 200);
  } finally { await s.approval.close(); }
});

/** A POST whose body is sent in two parts, so something can happen in between. */
function slowPost(port, p, body) {
  const data = Buffer.from(JSON.stringify(body));
  const r = http.request({ host: '127.0.0.1', port, method: 'POST', path: p, headers: { host: HOST, origin: ORIGIN, 'content-type': 'application/json', 'content-length': data.length } });
  const done = new Promise((resolve, reject) => { r.on('response', (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); }); r.on('error', reject); });
  r.write(data.subarray(0, 10));
  return { finish: () => { r.end(data.subarray(10)); return done; }, abort: () => { r.destroy(); done.catch(() => {}); } };
}

test('a setup link put back after a failure never replaces a newer one issued meanwhile', async () => {
  const s = await setup();
  try {
    const token = openEnrollment(s.dir);
    const bad = await new SoftAuthenticator({ uv: false }).register((await call(s.port, 'GET', `/enroll/${token}/options`)).body, ORIGIN);
    const post = slowPost(s.port, `/enroll/${token}`, bad);
    await new Promise((r) => setTimeout(r, 30));            // the old link is claimed now
    const newer = openEnrollment(s.dir);                     // a newer link is issued meanwhile
    assert.equal(await post.finish(), 403);                  // the old registration fails...
    assert.equal((await call(s.port, 'GET', `/enroll/${newer}`)).status, 200);   // ...and doesn't replace the newer link
    assert.equal((await call(s.port, 'GET', `/enroll/${token}`)).status, 404);
  } finally { await s.approval.close(); }
});

test('a setup request cut off mid-body puts the link back', async () => {
  const s = await setup();
  try {
    const token = openEnrollment(s.dir);
    const reg = await new SoftAuthenticator().register((await call(s.port, 'GET', `/enroll/${token}/options`)).body, ORIGIN);
    const post = slowPost(s.port, `/enroll/${token}`, reg);
    await new Promise((r) => setTimeout(r, 30));
    post.abort();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal((await call(s.port, 'GET', `/enroll/${token}`)).status, 200);
    assert.equal(fs.readdirSync(s.dir).filter((f) => f.startsWith('enroll.json.claimed')).length, 0);
  } finally { await s.approval.close(); }
});

test('the person can revoke from the approval page: an approved grant, or a spent one-shot one', async () => {
  const s = await setup();
  try {
    const g = await s.ask();
    assert.equal((await call(s.port, 'POST', `/approve/${g.grant_id}/revoke`, {})).status, 410);   // pending: that's declining
    s.broker.decide(g.grant_id, true);
    s.broker.sessions.set('s1', { grant_id: g.grant_id, url: 'https://table.example/' });
    const shown = (await call(s.port, 'GET', `/approve/${g.grant_id}`)).body;
    assert.match(shown, /You approved this/);
    assert.match(shown, /id="revoke"/);
    assert.equal((await call(s.port, 'POST', `/approve/${g.grant_id}/revoke`, {}, { origin: 'https://evil.test' })).status, 403);
    const r = await call(s.port, 'POST', `/approve/${g.grant_id}/revoke`, {});
    assert.deepEqual(r.body, { ok: true, grant_id: g.grant_id, state: 'revoked' });
    assert.equal(s.broker.grants.get(g.grant_id).state, 'revoked');
    assert.deepEqual(s.events, ['approved', 'revoked']);   // the core didn't ask for this, so it's told
    assert.equal(s.broker.sessions.size, 0);                // its sessions end with it, as with grant.revoke
    const after = (await call(s.port, 'GET', `/approve/${g.grant_id}`)).body;
    assert.match(after, /This was revoked/);
    assert.doesNotMatch(after, /id="revoke"/);
    assert.equal((await call(s.port, 'POST', `/approve/${g.grant_id}/revoke`, {})).status, 410);
    const log = fs.readFileSync(path.join(s.dir, 'actions.jsonl'), 'utf8');
    assert.match(log, /"by":"person"[^\n]*"type":"grant\.revoked"/);
    // A spent one-shot grant, by its short link: revoking it stops declarations of the act.
    const used = await s.ask();
    s.broker.decide(used.grant_id, true);
    s.broker.grants.use(s.broker.grants.get(used.grant_id));
    const code = s.broker.grants.get(used.grant_id).code;
    assert.match((await call(s.port, 'GET', `/a/${code}`)).body, /id="revoke"/);
    assert.equal((await call(s.port, 'POST', `/a/${code}/revoke`, {})).status, 200);
    await assert.rejects(s.broker.handlers()['identity.declaration']({ grant_id: used.grant_id, act: 'book' }, { errand_id: null }), { code: 'grant_revoked' });
  } finally { await s.approval.close(); }
});
