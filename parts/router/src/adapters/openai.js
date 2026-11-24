// Any OpenAI-compatible chat completions endpoint: OpenRouter, a local model server, OpenAI itself.
// Translates the contract's neutral request and result both ways.
import { RouterError } from '../errors.js';

const text = (content) => (typeof content === 'string' ? content
  : content.filter((p) => p.type === 'text').map((p) => p.text).join('\n'));

/** Contract args -> chat completions body. */
export function toOpenAI(args, model) {
  const messages = args.system ? [{ role: 'system', content: args.system }] : [];
  for (const m of args.messages) {
    const parts = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
    if (m.role === 'tool') {
      for (const p of parts.filter((x) => x.type === 'tool_result')) {
        const c = typeof p.content === 'string' ? p.content : JSON.stringify(p.content);
        messages.push({ role: 'tool', tool_call_id: p.call_id, content: p.is_error ? `Error: ${c}` : c });
      }
    } else if (m.role === 'assistant') {
      const calls = parts.filter((p) => p.type === 'tool_call').map((p) => ({
        id: p.call_id, type: 'function', function: { name: p.name, arguments: JSON.stringify(p.arguments ?? {}) },
      }));
      messages.push({ role: 'assistant', content: text(parts) || null, ...(calls.length ? { tool_calls: calls } : {}) });
    } else {
      messages.push({ role: 'user', content: text(parts) });
    }
  }
  const body = { model, messages, max_tokens: args.max_tokens ?? 16000 };
  if (args.tools?.length) {
    body.tools = args.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
  }
  return body;
}

const STOP = { stop: 'end', tool_calls: 'tool_calls', length: 'max_tokens', content_filter: 'refused' };

/** Chat completions response -> contract result. */
export function fromOpenAI(json, provider) {
  const choice = json.choices?.[0];
  if (!choice) throw new RouterError('provider_error', 'provider returned no choices');
  const msg = choice.message || {};
  const tool_calls = (msg.tool_calls || []).map((tc) => {
    let a;
    try { a = JSON.parse(tc.function?.arguments || '{}'); } catch { a = null; }
    if (!a || typeof a !== 'object' || Array.isArray(a)) throw new RouterError('provider_error', `malformed arguments for tool ${tc.function?.name}`);
    return { call_id: tc.id, name: tc.function.name, arguments: a };
  });
  let stop = STOP[choice.finish_reason] ?? 'end';
  if (choice.native_finish_reason === 'refusal') stop = 'refused';
  if (tool_calls.length && stop === 'end') stop = 'tool_calls';
  return {
    content: msg.content ? [{ type: 'text', text: msg.content }] : [],
    tool_calls,
    stop,
    usage: { input_tokens: json.usage?.prompt_tokens ?? 0, output_tokens: json.usage?.completion_tokens ?? 0 },
    served_by: { provider, model: json.model || '' },
  };
}

function mapError(status, err) {
  const msg = String(err?.message || '').slice(0, 200);
  if (status === 429) return new RouterError('rate_limited', 'provider rate limit');
  if ((status === 400 || status === 413) && /context|too long|too many tokens|maximum.*tokens/i.test(msg)) {
    return new RouterError('context_too_long', msg);
  }
  return new RouterError('provider_error', `provider returned ${status}${msg ? `: ${msg}` : ''}`);
}

/** cfg: { base_url, model, credential }; key(name) returns the secret. */
export function openaiAdapter(cfg, key, { timeoutMs = 120000 } = {}) {
  const provider = new URL(cfg.base_url).hostname;
  return async (args) => {
    let res;
    try {
      res = await fetch(cfg.base_url.replace(/\/$/, '') + '/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key(cfg.credential)}` },
        body: JSON.stringify(toOpenAI(args, cfg.model)),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      if (e instanceof RouterError) throw e;
      throw new RouterError('provider_error', e.name === 'TimeoutError' ? 'provider timed out' : 'provider unreachable');
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw mapError(res.status, json.error);
    if (json.error) throw mapError(Number(json.error.code) || 502, json.error);   // OpenRouter: upstream errors with 200
    return fromOpenAI(json, provider);
  };
}
