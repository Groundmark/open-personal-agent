// Any OpenAI-compatible chat completions endpoint: OpenRouter, a local model server, OpenAI itself.
// Translates the contract's neutral request and result both ways. Everything from the provider is checked
// before it is believed: a reply that is cut short, malformed or ends for an unknown reason is a
// provider_error, never a normal answer. Error messages are fixed text, never the provider's own words
// (which can quote the prompt).
import { RouterError } from '../errors.js';
import { isObj, isStr, isCount } from '../check.js';

const MAX_REPLY = 8 * 1024 * 1024;

const text = (parts) => parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n');

/** Contract args (already checked) -> chat completions body. */
export function toOpenAI(args, model, defaults = {}) {
  const messages = args.system ? [{ role: 'system', content: args.system }] : [];
  for (const m of args.messages) {
    const parts = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
    if (m.role === 'tool') {
      for (const p of parts) {
        const c = typeof p.content === 'string' ? p.content : JSON.stringify(p.content);
        messages.push({ role: 'tool', tool_call_id: p.call_id, content: p.is_error ? `Error: ${c}` : c });
      }
    } else if (m.role === 'assistant') {
      const calls = parts.filter((p) => p.type === 'tool_call').map((p) => ({
        id: p.call_id, type: 'function', function: { name: p.name, arguments: JSON.stringify(p.arguments) },
      }));
      messages.push({ role: 'assistant', content: text(parts) || null, ...(calls.length ? { tool_calls: calls } : {}) });
    } else {
      messages.push({ role: 'user', content: text(parts) });
    }
  }
  const body = { model, messages };
  const max = args.max_tokens ?? defaults.max_tokens;   // no default of our own: the provider's applies
  if (max !== undefined) body.max_tokens = max;
  if (args.tools?.length) {
    body.tools = args.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
  }
  return body;
}

const STOP = { stop: 'end', tool_calls: 'tool_calls', length: 'max_tokens', content_filter: 'refused' };
const malformed = (what) => new RouterError('provider_error', `malformed reply from provider: ${what}`);

/** Chat completions response -> contract result. */
export function fromOpenAI(json, provider) {
  if (!isObj(json) || !Array.isArray(json.choices)) throw malformed('not a chat completion');
  const choice = json.choices[0];
  if (choice === undefined) throw new RouterError('provider_error', 'provider returned no choices');
  if (!isObj(choice) || !isObj(choice.message)) throw malformed('no message');
  const msg = choice.message;
  if (msg.content !== undefined && msg.content !== null && !isStr(msg.content)) throw malformed('content is not text');
  if (msg.tool_calls !== undefined && msg.tool_calls !== null && !Array.isArray(msg.tool_calls)) throw malformed('tool_calls is not a list');
  const tool_calls = (msg.tool_calls || []).map((tc) => {
    if (!isObj(tc) || !isStr(tc.id) || !isObj(tc.function) || !isStr(tc.function.name) || !isStr(tc.function.arguments)) throw malformed('a tool call is incomplete');
    let a;
    try { a = JSON.parse(tc.function.arguments || '{}'); } catch { a = null; }   // "" is a call with no arguments
    if (!isObj(a)) throw malformed('a tool call\'s arguments are not a JSON object');
    return { call_id: tc.id, name: tc.function.name, arguments: a };
  });
  let stop;
  if (choice.native_finish_reason === 'refusal') stop = 'refused';
  else if (isStr(choice.finish_reason) && Object.hasOwn(STOP, choice.finish_reason)) stop = STOP[choice.finish_reason];
  else throw new RouterError('provider_error', 'provider finished for an unexpected reason');   // includes OpenRouter's "error", and none at all
  if (stop === 'tool_calls' && !tool_calls.length) throw malformed('finished for tool calls but sent none');
  if (tool_calls.length && stop === 'end') stop = 'tool_calls';
  const u = json.usage ?? {};
  if (!isObj(u)) throw malformed('usage');
  const count = (v) => { if (v === undefined || v === null) return 0; if (!isCount(v)) throw malformed('usage'); return v; };
  return {
    content: msg.content ? [{ type: 'text', text: msg.content }] : [],
    tool_calls,
    stop,
    usage: { input_tokens: count(u.prompt_tokens), output_tokens: count(u.completion_tokens) },
    served_by: { provider, model: isStr(json.model) ? json.model : '' },
  };
}

// Only the input being too big is context_too_long. Output-limit errors ("max_tokens: 16000 > 8192, which is the
// maximum allowed number of output tokens") are not: retrying with a shorter history wouldn't help.
const CONTEXT = /context|prompt is too long|input is too long|too many (input|prompt) tokens/i;

function mapError(status, err) {
  if (status === 429) return new RouterError('rate_limited', 'provider rate limit');
  const msg = isObj(err) && isStr(err.message) ? err.message : '';
  if ((status === 400 || status === 413) && CONTEXT.test(msg)) return new RouterError('context_too_long', 'the request is too long for this model');
  return new RouterError('provider_error', `provider returned ${status}`);
}

/** The reply body as JSON (null if it isn't), read up to MAX_REPLY bytes. */
async function readJson(res) {
  const chunks = []; let size = 0;
  for await (const c of res.body ?? []) {
    size += c.length;
    if (size > MAX_REPLY) { await res.body.cancel().catch(() => {}); throw new RouterError('provider_error', 'provider reply too large'); }
    chunks.push(c);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return null; }
}

/** cfg: { base_url, model, credential, max_tokens?, timeout_s? }; key(name) returns the secret. */
export function openaiAdapter(cfg, key, { timeoutMs = (cfg.timeout_s ?? 120) * 1000 } = {}) {
  const provider = new URL(cfg.base_url).hostname;
  return async (args) => {
    const auth = `Bearer ${key(cfg.credential)}`;
    let res, json;
    try {
      // The timeout covers the whole exchange: connecting, waiting and reading the reply.
      res = await fetch(cfg.base_url.replace(/\/$/, '') + '/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: auth },
        body: JSON.stringify(toOpenAI(args, cfg.model, cfg)),
        signal: AbortSignal.timeout(timeoutMs),
      });
      json = await readJson(res);
    } catch (e) {
      if (e instanceof RouterError) throw e;
      throw new RouterError('provider_error', e?.name === 'TimeoutError' ? 'provider timed out' : 'provider unreachable');
    }
    if (!res.ok) throw mapError(res.status, json?.error);
    if (isObj(json) && json.error !== undefined && json.error !== null) {   // OpenRouter: upstream errors with 200
      const c = isObj(json.error) ? json.error.code : undefined;
      const code = typeof c === 'number' || typeof c === 'string' ? Number(c) : NaN;
      throw mapError(Number.isInteger(code) && code >= 400 && code < 600 ? code : 502, json.error);
    }
    return fromOpenAI(json, provider);
  };
}
