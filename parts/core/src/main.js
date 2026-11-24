#!/usr/bin/env node
// opa-core <core.json>
//   { "state_dir": "/var/lib/opa/core", "router_url": "http://127.0.0.1:8411/infer", "broker_socket": "/run/opa/broker-core.sock",
//     "channels": { "web": "/run/opa/channel-web.sock" }, "services": { ... }, "timezone": "America/Los_Angeles",
//     "socket": "/run/opa/core.sock" }   // socket only when systemd doesn't hand it over
import { readFileSync } from 'node:fs';
import { Core } from './core.js';
import { serve } from './wire.js';

const cfg = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const core = new Core({ stateDir: cfg.state_dir, routerUrl: cfg.router_url, brokerSocket: cfg.broker_socket, channels: cfg.channels,
  services: cfg.services ?? {}, model: cfg.model ?? 'default', timezone: cfg.timezone ?? 'UTC' });
const fromSystemd = Number(process.env.LISTEN_PID) === process.pid && Number(process.env.LISTEN_FDS) >= 1;
if (fromSystemd) {
  await serve({ fd: 3 }, core.handlers());   // the socket systemd made, with its owner and mode
} else await serve(cfg.socket, core.handlers());
core.reconcile().catch((e) => console.error('core: reconcile failed:', e.message));
console.log(`core: channels ${Object.keys(cfg.channels).join(', ')}; places ${Object.keys(cfg.services ?? {}).join(', ') || 'none yet'}; model ${cfg.model ?? 'default'}`);
