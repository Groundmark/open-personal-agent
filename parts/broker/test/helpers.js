import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'broker-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A test-only fake secret, made fresh for each run. Never a real credential.
export function fakeSecret() {
  return {
    clientId: `test-only-fake-id-${randomBytes(8).toString('hex')}`,
    clientSecret: `test-only-fake-secret-${randomBytes(24).toString('hex')}`,
  };
}
