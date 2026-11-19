import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { writeAtomic } from '../src/fsutil.js';
import { tempDir } from './helpers.js';

test('writeAtomic writes the whole file, mode 0600', (t) => {
  const p = join(tempDir(t), 'f.json');
  writeAtomic(p, '{"a":1}\n');
  assert.equal(readFileSync(p, 'utf8'), '{"a":1}\n');
  assert.equal(statSync(p).mode & 0o777, 0o600);
});

test('passkeys module loads', async () => {
  const m = await import('../approval/passkeys.js');
  assert.ok(m.PasskeyStore);
});
