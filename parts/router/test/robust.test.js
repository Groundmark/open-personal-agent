// What goes wrong around the happy path: failed writes, callers that hang up, providers that send something
// odd, bad input, bad config, bad recordings. Each must give a contract error, never a crash or a fake answer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseToml, loadConfig } from '../src/config.js';
import { fromOpenAI, openaiAdapter } from '../src/adapters/openai.js';
import { recording, replayAdapter, requestKey } from '../src/adapters/replay.js';
import { buildAdapters, handle, startServer } from '../src/server.js';

const KEY = 'sk-fake-router-test-0000';
const key = () => KEY;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'opa-router-'));
const env = (args) => ({ op: 'infer', id: '01JD0000000000000000000000', caller: 'core', errand_id: null, ts: new Date().toISOString(), args });
const hi = { model: 'default', messages: [{ role: 'user', content: 'hi' }] };
const RESULT = { content: [{ type: 'text', text: 'ok' }], tool_calls: [], stop: 'end', usage: { input_tokens: 1, output_tokens: 1 } };
const fixed = { default: { run: async () => RESULT } };
const missingDir = path.join(os.tmpdir(), 'opa-router-no-such-dir', 'x.jsonl');
const post = (url, body) => fetch(url, { method: 'POST', body: JSON.stringify(body) }).then((r) => r.json());

/** A raw upstream: handler(req, res) does whatever it likes. */
async function rawUpstream(handler) {
  const server = http.createServer(async (req, res) => { for await (const _ of req); handler(req, res); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/v1`, close: () => new Promise((r) => { server.close(r); server.closeAllConnections(); }) };
}

test('a log write that fails is reported, and the call still gets its answer', async () => {
  const r = await startServer({ port: 0, log: missingDir }, fixed);
  try {
    const a = await post(r.url, env(hi));
    assert.equal(a.ok, true);
    assert.equal((await post(r.url, env(hi))).ok, true);
  } finally { await r.close(); }
});

test('a recording that fails to save still returns the answer already paid for', async () => {
  const run = recording(async () => RESULT, missingDir);
  assert.deepEqual(await run(hi), RESULT);
});

test('the router process survives a caller hanging up and a failing log, and answers the next call', async () => {
  const d = tmp();
  const rec = path.join(d, 'rec.jsonl');
  fs.writeFileSync(rec, JSON.stringify({ key: requestKey(hi), result: RESULT }) + '\n');
  const toml = path.join(d, 'router.toml');
  fs.writeFileSync(toml, `[server]\nport = 0\nlog = ${JSON.stringify(missingDir)}\n\n[models.default]\nprovider = "replay"\nfile = ${JSON.stringify(rec)}\n`);
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/main.js', import.meta.url)), toml], { stdio: ['ignore', 'pipe', 'pipe'] });
  let exited = null; child.on('exit', (c) => { exited = c; });
  try {
    const url = await new Promise((res, rej) => {
      let out = ''; child.stdout.on('data', (b) => { out += b; const m = /(http:\S+\/infer)/.exec(out); if (m) res(m[1]); });
      child.on('exit', () => rej(new Error('router exited at start')));
    });
    const u = new URL(url);
    await new Promise((res) => {   // a body cut off mid-way
      const s = net.connect(Number(u.port), u.hostname, () => {
        s.write('POST /infer HTTP/1.1\r\nHost: x\r\nContent-Length: 500\r\n\r\n{"op":"infer"');
        setTimeout(() => { s.destroy(); res(); }, 50);
      });
    });
    await new Promise((r) => setTimeout(r, 100));
    const a = await post(url, env(hi));   // and its log write fails too
    assert.equal(a.ok, true);
    assert.deepEqual(a.result.content, RESULT.content);
    assert.equal(exited, null);
  } finally { child.kill(); }
});

test('provider replies that are cut short, malformed or end oddly are provider_error, never an answer', () => {
  const ok = (message, finish_reason = 'stop', extra = {}) => ({ model: 'm', choices: [{ message, finish_reason, ...extra }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
  const call = (fn) => ({ content: null, tool_calls: [{ id: 'c1', type: 'function', function: fn }] });
  const bad = [
    ok({ content: 'half an answer' }, 'error'),                 // OpenRouter's "error" finish
    ok({ content: 'x' }, null),
    { model: 'm', choices: [{ message: { content: 'x' } }] },    // no finish reason at all
    ok({ content: 'x' }, '__proto__'),
    ok({ content: 'x' }, 'function_call'),
    ok({ content: null, tool_calls: [] }, 'tool_calls'),         // tool_calls with no calls
    ok({ content: null }, 'tool_calls'),
    ok(call(undefined), 'tool_calls'),                           // no function object
    ok(call({ name: 'f' }), 'tool_calls'),                       // no arguments
    ok(call({ name: 'f', arguments: false }), 'tool_calls'),
    ok(call({ name: 'f', arguments: '[1]' }), 'tool_calls'),
    ok(call({ arguments: '{}' }), 'tool_calls'),                 // no name
    { model: 'm', choices: [{ finish_reason: 'stop' }] },        // no message
    ok({ content: [{ type: 'text', text: 'x' }] }),              // content not a string
    ok({ content: 'x', tool_calls: {} }),
    null,
    { choices: 'no' },
    { ...ok({ content: 'x' }), usage: { prompt_tokens: '12', completion_tokens: 1 } },
    { ...ok({ content: 'x' }), usage: 'lots' },
  ];
  for (const b of bad) {
    assert.throws(() => fromOpenAI(b, 'p'), (e) => e.code === 'provider_error', JSON.stringify(b));
  }
  assert.deepEqual(fromOpenAI(ok(call({ name: 'f', arguments: '' }), 'tool_calls'), 'p').tool_calls, [{ call_id: 'c1', name: 'f', arguments: {} }]);
  assert.deepEqual(fromOpenAI({ model: 'm', choices: [{ message: { content: 'x' }, finish_reason: 'stop' }] }, 'p').usage, { input_tokens: 0, output_tokens: 0 });
  assert.equal(fromOpenAI(ok({ content: '' }, null, { native_finish_reason: 'refusal' }), 'p').stop, 'refused');
});

test('only an input that is too long is context_too_long; provider text never comes back', async () => {
  const replies = [
    [400, { error: { message: 'max_tokens: 16000 > 8192, which is the maximum allowed number of output tokens' } }],
    [400, { error: { message: 'prompt is too long: 210000 tokens > 200000 maximum' } }],
    [400, { error: { message: `bad request: you said "SECRET-PROMPT" with ${KEY}` } }],
    [200, { error: { code: { toString: 'not callable' }, message: 'bad' } }],
  ];
  const up = await rawUpstream((req, res) => { const [s, j] = replies.shift(); res.writeHead(s, { 'content-type': 'application/json' }).end(JSON.stringify(j)); });
  const a = buildAdapters({ models: { default: { provider: 'openai', base_url: up.url, model: 'm', credential: 'inference-test' } } }, key);
  try {
    assert.equal((await handle(a, env(hi))).error, 'provider_error');
    assert.equal((await handle(a, env(hi))).error, 'context_too_long');
    const e = await handle(a, env(hi));
    assert.equal(e.error, 'provider_error');
    assert.doesNotMatch(JSON.stringify(e), /SECRET-PROMPT|sk-fake/);
    const odd = await handle(a, env(hi));   // an error code that isn't a number or string
    assert.equal(odd.error, 'provider_error');
    assert.equal(odd.message, 'provider returned 502');
  } finally { await up.close(); }
});

test('an oversized provider reply and a provider that stalls mid-reply are provider_error', async () => {
  const big = await rawUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'x'.repeat(9 * 1024 * 1024) }, finish_reason: 'stop' }] }));
  });
  const slow = await rawUpstream((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"choices":'); });
  try {
    await assert.rejects(openaiAdapter({ base_url: big.url, model: 'm', credential: 'c' }, key)(hi), (e) => e.code === 'provider_error' && /too large/.test(e.message));
    await assert.rejects(openaiAdapter({ base_url: slow.url, model: 'm', credential: 'c' }, key, { timeoutMs: 200 })(hi), (e) => e.code === 'provider_error' && /timed out/.test(e.message));
  } finally { await big.close(); await slow.close(); }
});

test('input the router can\'t translate faithfully is bad_request, and odd model names are unknown_model', async () => {
  const bad = [
    { model: 'default', messages: [{ role: 'tool', content: 'a string has no call_id' }] },
    { model: 'default', messages: [{ role: 'user', content: [null] }] },
    { model: 'default', messages: [{ role: 'user', content: [{ type: 'tool_call', call_id: 'c', name: 'f', arguments: {} }] }] },
    { model: 'default', messages: [{ role: 'assistant', content: [{ type: 'tool_result', call_id: 'c', content: 1 }] }] },
    { model: 'default', messages: [{ role: 'tool', content: [{ type: 'text', text: 'x' }] }] },
    { model: 'default', messages: [{ role: 'tool', content: [{ type: 'tool_result', call_id: 'c' }] }] },
    { model: 'default', messages: [{ role: 'assistant', content: [{ type: 'tool_call', call_id: 'c', name: 'f', arguments: [] }] }] },
    { model: 'default', messages: [{ role: 'user', content: [{ type: 'text', text: 3 }] }] },
    { ...hi, tools: [{ name: 'f', parameters: { type: 'object' } }] },
    { ...hi, system: 5 },
    { model: 'default', messages: [{ role: ['assistant'], content: [{ type: 'tool_call', call_id: 'c', name: 'f', arguments: {} }] }] },
    { model: 'default', messages: [{ role: { toString: 'not callable' }, content: 'x' }] },
  ];
  let called = 0;
  const counting = { default: { run: async () => { called++; return RESULT; } } };
  for (const args of bad) assert.equal((await handle(counting, env(args))).error, 'bad_request', JSON.stringify(args));
  assert.equal(called, 0);
  const nullResult = { model: 'default', messages: [{ role: 'tool', content: [{ type: 'tool_result', call_id: 'c', content: null }] }] };
  assert.equal((await handle(fixed, env(nullResult))).ok, true);
  for (const model of ['constructor', '__proto__', 'toString']) assert.equal((await handle(fixed, env({ ...hi, model }))).error, 'unknown_model');
  assert.equal((await handle({ default: { run: async () => ({ content: 'oops' }) } }, env(hi))).error, 'provider_error');
});

test('router.toml: a table or key set twice is an error, # inside quotes is kept, __proto__ is just a name', () => {
  assert.throws(() => parseToml('[models.default]\nprovider = "openai"\n[models.default]\nprovider = "replay"\n'), /line 3: \[models.default\] appears twice/);
  assert.throws(() => parseToml('[server]\nport = 1\nport = 2\n'), /port is set twice/);
  assert.throws(() => parseToml('[server]\nport = 1\n[server.port]\n'), /already a value/);
  assert.equal(parseToml('a = "x #1" # real comment\nb = "q\\" #" #c\n').a, 'x #1');
  assert.equal(parseToml('b = "q\\" #" #c\n').b, 'q" #');
  parseToml('[__proto__]\npolluted = true\n');
  assert.equal({}.polluted, undefined);
  const d = tmp(); const f = path.join(d, 'r.toml');
  const example = fs.readFileSync(fileURLToPath(new URL('../router.example.toml', import.meta.url)), 'utf8');
  fs.writeFileSync(f, example.replace(/^# (\[models\.default\]|provider = "replay".*|file = .*)$/gm, '$1'));   // uncomment the replay block only
  assert.throws(() => loadConfig(f), /appears twice/);
  fs.writeFileSync(f, '[models.default]\nprovider = "openai"\nbase_url = "http://x"\nmodel = "m"\ncredential = "c"\nmax_tokens = 0\n');
  assert.throws(() => loadConfig(f), /max_tokens must be a positive whole number/);
});

test('replay: a broken line doesn\'t hide older recordings; a malformed recording is provider_error', async () => {
  const d = tmp(); const f = path.join(d, 'rec.jsonl');
  const other = { ...hi, messages: [{ role: 'user', content: 'other' }] };
  const third = { ...hi, messages: [{ role: 'user', content: 'third' }] };
  fs.writeFileSync(f, [
    JSON.stringify({ key: requestKey(hi), result: RESULT }),
    JSON.stringify({ key: requestKey(other), result: { ...RESULT, usage: undefined } }),
    JSON.stringify({ key: requestKey(third), result: { ...RESULT, stop: 'tool_calls' } }),   // tool_calls, but none
    '{"key":"trunc',
  ].join('\n'));
  const run = replayAdapter({ file: f });
  assert.deepEqual((await run(hi)).content, RESULT.content);
  await assert.rejects(run(other), (e) => e.code === 'provider_error' && /malformed/.test(e.message));
  await assert.rejects(run(third), (e) => e.code === 'provider_error' && /malformed/.test(e.message));
});

test('follow-ups: a misspelt setting is an error; an empty message is bad_request; a reply cut off mid-call is max_tokens', async () => {
  const d = tmp(); const f = path.join(d, 'r.toml');
  const base = '[models.default]\nprovider = "openai"\nbase_url = "http://x"\nmodel = "m"\ncredential = "c"\n';
  for (const [extra, re] of [['timeout_sec = 600\n', /models\.default\.timeout_sec isn't a setting/], ['max_token = 4000\n', /max_token isn't a setting/]]) {
    fs.writeFileSync(f, base + extra);
    assert.throws(() => loadConfig(f), re);
  }
  fs.writeFileSync(f, '[server]\nprot = 1\n' + base);
  assert.throws(() => loadConfig(f), /server\.prot isn't a setting/);
  fs.writeFileSync(f, '[sever]\nport = 1\n' + base);
  assert.throws(() => loadConfig(f), /sever isn't a setting/);
  fs.writeFileSync(f, base + 'max_tokens = 4000\ntimeout_s = 600\n');
  assert.equal(loadConfig(f).models.default.timeout_s, 600);

  for (const role of ['tool', 'assistant', 'user']) {
    assert.equal((await handle(fixed, env({ model: 'default', messages: [{ role: 'user', content: 'x' }, { role, content: [] }] }))).error, 'bad_request', role);
  }

  const cut = { model: 'm', choices: [{ message: { content: 'Let me', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{"party_si' } }] }, finish_reason: 'length' }], usage: { prompt_tokens: 5, completion_tokens: 16000 } };
  const r = fromOpenAI(cut, 'p');
  assert.equal(r.stop, 'max_tokens');
  assert.deepEqual(r.tool_calls, []);
  assert.deepEqual(r.content, [{ type: 'text', text: 'Let me' }]);
  // Calls that parse are dropped too: the model may not have finished choosing them.
  const call = (id, args) => ({ id, type: 'function', function: { name: 'f', arguments: args } });
  for (const calls of [[call('a', '{"x":1}')], [call('a', '{"x":1}'), call('b', '{"x"')]]) {
    const x = fromOpenAI({ ...cut, choices: [{ message: { content: null, tool_calls: calls }, finish_reason: 'length' }] }, 'p');
    assert.equal(x.stop, 'max_tokens');
    assert.deepEqual(x.tool_calls, []);
  }
});

test('review of 5b43cb0: refusals carry no tool calls, an error is never a refusal, empty text is bad_request', async () => {
  const reply = (message, finish_reason, extra = {}) => ({ model: 'm', choices: [{ message, finish_reason, ...extra }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
  const buy = { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'buy', arguments: '{}' } }] };
  for (const r of [reply(buy, 'content_filter'), reply(buy, 'tool_calls', { native_finish_reason: 'refusal' }), reply(buy, 'length', { native_finish_reason: 'refusal' })]) {
    const x = fromOpenAI(r, 'p');
    assert.equal(x.stop, 'refused');
    assert.deepEqual(x.tool_calls, []);
  }
  // A refusal with a broken tool call is still just a refusal.
  assert.equal(fromOpenAI(reply({ content: 'no', tool_calls: [{ id: 'c1' }] }, 'content_filter'), 'p').stop, 'refused');
  for (const fr of ['error', 'something_new']) {
    assert.throws(() => fromOpenAI(reply({ content: '' }, fr, { native_finish_reason: 'refusal' }), 'p'), (e) => e.code === 'provider_error', fr);
  }
  const bare = fromOpenAI(reply(buy, null, { native_finish_reason: 'refusal' }), 'p');   // no finish reason: the native refusal stands
  assert.equal(bare.stop, 'refused');
  assert.deepEqual(bare.tool_calls, []);
  // A recorded refusal with tool calls isn't believed either.
  const d = tmp(); const rec = path.join(d, 'rec.jsonl');
  fs.writeFileSync(rec, JSON.stringify({ key: requestKey(hi), result: { ...RESULT, stop: 'refused', tool_calls: [{ call_id: 'c1', name: 'buy', arguments: {} }] } }) + '\n');
  await assert.rejects(replayAdapter({ file: rec })(hi), (e) => e.code === 'provider_error');

  const empty = [
    { role: 'assistant', content: [{ type: 'text', text: '' }] },
    { role: 'user', content: [{ type: 'text', text: '' }, { type: 'text', text: '' }] },
    { role: 'user', content: '' },
    { role: 'assistant', content: '' },
  ];
  for (const m of empty) {
    assert.equal((await handle(fixed, env({ model: 'default', messages: [{ role: 'user', content: 'x' }, m] }))).error, 'bad_request', JSON.stringify(m));
  }
  // Empty text beside a tool call is fine.
  const withCall = { role: 'assistant', content: [{ type: 'text', text: '' }, { type: 'tool_call', call_id: 'c1', name: 'f', arguments: {} }] };
  assert.equal((await handle(fixed, env({ model: 'default', messages: [{ role: 'user', content: 'x' }, withCall] }))).ok, true);
});

test('review of 5b43cb0: an oversize request gets its 413; [server] settings and string escapes are checked with a line', async () => {
  const r = await startServer({ port: 0, log: null }, fixed);
  try {
    const u = new URL(r.url);
    const status = await new Promise((res, rej) => {
      const req = http.request({ host: u.hostname, port: u.port, path: '/infer', method: 'POST' }, (resp) => { resp.resume(); res(resp.statusCode); });
      req.on('error', rej);
      const chunk = Buffer.alloc(1024 * 1024, 'a');
      let sent = 0;
      const pump = () => { while (sent < 10) { sent++; if (!req.write(chunk)) { req.once('drain', pump); return; } } req.end(); };
      pump();
    });
    assert.equal(status, 413);
    assert.equal((await post(r.url, env(hi))).ok, true);   // and the router carries on
  } finally { await r.close(); }

  assert.throws(() => parseToml('a = "x\\\'y"'), /router\.toml line 1: unsupported escape/);
  const d = tmp(); const f = path.join(d, 'r.toml');
  const base = '[models.default]\nprovider = "replay"\nfile = "x.jsonl"\n';
  for (const [server, re] of [['port = "abc"', /server\.port must be/], ['port = 70000', /server\.port must be/], ['record = true', /server\.record must be/], ['log = 3', /server\.log must be/]]) {
    fs.writeFileSync(f, `[server]\n${server}\n` + base);
    assert.throws(() => loadConfig(f), re, server);
  }
  fs.writeFileSync(f, '[server]\nport = 0\nlog = "a.log"\nrecord = "r.jsonl"\n' + base);
  assert.equal(loadConfig(f).port, 0);
});
