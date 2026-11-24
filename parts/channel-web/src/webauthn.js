// Passkey sign-in, checked with node:crypto only (the same checks as parts/broker/approval/binding.js).
// The person's passkey is pinned at install: its credential id and public key (JWK, P-256), copied from
// the broker's passkeys.json. Public keys aren't secrets.
import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';

const sha256 = (b) => createHash('sha256').update(b).digest();
const b64u = (s) => Buffer.from(s, 'base64url');

export const newChallenge = () => randomBytes(32).toString('base64url');

/**
 * assertion: what the page posts: { id, response: { clientDataJSON, authenticatorData, signature } } (base64url).
 * Returns null if it's a fresh, user-verified signature by the pinned passkey over `challenge` from `origin`,
 * else the reason it isn't.
 */
export function checkSignIn(assertion, { pinned, challenge, origins, rpId }) {
  const r = assertion?.response;
  if (!r || typeof assertion.id !== 'string') return 'malformed assertion';
  if (assertion.id !== pinned.credentialId) return 'not the paired passkey';
  let cd;
  try { cd = JSON.parse(b64u(r.clientDataJSON).toString('utf8')); } catch { return 'clientDataJSON is not JSON'; }
  if (cd.type !== 'webauthn.get') return 'wrong type';
  if (cd.challenge !== challenge) return 'wrong challenge';
  if (!origins.includes(cd.origin)) return `wrong origin ${cd.origin}`;
  if (cd.crossOrigin === true) return 'cross-origin';
  const auth = b64u(r.authenticatorData);
  if (auth.length < 37 || !auth.subarray(0, 32).equals(sha256(Buffer.from(rpId)))) return 'wrong rpId';
  if (!(auth[32] & 0x01) || !(auth[32] & 0x04)) return 'user not present and verified';
  const key = createPublicKey({ key: pinned.publicKey, format: 'jwk' });
  const ok = verify('sha256', Buffer.concat([auth, sha256(b64u(r.clientDataJSON))]), key, b64u(r.signature));
  return ok ? null : 'bad signature';
}
