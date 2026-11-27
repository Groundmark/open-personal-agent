import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { WebChannel } from '../src/server.js';

const ORIGIN = 'https://chat.example.test', HOST = 'chat.example.test', RP = 'example.test';
const sha = (b) => createHash('sha256').update(b).digest();
const key = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const jwk = key.publicKey.export({ format: 'jwk' });
const pinned = { credentialId: 'cred-AAAA', publicKey: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y } };

/** A passkey assertion as a browser would make it (flags UP|UV unless told otherwise). */
function assertion(challenge, { origin = ORIGIN, priv = key.privateKey, id = pinned.credentialId, flags = 0x05 } = {}) {
  const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin }));
  const authenticatorData = Buffer.concat([sha(Buffer.from(RP)), Buffer.from([flags]), Buffer.alloc(4)]);
  const signature = sign('sha256', Buffer.concat([authenticatorData, sha(clientDataJSON)]), priv);
  const b = (x) => x.toString('base64url');
  return { id, rawId: id, type: 'public-key', response: { clientDataJSON: b(clientDataJSON), authenticatorData: b(authenticatorData), signature: b(signature) } };
}

function req(port, method, p, body, { cookie, origin = ORIGIN, host = HOST, stream = false } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: { host, ...(cookie ? { cookie } : {}), ...(method === 'POST' ? { origin, 'content-type': 'application/json' } : {}) } }, (res) => {
      if (stream) return resolve(res);
      let b = ''; res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, cookie: (res.headers['set-cookie']?.[0] ?? '').split(';')[0], body: /json/.test(res.headers['content-type'] ?? '') ? JSON.parse(b) : b }));
    });
    r.on('error', reject);
    r.end(body === undefined ? null : JSON.stringify(body));
  });
}

async function setup(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opa-web-'));
  const inbound = [];
  const core = net.createServer((c) => { let b = ''; c.on('data', (d) => { b += d; if (b.includes('\n')) { const r = JSON.parse(b); inbound.push(r); c.end(JSON.stringify({ id: r.id, ok: true, result: {} }) + '\n'); } }); });
  await new Promise((r) => core.listen(path.join(dir, 'core.sock'), r));
  const ch = new WebChannel({ state_dir: dir, origins: [ORIGIN], rp_id: RP, pinned, core_socket: path.join(dir, 'core.sock'), ...extra });
  await ch.listenSocket(path.join(dir, 'web.sock'));
  const port = await ch.listenHttp(0);
  const signIn = async (opts = {}) => {
    const o = (await req(port, 'POST', '/api/signin/options', {})).body;
    return req(port, 'POST', '/api/signin', assertion(o.challenge, opts));
  };
  const coreSend = (args, caller = 'core') => new Promise((resolve) => {
    const c = net.createConnection(path.join(dir, 'web.sock'), () => c.write(JSON.stringify({ op: 'channel.send', id: '01JD0000000000000000000000', caller, errand_id: null, ts: new Date().toISOString(), args }) + '\n'));
    let b = ''; c.on('data', (d) => { b += d; }); c.on('end', () => resolve(JSON.parse(b)));
  });
  return { dir, ch, port, inbound, signIn, coreSend, stop: () => { ch.close(); core.close(); } };
}

test('passkey sign-in, a message to the core, the reply streamed back', async () => {
  const s = await setup();
  try {
    assert.equal((await req(s.port, 'POST', '/api/send', { text: 'hi' })).status, 401);
    const r = await s.signIn();
    assert.equal(r.status, 200);
    assert.match(r.cookie, /^sid=/);
    assert.equal((await req(s.port, 'POST', '/api/send', { text: 'Book a table for two Friday at 7' }, { cookie: r.cookie })).status, 200);
    assert.equal(s.inbound[0].op, 'channel.inbound');
    assert.equal(s.inbound[0].caller, 'channel-web');
    assert.equal(s.inbound[0].args.from, pinned.credentialId);
    const stream = await req(s.port, 'GET', '/api/events', undefined, { cookie: r.cookie, stream: true });
    let got = ''; stream.on('data', (d) => { got += d; });
    await new Promise((x) => setTimeout(x, 50));
    const sent = await s.coreSend({ channel: 'web', to: pinned.credentialId, text: 'What time works?' });
    assert.equal(sent.ok, true);
    await new Promise((x) => setTimeout(x, 50));
    assert.match(got, /"text":"What time works\?"/);
    // A second device catches up on everything, both ways.
    const later = await req(s.port, 'GET', '/api/events?after=0', undefined, { cookie: r.cookie, stream: true });
    let caught = ''; later.on('data', (d) => { caught += d; });
    await new Promise((x) => setTimeout(x, 50));
    assert.match(caught, /"who":"me","text":"Book a table for two Friday at 7"/);
    assert.match(caught, /"who":"them","text":"What time works\?"/);
    later.destroy();
    stream.destroy();
  } finally { s.stop(); }
});

test('sign-in refuses another key, another site, no user verification, and a reused challenge', async () => {
  const s = await setup();
  try {
    const other = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
    assert.equal((await s.signIn({ priv: other })).status, 403);
    assert.equal((await s.signIn({ origin: 'https://evil.test' })).status, 403);
    assert.equal((await s.signIn({ flags: 0x01 })).status, 403);
    const o = (await req(s.port, 'POST', '/api/signin/options', {})).body;
    assert.equal((await req(s.port, 'POST', '/api/signin', assertion(o.challenge))).status, 200);
    assert.equal((await req(s.port, 'POST', '/api/signin', assertion(o.challenge))).status, 403);   // spent
    assert.equal((await req(s.port, 'GET', '/api/me', undefined, { host: 'evil.test' })).status, 421);
    assert.equal((await req(s.port, 'POST', '/api/signin/options', {}, { origin: 'https://evil.test' })).status, 403);
  } finally { s.stop(); }
});

test('password sign-in is off unless the config turns it on', async () => {
  const s = await setup();
  try {
    const me = (await req(s.port, 'GET', '/api/me')).body;
    assert.equal(me.password_signin, false);
    assert.equal(me.has_password, false);
    fs.writeFileSync(path.join(s.dir, 'password.json'), JSON.stringify({ salt: 'x', hash: 'y' }), { mode: 0o600 });   // left from when it was on
    assert.equal((await req(s.port, 'GET', '/api/me')).body.has_password, false);
    const r = await req(s.port, 'POST', '/api/signin/password', { password: 'anything at all' });
    assert.equal(r.status, 404);
    assert.equal(r.body.error, 'password_signin_off');
    assert.equal((await req(s.port, 'POST', '/api/password', { password: 'correct horse battery staple' })).status, 404);
  } finally { s.stop(); }
});

test('a password, set once signed in, signs in on a computer; wrong ones lock after 10', async () => {
  const s = await setup({ password_signin: true });
  try {
    assert.equal((await req(s.port, 'GET', '/api/me')).body.has_password, false);
    assert.equal((await req(s.port, 'POST', '/api/signin/password', { password: 'anything at all' })).status, 403);
    const { cookie } = await s.signIn();
    assert.equal((await req(s.port, 'POST', '/api/password', { password: 'short' }, { cookie })).status, 400);
    assert.equal((await req(s.port, 'POST', '/api/password', { password: 'correct horse battery staple' }, { cookie })).status, 200);
    assert.equal(fs.statSync(path.join(s.dir, 'password.json')).mode & 0o777, 0o600);
    assert.doesNotMatch(fs.readFileSync(path.join(s.dir, 'password.json'), 'utf8'), /horse/);
    const ok = await req(s.port, 'POST', '/api/signin/password', { password: 'correct horse battery staple' });
    assert.equal(ok.status, 200);
    assert.equal((await req(s.port, 'GET', '/api/me', undefined, { cookie: ok.cookie })).body.signed_in, true);
    for (let i = 0; i < 10; i++) assert.equal((await req(s.port, 'POST', '/api/signin/password', { password: `wrong ${i}` })).status, 403);
    assert.equal((await req(s.port, 'POST', '/api/signin/password', { password: 'correct horse battery staple' })).status, 429);
  } finally { s.stop(); }
});

test('channel.send: only to the paired account, only from the core', async () => {
  const s = await setup();
  try {
    assert.equal((await s.coreSend({ channel: 'web', to: 'someone-else', text: 'x' })).error, 'recipient_not_allowed');
    assert.equal((await s.coreSend({ channel: 'web', to: pinned.credentialId, text: 'x' }, 'channel-signal')).error, 'unauthorized_caller');
  } finally { s.stop(); }
});

test('/approve/* goes to the approval page with Host and Origin kept', async () => {
  const seen = [];
  const up = http.createServer((q, r) => { seen.push([q.method, q.url, q.headers.host, q.headers.origin]); r.writeHead(200, { 'content-type': 'application/json' }); r.end('{"ok":true}'); });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const s = await setup({ approval_upstream: `http://127.0.0.1:${up.address().port}` });
  try {
    const id = '01M85C77CFCPQS8CTXV9962TAF';
    assert.equal((await req(s.port, 'POST', `/approve/${id}/decline`, {})).status, 200);
    assert.deepEqual(seen[0], ['POST', `/approve/${id}/decline`, HOST, ORIGIN]);
  } finally { s.stop(); up.closeAllConnections(); up.close(); }
});

// ---- notifications ----
import { createDecipheriv, createECDH, createHmac } from 'node:crypto';
import { encrypt, pushHostOk, vapidKeys } from '../src/push.js';

/** What the phone does with a push (RFC 8291), to check our encryption. */
function decrypt(body, ua, auth) {
  const hm = (k, d) => createHmac('sha256', k).update(d).digest();
  const salt = body.subarray(0, 16), idlen = body[20], asPublic = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
  const ikm = hm(hm(auth, ua.computeSecret(asPublic)), Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic, Buffer.from([1])]));
  const prk = hm(salt, ikm);
  const d = createDecipheriv('aes-128-gcm', hm(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16), hm(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12));
  d.setAuthTag(ct.subarray(ct.length - 16));
  const pt = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  return pt.subarray(0, pt.lastIndexOf(2)).toString();
}

test('push: the message is encrypted for the device and only the device can read it', () => {
  const ua = createECDH('prime256v1'); ua.generateKeys();
  const auth = Buffer.from('0123456789abcdef');
  const body = encrypt('{"title":"Your agent"}', { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') });
  assert.equal(decrypt(body, ua, auth), '{"title":"Your agent"}');
  assert.ok(!body.includes(Buffer.from('Your agent')));
  assert.equal(pushHostOk('https://fcm.googleapis.com/fcm/send/x'), true);
  assert.equal(pushHostOk('https://web.push.apple.com/abc'), true);
  assert.equal(pushHostOk('http://fcm.googleapis.com/x'), false);
  assert.equal(pushHostOk('https://169.254.169.254/latest'), false);
});

test('push: devices without the chat open get a notification; a gone subscription is dropped', async () => {
  const sent = []; let status = 201;
  const ua = createECDH('prime256v1'); ua.generateKeys();
  const auth = Buffer.from('fedcba9876543210');
  const s = await setup({ ack_wait_ms: 80, push_hosts: ['^push\\.example\\.test$'], push_fetch: async (url, o) => { sent.push({ url, o }); return { status }; } });
  try {
    const { cookie } = await s.signIn();
    assert.equal((await req(s.port, 'POST', '/api/push/subscribe', { endpoint: 'https://evil.example/x', keys: { p256dh: 'a', auth: 'b' } }, { cookie })).status, 400);
    const sub = { endpoint: 'https://push.example.test/sub/1', keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } };
    assert.equal((await req(s.port, 'POST', '/api/push/subscribe', sub, { cookie })).status, 200);
    assert.equal((await req(s.port, 'GET', '/api/me', undefined, { cookie })).body.push, true);
    // The chat is in view on that device and shows the message: no notification.
    const stream = await req(s.port, 'GET', '/api/events', undefined, { cookie, stream: true });
    let last = ''; stream.on('data', (d) => { const m = [...String(d).matchAll(/^id: (\S+)/gm)].pop(); if (m) last = m[1]; });
    const here = (extra = {}) => req(s.port, 'POST', '/api/here', { page: 'p1', cursor: last, ...extra }, { cookie });
    await here();
    await s.coreSend({ channel: 'web', to: pinned.credentialId, text: 'Hello' });
    await new Promise((x) => setTimeout(x, 30));
    await here();                                              // the page says it showed it
    await new Promise((x) => setTimeout(x, 120));
    assert.equal(sent.length, 0);
    // In view, but the message never reaches the page (a stream left half-open when the phone locked): it goes anyway.
    await s.coreSend({ channel: 'web', to: pinned.credentialId, text: 'Missed' });
    await new Promise((x) => setTimeout(x, 30));
    assert.equal(sent.length, 0);
    await new Promise((x) => setTimeout(x, 120));
    assert.equal(sent.length, 1);
    sent.length = 0;
    await here({ away: true });                                // the page went out of view
    stream.destroy(); await new Promise((x) => setTimeout(x, 30));
    // Not in view: the approval request becomes a notification at once, encrypted for the device, with VAPID.
    await s.coreSend({ channel: 'web', to: pinned.credentialId, text: 'It needs your approval.\n\nBook Casa Verde, Fri 27 Nov at 19:00, 2 people.\nApprove: https://approve.example.test/a/K7QM2XR4PD' });
    await new Promise((x) => setTimeout(x, 50));
    assert.equal(sent.length, 1);
    assert.match(sent[0].o.headers.authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]{87}$/);
    assert.deepEqual(JSON.parse(decrypt(sent[0].o.body, ua, auth)), { title: 'Your agent needs your OK', body: 'Book Casa Verde, Fri 27 Nov at 19:00, 2 people.', url: '/' });
    status = 410;
    await s.coreSend({ channel: 'web', to: pinned.credentialId, text: 'Booked.' });
    await new Promise((x) => setTimeout(x, 50));
    assert.equal((await req(s.port, 'GET', '/api/me', undefined, { cookie })).body.push, false);   // gone: dropped
  } finally { s.stop(); }
});

test('signing out ends that session\'s open pages', async () => {
  const s = await setup();
  try {
    const { cookie } = await s.signIn();
    const stream = await req(s.port, 'GET', '/api/events', undefined, { cookie, stream: true });
    let got = '', ended = false; stream.on('data', (d) => { got += d; }); stream.on('end', () => { ended = true; });
    await new Promise((x) => setTimeout(x, 30));
    assert.equal((await req(s.port, 'POST', '/api/signout', {}, { cookie })).status, 200);
    await s.coreSend({ channel: 'web', to: pinned.credentialId, text: 'Private after sign-out' });
    await new Promise((x) => setTimeout(x, 50));
    assert.equal(ended, true);
    assert.doesNotMatch(got, /Private after sign-out/);
  } finally { s.stop(); }
});

// ---- review fixes: failures around the happy path ----
import { spawn } from 'node:child_process';

const coreAt = (p, handler) => new Promise((resolve) => {
  const srv = net.createServer((c) => { let b = ''; c.on('data', (d) => { b += d; if (b.includes('\n')) handler(JSON.parse(b), c); }); });
  srv.listen(p, () => resolve(srv));
});

test('an approval page that breaks mid-answer, or never answers, ends only that request', async () => {
  let mode = 'reset';
  const up = http.createServer((q, r) => {
    if (mode === 'reset') { r.writeHead(200, { 'content-type': 'text/html' }); r.write('<p>half'); setTimeout(() => r.socket.destroy(), 20); }
    else if (mode === 'down') q.socket.destroy();
  });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const s = await setup({ approval_upstream: `http://127.0.0.1:${up.address().port}` });
  try {
    const id = '01M85C77CFCPQS8CTXV9962TAF';
    await new Promise((resolve) => {   // headers sent, then the broker goes away: this request is cut off
      http.get({ host: '127.0.0.1', port: s.port, path: `/approve/${id}`, headers: { host: HOST } }, (res) => { res.on('error', () => {}); res.resume(); res.on('close', resolve); }).on('error', resolve);
    });
    mode = 'down';
    assert.equal((await req(s.port, 'GET', `/approve/${id}`)).status, 502);   // before headers: a clean 502
    assert.equal((await req(s.port, 'GET', '/api/me')).status, 200);         // and the server is still up
  } finally { s.stop(); up.closeAllConnections(); up.close(); }
});

test('a one-time code typed while the broker waits for one goes to the broker, never to the core or another device', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opa-web-code-'));
  const delivered = []; let deliver = (a) => ({ ok: true, result: { accepted: true } }); let slotsCalls = 0;
  const broker = await coreAt(path.join(dir, 'broker.sock'), (r, c) => {
    if (r.op === 'code.slots') { if (slotsCalls++ === 0) c.end(JSON.stringify({ id: r.id, ok: true, result: { slots: [{ slot_id: 'S1', expires_at: new Date(Date.now() + 600_000).toISOString() }, { slot_id: 'S2', expires_at: new Date(Date.now() + 600_000).toISOString() }, { slot_id: 'S3', expires_at: new Date(Date.now() + 600_000).toISOString() }], cursor: 'c1' } }) + '\n'); return; }
    if (r.op === 'code.deliver') { delivered.push(r.args); c.end(JSON.stringify({ id: r.id, ...deliver(r.args) }) + '\n'); }
  });
  const s = await setup({ broker_socket: path.join(dir, 'broker.sock') });
  s.ch.watchSlots();
  try {
    const { cookie } = await s.signIn();
    const stream = await req(s.port, 'GET', '/api/events', undefined, { cookie, stream: true });
    let got = ''; stream.on('data', (d) => { got += d; });
    await new Promise((x) => setTimeout(x, 50));
    const a = await req(s.port, 'POST', '/api/send', { text: '123 456', client: 'x:1' }, { cookie });
    assert.deepEqual(a.body, { ok: true, display: '(one-time code, sent to the site)', code: 'delivered' });
    assert.deepEqual(delivered[0], { slot_id: 'S1', code: '123456' });
    assert.equal(s.inbound.at(-1).args.text, '[one-time code delivered]');
    deliver = () => ({ ok: false, error: 'bad_request', message: 'no open code slot S2' });
    assert.equal((await req(s.port, 'POST', '/api/send', { text: '654321' }, { cookie })).body.code, 'late');
    assert.equal(s.inbound.at(-1).args.text, '[one-time code not delivered: the request for it had ended]');
    assert.equal((await req(s.port, 'POST', '/api/send', { text: 'the code is 111222' }, { cookie })).body.display, 'the code is 111222');   // not only a code: as usual
    await new Promise((x) => setTimeout(x, 50));
    assert.doesNotMatch(got + JSON.stringify(s.ch.recent) + JSON.stringify(s.inbound), /123456|123 456|654321/);
    stream.destroy();
  } finally { s.stop(); broker.close(); }
});

test('a code that reached the site is reported as such even if the core is down', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opa-web-code2-'));
  const broker = await coreAt(path.join(dir, 'broker.sock'), (r, c) => {
    if (r.op === 'code.slots') return c.end(JSON.stringify({ id: r.id, ok: true, result: { slots: [{ slot_id: 'S1', expires_at: new Date(Date.now() + 600_000).toISOString() }], cursor: 'c' } }) + '\n');
    c.end(JSON.stringify({ id: r.id, ok: true, result: { accepted: true } }) + '\n');
  });
  const s = await setup({ broker_socket: path.join(dir, 'broker.sock'), core_socket: path.join(dir, 'no-core.sock') });
  s.ch.watchSlots();
  try {
    const { cookie } = await s.signIn();
    await new Promise((x) => setTimeout(x, 50));
    const a = await req(s.port, 'POST', '/api/send', { text: '123456' }, { cookie });
    assert.deepEqual(a.body, { ok: true, display: '(one-time code, sent to the site)', code: 'delivered', agent: 'unavailable' });
  } finally { s.stop(); broker.close(); }
});

test('only a passkey session can change the password, and a change signs everyone else out', async () => {
  const s = await setup({ password_signin: true });
  try {
    const { cookie } = await s.signIn();
    assert.equal((await req(s.port, 'GET', '/api/me', undefined, { cookie })).body.how, 'passkey');
    assert.equal((await req(s.port, 'POST', '/api/password', { password: 'first password 123' }, { cookie })).status, 200);
    const pw = await req(s.port, 'POST', '/api/signin/password', { password: 'first password 123' });
    const other = pw.cookie;
    assert.equal((await req(s.port, 'GET', '/api/me', undefined, { cookie: other })).body.how, 'password');
    const r = await req(s.port, 'POST', '/api/password', { password: 'an intruder pw 456' }, { cookie: other });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'passkey_needed');
    assert.equal((await req(s.port, 'POST', '/api/password', { password: 'second password 789' }, { cookie })).status, 200);
    assert.equal((await req(s.port, 'GET', '/api/me', undefined, { cookie: other })).body.signed_in, false);   // signed out
    assert.equal((await req(s.port, 'GET', '/api/me', undefined, { cookie })).body.signed_in, true);           // not the one who changed it
  } finally { s.stop(); }
});

test('after a restart, a device catches up on everything it missed', async () => {
  const s = await setup();
  try {
    const { cookie } = await s.signIn();
    for (let i = 1; i <= 3; i++) await s.coreSend({ channel: 'web', to: pinned.credentialId, text: `old ${i}` });
    const oldCursor = s.ch.recent.at(-1).id ?? String(s.ch.recent.at(-1).seq);   // the device last saw the 3rd
    // A restart: a new adapter on the same state; it sends five messages while the device is closed.
    const again = new WebChannel({ ...s.ch.cfg });
    again.sessions = s.ch.sessions;
    for (let i = 1; i <= 5; i++) again.send({ to: pinned.credentialId, text: `new ${i}` });
    s.ch.close();
    const port = await again.listenHttp(0);
    const stream = await req(port, 'GET', `/api/events?after=${encodeURIComponent(oldCursor)}`, undefined, { cookie, stream: true });
    let got = ''; stream.on('data', (d) => { got += d; });
    await new Promise((x) => setTimeout(x, 50));
    assert.match(got, /new 1[\s\S]*new 2[\s\S]*new 3[\s\S]*new 4[\s\S]*new 5/);   // not just the ones numbered past 3
    stream.destroy(); again.close();
  } finally { s.stop(); }
});

test('the page may draw its icons (data: images); a sign-in challenge flood is refused, not evicting', async () => {
  const s = await setup();
  try {
    const page = await req(s.port, 'GET', '/');
    assert.match(page.body, /<html/i);
    const r = await new Promise((resolve) => http.get({ host: '127.0.0.1', port: s.port, path: '/', headers: { host: HOST } }, (res) => { res.resume(); resolve(res.headers['content-security-policy']); }));
    assert.match(r, /img-src 'self' data:/);
    const first = (await req(s.port, 'POST', '/api/signin/options', {})).body.challenge;
    for (let i = 0; i < 999; i++) await req(s.port, 'POST', '/api/signin/options', {});
    assert.equal((await req(s.port, 'POST', '/api/signin/options', {})).status, 429);
    assert.equal((await req(s.port, 'POST', '/api/signin', assertion(first))).status, 200);   // the first is still good
  } finally { s.stop(); }
});

test('a core that takes the connection but never answers: the page hears "unavailable", not silence', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opa-web-hang-'));
  const core = await coreAt(path.join(dir, 'core.sock'), () => {});
  const s = await setup({ core_socket: path.join(dir, 'core.sock'), core_timeout_ms: 100 });
  try {
    const { cookie } = await s.signIn();
    const t0 = Date.now();
    assert.equal((await req(s.port, 'POST', '/api/send', { text: 'hello' }, { cookie })).status, 503);
    assert.ok(Date.now() - t0 < 2000);
  } finally { s.stop(); core.close(); }
});

test('the core\'s socket: a stale file from a killed adapter is cleared; one in use, or none configured, is an error', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opa-web-sock-'));
  const p = path.join(dir, 'web.sock');
  const child = spawn(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(p)}, () => console.log('up'))`]);
  await new Promise((r) => child.stdout.once('data', r));
  child.kill('SIGKILL'); await new Promise((r) => child.once('exit', r));
  assert.ok(fs.existsSync(p));
  const ch = new WebChannel({ state_dir: dir, origins: [ORIGIN], rp_id: RP, pinned, core_socket: path.join(dir, 'core.sock') });
  await ch.listenSocket(p);                                                 // the stale file is gone and replaced
  const ch2 = new WebChannel({ state_dir: dir, origins: [ORIGIN], rp_id: RP, pinned, core_socket: path.join(dir, 'core.sock') });
  await assert.rejects(ch2.listenSocket(p), /in use/);
  await assert.rejects(ch2.listenSocket(undefined), /no socket for the core/);
  ch.close();
});

test('catch-up never sends messages older than 24 hours, even with nothing new since', async () => {
  let now = Date.now();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opa-web-age-'));
  const ch = new WebChannel({ state_dir: dir, origins: [ORIGIN], rp_id: RP, pinned, core_socket: path.join(dir, 'core.sock') }, { now: () => now });
  const port = await ch.listenHttp(0);
  try {
    const o = (await req(port, 'POST', '/api/signin/options', {})).body;
    const { cookie } = await req(port, 'POST', '/api/signin', assertion(o.challenge));
    ch.send({ to: pinned.credentialId, text: 'yesterday' });
    now += 25 * 3600_000;
    const stream = await req(port, 'GET', '/api/events', undefined, { cookie, stream: true });
    let got = ''; stream.on('data', (d) => { got += d; });
    await new Promise((x) => setTimeout(x, 50));
    assert.match(got, /hello/);
    assert.doesNotMatch(got, /yesterday/);
    stream.destroy();
  } finally { ch.close(); }
});

test('codes: a broker that could not be reached keeps the slot for the next try; codes sent together never go on as text', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opa-web-code3-'));
  let deliverMode = 'drop', calls = 0;
  const broker = await coreAt(path.join(dir, 'broker.sock'), (r, c) => {
    if (r.op === 'code.slots') { if (calls++ === 0) c.end(JSON.stringify({ id: r.id, ok: true, result: { slots: [{ slot_id: 'S1', expires_at: new Date(Date.now() + 600_000).toISOString() }], cursor: 'c' } }) + '\n'); return; }
    if (deliverMode === 'drop') return c.destroy();   // no answer: did it arrive?
    if (deliverMode === 'internal') return c.end(JSON.stringify({ id: r.id, ok: false, error: 'internal' }) + '\n');   // a refusal that doesn't end the slot
    setTimeout(() => c.end(JSON.stringify({ id: r.id, ok: true, result: { accepted: true } }) + '\n'), 80);
  });
  const s = await setup({ broker_socket: path.join(dir, 'broker.sock') });
  s.ch.watchSlots();
  try {
    const { cookie } = await s.signIn();
    await new Promise((x) => setTimeout(x, 50));
    assert.equal((await req(s.port, 'POST', '/api/send', { text: '123456' }, { cookie })).body.code, 'unknown');
    deliverMode = 'internal';
    assert.equal((await req(s.port, 'POST', '/api/send', { text: '123456' }, { cookie })).body.code, 'refused');
    deliverMode = 'ok';
    const [a, b] = await Promise.all([   // tried again, twice at once
      req(s.port, 'POST', '/api/send', { text: '123456' }, { cookie }),
      req(s.port, 'POST', '/api/send', { text: '123456' }, { cookie }),
    ]);
    assert.deepEqual([a.body.code, b.body.code].sort(), ['delivered', 'late']);
    assert.doesNotMatch(JSON.stringify(s.inbound), /123456/);
  } finally { s.stop(); broker.close(); }
});

test('a session signed out while its request body is still arriving can\'t change the password', async () => {
  const s = await setup({ password_signin: true });
  try {
    const first = (await s.signIn()).cookie;
    const second = (await s.signIn()).cookie;
    // The first session starts a change but holds back its body...
    const slow = new Promise((resolve) => {
      const r = http.request({ host: '127.0.0.1', port: s.port, method: 'POST', path: '/api/password', headers: { host: HOST, origin: ORIGIN, cookie: first, 'content-type': 'application/json' } }, (res) => { let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
      r.write('{"password":"held back');
      setTimeout(() => r.end(' pw 123"}'), 150);
    });
    await new Promise((x) => setTimeout(x, 40));
    // ...while the second changes it, which signs the first out.
    assert.equal((await req(s.port, 'POST', '/api/password', { password: 'the real one 456' }, { cookie: second })).status, 200);
    assert.equal((await slow).status, 401);
    assert.equal((await req(s.port, 'GET', '/api/me', undefined, { cookie: second })).body.signed_in, true);
    assert.equal((await req(s.port, 'POST', '/api/signin/password', { password: 'the real one 456' })).status, 200);
  } finally { s.stop(); }
});
