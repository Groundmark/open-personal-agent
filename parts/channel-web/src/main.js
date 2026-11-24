#!/usr/bin/env node
// opa-channel-web <web.json>
//   { "state_dir": "/var/lib/opa/web", "origins": ["https://chat.groundmark.fyi"], "rp_id": "groundmark.fyi",
//     "pinned_file": "/etc/opa/web-pinned.json", "core_socket": "/run/opa/core.sock", "port": 8081,
//     "approval_upstream": "http://127.0.0.1:8443", "socket": "/run/opa/channel-web.sock" }   // socket only without systemd
import { readFileSync } from 'node:fs';
import { WebChannel } from './server.js';

const cfg = JSON.parse(readFileSync(process.argv[2], 'utf8'));
cfg.pinned = JSON.parse(readFileSync(cfg.pinned_file, 'utf8'));
const ch = new WebChannel(cfg);
const fromSystemd = Number(process.env.LISTEN_PID) === process.pid && Number(process.env.LISTEN_FDS) >= 1;
await ch.listenSocket(fromSystemd ? { fd: 3 } : cfg.socket);
const port = await ch.listenHttp(cfg.port ?? 8081);
console.log(`web channel: page on 127.0.0.1:${port} for ${cfg.origins.join(', ')}; core's socket ${fromSystemd ? 'from systemd' : cfg.socket}; password sign-in ${ch.passwordOn ? (ch.hasPassword ? 'on (set)' : 'on (not set yet)') : 'off'}`);
