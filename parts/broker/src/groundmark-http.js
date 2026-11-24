// Requests to a relying party, signed as the agent (Groundmark core §5: RFC 9421 HTTP Message Signatures,
// Ed25519, the key published at _agentid.<agent domain>). Covered: @method, @authority, @target-uri, and
// content-digest when there's a body; created, expires (+300 s), keyid, alg, and the relying party's nonce
// for state-changing requests. A request the relying party challenges (401 with Accept-Signature carrying
// a nonce) is signed again with that nonce, once.
import { createHash, sign } from 'node:crypto';
import { canonicalize } from './jcs.js';

const COMPONENTS = ['@method', '@authority', '@target-uri'];

/** The signature base and Signature-Input value for a request (exported for tests). */
export function signatureBase({ method, url, digest, created, expires, nonce, keyid }) {
  const u = new URL(url);
  const comps = digest ? [...COMPONENTS, 'content-digest'] : COMPONENTS;
  const value = { '@method': method.toUpperCase(), '@authority': u.host.toLowerCase(), '@target-uri': u.href, 'content-digest': digest };
  const params = `(${comps.map((c) => `"${c}"`).join(' ')});created=${created};expires=${expires}${nonce ? `;nonce="${nonce}"` : ''};keyid="${keyid}";alg="ed25519"`;
  const base = [...comps.map((c) => `"${c}": ${value[c]}`), `"@signature-params": ${params}`].join('\n');
  return { base, params };
}

/** RFC 9530 Content-Digest of a body. */
export const contentDigest = (body) => `sha-256=:${createHash('sha256').update(body).digest('base64')}:`;

/** Builds the signing headers. key: the agent's private KeyObject. */
export function signHeaders({ method, url, body, key, keyid, nonce, now = Date.now() }) {
  const created = Math.floor(now / 1000);
  const digest = body !== undefined ? contentDigest(body) : undefined;
  const { base, params } = signatureBase({ method, url, digest, created, expires: created + 300, nonce, keyid });
  const sig = sign(null, Buffer.from(base), key).toString('base64');
  return { ...(digest ? { 'content-digest': digest } : {}), 'signature-input': `gm=${params}`, signature: `gm=:${sig}:` };
}

const nonceFrom = (accept) => /;\s*nonce="([^"]+)"/.exec(accept || '')?.[1];

/**
 * A fetch that signs as the agent. Returns { status, json, presented, verified } where `presented` says
 * a signature was sent and `verified` that the relying party accepted it (2xx).
 */
export function agentFetch({ key, keyid, fetchImpl = fetch }) {
  return async (url, { method = 'GET', body } = {}) => {
    const go = async (nonce) => fetchImpl(url, {
      method, body, signal: AbortSignal.timeout(20_000),
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), accept: 'application/json', ...signHeaders({ method, url, body, key, keyid, nonce }) },
    });
    let res = await go();
    const challenge = res.status === 401 && nonceFrom(res.headers.get('accept-signature'));
    if (challenge) res = await go(challenge);
    const out = await res.json().catch(() => ({}));
    return { status: res.status, json: out, presented: true, verified: res.ok };
  };
}

const BINDING = new Set(['book', 'edit_order', 'pay']);

/**
 * MCP-style tools for a relying party reached over plain HTTPS (broker.json "web_services"):
 *   { <server>: { credential, base_url, tools: { <tool>: { op, method, path } } } }
 * Each tool sends the arguments (query string for GET, canonical JSON body otherwise), signed as the agent.
 * Only a binding op (book, edit_order, pay) may use a method other than GET: a standing read or search grant
 * must never get a state-changing request signed. describe(args) is the exact request run(args) sends
 * (method, URL, Content-Digest), so the broker can put it in the grant the person approves.
 */
export function webServices(config = {}, { key, keyid, fetchImpl } = {}) {
  const call = agentFetch({ key, keyid, fetchImpl });
  return Object.fromEntries(Object.entries(config).map(([server, s]) => [server, {
    credential: s.credential,
    tools: Object.fromEntries(Object.entries(s.tools).map(([tool, t]) => {
      const method = (t.method ?? 'GET').toUpperCase();
      if (method !== 'GET' && !BINDING.has(t.op)) throw new Error(`web_services ${server}/${tool}: a ${t.op} tool must use GET; only binding ops may change anything`);
      const fixed = new Set(new URL(t.path, s.base_url).searchParams.keys());
      const build = (args) => {
        const url = new URL(t.path, s.base_url);
        // Arguments never replace a query parameter fixed in the configured path (an action=, say).
        const clash = Object.keys(args).find((k) => fixed.has(k));
        if (clash !== undefined) throw Object.assign(new Error(`argument "${clash}" would replace a fixed query parameter`), { local: true, definite: true });
        if (method === 'GET') for (const [k, v] of Object.entries(args)) url.searchParams.set(k, String(v));
        return { method, url: url.href, body: method === 'GET' ? undefined : canonicalize(args) };
      };
      const describe = (args) => { const r = build(args); return { method: r.method, url: r.url, ...(r.body !== undefined ? { content_digest: contentDigest(r.body) } : {}) }; };
      const run = async (args) => {
        const r = build(args);
        const res = await call(r.url, { method: r.method, body: r.body });
        // 4xx (other than 408/429) is the relying party saying it didn't do it; 5xx and the rest leave it unknown.
        if (res.status >= 400) {
          const definite = res.status < 500 && res.status !== 408 && res.status !== 429;
          throw Object.assign(new Error(res.json?.message || res.json?.error || `HTTP ${res.status}`), { upstream: res.json, status: res.status, definite });
        }
        return { ...res.json, groundmark: { presented: true, verified: true } };
      };
      return [tool, { op: t.op, describe, run }];
    })),
  }]));
}
