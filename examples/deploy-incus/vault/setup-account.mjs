// Run once, inside the container, while Vaultwarden allows sign-ups: creates the agent's account, an organization
// with one collection ("Agent logins"), and two fake logins; then gets the account's API key. Everything is
// encrypted on this side, the way Bitwarden clients do it (Vaultwarden only stores ciphertext):
//   master key = PBKDF2-SHA256(password, email, 600000); its HKDF-expanded enc/mac keys wrap a random user key;
//   an RSA key pair (private key under the user key); a random org key, wrapped with RSA-OAEP for the account.
// Writes bw-client-id, bw-client-secret, bw-password into the directory given (0600), and prints the collection id.
import { createCipheriv, createHmac, generateKeyPairSync, pbkdf2Sync, publicEncrypt, randomBytes, randomUUID, constants } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [base, email, outDir] = process.argv.slice(2);
const password = randomBytes(24).toString('base64url');
const ITER = 600000;
const b64 = (b) => Buffer.from(b).toString('base64');
const hkdfExpand = (prk, info) => createHmac('sha256', prk).update(Buffer.concat([Buffer.from(info), Buffer.from([1])])).digest();
function encString(plain, key) {            // type 2: AES-256-CBC + HMAC-SHA256; key = 32 enc || 32 mac
  const iv = randomBytes(16), c = createCipheriv('aes-256-cbc', key.subarray(0, 32), iv);
  const ct = Buffer.concat([c.update(Buffer.from(plain)), c.final()]);
  const mac = createHmac('sha256', key.subarray(32, 64)).update(Buffer.concat([iv, ct])).digest();
  return `2.${b64(iv)}|${b64(ct)}|${b64(mac)}`;
}
async function call(path, { method = 'POST', json, form, token } = {}) {
  const res = await fetch(base + path, { method, headers: { ...(json ? { 'content-type': 'application/json' } : {}), ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: json ? JSON.stringify(json) : form ? new URLSearchParams(form) : undefined });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

const masterKey = pbkdf2Sync(password, email.toLowerCase(), ITER, 32, 'sha256');
const hash = b64(pbkdf2Sync(masterKey, password, 1, 32, 'sha256'));
const stretched = Buffer.concat([hkdfExpand(masterKey, 'enc'), hkdfExpand(masterKey, 'mac')]);
const userKey = randomBytes(64);
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pub = rsa.publicKey.export({ type: 'spki', format: 'der' });
const keys = { publicKey: b64(pub), encryptedPrivateKey: encString(rsa.privateKey.export({ type: 'pkcs8', format: 'der' }), userKey) };
const reg = { email, name: 'Agent', masterPasswordHash: hash, masterPasswordHint: null, key: encString(userKey, stretched), kdf: 0, kdfIterations: ITER, keys };
// Vaultwarden 1.37: ask for a verification token (returned directly when no mail server is set up), then finish.
const vt = await fetch(base + '/identity/accounts/register/send-verification-email', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email, name: 'Agent', receiveMarketingEmails: false }) });
const verifyToken = (await vt.text()).replace(/^"|"$/g, '');
if (!vt.ok) throw new Error(`send-verification-email: ${vt.status} ${verifyToken.slice(0, 200)}`);
await call('/identity/accounts/register/finish', { json: { email, emailVerificationToken: verifyToken, masterPasswordHash: hash, masterPasswordHint: null,
  userSymmetricKey: reg.key, userAsymmetricKeys: keys, kdf: 0, kdfIterations: ITER } });

const device = randomUUID();
const tok = await call('/identity/connect/token', { form: { grant_type: 'password', username: email, password: hash, scope: 'api offline_access', client_id: 'cli', deviceType: '8', deviceIdentifier: device, deviceName: 'opa-setup' } });
const token = tok.access_token;

const orgKey = randomBytes(64);
const orgRsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const org = await call('/api/organizations', { token, json: {
  name: 'Agent', billingEmail: email, planType: 0,
  key: `4.${b64(publicEncrypt({ key: rsa.publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' }, orgKey))}`,
  keys: { publicKey: b64(orgRsa.publicKey.export({ type: 'spki', format: 'der' })), encryptedPrivateKey: encString(orgRsa.privateKey.export({ type: 'pkcs8', format: 'der' }), orgKey) },
  collectionName: encString('Agent logins', orgKey),
} });
const cols = await call(`/api/organizations/${org.id ?? org.Id}/collections`, { method: 'GET', token });
const collection = (cols.data ?? cols.Data)[0].id ?? (cols.data ?? cols.Data)[0].Id;

const prof = await call('/api/accounts/profile', { method: 'GET', token });

// Fake logins only: a "member" login at the demo restaurant (with a TOTP seed) and a shop.
for (const it of [
  { name: 'Casa Verde (demo member)', username: 'diner@example.test', password: 'FAKE-' + randomBytes(9).toString('base64url'), uri: 'https://table.groundmark.fyi/login', totp: 'JBSWY3DPEHPK3PXP' },
  { name: 'Example shop (fake)', username: 'shopper@example.test', password: 'FAKE-' + randomBytes(9).toString('base64url'), uri: 'https://shop.example' },
]) {
  await call('/api/ciphers/create', { token, json: { collectionIds: [collection], cipher: {
    type: 1, organizationId: org.id ?? org.Id, encryptedFor: prof.id ?? prof.Id, name: encString(it.name, orgKey), notes: null, favorite: false,
    login: { username: encString(it.username, orgKey), password: encString(it.password, orgKey), totp: it.totp ? encString(it.totp, orgKey) : null, uris: [{ uri: encString(it.uri, orgKey), match: null }] },
  } } });
}

const api = await call('/api/accounts/api-key', { token, json: { masterPasswordHash: hash } });
for (const [f, v] of [['bw-client-id', `user.${prof.id ?? prof.Id}`], ['bw-client-secret', api.apiKey ?? api.ApiKey], ['bw-password', password]]) writeFileSync(join(outDir, f), v, { mode: 0o600 });
console.log(JSON.stringify({ collection_id: collection, organization_id: org.id ?? org.Id }));
