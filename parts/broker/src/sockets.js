// One socket per caller (contracts/broker.md, Caller proof): the socket a request arrives on is the caller.
// Deployed, systemd makes the sockets (one .socket unit each, SocketUser=<caller's user>, SocketMode=0600,
// FileDescriptorName=<caller>) and hands them over, so only that caller can connect and the broker needs
// no root. In tests and development, listen() makes them at the given paths, mode 0600.
import { createServer } from 'node:net';
import { chmodSync, existsSync, lstatSync, unlinkSync } from 'node:fs';
import { BrokerError, MAX_CODE_WAIT_S } from './grants.js';

const MAX_REQUEST = 256 * 1024;
// A connection may sit idle while fill_code waits for the person, so it must outlast the longest wait plus the
// time to fill the code and answer. Equal to the wait, it dropped just as a late code arrived.
export const IDLE_MS = (MAX_CODE_WAIT_S + 5 * 60) * 1000;

/** Handles one parsed envelope arriving on `caller`'s socket. */
export async function dispatch(handlers, caller, req) {
  const id = req?.id ?? null;
  if (!req || typeof req.op !== 'string' || typeof req.id !== 'string' || typeof req.caller !== 'string' || typeof req.args !== 'object' || req.args === null) {
    return { id, ok: false, error: 'bad_request', message: 'envelope incomplete' };
  }
  if (req.caller !== caller) return { id, ok: false, error: 'unauthorized_caller', message: `this socket is for ${caller}` };
  if ((req.op === 'code.deliver' || req.op === 'code.slots') && !caller.startsWith('channel-')) return { id, ok: false, error: 'unauthorized_caller', message: `${req.op} is only for channel adapters` };
  // Channel adapters may only wait for code slots, deliver codes and ask status; everything else is the core's.
  if (caller !== 'core' && !['code.slots', 'code.deliver', 'status'].includes(req.op)) return { id, ok: false, error: 'unauthorized_caller', message: `${req.op} is only for the core` };
  const h = handlers[req.op];
  if (!h) return { id, ok: false, error: 'unknown_op', message: req.op };
  try {
    return { id, ok: true, result: (await h(req.args, req)) ?? {} };
  } catch (e) {
    if (e instanceof BrokerError || (e?.code && /^[a-z_]+$/.test(e.code) && e.code !== 'internal')) {
      return { id, ok: false, error: e.code, message: e.message, ...(e.detail ? { detail: e.detail } : {}) };
    }
    console.error(`broker: ${req.op} failed:`, e?.stack || e);
    return { id, ok: false, error: 'internal', message: 'internal error' };
  }
}

function server(handlers, caller) {
  return createServer((conn) => {
    let buf = Buffer.alloc(0), done = false;
    conn.setTimeout(IDLE_MS, () => conn.destroy());
    conn.on('error', () => {});
    conn.on('data', async (chunk) => {
      if (done) return;
      buf = Buffer.concat([buf, chunk]);
      const nl = buf.indexOf(0x0a);
      if (nl < 0) { if (buf.length > MAX_REQUEST) { done = true; conn.end(JSON.stringify({ id: null, ok: false, error: 'bad_request', message: 'request too long' }) + '\n'); } return; }
      done = true;
      let req = null;
      try { req = JSON.parse(buf.subarray(0, nl).toString('utf8')); } catch {}
      conn.end(JSON.stringify(await dispatch(handlers, caller, req)) + '\n');
    });
  });
}

/** Sockets handed over by systemd: [{ caller, fd }], from LISTEN_FDS / LISTEN_FDNAMES. */
export function systemdSockets(env = process.env) {
  if (Number(env.LISTEN_PID) !== process.pid) return [];
  const names = (env.LISTEN_FDNAMES || '').split(':');
  return Array.from({ length: Number(env.LISTEN_FDS) || 0 }, (_, i) => ({ caller: names[i], fd: 3 + i }));
}

/** Starts one server per socket: [{ caller, path } | { caller, fd }]. Returns the servers. */
export async function listen(broker, sockets) {
  const handlers = broker.handlers();
  return Promise.all(sockets.map(async (s) => {
    if (!/^(core|channel-[a-z0-9-]+)$/.test(s.caller || '')) throw new Error(`broker: socket caller must be core or channel-<name>, got ${s.caller}`);
    if (s.caller.startsWith('channel-')) broker.channels?.add(s.caller.slice('channel-'.length));   // code slots go to one adapter
    const srv = server(handlers, s.caller);
    if (s.fd !== undefined) {
      await new Promise((r, j) => { srv.once('error', j); srv.listen({ fd: s.fd }, r); });
    } else {
      if (existsSync(s.path)) {
        if (!lstatSync(s.path).isSocket()) throw new Error(`${s.path} exists and is not a socket`);
        unlinkSync(s.path);
      }
      await new Promise((r, j) => { srv.once('error', j); srv.listen(s.path, r); });
      chmodSync(s.path, 0o600);
    }
    return srv;
  }));
}
