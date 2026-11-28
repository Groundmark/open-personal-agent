// POST /infer on loopback (contracts/router.md). One envelope in, one response out.
// Nothing a caller or provider does may stop the process: every request is answered or dropped on its own.
import fs from 'node:fs';
import http from 'node:http';
import { RouterError } from './errors.js';
import { checkArgs, isResult } from './check.js';
import { openaiAdapter } from './adapters/openai.js';
import { replayAdapter, recording } from './adapters/replay.js';
import { credentialReader } from './credentials.js';

const MAX_BODY = 8 * 1024 * 1024;

export function buildAdapters(config, key = credentialReader()) {
  const out = Object.create(null);
  for (const [name, m] of Object.entries(config.models)) {
    let a = m.provider === 'replay' ? replayAdapter(m) : openaiAdapter(m, key);
    if (config.record && m.provider !== 'replay') a = recording(a, config.record);
    out[name] = { run: a, provider: m.provider, model: m.model || m.file };
  }
  return out;
}

/** Handles one parsed envelope. Exported for tests. */
export async function handle(adapters, env, logLine = () => {}) {
  const id = env?.id ?? null;
  if (!env || typeof env.op !== 'string' || typeof env.id !== 'string' || typeof env.caller !== 'string' || !('args' in env)) {
    return { id, ok: false, error: 'bad_request', message: 'envelope incomplete' };
  }
  if (env.op !== 'infer') return { id, ok: false, error: 'unknown_op', message: env.op };
  const t0 = Date.now();
  const entry = { ts: new Date().toISOString(), errand_id: env.errand_id ?? null, caller: env.caller, model: env.args?.model };
  try {
    checkArgs(env.args);
    if (!Object.hasOwn(adapters, env.args.model)) throw new RouterError('unknown_model', env.args.model);
    const result = await adapters[env.args.model].run(env.args);
    if (!isResult(result)) throw new RouterError('provider_error', 'malformed result from the adapter');
    logLine({ ...entry, provider: result.served_by?.provider, provider_model: result.served_by?.model, ok: true, stop: result.stop,
      input_tokens: result.usage.input_tokens, output_tokens: result.usage.output_tokens, ms: Date.now() - t0 });
    return { id, ok: true, result };
  } catch (e) {
    const code = e instanceof RouterError ? e.code : 'internal';
    const message = e instanceof RouterError ? e.message : 'internal error';
    if (code === 'internal') console.error('router: infer failed:', e?.stack || e);
    logLine({ ...entry, ok: false, error: code, ms: Date.now() - t0 });
    return { id, ok: false, error: code, message };
  }
}

/** The call log, best effort: a write that fails (full disk, wrong owner) is reported and the call goes on. */
export function callLog(file) {
  if (!file) return () => {};
  return (o) => {
    try { fs.appendFileSync(file, JSON.stringify(o) + '\n', { mode: 0o600 }); } catch (e) { console.error(`router: can't write the call log ${file}: ${e.code || 'error'}`); }
  };
}

export function startServer(config, adapters = buildAdapters(config), { host = '127.0.0.1', port = config.port } = {}) {
  const logLine = callLog(config.log);
  const server = http.createServer(async (req, res) => {
    let env = null;
    try {
      if (req.method !== 'POST' || req.url !== '/infer') { res.writeHead(404).end(); return; }
      let size = 0; const chunks = [];
      try {
        for await (const c of req) {
          size += c.length;
          if (size > MAX_BODY) { res.writeHead(413).end(); req.destroy(); return; }
          chunks.push(c);
        }
      } catch { req.destroy(); return; }   // the caller hung up mid-request: nobody to answer
      try { env = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
      const out = await handle(adapters, env, logLine);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out));
    } catch (e) {
      console.error('router: request failed:', e?.stack || e);
      if (!res.headersSent && res.writable) {
        res.writeHead(500, { 'content-type': 'application/json' })
          .end(JSON.stringify({ id: typeof env?.id === 'string' ? env.id : null, ok: false, error: 'internal', message: 'internal error' }));
      } else res.destroy();
    }
  });
  return new Promise((resolve) => server.listen(port, host, () => resolve({
    server, url: `http://${host}:${server.address().port}/infer`,
    close: () => new Promise((r) => { server.close(r); server.closeAllConnections(); }),
  })));
}
