// Validate fixture traffic against the contract schemas in contracts/schemas/.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'contracts', 'schemas');
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
  ajv.addSchema(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')), f);
}

/** validate('broker.schema.json', 'grant.request.args', data) -> [] or list of error strings */
export function validate(file, def, data) {
  const v = ajv.getSchema(`${file}#/$defs/${def}`);
  if (!v) throw new Error(`no schema ${file}#/$defs/${def}`);
  return v(data) ? [] : v.errors.map((e) => `${e.instancePath || '/'} ${e.message}`);
}

export function validateEnvelope(kind, data) {
  return validate('envelope.schema.json', kind, data);
}
