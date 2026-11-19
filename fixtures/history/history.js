// History tools (contracts/history.md): show one errand across the three logs, verify
// every chain and signature offline. Works with every other part stopped.
//   node history/history.js show   <dir> <errand_id>
//   node history/history.js verify <dir>
//   node history/history.js errands <dir>
// <dir> holds actions.jsonl, context-reads.jsonl, conversation.jsonl and keys.json
// (public keys, PEM, written by whoever ran the parts).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readLog, verifyLog } from '../lib/log.js';

const FILES = { actions: 'actions.jsonl', context: 'context-reads.jsonl', conversation: 'conversation.jsonl' };

function keys(dir) {
  const p = path.join(dir, 'keys.json');
  if (!fs.existsSync(p)) return {};
  return Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(p, 'utf8'))).map(([k, pem]) => [k, crypto.createPublicKey(pem)]));
}

export function verifyAll(dir) {
  const k = keys(dir);
  return {
    actions: verifyLog(path.join(dir, FILES.actions), k.broker || null),
    context: verifyLog(path.join(dir, FILES.context), k.context || null),
    conversation: verifyLog(path.join(dir, FILES.conversation), null),
  };
}

export function show(dir, errandId) {
  const rows = [];
  for (const [src, f] of Object.entries(FILES)) {
    for (const l of readLog(path.join(dir, f))) if (l.errand_id === errandId) rows.push({ src, ...l });
  }
  rows.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return rows.map((r) => {
    if (r.src === 'conversation') return `${r.ts}  ${r.direction === 'in' ? 'person' : 'agent '}  ${r.text}`;
    if (r.src === 'context') return `${r.ts}  read    scope=${r.scope} items=[${r.item_ids}]`;
    const d = r.detail || {};
    const what = { 'grant.requested': `${d.mode} ${d.ops} on ${d.credential}`, 'grant.used': `${d.op}${d.confirmation ? ' ' + d.confirmation : ''}${d.mode ? ' (' + d.mode + ')' : ''}`,
      'grant.refused': d.error, 'identity.declaration': `would have presented to ${d.declaration?.relying_party} (presented=${d.presented})` }[r.type] || '';
    return `${r.ts}  ${r.type.padEnd(21)} ${what}`;
  }).join('\n');
}

export function errands(dir) {
  const seen = new Map();
  for (const l of readLog(path.join(dir, FILES.conversation))) if (!seen.has(l.errand_id)) seen.set(l.errand_id, l.ts);
  return [...seen].map(([id, ts]) => `${id}  started ${ts}`).join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, dir, id] = process.argv.slice(2);
  if (cmd === 'verify') {
    const r = verifyAll(dir);
    for (const [k, v] of Object.entries(r)) console.log(`${k.padEnd(13)} ${v.ok ? 'OK' : 'BROKEN at line ' + v.break.line + ': ' + v.break.reason} (${v.lines} lines)`);
    process.exit(Object.values(r).every((v) => v.ok) ? 0 : 1);
  } else if (cmd === 'show') console.log(show(dir, id));
  else if (cmd === 'errands') console.log(errands(dir));
  else { console.error('usage: history.js show <dir> <errand_id> | verify <dir> | errands <dir>'); process.exit(2); }
}
