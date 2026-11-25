#!/usr/bin/env node
// opa-channel-signal serve <signal.json>   run the adapter (and signal-cli as the account's only receiver)
// opa-channel-signal pair  <signal.json>   show a six-digit pairing code (15 minutes, once): text it to the agent
//
// signal.json: { "state_dir": "/var/lib/opa/signal", "account": "+15551234567", "signal_cli": "/opt/signal-cli/bin/signal-cli",
//                "signal_cli_config": "/var/lib/opa/signal/signal-cli", "core_socket": "/run/opa/core.sock",
//                "broker_socket": "/run/opa/broker-channel-signal.sock", "socket": "/run/opa/channel-signal.sock" }
import { readFileSync } from 'node:fs';
import { SignalChannel, newPairingCode, signalRpc } from './adapter.js';

const [cmd, file] = process.argv.slice(2);
if (!['serve', 'pair'].includes(cmd) || !file) { console.error('usage: opa-channel-signal serve|pair <signal.json>'); process.exit(2); }
const cfg = JSON.parse(readFileSync(file, 'utf8'));
if (cmd === 'pair') {
  console.log(`From your phone, send this to the agent's Signal number (${cfg.account}) within 15 minutes:\n\n    ${newPairingCode(cfg.state_dir)}\n`);
  process.exit(0);
}
const ch = new SignalChannel(cfg);
ch.attach(signalRpc(cfg.signal_cli, ['--config', cfg.signal_cli_config, '-a', cfg.account, '--trust-new-identities', 'always', 'jsonRpc'],
  (env) => ch.onEnvelope(env).catch((e) => console.error('signal:', e.message))));
const fromSystemd = Number(process.env.LISTEN_PID) === process.pid && Number(process.env.LISTEN_FDS) >= 1;
await ch.listen(fromSystemd ? { fd: 3 } : cfg.socket);
ch.watchSlots();
console.log(`signal channel: ${cfg.account}; ${ch.status().paired ? 'paired' : 'not paired yet (run pair)'}`);
