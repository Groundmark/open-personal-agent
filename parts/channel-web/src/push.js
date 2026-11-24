// Web Push, with node:crypto only: VAPID (RFC 8292) to identify this server to the push service, and the
// message encrypted for the device (RFC 8291, aes128gcm), so the push service carries it without reading it.
import { createCipheriv, createECDH, createHmac, createPrivateKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const b64u = (b) => Buffer.from(b).toString('base64url');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();

/** The server's VAPID key pair, made on first use: { publicKey (raw, base64url), privateKey (KeyObject) }. */
export function vapidKeys(file) {
  if (!existsSync(file)) {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    writeFileSync(file, JSON.stringify(privateKey.export({ format: 'jwk' })), { mode: 0o600 });
  }
  const jwk = JSON.parse(readFileSync(file, 'utf8'));
  const raw = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  return { publicKey: b64u(raw), privateKey: createPrivateKey({ key: jwk, format: 'jwk' }) };
}

/** RFC 8291: the request body for `payload`, encrypted to the subscription's keys. */
export function encrypt(payload, { p256dh, auth }) {
  const ua = Buffer.from(p256dh, 'base64url'), secret = Buffer.from(auth, 'base64url');
  const ecdh = createECDH('prime256v1'); ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(ua);
  const ikm = hmac(hmac(secret, shared), Buffer.concat([Buffer.from('WebPush: info\0'), ua, asPublic, Buffer.from([1])]));
  const salt = randomBytes(16);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const c = createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([c.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const head = Buffer.alloc(21); salt.copy(head); head.writeUInt32BE(4096, 16); head[20] = asPublic.length;
  return Buffer.concat([head, asPublic, body]);
}

/** RFC 8292: the Authorization header for a push service. */
export function vapidAuth(endpoint, { publicKey, privateKey }, subject) {
  const enc = (o) => b64u(JSON.stringify(o));
  const unsigned = `${enc({ typ: 'JWT', alg: 'ES256' })}.${enc({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })}`;
  const sig = sign('sha256', Buffer.from(unsigned), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${unsigned}.${b64u(sig)}, k=${publicKey}`;
}

// Only the browsers' push services: the server never posts to an address a page made up.
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /(^|\.)push\.apple\.com$/, /\.notify\.windows\.com$/];
export const pushHostOk = (endpoint, extra = []) => {
  try { const u = new URL(endpoint); return u.protocol === 'https:' && [...PUSH_HOSTS, ...extra].some((r) => r.test(u.hostname)); } catch { return false; }
};

/** Sends one notification. Resolves to the push service's status (404/410: the subscription is gone). */
export async function sendPush(sub, payload, keys, subject, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(sub.endpoint, {
    method: 'POST', signal: AbortSignal.timeout(15_000),
    headers: { authorization: vapidAuth(sub.endpoint, keys, subject), 'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream', ttl: '3600', urgency: 'high' },
    body: encrypt(JSON.stringify(payload), sub.keys),
  });
  return res.status;
}
