import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canonicalize } from '../src/jcs.js';
import { verifyAll, verifyLog, loadKeys } from '../src/logs.js';
import { errands, pairing, show, describe } from '../src/story.js';
import { run } from '../src/cli.js';

const E1 = '01M85AFY69WCYA5HD84FXVN2RF', E2 = '01M85AFY69WCYA5HD84FXVN2RG', G = '01M85AFY92130HVBF4MF40SKBS';
const broker = crypto.generateKeyPairSync('ed25519'), context = crypto.generateKeyPairSync('ed25519');

/** Writes a log the way the parts do: seq, prev_hash over the previous line's bytes, optional sig. */
function write(file, entries, key = null) {
  let prev = '';
  const lines = entries.map((e, seq) => {
    const o = { seq, ts: e.ts, errand_id: null, ...e, prev_hash: prev };
    if (key) o.sig = crypto.sign(null, Buffer.from(canonicalize(o)), key.privateKey).toString('base64');
    const line = canonicalize(o);
    prev = crypto.createHash('sha256').update(line).digest('hex');
    return line;
  });
  fs.writeFileSync(file, lines.map((l) => l + '\n').join(''));
}

function logs(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opa-history-'));
  const t = (s) => `2026-11-23T10:00:${String(s).padStart(2, '0')}.000Z`;
  write(path.join(dir, 'actions.jsonl'), extra.actions ?? [
    { ts: t(2), errand_id: E1, type: 'grant.requested', grant_id: G, detail: { mode: 'one_shot', ops: ['book'], credential: 'fake-table', purpose: 'Book this table' } },
    { ts: t(3), errand_id: E1, type: 'grant.approved', grant_id: G, detail: { passkey_credential_id: 'pk1', bound_hash: 'ab' } },
    { ts: t(4), errand_id: E1, type: 'grant.used', grant_id: G, detail: { op: 'login', browser: 'fill_code', source: 'person', status: 'ok', mode: 'agent_browser', conforming: true } },
    { ts: t(5), errand_id: E1, type: 'grant.used', grant_id: G, detail: { op: 'book', status: 'ok', confirmation: 'FT-ABC123', mode: 'agent_browser', conforming: true } },
    { ts: t(7), errand_id: E2, type: 'grant.refused', detail: { error: 'store_no_answer', op: 'login' } },
  ], broker);
  write(path.join(dir, 'context-reads.jsonl'), [
    { ts: t(1), errand_id: E1, type: 'context.read', read_id: E2, scope: 'dining', query: 'party size', item_ids: ['i1', 'i2'] },
  ], context);
  write(path.join(dir, 'conversation.jsonl'), extra.conversation ?? [
    { ts: t(0), type: 'pairing', channel: 'signal', event: 'paired' },
    { ts: t(1), errand_id: E1, type: 'message', direction: 'in', channel: 'signal', message_id: 'm1', text: 'Book Casa Verde for 2', attachments: [] },
    { ts: t(4), errand_id: E1, type: 'message', direction: 'in', channel: 'signal', message_id: 'm2', text: '[one-time code delivered]', attachments: [] },
    { ts: t(6), errand_id: E1, type: 'message', direction: 'out', channel: 'signal', message_id: 'm3', text: 'Booked.', attachments: [] },
    { ts: t(7), errand_id: E2, type: 'message', direction: 'in', channel: 'web', message_id: 'm4', text: 'Sign in to the shop', attachments: [] },
  ]);
  const pem = (k) => k.publicKey.export({ type: 'spki', format: 'pem' });
  fs.writeFileSync(path.join(dir, 'keys.json'), JSON.stringify({ broker: pem(broker), context: pem(context) }));
  return dir;
}

const edit = (file, n, fn) => {   // n is 1-based, like the reports
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines[n - 1] = fn(lines[n - 1]);
  fs.writeFileSync(file, lines.join('\n'));
};
const brk = (dir, kind) => verifyAll(dir)[kind].break;

test('clean logs verify', () => {
  const r = verifyAll(logs());
  assert.deepEqual(Object.values(r).map((v) => [v.ok, v.lines]), [[true, 5], [true, 1], [true, 5]]);
});

test('a changed signed line fails its signature; a changed unsigned line breaks the next link', () => {
  let d = logs();
  edit(path.join(d, 'actions.jsonl'), 4, (l) => l.replace('FT-ABC123', 'FT-XYZ999'));
  assert.deepEqual(brk(d, 'actions'), { line: 4, reason: 'bad or missing broker signature' });
  d = logs();
  edit(path.join(d, 'conversation.jsonl'), 4, (l) => l.replace('Booked.', 'Not booked.'));
  assert.equal(brk(d, 'conversation').line, 5);
  assert.match(brk(d, 'conversation').reason, /prev_hash/);
});

test('removed, moved and half-written lines are caught', () => {
  let d = logs();
  edit(path.join(d, 'actions.jsonl'), 2, () => null);
  fs.writeFileSync(path.join(d, 'actions.jsonl'), fs.readFileSync(path.join(d, 'actions.jsonl'), 'utf8').replace('\n\n', '\n'));
  assert.match(brk(d, 'actions').reason, /seq is 2, expected 1/);
  d = logs();
  const f = path.join(d, 'conversation.jsonl');
  const ls = fs.readFileSync(f, 'utf8').trim().split('\n');
  [ls[1], ls[2]] = [ls[2], ls[1]];
  fs.writeFileSync(f, ls.join('\n') + '\n');
  assert.equal(brk(d, 'conversation').line, 2);
  d = logs();
  fs.appendFileSync(path.join(d, 'actions.jsonl'), '{"seq":5,"ts":"2026');
  assert.match(brk(d, 'actions').reason, /incomplete/);
});

test('signatures: no key is a failure, the wrong key is a failure', () => {
  const d = logs();
  assert.match(verifyAll(d, {}).actions.break.reason, /no broker public key/);
  const other = crypto.generateKeyPairSync('ed25519').publicKey;
  assert.match(verifyAll(d, { ...loadKeys(path.join(d, 'keys.json')), broker: other }).actions.break.reason, /bad or missing broker signature/);
  assert.equal(verifyLog(path.join(d, 'missing.jsonl'), 'actions', null).ok, true);   // empty log: nothing to check
});

test('a secret or a code in a log line fails verify', () => {
  const d = logs({ actions: [{ ts: '2026-11-23T10:00:00.000Z', errand_id: E1, type: 'grant.used', grant_id: G, detail: { op: 'login', browser: 'fill_code', code: '123456', status: 'ok' } }] });
  assert.match(brk(d, 'actions').reason, /secret-looking field "code"/);
});

test('show tells one errand in time order across the three logs', () => {
  const rows = show(logs(), E1);
  assert.deepEqual(rows.map((r) => r.src), ['conversation', 'context', 'actions', 'actions', 'conversation', 'actions', 'actions', 'conversation']);
  const text = rows.map(describe).join('\n');
  assert.match(text, /person    Book Casa Verde/);
  assert.match(text, /read      dining: 2 item\(s\) for "party size"/);
  assert.match(text, /grant.used\s+login \(fill_code\) ok code from person/);
  assert.match(text, /grant.used\s+book ok confirmation FT-ABC123 \[agent_browser\]/);
  assert.doesNotMatch(text, /pairing/);
});

test('errands and pairing', () => {
  const d = logs();
  assert.deepEqual(errands(d).map((e) => [e.errand_id, e.channels, e.outcome]), [
    [E1, ['signal'], 'book FT-ABC123'],
    [E2, ['web'], 'refused: store_no_answer'],
  ]);
  assert.deepEqual(pairing(d).map(describe), ['pairing   signal: paired']);
});

test('cli: exit codes and --json', () => {
  const d = logs();
  const out = [];
  assert.equal(run(['--dir', d, 'verify'], (s) => out.push(s)), 0);
  assert.match(out.pop(), /actions\s+OK \(5 lines\)/);
  assert.equal(run(['--dir', d, '--json', 'errands'], (s) => out.push(s)), 0);
  assert.equal(JSON.parse(out.pop())[0].outcome, 'book FT-ABC123');
  assert.equal(run(['--dir', d, 'show'], (s) => out.push(s)), 2);
  edit(path.join(d, 'actions.jsonl'), 1, (l) => l.replace('one_shot', 'standing'));
  assert.equal(run(['--dir', d, 'verify'], (s) => out.push(s)), 1);
  assert.match(out.pop(), /BROKEN at line 1/);
});

const fixtures = new URL('../../../fixtures/', import.meta.url).pathname;
test('the fixture errand\'s real logs verify, and a tampered copy does not', { skip: !fs.existsSync(fixtures + 'node_modules/ajv') && 'run npm ci in fixtures/ first' }, async () => {
  const { runErrand } = await import(fixtures + 'errand/run.js');
  const r = await runErrand();
  assert.deepEqual(Object.values(verifyAll(r.dir)).map((v) => v.ok), [true, true, true]);
  assert.match(errands(r.dir)[0].outcome, /^book FT-/);
  edit(path.join(r.dir, 'actions.jsonl'), 8, (l) => l.replace('"status":"ok"', '"status":"failed"'));
  assert.equal(verifyAll(r.dir).actions.ok, false);
});
