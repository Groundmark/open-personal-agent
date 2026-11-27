// router.toml: the small TOML subset the router needs. [a.b] tables, key = "string" | number | true/false,
// and # comments. Anything else is an error, so a typo fails at start instead of at the first call.
import fs from 'node:fs';

/** The line without its comment: from the first # that isn't inside a "..." string. */
function stripComment(line) {
  let inStr = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inStr && ch === '\\') i++;
    else if (ch === '"') inStr = !inStr;
    else if (ch === '#' && !inStr) return line.slice(0, i);
  }
  return line;
}

export function parseToml(text) {
  const root = Object.create(null);   // no prototype, so a table named __proto__ is just a name
  const seen = new Set();
  let table = root;
  text.split('\n').forEach((raw, i) => {
    const n = i + 1;
    const line = stripComment(raw).trim();
    if (!line) return;
    const head = /^\[([A-Za-z0-9_.-]+)\]$/.exec(line);
    if (head) {
      if (seen.has(head[1])) throw new Error(`router.toml line ${n}: [${head[1]}] appears twice`);
      seen.add(head[1]);
      table = root;
      for (const k of head[1].split('.')) {
        if (!(k in table)) table[k] = Object.create(null);
        else if (typeof table[k] !== 'object') throw new Error(`router.toml line ${n}: ${k} is already a value, not a table`);
        table = table[k];
      }
      return;
    }
    const kv = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (!kv) throw new Error(`router.toml line ${n}: can't read "${raw.trim()}"`);
    if (kv[1] in table) throw new Error(`router.toml line ${n}: ${kv[1]} is set twice`);
    table[kv[1]] = value(kv[2], n);
  });
  return root;
}

function value(v, n) {
  if (/^"([^"\\]|\\.)*"$/.test(v)) return JSON.parse(v);
  if (v === 'true' || v === 'false') return v === 'true';
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  throw new Error(`router.toml line ${n}: unsupported value ${v}`);
}

const positiveInt = (v) => Number.isInteger(v) && v > 0;

/** Reads and checks router.toml. Returns { port, log, record, models: { <logical>: {...} } }. */
export function loadConfig(file) {
  const t = parseToml(fs.readFileSync(file, 'utf8'));
  const models = t.models || Object.create(null);
  if (!Object.keys(models).length) throw new Error('router.toml: no [models.<name>] tables');
  // A misspelt setting is an error, not a default quietly applied.
  const only = (where, obj, keys) => {
    for (const k of Object.keys(obj)) if (!keys.includes(k)) throw new Error(`router.toml: ${where}${k} isn't a setting here (known: ${keys.join(', ')})`);
  };
  only('', t, ['server', 'models']);
  if (t.server !== undefined) { if (typeof t.server !== 'object') throw new Error('router.toml: server must be a table'); only('server.', t.server, ['port', 'log', 'record']); }
  for (const [name, m] of Object.entries(models)) {
    if (typeof m !== 'object') throw new Error(`router.toml: models.${name} must be a table`);
    if (!['openai', 'replay'].includes(m.provider)) throw new Error(`router.toml: models.${name}.provider must be "openai" or "replay"`);
    only(`models.${name}.`, m, m.provider === 'openai' ? ['provider', 'base_url', 'model', 'credential', 'max_tokens', 'timeout_s'] : ['provider', 'file']);
    if (m.provider === 'openai' && !(m.base_url && m.model && m.credential)) {
      throw new Error(`router.toml: models.${name} needs base_url, model and credential`);
    }
    if (m.provider === 'replay' && !m.file) throw new Error(`router.toml: models.${name} needs file`);
    for (const k of ['max_tokens', 'timeout_s']) {
      if (m[k] !== undefined && !positiveInt(m[k])) throw new Error(`router.toml: models.${name}.${k} must be a positive whole number`);
    }
  }
  return { port: t.server?.port ?? 8411, log: t.server?.log ?? null, record: t.server?.record ?? null, models };
}
