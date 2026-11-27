#!/usr/bin/env node
// opa-channel-web <web.json>
//   { "state_dir": "/var/lib/opa/web", "origins": ["https://chat.groundmark.fyi"], "rp_id": "groundmark.fyi",
//     "pinned_file": "/etc/opa/web-pinned.json", "core_socket": "/run/opa/core.sock", "port": 8081,
//     "approval_upstream": "http://127.0.0.1:8443", "socket": "/run/opa/channel-web.sock",   // socket only without systemd
//     "broker_socket": "/run/opa/broker-channel-web.sock" }   // optional: one-time codes typed in the chat go to the broker
import { readFileSync } from 'node:fs';
import { WebChannel } from './server.js';

const cfg = JSON.parse(readFileSync(process.argv[2], 'utf8'));
cfg.pinned = JSON.parse(readFileSync(cfg.pinned_file, 'utf8'));
const ch = new WebChannel(cfg);
const fromSystemd = Number(process.env.LISTEN_PID) === process.pid && Number(process.env.LISTEN_FDS) >= 1;
if (!fromSystemd && !cfg.socket) { console.error('web: no socket for the core: set "socket" in the config, or run under systemd'); process.exit(2); }
await ch.listenSocket(fromSystemd ? { fd: 3 } : cfg.socket);
const port = await ch.listenHttp(cfg.port ?? 8081);
ch.watchSlots().catch((e) => console.error(`web: code slots: ${e.message}`));
console.log(`web channel: page on 127.0.0.1:${port} for ${cfg.origins.join(', ')}; core's socket ${fromSystemd ? 'from systemd' : cfg.socket}; password sign-in ${ch.passwordOn ? (ch.hasPassword ? 'on (set)' : 'on (not set yet)') : 'off'}; one-time codes ${cfg.broker_socket ? 'to the broker' : 'off (no broker_socket)'}`);
