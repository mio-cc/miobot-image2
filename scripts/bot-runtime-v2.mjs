#!/usr/bin/env node
// Bot v2 launcher: runs the NEW architecture (apps/bot runtime: model+AgentRuntime+reply)
// against Napcat, in PARALLEL with the legacy scripts/bot-runtime.mjs.
// Reads the same config.json (MIOBOT_CONFIG_PATH or .runtime/config.json).
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startBot } from '../dist/apps/bot/src/start.js';
import { createLogger, ConsoleLogSink, JsonFileLogSink } from '../dist/packages/logger/src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const runtimeDir = process.env.MIOBOT_RUNTIME_DIR || path.join(root, '.runtime');
const configFilePath = process.env.MIOBOT_CONFIG_PATH || path.join(runtimeDir, 'config.json');
const systemLogPath = process.env.MIOBOT_SYSTEM_LOG_PATH || path.join(runtimeDir, 'logs', 'system.ndjson');
// 指标文件：bot 进程写，web 进程（面板 /api/metrics）读同一个。
const metricsFilePath = process.env.MIOBOT_METRICS_PATH || path.join(runtimeDir, 'metrics.json');

// 确保日志目录存在
fs.mkdirSync(path.dirname(systemLogPath), { recursive: true });

const logger = createLogger({
  scope: 'bot-v2',
  level: 'info',
  sinks: [
    new ConsoleLogSink(),
    new JsonFileLogSink(systemLogPath),
  ],
});

console.log(`[bot-v2] starting with config: ${configFilePath}`);
console.log(`[bot-v2] system log: ${systemLogPath}`);
const bot = startBot({ configFilePath, logger, metricsFilePath, dataDir: runtimeDir });

async function shutdown() {
  try { await bot.stop(); } catch { /* ignore */ }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
