// The broker's Unix socket. One JSON request per connection, one
// line each way: the caller writes a JSON object and a newline, the broker
// answers with a JSON object and a newline, then closes.
//
// Who can connect is decided by the socket's directory, not the socket file:
// /srv/agents/credbroker-sock is credbroker:brokercall, mode 0750, and only
// demoagent is in brokercall. The socket file itself is 0666 so that group
// members, who can reach it, can also write to it. (Node cannot read a
// peer's credentials, so the caller's name is what it declares; the demo design.)

import { createServer, createConnection } from 'node:net';
import { chmodSync, existsSync, unlinkSync, lstatSync } from 'node:fs';

export const DEFAULT_SOCKET = '/srv/agents/credbroker-sock/broker.sock';
const MAX_REQUEST = 64 * 1024;
const TIMEOUT_MS = 30_000;

// Starts listening. Refuses if another broker answers on the path; removes a
// stale socket file left by one that died. Resolves to the net.Server.
export async function listen(path, handle) {
  if (existsSync(path)) {
    if (!lstatSync(path).isSocket()) throw new Error(`${path} exists and is not a socket`);
    if (await answers(path)) throw new Error(`another broker is already listening on ${path}`);
    unlinkSync(path);
  }
  const server = createServer((conn) => serve(conn, handle));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => { server.off('error', reject); resolve(); });
  });
  chmodSync(path, 0o666);
  return server;
}

function serve(conn, handle) {
  let buf = Buffer.alloc(0);
  let done = false;
  conn.setTimeout(TIMEOUT_MS, () => conn.destroy());
  const reply = (res) => {
    done = true;
    conn.end(JSON.stringify(res) + '\n');
  };
  conn.on('error', () => {});
  conn.on('data', async (chunk) => {
    if (done) return;
    buf = Buffer.concat([buf, chunk]);
    const nl = buf.indexOf(0x0a);
    if (nl === -1) {
      if (buf.length > MAX_REQUEST) reply({ ok: false, error: 'bad_request', message: 'request too long' });
      return;
    }
    done = true;
    let req;
    try {
      req = JSON.parse(buf.subarray(0, nl).toString('utf8'));
    } catch {
      return reply({ ok: false, error: 'bad_request', message: 'request is not valid JSON' });
    }
    reply(await handle(req));
  });
}

// Sends one request and resolves to the response. Rejects with err.code
// ENOENT or ECONNREFUSED when no broker is listening, EACCES when the caller
// cannot reach the socket.
export function call(path, req, { timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const conn = createConnection(path);
    let buf = '';
    conn.setTimeout(timeoutMs, () => conn.destroy(Object.assign(new Error('broker did not answer in time'), { code: 'ETIMEDOUT' })));
    conn.on('connect', () => conn.write(JSON.stringify(req) + '\n'));
    conn.on('data', (d) => { buf += d; });
    conn.on('error', reject);
    conn.on('end', () => {
      try {
        resolve(JSON.parse(buf));
      } catch {
        reject(new Error('broker sent an answer that is not JSON'));
      }
    });
  });
}

async function answers(path) {
  try {
    await call(path, { op: 'status', caller: 'broker-startup' }, { timeoutMs: 2000 });
    return true;
  } catch {
    return false;
  }
}
