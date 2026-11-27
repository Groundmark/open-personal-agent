// The fixture errand (fixtures/errand) through this router, replaying answers recorded from
// anthropic/claude-haiku-5.5 via OpenRouter. No network, no key. To re-record, run the router live
// with [server] record = "<file>" and OPA_ROUTER_URL set for `npm run errand` in fixtures/.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildAdapters, startServer } from '../src/server.js';

const fixtures = fileURLToPath(new URL('../../../fixtures/', import.meta.url));
const ready = fs.existsSync(fixtures + 'node_modules/ajv');

test('fixture errand passes with the real router (replayed Haiku 5.5)', { skip: !ready && 'run npm ci in fixtures/ first' }, async () => {
  const cfg = { port: 0, log: null, record: null, models: { default: { provider: 'replay', file: fileURLToPath(new URL('errand-haiku-5.5.jsonl', import.meta.url)) } } };
  const router = await startServer(cfg, buildAdapters(cfg));
  process.env.OPA_ROUTER_URL = router.url;
  try {
    const { runErrand } = await import(fixtures + 'errand/run.js');
    const r = await runErrand();
    assert.deepEqual(r.violations, []);
    assert.match(r.confirmation, /^FT-[A-F0-9]{6}$/);
    assert.ok(Object.values(r.verify).every((v) => v.ok));
    assert.match(r.outbox.at(-1).text, /confirm/i);
  } finally {
    delete process.env.OPA_ROUTER_URL;
    await router.close();
  }
});
