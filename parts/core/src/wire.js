// The contracts' transport: one JSON line each way over a Unix socket (contracts/README.md),
// and the router's POST /infer on loopback.
import { createConnection, createServer } from 'node:net';
import { chmodSync, existsSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export function ulid(now = Date.now()) {
  let t = '';
  for (let i = 0, n = now; i < 10; i++, n = Math.floor(n / 32)) t = B32[n % 32] + t;
  return t + [...randomBytes(16)].map((b) => B32[b % 32]).join('');
}

export const envelope = (op, errandId, args) => ({ op, id: ulid(), caller: 'core', errand_id: errandId ?? null, ts: new Date().toISOString(), args });

/** One request on a Unix socket; resolves to the response envelope. */
export function call(socket, req, { timeoutMs = 16 * 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const c = createConnection(socket, () => c.write(JSON.stringify(req) + '\n'));
    let buf = '';
    c.setTimeout(timeoutMs, () => c.destroy(new Error(`${req.op}: no answer from ${socket}`)));
    c.on('data', (d) => { buf += d; });
    c.on('error', reject);
    c.on('end', () => { try { resolve(JSON.parse(buf)); } catch { reject(new Error(`${req.op}: answer is not JSON`)); } });
  });
}

export async function infer(url, req) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req), signal: AbortSignal.timeout(180_000) });
  return res.json();
}

/** Serves the core's socket at a path (mode 0660: callers come in by group) or on { fd } from systemd. */
export async function serve(path, handlers) {
  if (typeof path === 'string' && existsSync(path)) unlinkSync(path);
  const srv = createServer((conn) => {
    let buf = '', done = false;
    conn.on('error', () => {});
    conn.on('data', async (d) => {
      if (done) return;
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      done = true;
      let req = null; try { req = JSON.parse(buf.slice(0, nl)); } catch {}
      const id = req?.id ?? null, h = handlers[req?.op];
      if (!h) return conn.end(JSON.stringify({ id, ok: false, error: req ? 'unknown_op' : 'bad_request' }) + '\n');
      try { conn.end(JSON.stringify({ id, ok: true, result: (await h(req.args ?? {}, req)) ?? {} }) + '\n'); } catch (e) {
        conn.end(JSON.stringify({ id, ok: false, error: e.code ?? 'internal', message: e.message }) + '\n');
      }
    });
  });
  await new Promise((r, j) => { srv.once('error', j); srv.listen(path, r); });
  if (typeof path === 'string') chmodSync(path, 0o660);
  return srv;
}
