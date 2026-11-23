// Wire helpers for the contracts' transport: one JSON object per line over a
// Unix socket, one request per connection. See contracts/README.md.
import net from 'node:net';
import fs from 'node:fs';
import crypto from 'node:crypto';

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A ULID (time-ordered, 26 chars, Crockford base32). */
export function ulid(now = Date.now()) {
  let t = '';
  for (let i = 0, n = now; i < 10; i++, n = Math.floor(n / 32)) t = B32[n % 32] + t;
  const r = crypto.randomBytes(16);
  let s = '';
  for (let i = 0; i < 16; i++) s += B32[r[i] % 32];
  return t + s;
}

export const nowIso = () => new Date().toISOString();

/** Build a request envelope. */
export function request(op, caller, errandId, args = {}) {
  return { op, id: ulid(), caller, errand_id: errandId ?? null, ts: nowIso(), args };
}

export class ContractError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

/** Canonical JSON (RFC 8785 subset: sorted keys, no whitespace). Enough for our payloads. */
export function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  return '{' + Object.keys(v).sort().filter((k) => v[k] !== undefined)
    .map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
}

/**
 * Serve a seam on a Unix socket.
 * handlers: { 'op.name': async (args, req) => result }
 * opts.authorize(req) may throw ContractError('unauthorized_caller').
 */
export function serve(socketPath, handlers, opts = {}) {
  try { fs.unlinkSync(socketPath); } catch {}
  const server = net.createServer((sock) => {
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', async (chunk) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      const line = buf.slice(0, nl);
      buf = '';
      let req;
      try { req = JSON.parse(line); } catch {
        return sock.end(JSON.stringify({ id: null, ok: false, error: 'bad_request', message: 'not JSON' }) + '\n');
      }
      sock.end(JSON.stringify(await dispatch(handlers, req, opts)) + '\n');
    });
    sock.on('error', () => {});
  });
  return new Promise((resolve) => server.listen(socketPath, () => {
    fs.chmodSync(socketPath, 0o660);
    resolve(server);
  }));
}

export async function dispatch(handlers, req, opts = {}) {
  const id = req?.id ?? null;
  if (!req || typeof req.op !== 'string' || typeof req.caller !== 'string' || typeof req.id !== 'string' || !('args' in req)) {
    return { id, ok: false, error: 'bad_request', message: 'envelope incomplete' };
  }
  const h = handlers[req.op];
  if (!h) return { id, ok: false, error: 'unknown_op', message: req.op };
  try {
    if (opts.authorize) await opts.authorize(req);
    return { id, ok: true, result: (await h(req.args, req)) ?? {} };
  } catch (e) {
    if (e instanceof ContractError) return { id, ok: false, error: e.code, message: e.message, ...(e.detail ? { detail: e.detail } : {}) };
    return { id, ok: false, error: 'internal', message: String(e.message || e) };
  }
}

/** Send one request to a socket and return the parsed response. */
export function call(socketPath, req) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath);
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(JSON.stringify(req) + '\n'));
    sock.on('data', (d) => { buf += d; });
    sock.on('end', () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(e); } });
    sock.on('error', reject);
  });
}
