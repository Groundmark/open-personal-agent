// A software authenticator for tests: stands in for Face ID or Touch ID
// and for the browser's WebAuthn layer around it. ES256 (P-256) keys made
// fresh per instance, attestation "none", and user verification on unless a
// test turns it off. It builds clientDataJSON as a browser would, from the
// page's origin, and refuses an rpId that is not the origin's host.
//
//   const a = new SoftAuthenticator();
//   a.credentials(origin)   a navigator.credentials for the page at origin:
//                           create({ publicKey }) and get({ publicKey }),
//                           returning PublicKeyCredential-like objects
//   a.register(optionsJSON, origin), a.assert(optionsJSON, origin, { uv })
//                           the same, as the JSON @simplewebauthn/browser sends
//
// Test-only keys, never a real passkey.

import { createHash, generateKeyPairSync, sign, randomBytes } from 'node:crypto';

const sha256 = (b) => createHash('sha256').update(b).digest();

export class SoftAuthenticator {
  #creds = new Map(); // credential id (base64url) -> { id, rpId, privateKey, jwk, counter, userHandle }
  #uv;

  constructor({ uv = true } = {}) {
    this.#uv = uv;
  }

  credentials(origin, { uv } = {}) {
    return {
      create: async ({ publicKey }) => this.#create(publicKey, origin, uv ?? this.#uv),
      get: async ({ publicKey }) => this.#get(publicKey, origin, uv ?? this.#uv),
    };
  }

  async register(optionsJSON, origin, { uv } = {}) {
    const pk = { ...optionsJSON, challenge: b64u(optionsJSON.challenge), user: { ...optionsJSON.user, id: b64u(optionsJSON.user.id) } };
    const c = await this.#create(pk, origin, uv ?? this.#uv);
    return {
      id: c.id, rawId: c.id, type: 'public-key', clientExtensionResults: {}, authenticatorAttachment: 'platform',
      response: { attestationObject: s(c.response.attestationObject), clientDataJSON: s(c.response.clientDataJSON), transports: ['internal'] },
    };
  }

  async assert(optionsJSON, origin, { uv } = {}) {
    const pk = { ...optionsJSON, challenge: b64u(optionsJSON.challenge), allowCredentials: (optionsJSON.allowCredentials ?? []).map((c) => ({ ...c, id: b64u(c.id) })) };
    const c = await this.#get(pk, origin, uv ?? this.#uv);
    return {
      id: c.id, rawId: c.id, type: 'public-key', clientExtensionResults: {}, authenticatorAttachment: 'platform',
      response: {
        authenticatorData: s(c.response.authenticatorData), clientDataJSON: s(c.response.clientDataJSON),
        signature: s(c.response.signature), userHandle: c.response.userHandle ? s(c.response.userHandle) : undefined,
      },
    };
  }

  #create(publicKey, origin, uv) {
    const rpId = publicKey.rp?.id ?? new URL(origin).hostname;
    if (rpId !== new URL(origin).hostname) throw domError('SecurityError', 'rp.id is not the origin\'s host');
    if (!(publicKey.pubKeyCredParams ?? []).some((p) => p.alg === -7)) throw domError('NotSupportedError', 'ES256 not offered');
    const { privateKey, publicKey: pub } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = pub.export({ format: 'jwk' });
    const id = randomBytes(16);
    const cose = cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]));
    const flags = 0x01 | (uv ? 0x04 : 0) | 0x40;
    const len = Buffer.alloc(2);
    len.writeUInt16BE(id.length);
    const authData = Buffer.concat([sha256(Buffer.from(rpId)), Buffer.from([flags]), Buffer.alloc(4), Buffer.alloc(16), len, id, cose]);
    const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: buf(publicKey.challenge).toString('base64url'), origin, crossOrigin: false }));
    const attestationObject = cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
    this.#creds.set(id.toString('base64url'), { id, rpId, privateKey, jwk, counter: 0, userHandle: buf(publicKey.user.id) });
    return credential(id, {
      attestationObject: ab(attestationObject), clientDataJSON: ab(clientDataJSON),
      getTransports: () => ['internal'], getAuthenticatorData: () => ab(authData),
      getPublicKeyAlgorithm: () => -7, getPublicKey: () => null,
    });
  }

  #get(publicKey, origin, uv) {
    const rpId = publicKey.rpId ?? new URL(origin).hostname;
    if (rpId !== new URL(origin).hostname) throw domError('SecurityError', 'rpId is not the origin\'s host');
    const allowed = (publicKey.allowCredentials ?? []).map((c) => buf(c.id).toString('base64url'));
    const cred = [...this.#creds.values()].find((c) => c.rpId === rpId && (allowed.length === 0 || allowed.includes(c.id.toString('base64url'))));
    if (!cred) throw domError('NotAllowedError', 'no credential for this rpId');
    cred.counter += 1;
    const count = Buffer.alloc(4);
    count.writeUInt32BE(cred.counter);
    const authData = Buffer.concat([sha256(Buffer.from(rpId)), Buffer.from([0x01 | (uv ? 0x04 : 0)]), count]);
    const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: buf(publicKey.challenge).toString('base64url'), origin, crossOrigin: false }));
    const signature = sign('sha256', Buffer.concat([authData, sha256(clientDataJSON)]), cred.privateKey);
    return credential(cred.id, {
      authenticatorData: ab(authData), clientDataJSON: ab(clientDataJSON), signature: ab(signature), userHandle: ab(cred.userHandle),
    });
  }

  // Signs any authenticator data and client data with a registered key: for
  // tests that forge what a browser would never send.
  signRaw(credentialId, authData, clientDataJSON) {
    const cred = this.#creds.get(credentialId);
    return sign('sha256', Buffer.concat([authData, sha256(clientDataJSON)]), cred.privateKey);
  }
}

function credential(id, response) {
  return {
    id: id.toString('base64url'), rawId: ab(id), type: 'public-key', authenticatorAttachment: 'platform',
    response, getClientExtensionResults: () => ({}),
  };
}

function domError(name, message) {
  const e = new Error(message);
  e.name = name;
  return e;
}

const b64u = (x) => Buffer.from(x, 'base64url');
const s = (b) => Buffer.from(b).toString('base64url');
const ab = (b) => { const c = Uint8Array.from(b); return c.buffer; };
// An ArrayBuffer or view from any realm (the page runs in a vm context).
const buf = (x) => (ArrayBuffer.isView(x) ? Buffer.from(x.buffer, x.byteOffset, x.byteLength) : Buffer.from(new Uint8Array(x)));

// Minimal CBOR encoder: unsigned and negative integers, byte and text
// strings, maps. Enough for attestation objects and COSE keys.
export function cbor(v) {
  const head = (major, n) => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    if (n < 65536) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b; }
    const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(n, 1); return b;
  };
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === 'string') { const t = Buffer.from(v, 'utf8'); return Buffer.concat([head(3, t.length), t]); }
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error('cbor: unsupported value');
}
