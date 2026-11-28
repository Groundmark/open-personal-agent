// Recorded answers, keyed by a hash of the request, so a scripted errand runs through the real
// router with no model and no key. A recording is made by setting [server] record = "<file>":
// every live answer is then appended to that file, and a replay model reads it back.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { RouterError } from '../errors.js';
import { isResult } from '../check.js';

const canonical = (v) => (v === null || typeof v !== 'object' ? JSON.stringify(v)
  : Array.isArray(v) ? `[${v.map(canonical).join(',')}]`
    : `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`);

/** The key: everything the model sees, under the logical model name. */
export const requestKey = (args) => crypto.createHash('sha256')
  .update(canonical({ model: args.model, system: args.system, messages: args.messages, tools: args.tools, max_tokens: args.max_tokens }))
  .digest('hex');

export function replayAdapter(cfg) {
  return async (args) => {
    const k = requestKey(args);
    let lines = [];
    try { lines = fs.readFileSync(cfg.file, 'utf8').split('\n').filter(Boolean); } catch {}
    for (const [i, l] of [...lines.entries()].reverse()) {   // newest first
      let r;
      try { r = JSON.parse(l); } catch { console.error(`router: ${cfg.file} line ${i + 1} is not JSON, skipped`); continue; }
      if (r?.key !== k) continue;
      if (!isResult(r.result)) throw new RouterError('provider_error', `the recording for request ${k.slice(0, 12)} is malformed`);
      return { ...r.result, served_by: { provider: 'replay', model: typeof r.result.served_by?.model === 'string' ? r.result.served_by.model : '' } };
    }
    throw new RouterError('provider_error', `no recording for request ${k.slice(0, 12)}`);
  };
}

/** Wraps an adapter so every successful answer is appended to `file`. Best effort: an answer already
 * paid for goes back to the caller even if it can't be saved. */
export function recording(adapter, file) {
  return async (args) => {
    const result = await adapter(args);
    try {
      fs.appendFileSync(file, JSON.stringify({ key: requestKey(args), result }) + '\n', { mode: 0o600 });
    } catch (e) {
      console.error(`router: can't write the recording to ${file}: ${e.code || 'error'}`);
    }
    return result;
  };
}
