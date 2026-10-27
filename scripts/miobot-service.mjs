#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const enableBot = !['0', 'false', 'no'].includes(String(process.env.MIOBOT_ENABLE_BOT || '1').toLowerCase());

const children = [];

function start(name, script) {
  const child = spawn(process.execPath, [path.join(root, script)], {
    cwd: root,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => process.stdout.write(prefix(name, chunk)));
  child.stderr.on('data', (chunk) => process.stderr.write(prefix(name, chunk)));
  child.on('exit', (code, signal) => {
    console.error(`[${name}] exited code=${code ?? ''} signal=${signal ?? ''}`);
    shutdown(code || (signal ? 1 : 0));
  });
  children.push(child);
  return child;
}

function prefix(name, chunk) {
  return String(chunk)
    .split(/\r?\n/)
    .map((line, index, arr) => line || index === arr.length - 1 ? line : '')
    .filter((line, index, arr) => line || index < arr.length - 1)
    .map((line) => `[${name}] ${line}\n`)
    .join('');
}

let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(code), 800).unref();
}

process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));

// Bot runtime: 只保留 v2（apps/bot）。
// P1-D（R10 修复）：旧 scripts/bot-runtime.mjs 已随旧链路删除，不再保留 legacy 分支——
// 保留会形成指向不存在文件的坏回滚路径。设置 legacy 时明确报错退出。
const requestedBot = String(process.env.MIOBOT_BOT_RUNTIME || 'v2').toLowerCase();
if (requestedBot === 'legacy') {
  console.error('[service] MIOBOT_BOT_RUNTIME=legacy 不再受支持：旧 bot 运行时已移除。请使用 v2（默认）。');
  process.exit(2);
}
const botScript = 'scripts/bot-runtime-v2.mjs';

// Web runtime: defaults to the rebuilt v2 launcher (apps/admin + apps/canvas 装配式)。
// Set MIOBOT_WEB_RUNTIME=legacy to fall back to the old monolith scripts/local-verify-server.mjs.
const useLegacyWeb = String(process.env.MIOBOT_WEB_RUNTIME || 'v2').toLowerCase() === 'legacy';
const webScript = useLegacyWeb ? 'scripts/local-verify-server.mjs' : 'scripts/local-verify-server-v2.mjs';

console.log(`[service] starting web/admin/canvas(${useLegacyWeb ? 'legacy' : 'v2'})${enableBot ? ' + bot(v2)' : ''}`);
start('web', webScript);
if (enableBot) start('bot', botScript);
