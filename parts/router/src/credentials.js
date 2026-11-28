// Provider keys. Under systemd, `LoadCredential=inference-openrouter:/path` puts the key in a file in
// $CREDENTIALS_DIRECTORY that only this service can read; the key is never in the environment,
// the config or a log. (The contract says the key comes "through CredentialStore", which today is
// internal to the broker; this file is the stand-in until that's settled.)
import fs from 'node:fs';
import path from 'node:path';
import { RouterError } from './errors.js';

export function credentialReader(dir = process.env.CREDENTIALS_DIRECTORY) {
  const cache = new Map();
  return (name) => {
    if (!/^[a-z0-9-]+$/.test(name)) throw new RouterError('credential_unavailable', `bad credential name ${name}`);
    if (!cache.has(name)) {
      if (!dir) throw new RouterError('credential_unavailable', 'no CREDENTIALS_DIRECTORY');
      let v;
      try { v = fs.readFileSync(path.join(dir, name), 'utf8').trim(); } catch { v = ''; }
      if (!v) throw new RouterError('credential_unavailable', `credential ${name} not found`);
      cache.set(name, v);
    }
    return cache.get(name);
  };
}
