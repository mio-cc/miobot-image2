import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryActionConsumer } from '../dist/apps/bot/src/memory-actions.js';

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

test('memory actions: action is consumed and result is persisted', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miobot-memory-action-'));
  const actionFile = path.join(dir, 'actions.jsonl');
  const resultFile = path.join(dir, 'results.json');
  const processedFile = path.join(dir, 'done.json');
  fs.writeFileSync(actionFile, JSON.stringify({ id: 'm1', type: 'list', createdAt: new Date().toISOString() }) + '\n');
  let calls = 0;
  const consumer = new MemoryActionConsumer({
    actionFile, resultFile, processedFile, intervalMs: 100,
    async onAction(action) {
      calls += 1;
      return { ok: true, namespaces: [{ kind: 'group', count: 1, type: action.type }] };
    },
  });
  await consumer.start();
  for (let i = 0; i < 30 && !fs.existsSync(resultFile); i += 1) await sleep(50);
  consumer.stop();
  const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].id, 'm1');
  assert.equal(result.results[0].ok, true);
  assert.equal(calls, 1);
});
test('memory actions: restart does not replay historical actions after old processed file migration', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miobot-memory-action-replay-'));
  const actionFile = path.join(dir, 'actions.jsonl');
  const resultFile = path.join(dir, 'results.json');
  const processedFile = path.join(dir, 'done.json');
  fs.writeFileSync(actionFile,
    JSON.stringify({ id: 'old', type: 'list', createdAt: new Date().toISOString() }) + '\n' +
    JSON.stringify({ id: 'new', type: 'list', createdAt: new Date().toISOString() }) + '\n');
  fs.writeFileSync(processedFile, JSON.stringify({ ids: ['old'] }));
  let calls = [];
  const consumer = new MemoryActionConsumer({
    actionFile, resultFile, processedFile, intervalMs: 100,
    async onAction(action) { calls.push(action.id); return { ok: true }; },
  });
  await consumer.start();
  for (let i = 0; i < 30 && calls.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  consumer.stop();
  assert.deepEqual(calls, ['new']);
  const cursor = JSON.parse(fs.readFileSync(processedFile, 'utf8'));
  assert.ok(cursor.offset > 0);
});
