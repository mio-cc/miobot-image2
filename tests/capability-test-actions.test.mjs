import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CapabilityTestActionConsumer } from '../dist/apps/bot/src/capability-test-actions.js';

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

test('capability test queue: consumes action and persists result', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miobot-cap-test-'));
  const actionFile = path.join(dir, 'actions.jsonl');
  const resultFile = path.join(dir, 'results.json');
  const processedFile = path.join(dir, 'done.json');
  fs.writeFileSync(actionFile, JSON.stringify({ id: 'ct1', capability: 'file.generate', mode: 'validate', args: {}, createdAt: new Date().toISOString() }) + '\n');
  let calls = 0;
  const consumer = new CapabilityTestActionConsumer({
    actionFile, resultFile, processedFile, intervalMs: 100,
    async onAction(action) {
      calls += 1;
      return { ok: true, capability: action.capability, mode: action.mode, stage: 'complete', durationMs: 1, handlerRegistered: true, result: { status: 'success', outputs: [] } };
    },
  });
  await consumer.start();
  for (let i = 0; i < 30 && !fs.existsSync(resultFile); i += 1) await sleep(50);
  consumer.stop();
  const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].id, 'ct1');
  assert.equal(result.results[0].ok, true);
  assert.equal(calls, 1);
});