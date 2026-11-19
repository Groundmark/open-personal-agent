// Router fixture (contracts/router.md): POST /infer on loopback, scripted replies.
// A script is a list of rules: the first whose `when` substring appears in the last
// message's text (or tool result) wins. Deterministic, no model, no key.
import http from 'node:http';
import { dispatch, ContractError } from '../lib/wire.js';

const lastText = (messages) => {
  const m = messages[messages.length - 1];
  if (!m) return '';
  if (typeof m.content === 'string') return m.content;
  return m.content.map((p) => p.text ?? JSON.stringify(p.content ?? p.arguments ?? '')).join(' ');
};

export function startRouter({ script, models = ['default', 'cheap'], port = 0 }) {
  const handlers = {
    infer: async (a) => {
      if (!models.includes(a.model)) throw new ContractError('unknown_model', a.model);
      const text = lastText(a.messages);
      const rule = script.find((r) => text.includes(r.when)) || script.find((r) => r.when === '*');
      if (!rule) throw new ContractError('provider_error', `no scripted reply for: ${text.slice(0, 80)}`);
      const tool_calls = (rule.tool_calls || []).map((t, i) => ({ call_id: `c${Date.now()}${i}`, name: t.name, arguments: t.arguments }));
      return {
        content: rule.text ? [{ type: 'text', text: rule.text }] : [],
        tool_calls,
        stop: tool_calls.length ? 'tool_calls' : 'end',
        usage: { input_tokens: text.length, output_tokens: (rule.text || '').length },
        served_by: { provider: 'fixture', model: 'scripted' },
      };
    },
  };
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/infer') { res.writeHead(404); return res.end(); }
    let b = ''; for await (const c of req) b += c;
    let env; try { env = JSON.parse(b); } catch { env = null; }
    const out = await dispatch(handlers, env);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out));
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({
    server, url: `http://127.0.0.1:${server.address().port}/infer`, close: () => new Promise((r) => { server.close(r); server.closeAllConnections(); }),
  })));
}

export async function infer(url, envelope) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(envelope) });
  return res.json();
}
