// Shape checks for what crosses the seam: the caller's args (bad input is the caller's bad_request) and a
// result before it goes back (a bad one is the provider's or the recording's fault). Messages are fixed text:
// they never quote a prompt or a reply.
import { RouterError } from './errors.js';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string';
const isCount = (v) => Number.isInteger(v) && v >= 0;

// Which parts each role may carry: the ones the adapters can translate faithfully. The 0.4 schema allows more
// (any part under any role, string content for tool messages); see the README.
const PARTS = { user: ['text'], assistant: ['text', 'tool_call'], tool: ['tool_result'] };

function checkPart(p, role, bad) {
  if (!isObj(p) || !PARTS[role].includes(p.type)) bad(`a ${role} message may only hold ${PARTS[role].join(' or ')} parts`);
  if (p.type === 'text' && !isStr(p.text)) bad('a text part needs a string text');
  if (p.type === 'tool_call' && !(isStr(p.call_id) && isStr(p.name) && isObj(p.arguments))) bad('a tool_call part needs a string call_id and name, and an object of arguments');
  if (p.type === 'tool_result') {
    if (!isStr(p.call_id) || !Object.hasOwn(p, 'content')) bad('a tool_result part needs a string call_id and a content');
    if (p.is_error !== undefined && typeof p.is_error !== 'boolean') bad('is_error must be true or false');
  }
}

export function checkArgs(a) {
  const bad = (why) => { throw new RouterError('bad_request', why); };
  if (!isObj(a)) bad('args must be an object');
  if (!isStr(a.model)) bad('model must be a string');
  if (a.system !== undefined && !isStr(a.system)) bad('system must be a string');
  if (!Array.isArray(a.messages) || !a.messages.length) bad('messages must be a non-empty list');
  for (const m of a.messages) {
    if (!isObj(m) || !isStr(m.role) || !Object.hasOwn(PARTS, m.role)) bad('message role must be user, assistant or tool');
    if (isStr(m.content)) {
      if (m.role === 'tool') bad('tool messages take a list of tool_result parts');
    } else if (Array.isArray(m.content)) {
      if (!m.content.length) bad('a message needs at least one part');   // an empty one would vanish or be refused upstream
      for (const p of m.content) checkPart(p, m.role, bad);
    } else bad('message content must be a string or a list of parts');
  }
  if (a.tools !== undefined) {
    if (!Array.isArray(a.tools)) bad('tools must be a list');
    for (const t of a.tools) if (!(isObj(t) && isStr(t.name) && isStr(t.description) && isObj(t.parameters))) bad('each tool needs a string name and description, and an object of parameters');
  }
  if (a.max_tokens !== undefined && !(Number.isInteger(a.max_tokens) && a.max_tokens > 0)) bad('max_tokens must be a positive integer');
}

const STOPS = ['end', 'tool_calls', 'max_tokens', 'refused'];

/** True if `r` is a well-formed infer result (served_by aside, which the router fills in). */
export function isResult(r) {
  return isObj(r)
    && Array.isArray(r.content) && r.content.every((p) => isObj(p) && p.type === 'text' && isStr(p.text))
    && Array.isArray(r.tool_calls) && r.tool_calls.every((c) => isObj(c) && isStr(c.call_id) && isStr(c.name) && isObj(c.arguments))
    && STOPS.includes(r.stop) && (r.stop !== 'tool_calls' || r.tool_calls.length > 0)
    && isObj(r.usage) && isCount(r.usage.input_tokens) && isCount(r.usage.output_tokens);
}

export { isObj, isStr, isCount };
