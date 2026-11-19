// What binds a passkey approval to one grant, and the check of a
// stored assertion that the broker runs when it approves and broker-verify
// runs again offline. node:crypto only: no network, no WebAuthn library, so
// the offline check does not lean on the code that accepted the assertion.
//
// The challenge is the SHA-256 of the canonical (RFC 8785) form of
//   { purpose: APPROVAL_PURPOSE, grant: <the grant's grant.create body> }
// The grant.create body (broker/grants.js createBody) holds the grant id, its
// nonce, the caller, the credential, the items, the excluded items, the
// expiry and the recipient: id, display name, delivery endpoint and receipt
// key. Change any of them and the challenge changes, so an assertion made for
// one grant cannot approve another grant, or the same grant sent elsewhere.
// broker-verify takes the body from the signed log, not from grants.json.
//
// An assertion passes checkAssertion only if all of these hold:
//   - its credential id is the registered passkey's
//   - clientDataJSON: type "webauthn.get", challenge equal to the grant's
//     challenge, origin equal to the passkey's registered origin, not cross-origin
//   - authenticatorData: rpIdHash equal to SHA-256 of the passkey's rpId,
//     user present (UP) and user verified (UV) set. UV is checked here, not
//     only requested: an assertion without it fails (Face ID, Touch ID).
//   - the signature verifies under the registered public key (ES256) over
//     authenticatorData || SHA-256(clientDataJSON)

import { createHash, createPublicKey, verify } from 'node:crypto';
import { canonicalize } from '../src/jcs.js';

export const APPROVAL_PURPOSE = 'credential-broker grant approval v1';
export const COSE_ES256 = -7;
const FLAG_UP = 0x01;
const FLAG_UV = 0x04;

const sha256 = (b) => createHash('sha256').update(b).digest();
const b64u = (s) => Buffer.from(s, 'base64url');
const isB64u = (s) => typeof s === 'string' && /^[A-Za-z0-9_-]*$/.test(s) && b64u(s).toString('base64url') === s;

// The base64url challenge for a grant.create body.
export function approvalChallenge(createBody) {
  if (typeof createBody?.nonce !== 'string' || !createBody.nonce) {
    throw new Error('approval: this grant has no nonce (made before nonces existed); it cannot take a passkey approval');
  }
  return sha256(Buffer.from(canonicalize({ purpose: APPROVAL_PURPOSE, grant: createBody }), 'utf8')).toString('base64url');
}

// The stored approval record (what grants.json keeps and the approval log
// entry hashes), from an assertion as @simplewebauthn/browser returns it.
export function approvalRecord({ response, registration, challenge, at }) {
  return {
    method: 'passkey',
    credentialId: registration.credentialId,
    rpId: registration.rpId,
    origin: registration.origin,
    challenge,
    authenticatorData: response.response.authenticatorData,
    clientDataJSON: response.response.clientDataJSON,
    signature: response.response.signature,
    userHandle: response.response.userHandle ?? null,
    at,
  };
}

// registration: { credentialId, rpId, origin, publicKey: JWK (EC P-256) }.
// createBody: the grant's grant.create body. Returns null if the approval
// holds, else the reason it does not.
export function checkAssertion(approval, { registration, createBody }) {
  if (approval?.method !== 'passkey') return 'not a passkey approval';
  for (const k of ['credentialId', 'challenge', 'authenticatorData', 'clientDataJSON', 'signature']) {
    if (!isB64u(approval[k])) return `assertion: ${k} missing or not base64url`;
  }
  if (!registration) return 'assertion: no registered passkey with this credential id';
  if (approval.credentialId !== registration.credentialId) return 'assertion: credential id is not the registered passkey\'s';
  if (approval.rpId !== registration.rpId || approval.origin !== registration.origin) return 'assertion: rpId or origin differs from the passkey\'s registration';

  let want;
  try {
    want = approvalChallenge(createBody);
  } catch (err) {
    return err.message;
  }
  if (approval.challenge !== want) return 'assertion: stored challenge is not the hash of this grant';

  const clientDataBytes = b64u(approval.clientDataJSON);
  let cd;
  try {
    cd = JSON.parse(clientDataBytes.toString('utf8'));
  } catch {
    return 'assertion: clientDataJSON is not JSON';
  }
  if (cd?.type !== 'webauthn.get') return 'assertion: clientData type is not webauthn.get';
  if (cd.challenge !== want) return 'assertion: signed challenge is not the hash of this grant (another grant, or another recipient)';
  if (cd.origin !== registration.origin) return `assertion: origin ${cd.origin} is not the passkey's ${registration.origin}`;
  if (cd.crossOrigin === true) return 'assertion: made cross-origin';

  const authData = b64u(approval.authenticatorData);
  if (authData.length < 37) return 'assertion: authenticatorData too short';
  if (!authData.subarray(0, 32).equals(sha256(Buffer.from(registration.rpId, 'utf8')))) return 'assertion: rpIdHash is not the passkey\'s rpId';
  const flags = authData[32];
  if (!(flags & FLAG_UP)) return 'assertion: user not present (UP flag clear)';
  if (!(flags & FLAG_UV)) return 'assertion: user not verified (UV flag clear): no Face ID, Touch ID or PIN';

  let key;
  try {
    key = createPublicKey({ key: registration.publicKey, format: 'jwk' });
  } catch {
    return 'assertion: registered public key is not a usable JWK';
  }
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') return 'assertion: registered key is not ES256 (P-256)';
  const signed = Buffer.concat([authData, sha256(clientDataBytes)]);
  let ok = false;
  try {
    ok = verify('sha256', signed, key, b64u(approval.signature));
  } catch {
    ok = false;
  }
  return ok ? null : 'assertion: signature does not verify under the registered passkey';
}

// A P-256 COSE key (as decodeCredentialPublicKey gives it, a Map) as a JWK.
export function coseToJwk(cose) {
  const get = (k) => cose.get(k);
  if (get(1) !== 2 || get(3) !== COSE_ES256 || get(-1) !== 1) throw new Error('approval: only ES256 (P-256) passkeys are accepted');
  const x = Buffer.from(get(-2));
  const y = Buffer.from(get(-3));
  if (x.length !== 32 || y.length !== 32) throw new Error('approval: bad P-256 coordinates');
  return { kty: 'EC', crv: 'P-256', x: x.toString('base64url'), y: y.toString('base64url') };
}
