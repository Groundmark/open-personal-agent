// router.toml: the small TOML subset the router needs. [a.b] tables, key = "string" | number | true/false,
// and # comments. Anything else is an error, so a typo fails at start instead of at the first call.
import fs from 'node:fs';

export function parseToml(text) {
  const root = {};
  let table = root;
  text.split('\n').forEach((raw, i) => {
    const line = raw.replace(/\s+#.*$|^\s*#.*$/, '').trim();
    if (!line) return;
    const head = /^\[([A-Za-z0-9_.-]+)\]$/.exec(line);
    if (head) {
      table = root;
      for (const k of head[1].split('.')) table = table[k] ??= {};
      return;
    }
    const kv = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (!kv) throw new Error(`router.toml line ${i + 1}: can't read "${raw.trim()}"`);
    table[kv[1]] = value(kv[2], i + 1);
  });
  return root;
}

function value(v, n) {
  if (/^"([^"\\]|\\.)*"$/.test(v)) return JSON.parse(v);
  if (v === 'true' || v === 'false') return v === 'true';
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  throw new Error(`router.toml line ${n}: unsupported value ${v}`);
}

/** Reads and checks router.toml. Returns { port, log, record, models: { <logical>: {...} } }. */
export function loadConfig(file) {
  const t = parseToml(fs.readFileSync(file, 'utf8'));
  const models = t.models || {};
  if (!Object.keys(models).length) throw new Error('router.toml: no [models.<name>] tables');
  for (const [name, m] of Object.entries(models)) {
    if (!['openai', 'replay'].includes(m.provider)) throw new Error(`router.toml: models.${name}.provider must be "openai" or "replay"`);
    if (m.provider === 'openai' && !(m.base_url && m.model && m.credential)) {
      throw new Error(`router.toml: models.${name} needs base_url, model and credential`);
    }
    if (m.provider === 'replay' && !m.file) throw new Error(`router.toml: models.${name} needs file`);
  }
  return { port: t.server?.port ?? 8411, log: t.server?.log ?? null, record: t.server?.record ?? null, models };
}
