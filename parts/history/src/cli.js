#!/usr/bin/env node
// history [--dir <dir>] [--keys <keys.json>] [--json] verify | show <errand_id> | errands | pairing
// <dir> holds actions.jsonl, context-reads.jsonl and conversation.jsonl (default $OPA_HISTORY_DIR, else .).
// keys.json maps "broker" and "context" to their public keys (PEM or JWK); default <dir>/keys.json.
import path from 'node:path';
import { loadKeys, verifyAll } from './logs.js';
import { describe, errands, pairing, show } from './story.js';

const USAGE = 'usage: history [--dir <dir>] [--keys <keys.json>] [--json] verify | show <errand_id> | errands | pairing';

export function run(argv, out = console.log) {
  const opts = { dir: process.env.OPA_HISTORY_DIR || '.', keys: null, json: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir') opts.dir = argv[++i];
    else if (argv[i] === '--keys') opts.keys = argv[++i];
    else if (argv[i] === '--json') opts.json = true;
    else rest.push(argv[i]);
  }
  const [cmd, arg] = rest;
  const print = (rows, text) => out(opts.json ? JSON.stringify(rows, null, 2) : text(rows));
  switch (cmd) {
    case 'verify': {
      const r = verifyAll(opts.dir, loadKeys(opts.keys || path.join(opts.dir, 'keys.json')));
      print(r, (x) => Object.entries(x).map(([k, v]) => `${k.padEnd(13)} ${v.ok ? 'OK' : `BROKEN at line ${v.break.line}: ${v.break.reason}`} (${v.lines} lines)`
        + v.warnings.map((w) => `\n  warning: ${w}`).join('')).join('\n'));
      return Object.values(r).every((v) => v.ok) ? 0 : 1;
    }
    case 'show': {
      if (!arg) { out(USAGE); return 2; }
      const rows = show(opts.dir, arg);
      print(rows, (x) => (x.length ? x.map((r) => `${r.ts}  ${describe(r)}`).join('\n') : `no lines for errand ${arg}`));
      return rows.length ? 0 : 1;
    }
    case 'errands':
      print(errands(opts.dir), (x) => x.map((e) => `${e.errand_id}  ${e.started}  ${(e.channels.join(',') || '-').padEnd(10)} ${e.outcome}`).join('\n') || 'no errands');
      return 0;
    case 'pairing':
      print(pairing(opts.dir), (x) => x.map((r) => `${r.ts}  ${describe(r)}`).join('\n') || 'no pairing events');
      return 0;
    default:
      out(USAGE);
      return 2;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = run(process.argv.slice(2));
