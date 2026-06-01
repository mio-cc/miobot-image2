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

console.log(`[service] starting web/admin/canvas${enableBot ? ' + bot' : ''}`);
start('web', 'scripts/local-verify-server.mjs');
if (enableBot) start('bot', 'scripts/bot-runtime.mjs');
