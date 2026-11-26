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
  const s = await setup({ push_hosts: ['^push\\.example\\.test$'], push_fetch: async (url, o) => { sent.push({ url, o }); return { status }; } });
  try {
    const { cookie } = await s.signIn();
    assert.equal((await req(s.port, 'POST', '/api/push/subscribe', { endpoint: 'https://evil.example/x', keys: { p256dh: 'a', auth: 'b' } }, { cookie })).status, 400);
    const sub = { endpoint: 'https://push.example.test/sub/1', keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } };
    assert.equal((await req(s.port, 'POST', '/api/push/subscribe', sub, { cookie })).status, 200);
    assert.equal((await req(s.port, 'GET', '/api/me', undefined, { cookie })).body.push, true);
    // The chat is open on that device: no notification.
    const stream = await req(s.port, 'GET', '/api/events', undefined, { cookie, stream: true }); stream.on('data', () => {});
    await new Promise((x) => setTimeout(x, 30));
    await s.coreSend({ channel: 'web', to: pinned.credentialId, text: 'Hello' });
    await new Promise((x) => setTimeout(x, 30));
    assert.equal(sent.length, 0);
    stream.destroy(); await new Promise((x) => setTimeout(x, 30));
    // Closed: the approval request becomes a notification, encrypted for the device, with VAPID.
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
