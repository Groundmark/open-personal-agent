#!/usr/bin/env node
// node src/main.js [path/to/router.toml]
import { loadConfig } from './config.js';
import { startServer } from './server.js';

const config = loadConfig(process.argv[2] || 'router.toml');
const { url } = await startServer(config);
console.log(`router: ${url} (${Object.keys(config.models).join(', ')})${config.record ? `, recording to ${config.record}` : ''}`);
