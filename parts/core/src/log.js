// conversation.jsonl (contracts/history.md): one line per message in or out, hash-chained, append-only.
// Lines are canonical JSON (sorted keys), so parts/history verifies the chain over their bytes.
import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, fsyncSync, openSync, readFileSync, truncateSync, writeFileSync, writeSync } from 'node:fs';

const canon = (v) => (v === null || typeof v !== 'object' ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(canon).join(',')}]`
  : `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`);

export class ConversationLog {
  #path; #seq = 0; #prev = '';
  constructor(path) {
    this.#path = path;
    let buf = existsSync(path) ? readFileSync(path) : Buffer.alloc(0);
    if (buf.length && buf.at(-1) !== 0x0a) buf = repairTail(path, buf);
    const lines = buf.toString('utf8').split('\n').filter(Boolean);
    if (lines.length) {
      let last;
      try { last = JSON.parse(lines.at(-1)); } catch { last = null; }
      if (!Number.isInteger(last?.seq)) throw new Error(`${path}: the last line isn't a log entry. Fix it by hand (\`history verify\` shows where) before starting`);
      this.#seq = last.seq + 1;
      this.#prev = createHash('sha256').update(lines.at(-1)).digest('hex');
    }
  }
  append(entry) {
    const line = canon({ seq: this.#seq, ts: new Date().toISOString(), errand_id: null, ...entry, prev_hash: this.#prev });
    const fd = openSync(this.#path, 'a', 0o600);
    try { writeSync(fd, line + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
    this.#seq += 1;
    this.#prev = createHash('sha256').update(line).digest('hex');
  }
}

/**
 * The file doesn't end in a newline: a write was interrupted (a crash or power cut). If the last line is a whole
 * entry that only lost its newline, the newline is added. Otherwise the cut-off bytes are copied aside, exactly,
 * to <path>.partial-<time>, and removed; complete lines are never touched. Returns the file's bytes after.
 */
function repairTail(path, buf) {
  const cut = buf.lastIndexOf(0x0a) + 1;
  const tail = buf.subarray(cut);
  let whole = null;
  try { whole = JSON.parse(tail.toString('utf8')); } catch {}
  if (Number.isInteger(whole?.seq)) {
    appendFileSync(path, '\n');
    console.error(`core: ${path}: the last line had lost its newline; added it`);
    return Buffer.concat([buf, Buffer.from('\n')]);
  }
  const aside = `${path}.partial-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  writeFileSync(aside, tail, { mode: 0o600, flag: 'wx' });   // if this fails, the log is left as it was
  truncateSync(path, cut);
  console.error(`core: ${path}: removed an interrupted last line (${tail.length} bytes, kept in ${aside})`);
  return buf.subarray(0, cut);
}
