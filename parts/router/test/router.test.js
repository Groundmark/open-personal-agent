import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { parseToml, loadConfig } from '../src/config.js';
import { toOpenAI, fromOpenAI } from '../src/adapters/openai.js';
import { requestKey } from '../src/adapters/replay.js';
import { buildAdapters, handle, startServer } from '../src/server.js';

const KEY = 'sk-fake-router-test-0000';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'opa-router-'));
const env = (args, op = 'infer') => ({ op, id: '01JD0000000000000000000000', caller: 'core', errand_id: null, ts: new Date().toISOString(), args });

/** A fake OpenAI-compatible server. `reply(body, req)` returns [status, json]. */
async function upstream(reply) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    let b = ''; for await (const c of req) b += c;
    const body = JSON.parse(b);
    seen.push({ body, auth: req.headers.authorization });
    const [status, json] = await reply(body, req);
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(json));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/v1`, seen, close: () => new Promise((r) => { server.close(r); server.closeAllConnections(); }) };
}

const completion = (message, finish_reason = 'stop') => ({ model: 'up/model-1', choices: [{ message, finish_reason }], usage: { prompt_tokens: 12, completion_tokens: 3 } });
const key = () => KEY;

test('toml subset: tables, strings, numbers, booleans, comments; rejects the rest', () => {
  const t = parseToml('# c\n[server]\nport = 8411 # trailing\n[models.default]\nprovider = "openai"\nx = true\n');
  assert.deepEqual(JSON.parse(JSON.stringify(t)), { server: { port: 8411 }, models: { default: { provider: 'openai', x: true } } });
  assert.throws(() => parseToml('a = [1]'), /unsupported value/);
  assert.throws(() => parseToml('nonsense'), /can't read/);
});

test('config: each model needs its fields', () => {
  const d = tmp(); const f = path.join(d, 'r.toml');
  fs.writeFileSync(f, '[models.default]\nprovider = "openai"\nmodel = "m"\n');
  assert.throws(() => loadConfig(f), /needs base_url, model and credential/);
  fs.writeFileSync(f, '[models.default]\nprovider = "anthropic"\n');
  assert.throws(() => loadConfig(f), /must be "openai" or "replay"/);
});

test('translation to chat completions: system, tool calls and tool results', () => {
  const body = toOpenAI({
    system: 'You book tables.',
    messages: [
      { role: 'user', content: 'Book it' },
      { role: 'assistant', content: [{ type: 'text', text: 'Looking.' }, { type: 'tool_call', call_id: 'c1', name: 'find_table', arguments: { party_size: 2 } }] },
      { role: 'tool', content: [{ type: 'tool_result', call_id: 'c1', content: { ok: true } }, { type: 'tool_result', call_id: 'c2', content: 'gone', is_error: true }] },
    ],
    tools: [{ name: 'find_table', description: 'Find', parameters: { type: 'object' } }],
  }, 'up/model-1');
  assert.equal(body.model, 'up/model-1');
  assert.equal('max_tokens' in body, false);   // no default of the router's own
  assert.equal(toOpenAI({ messages: [{ role: 'user', content: 'x' }] }, 'm', { max_tokens: 900 }).max_tokens, 900);
  assert.equal(toOpenAI({ messages: [{ role: 'user', content: 'x' }], max_tokens: 50 }, 'm', { max_tokens: 900 }).max_tokens, 50);
  assert.deepEqual(body.messages[0], { role: 'system', content: 'You book tables.' });
  assert.deepEqual(body.messages[2].tool_calls, [{ id: 'c1', type: 'function', function: { name: 'find_table', arguments: '{"party_size":2}' } }]);
  assert.deepEqual(body.messages[3], { role: 'tool', tool_call_id: 'c1', content: '{"ok":true}' });
  assert.deepEqual(body.messages[4], { role: 'tool', tool_call_id: 'c2', content: 'Error: gone' });
  assert.deepEqual(body.tools[0], { type: 'function', function: { name: 'find_table', description: 'Find', parameters: { type: 'object' } } });
});

test('translation back: stop reasons, tool arguments, usage', () => {
  const r = fromOpenAI(completion({ content: null, tool_calls: [{ id: 'x', function: { name: 'f', arguments: '{"a":1}' } }] }, 'tool_calls'), 'p');
  assert.deepEqual(r.tool_calls, [{ call_id: 'x', name: 'f', arguments: { a: 1 } }]);
  assert.equal(r.stop, 'tool_calls');
  assert.deepEqual(r.usage, { input_tokens: 12, output_tokens: 3 });
  assert.equal(fromOpenAI(completion({ content: 'hi' }, 'length'), 'p').stop, 'max_tokens');
  assert.equal(fromOpenAI(completion({ content: '' }, 'content_filter'), 'p').stop, 'refused');
  assert.equal(fromOpenAI({ ...completion({ content: '' }), choices: [{ message: {}, finish_reason: 'stop', native_finish_reason: 'refusal' }] }, 'p').stop, 'refused');
  assert.throws(() => fromOpenAI(completion({ tool_calls: [{ id: 'x', function: { name: 'f', arguments: '{oops' } }] }, 'tool_calls'), 'p'), /arguments are not a JSON object/);
});

test('envelope errors: bad_request, unknown_op, unknown_model', async () => {
  const adapters = { default: { run: async () => { throw new Error('not called'); } } };
  assert.equal((await handle(adapters, null)).error, 'bad_request');
  assert.equal((await handle(adapters, env({ model: 'default', messages: [] }))).error, 'bad_request');
  assert.equal((await handle(adapters, env({ model: 'default', messages: [{ role: 'user', content: 'hi' }] }, 'other'))).error, 'unknown_op');
  assert.equal((await handle(adapters, env({ model: 'gpt-9', messages: [{ role: 'user', content: 'hi' }] }))).error, 'unknown_model');
});

test('end to end over HTTP: the key goes only to the provider, the log has no prompt and no key', async () => {
  const up = await upstream(() => [200, completion({ content: 'Booked.' })]);
  const d = tmp();
  const cfg = { port: 0, log: path.join(d, 'calls.jsonl'), record: null,
    models: { default: { provider: 'openai', base_url: up.url, model: 'up/model-1', credential: 'inference-test' } } };
  const r = await startServer(cfg, buildAdapters(cfg, key));
  try {
    const res = await fetch(r.url, { method: 'POST', body: JSON.stringify(env({ model: 'default', messages: [{ role: 'user', content: 'SECRET-PROMPT table for two' }] })) }).then((x) => x.json());
    assert.equal(res.ok, true);
    assert.deepEqual(res.result.content, [{ type: 'text', text: 'Booked.' }]);
    assert.deepEqual(res.result.served_by, { provider: '127.0.0.1', model: 'up/model-1' });
    assert.equal(up.seen[0].auth, `Bearer ${KEY}`);
    const log = fs.readFileSync(cfg.log, 'utf8');
    assert.match(log, /"model":"default".*"input_tokens":12/);
    assert.doesNotMatch(log, /SECRET-PROMPT|sk-fake/);
    assert.doesNotMatch(JSON.stringify(res), /sk-fake/);
  } finally { await r.close(); await up.close(); }
});

test('provider errors map to the contract: 429, context too long, OpenRouter 200-with-error, unreachable, no credential', async () => {
  const replies = [
    [429, { error: { message: 'slow down' } }],
    [400, { error: { message: "This model's maximum context length is 200000 tokens" } }],
    [200, { error: { code: 502, message: 'upstream failed' } }],
  ];
  const up = await upstream(() => replies.shift());
  const mk = (base_url, k = key) => buildAdapters({ models: { default: { provider: 'openai', base_url, model: 'm', credential: 'inference-test' } } }, k);
  const ask = (a) => handle(a, env({ model: 'default', messages: [{ role: 'user', content: 'hi' }] }));
  const a = mk(up.url);
  assert.equal((await ask(a)).error, 'rate_limited');
  assert.equal((await ask(a)).error, 'context_too_long');
  const e = await ask(a);
  assert.equal(e.error, 'provider_error');
  assert.equal(e.message, 'provider returned 502');   // fixed text: the provider's own words can quote the prompt
  await up.close();
  assert.equal((await ask(mk(up.url))).error, 'provider_error');
  const { credentialReader } = await import('../src/credentials.js');
  assert.equal((await ask(mk('http://127.0.0.1:9/v1', credentialReader(tmp())))).error, 'credential_unavailable');
});

test('record, then replay the same request with no provider', async () => {
  const up = await upstream(() => [200, completion({ content: null, tool_calls: [{ id: 'c9', function: { name: 'find_table', arguments: '{"party_size":2}' } }] }, 'tool_calls')]);
  const d = tmp(); const rec = path.join(d, 'rec.jsonl');
  const args = { model: 'default', messages: [{ role: 'user', content: 'Book a table' }], tools: [{ name: 'find_table', description: 'd', parameters: { type: 'object' } }] };
  const live = buildAdapters({ record: rec, models: { default: { provider: 'openai', base_url: up.url, model: 'm', credential: 'inference-test' } } }, key);
  const first = await handle(live, env(args));
  await up.close();
  assert.equal(fs.statSync(rec).mode & 0o777, 0o600);
  const replay = buildAdapters({ models: { default: { provider: 'replay', file: rec } } });
  const again = await handle(replay, env(args));
  assert.deepEqual(again.result.tool_calls, first.result.tool_calls);
  assert.equal(again.result.served_by.provider, 'replay');
  assert.equal((await handle(replay, env({ ...args, messages: [{ role: 'user', content: 'something else' }] }))).error, 'provider_error');
  assert.equal(requestKey(args), requestKey(JSON.parse(JSON.stringify(args))));
});
