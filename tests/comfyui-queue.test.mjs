import test from 'node:test';
import assert from 'node:assert/strict';

import { runInComfyUiQueue, resetComfyUiQueuesForTest } from '../dist/apps/bot/src/main.js';
import { normalizeConfig } from '../dist/packages/config/src/index.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('comfyui queue: serializes multiple tasks and keeps FIFO order', async () => {
  const key = `serial-${Date.now()}-${Math.random()}`;
  let active = 0;
  let maxActive = 0;
  const order = [];
  const task = (id) => runInComfyUiQueue(key, { maxConcurrent: 1, maxQueue: 4, queueTimeoutMs: 2000 }, async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    order.push(id);
    await wait(30);
    active -= 1;
    return id;
  });
  const result = await Promise.all([task('a'), task('b'), task('c')]);
  assert.deepEqual(result, ['a', 'b', 'c']);
  assert.deepEqual(order, ['a', 'b', 'c']);
  assert.equal(maxActive, 1);
  resetComfyUiQueuesForTest();
});

test('comfyui queue: full queue is rejected instead of stacking forever', async () => {
  const key = `full-${Date.now()}-${Math.random()}`;
  let release;
  const first = runInComfyUiQueue(key, { maxConcurrent: 1, maxQueue: 1, queueTimeoutMs: 2000 }, () => new Promise((resolve) => {
    release = () => resolve('first');
  }));
  const second = runInComfyUiQueue(key, { maxConcurrent: 1, maxQueue: 1, queueTimeoutMs: 2000 }, async () => 'second');
  await assert.rejects(() => runInComfyUiQueue(key, { maxConcurrent: 1, maxQueue: 1, queueTimeoutMs: 2000 }, async () => 'third'), /排队任务过多/);
  release();
  assert.equal(await first, 'first');
  assert.equal(await second, 'second');
  resetComfyUiQueuesForTest();
});

test('comfyui config: queue defaults are persisted', () => {
  const cfg = normalizeConfig({
    llm: {
      apiKeys: [{
        name: 'Comfy', baseUrl: 'http://comfy:8188', key: '', kind: 'comfyui', models: [], modelsFetchedAt: '', concurrency: 1,
        comfyui: { profiles: [], pollTimeoutMs: 120000, pollIntervalMs: 1000, maxBatchSize: 4 },
      }],
    },
  });
  const node = cfg.llm.apiKeys[0].comfyui;
  assert.equal(node?.maxConcurrent, 1);
  assert.equal(node?.maxQueue, 10);
  assert.ok((node?.queueTimeoutMs || 0) >= 10000);
});
