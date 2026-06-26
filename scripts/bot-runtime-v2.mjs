#!/usr/bin/env node
// Bot v2 launcher: runs the NEW architecture (apps/bot runtime: model+bot-engine+reply)
// against Napcat, in PARALLEL with the legacy scripts/bot-runtime.mjs.
// Reads the same config.json (MIOBOT_CONFIG_PATH or .runtime/config.json).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startBot } from '../dist/apps/bot/src/start.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const configFilePath = process.env.MIOBOT_CONFIG_PATH || path.join(root, '.runtime', 'config.json');

console.log(`[bot-v2] starting with config: ${configFilePath}`);
const bot = startBot({ configFilePath });

function shutdown() {
  try { bot.stop(); } catch { /* ignore */ }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
