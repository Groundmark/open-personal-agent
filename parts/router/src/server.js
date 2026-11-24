// POST /infer on loopback (contracts/router.md). One envelope in, one response out.
import fs from 'node:fs';
import http from 'node:http';
import { RouterError } from './errors.js';
import { openaiAdapter } from './adapters/openai.js';
import { replayAdapter, recording } from './adapters/replay.js';
import { credentialReader } from './credentials.js';

const MAX_BODY = 8 * 1024 * 1024;

export function buildAdapters(config, key = credentialReader()) {
  const out = {};
  for (const [name, m] of Object.entries(config.models)) {
    let a = m.provider === 'replay' ? replayAdapter(m) : openaiAdapter(m, key);
    if (config.record && m.provider !== 'replay') a = recording(a, config.record);
    out[name] = { run: a, provider: m.provider, model: m.model || m.file };
  }
  return out;
}

function checkArgs(a) {
  const bad = (why) => { throw new RouterError('bad_request', why); };
  if (!a || typeof a !== 'object') bad('args must be an object');
  if (typeof a.model !== 'string') bad('model must be a string');
  if (!Array.isArray(a.messages) || !a.messages.length) bad('messages must be a non-empty list');
  for (const m of a.messages) {
    if (!['user', 'assistant', 'tool'].includes(m?.role)) bad('message role must be user, assistant or tool');
    if (typeof m.content !== 'string' && !Array.isArray(m.content)) bad('message content must be a string or a list of parts');
  }
  if (a.tools !== undefined && !Array.isArray(a.tools)) bad('tools must be a list');
  if (a.max_tokens !== undefined && !(Number.isInteger(a.max_tokens) && a.max_tokens > 0)) bad('max_tokens must be a positive integer');
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
    const a = adapters[env.args.model];
    if (!a) throw new RouterError('unknown_model', env.args.model);
    const result = await a.run(env.args);
    logLine({ ...entry, provider: result.served_by?.provider, provider_model: result.served_by?.model, ok: true, stop: result.stop,
      input_tokens: result.usage.input_tokens, output_tokens: result.usage.output_tokens, ms: Date.now() - t0 });
    return { id, ok: true, result };
  } catch (e) {
    const code = e instanceof RouterError ? e.code : 'internal';
    const message = e instanceof RouterError ? e.message : 'internal error';
    logLine({ ...entry, ok: false, error: code, ms: Date.now() - t0 });
    return { id, ok: false, error: code, message };
  }
}

export function startServer(config, adapters = buildAdapters(config), { host = '127.0.0.1', port = config.port } = {}) {
  const logLine = config.log
    ? (o) => fs.appendFileSync(config.log, JSON.stringify(o) + '\n', { mode: 0o600 })
    : () => {};
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/infer') { res.writeHead(404).end(); return; }
    let size = 0; const chunks = [];
    for await (const c of req) {
      size += c.length;
      if (size > MAX_BODY) { res.writeHead(413).end(); req.destroy(); return; }
      chunks.push(c);
    }
    let env = null;
    try { env = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
    const out = await handle(adapters, env, logLine);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out));
  });
  return new Promise((resolve) => server.listen(port, host, () => resolve({
    server, url: `http://${host}:${server.address().port}/infer`,
    close: () => new Promise((r) => { server.close(r); server.closeAllConnections(); }),
  })));
}
