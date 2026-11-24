// conversation.jsonl (contracts/history.md): one line per message in or out, hash-chained, append-only.
// Lines are canonical JSON (sorted keys), so parts/history verifies the chain over their bytes.
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeSync } from 'node:fs';

const canon = (v) => (v === null || typeof v !== 'object' ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(canon).join(',')}]`
  : `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`);

export class ConversationLog {
  #path; #seq = 0; #prev = '';
  constructor(path) {
    this.#path = path;
    const lines = existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean) : [];
    if (lines.length) { this.#seq = JSON.parse(lines.at(-1)).seq + 1; this.#prev = createHash('sha256').update(lines.at(-1)).digest('hex'); }
  }
  append(entry) {
    const line = canon({ seq: this.#seq, ts: new Date().toISOString(), errand_id: null, ...entry, prev_hash: this.#prev });
    const fd = openSync(this.#path, 'a', 0o600);
    try { writeSync(fd, line + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
    this.#seq += 1;
    this.#prev = createHash('sha256').update(line).digest('hex');
  }
}
