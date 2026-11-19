import { openSync, writeSync, fsyncSync, closeSync, renameSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';


// Temp file beside the target, fsync, rename over it, fsync the directory.
// A crash before the rename leaves the old file; after it, the new one.
export function writeAtomic(path, text, beforeRename) {
  const tmp = `${path}.tmp-${process.pid}`;
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    beforeRename?.(tmp);
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch {}
    throw err;
  }
  const dfd = openSync(dirname(path), 'r');
  try { fsyncSync(dfd); } finally { closeSync(dfd); }
}
