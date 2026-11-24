#!/usr/bin/env node
// opa-broker serve  <broker.json>   run the broker: its sockets, the approval page, the expiry sweep
// opa-broker enroll <broker.json>   print a one-time link (and QR code) to set up the person's passkey
//
// broker.json:
//   { "state_dir": "/var/lib/opa/broker", "operator": "agent.groundmark.fyi",
//     "approval": { "origins": ["https://approve.groundmark.fyi"], "rp_id": "groundmark.fyi", "port": 8443 },
//     "sockets": [{ "caller": "core", "path": "/run/opa/broker-core.sock" }],   // only when systemd doesn't hand them over
//     "core_socket": "/run/opa/core.sock", "pending_seconds": 1800, "agent_keyid": "agent.groundmark.fyi#k1",
//     "web_services": { "table": { "credential": "table.groundmark.fyi", "base_url": "https://table.groundmark.fyi",
//        "tools": { "find_tables": { "op": "search", "method": "GET", "path": "/api/availability" }, "book_table": { "op": "book", "method": "POST", "path": "/api/bookings" } } } } }
import { readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import qrcode from 'qrcode-generator';
import { Broker } from './broker.js';
import { ulid } from './grants.js';
import { listen, systemdSockets } from './sockets.js';
import { PasskeyApproval, openEnrollment } from '../approval/server.js';
import { webServices } from './groundmark-http.js';
import { AgentAccessStore } from './agent-access-store.js';
import { BitwardenStore, CombinedStore, bwUnlock } from './bw-store.js';

const [cmd, file] = process.argv.slice(2);
if (!['serve', 'enroll'].includes(cmd) || !file) { console.error('usage: opa-broker serve|enroll <broker.json>'); process.exit(2); }
const cfg = JSON.parse(readFileSync(file, 'utf8'));

if (cmd === 'enroll') {
  const url = `${cfg.approval.origins[0]}/enroll/${openEnrollment(cfg.state_dir)}`;
  console.log(`Open this on the phone or computer you'll approve with (valid 15 minutes, one passkey):\n\n${url}\n`);
  if (process.stdout.isTTY) console.log(qrTerminal(url));   // only where a terminal can draw it
  process.exit(0);
}

/** Tells the core a grant was approved, denied or expired (contracts/core.md, grant.event). */
function tellCore(grant_id, state, errand_id) {
  if (!cfg.core_socket || !['approved', 'denied', 'expired'].includes(state)) return;
  const req = { op: 'grant.event', id: ulid(), caller: 'broker', errand_id: errand_id ?? null, ts: new Date().toISOString(), args: { grant_id, state } };
  const c = createConnection(cfg.core_socket, () => c.end(JSON.stringify(req) + '\n'));
  c.on('error', (e) => console.error(`broker: could not tell the core about ${grant_id} (${state}): ${e.code}`));
  c.on('data', () => {});
}

const approval = new PasskeyApproval({ stateDir: cfg.state_dir, origins: cfg.approval.origins, rpId: cfg.approval.rp_id, port: cfg.approval.port ?? 8443 });
// The store: login-free web services (broker.json "web_services": the "credential" is the service's name, with no
// secret behind it) plus at most one vault ("vault"):
//   { "type": "bitwarden", "bw": "/opt/opa/bw/node_modules/.bin/bw", "app_data_dir": "/var/lib/opa/broker/bw",
//     "server_url": "https://vault.example", "collection_id": "<uuid>" }   (credential files bw-client-id, bw-client-secret,
//     bw-password in $CREDENTIALS_DIRECTORY, from systemd LoadCredential=)
//   { "type": "agent-access", "aac": "/usr/local/bin/aac", "session": "<fingerprint>", "state_home": "/var/lib/opa/broker/aac" }
const services = cfg.web_services ?? {};
let vault = null;
if (cfg.vault?.type === 'bitwarden') {
  const cred = (n) => `${process.env.CREDENTIALS_DIRECTORY}/${n}`;
  const session = await bwUnlock({ bw: cfg.vault.bw, appDataDir: cfg.vault.app_data_dir, serverUrl: cfg.vault.server_url, caFile: cfg.vault.ca_file,
    clientIdFile: cred('bw-client-id'), clientSecretFile: cred('bw-client-secret'), passwordFile: cred('bw-password') });
  vault = new BitwardenStore({ bw: cfg.vault.bw, appDataDir: cfg.vault.app_data_dir, collectionId: cfg.vault.collection_id, session, caFile: cfg.vault.ca_file });
} else if (cfg.vault?.type === 'agent-access') {
  vault = new AgentAccessStore({ aacPath: cfg.vault.aac, session: cfg.vault.session, stateHome: cfg.vault.state_home });
}
const store = new CombinedStore({ services, vault });
const broker = new Broker({ stateDir: cfg.state_dir, store, approvals: approval, operator: cfg.operator, pendingSeconds: cfg.pending_seconds ?? 1800, onGrantEvent: tellCore });
// Requests to them are signed as the agent (Groundmark): keyid is the agent's domain and the key's kid in its _agentid record.
broker.mcp = webServices(services, { key: broker.agentKey.privateKey, keyid: cfg.agent_keyid });
await approval.open(broker);
const sockets = systemdSockets();
await listen(broker, sockets.length ? sockets : cfg.sockets ?? []);
setInterval(() => broker.sweep().catch((e) => console.error('broker: sweep failed:', e.message)), 30_000).unref();
console.log(`broker: agent ${broker.agentKey.kid}, broker ${broker.brokerKey.kid}; sockets ${(sockets.length ? sockets : cfg.sockets ?? []).map((s) => s.caller).join(', ') || 'none'}; `
  + `approval page on 127.0.0.1:${approval.port} for ${cfg.approval.origins.join(', ')}; ${approval.passkeys.length} passkey(s) set up`);

function qrTerminal(text) {
  const qr = qrcode(0, 'M'); qr.addData(text); qr.make();
  const n = qr.getModuleCount(), dark = (r, c) => r >= 0 && c >= 0 && r < n && c < n && qr.isDark(r, c), out = [];
  for (let r = -2; r < n + 2; r += 2) {
    let line = '';
    for (let c = -2; c < n + 2; c++) line += `\x1b[${dark(r, c) ? 30 : 97};${dark(r + 1, c) ? 40 : 107}m▀`;
    out.push(line + '\x1b[0m');
  }
  return out.join('\n');
}
