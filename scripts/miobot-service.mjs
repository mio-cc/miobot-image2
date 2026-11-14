#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const enableBot = !['0', 'false', 'no'].includes(String(process.env.MIOBOT_ENABLE_BOT || '1').toLowerCase());
const botRestartMax = Math.max(0, Number(process.env.MIOBOT_BOT_RESTART_MAX ?? 20) || 0);
const botRestartBaseMs = Math.max(1000, Number(process.env.MIOBOT_BOT_RESTART_DELAY_MS || 5000) || 5000);
const botRestartMaxMs = Math.max(botRestartBaseMs, Number(process.env.MIOBOT_BOT_RESTART_MAX_DELAY_MS || 60000) || 60000);

const children = new Set();
let shuttingDown = false;
let botRestartTimer = null;
let botStableTimer = null;
let botRestarts = 0;

function start(name, script) {
  const child = spawn(process.execPath, [path.join(root, script)], {
    cwd: root,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  child.stdout.on('data', (chunk) => process.stdout.write(prefix(name, chunk)));
  child.stderr.on('data', (chunk) => process.stderr.write(prefix(name, chunk)));
  child.on('exit', (code, signal) => {
    children.delete(child);
    console.error(`[${name}] exited code=${code ?? ''} signal=${signal ?? ''}`);
    if (shuttingDown) return;
    if (name === 'web') {
      // Web/admin/canvas is the control plane. If it dies, restart the whole service.
      shutdown(code || (signal ? 1 : 0));
      return;
    }
    if (name === 'bot') {
      if (botRestartMax > 0 && botRestarts >= botRestartMax) {
        console.error(`[service] bot restart limit reached (${botRestartMax}); web/admin/canvas remains available`);
        return;
      }
      botRestarts += 1;
      const delay = Math.min(botRestartMaxMs, botRestartBaseMs * Math.pow(2, Math.min(6, botRestarts - 1)));
      console.error(`[service] bot will restart in ${delay}ms (attempt ${botRestarts}${botRestartMax ? '/' + botRestartMax : ''}); web stays up`);
      botRestartTimer = setTimeout(() => {
        botRestartTimer = null;
        if (!shuttingDown) start('bot', botScript);
      }, delay);
      botRestartTimer.unref?.();
    }
  });
  if (name === 'bot') {
    if (botStableTimer) clearTimeout(botStableTimer);
    botStableTimer = setTimeout(() => {
      botRestarts = 0;
      botStableTimer = null;
    }, 60000);
    botStableTimer.unref?.();
  }
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

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (botRestartTimer) { clearTimeout(botRestartTimer); botRestartTimer = null; }
  if (botStableTimer) { clearTimeout(botStableTimer); botStableTimer = null; }
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(code), 800).unref();
}

process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));

// Bot runtime: only v2 (apps/bot). Legacy is rejected so a bad rollback cannot point at a deleted file.
const requestedBot = String(process.env.MIOBOT_BOT_RUNTIME || 'v2').toLowerCase();
if (requestedBot === 'legacy') {
  console.error('[service] MIOBOT_BOT_RUNTIME=legacy is no longer supported; use v2 (default).');
  process.exit(2);
}
const botScript = 'scripts/bot-runtime-v2.mjs';

// Web runtime: defaults to the rebuilt v2 launcher (apps/admin + apps/canvas).
const useLegacyWeb = String(process.env.MIOBOT_WEB_RUNTIME || 'v2').toLowerCase() === 'legacy';
const webScript = useLegacyWeb ? 'scripts/local-verify-server.mjs' : 'scripts/local-verify-server-v2.mjs';

console.log(`[service] starting web/admin/canvas(${useLegacyWeb ? 'legacy' : 'v2'})${enableBot ? ' + bot(v2)' : ''}`);
start('web', webScript);
if (enableBot) start('bot', botScript);
