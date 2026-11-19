// 运行期队列快照 + 队列类别并发 + 三级功能并发（2026-11-19）
import test from 'node:test';
import assert from 'node:assert/strict';
import { sampleRuntimeQueues, writeRuntimeQueuesSnapshot } from '../dist/apps/bot/src/runtime-queues-snapshot.js';
import { FeatureGate, FeatureLimitError } from '../dist/apps/bot/src/feature-gate.js';
import { createDefaultConfig } from '../dist/packages/config/src/index.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('快照：采样失败不抛错，只记 warning', () => {
  const snapshot = sampleRuntimeQueues({
    agentTurns: () => [{ key: 'agent.turn', running: 2, queued: 1, limit: 4 }],
    toolQueues: () => { throw new Error('boom'); },
    outbound: () => [],
    agentSessions: () => 3,
    toolJobs: () => ({ queued: 1, running: 2, total: 10 }),
    comfyui: () => [{ key: 'https://comfy', running: 1, queued: 2, limit: 1 }],
  });
  assert.equal(snapshot.agentTurns[0].running, 2);
  assert.deepEqual(snapshot.toolQueues, []);
  assert.equal(snapshot.agentSessions.inFlight, 3);
  assert.equal(snapshot.comfyui[0].queued, 2);
  assert.equal(snapshot.warnings?.length, 1);
});

test('快照：原子写，读回来是完整 JSON', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miobot-queues-'));
  const file = path.join(dir, 'runtime-queues.json');
  const snapshot = sampleRuntimeQueues({
    agentTurns: () => [{ key: 'agent.turn', running: 0, queued: 0, limit: 4 }],
    toolQueues: () => [],
    outbound: () => [{ key: 'group:1', running: 1, queued: 2, limit: 1 }],
    agentSessions: () => 0,
    toolJobs: () => ({ queued: 0, running: 0, total: 0 }),
  });
  writeRuntimeQueuesSnapshot(file, snapshot);
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(parsed.version, 1);
  assert.equal(parsed.outbound[0].queued, 2);
  assert.equal(fs.existsSync(file + '.tmp'), false, '临时文件必须被 rename 掉');
  fs.rmSync(dir, { recursive: true, force: true });
});

function gateConfig(limits) {
  const cfg = createDefaultConfig();
  cfg.bot.features['image.generate'] = {
    ...cfg.bot.features['image.generate'],
    enabled: true,
    limits: { ...cfg.bot.features['image.generate'].limits, ...limits },
  };
  return cfg;
}

test('功能并发：每群上限独立生效', async () => {
  const cfg = gateConfig({ concurrency: 0, concurrencyPerGroup: 1 });
  const gate = new FeatureGate({ getConfig: () => cfg });
  const releaseA = await gate.acquire({ featureId: 'image.generate', chatType: 'group', groupId: '111', userId: 'u1' });
  // 同一群第二个人必须等到名额释放
  let acquired = false;
  const pending = gate.acquire({ featureId: 'image.generate', chatType: 'group', groupId: '111', userId: 'u2' })
    .then((release) => { acquired = true; return release; });
  await sleep(30);
  assert.equal(acquired, false, '同群第二个请求应排队');
  releaseA();
  const releaseB = await pending;
  assert.equal(acquired, true);
  releaseB();
});

test('功能并发：不同群互不影响', async () => {
  const cfg = gateConfig({ concurrency: 0, concurrencyPerGroup: 1 });
  const gate = new FeatureGate({ getConfig: () => cfg });
  const r1 = await gate.acquire({ featureId: 'image.generate', chatType: 'group', groupId: '111', userId: 'u1' });
  const r2 = await gate.acquire({ featureId: 'image.generate', chatType: 'group', groupId: '222', userId: 'u2' });
  assert.ok(r1 && r2, '不同群应各自拿到名额');
  r1(); r2();
});

test('功能并发：每用户上限跨群也生效', async () => {
  const cfg = gateConfig({ concurrency: 0, concurrencyPerUser: 1 });
  const gate = new FeatureGate({ getConfig: () => cfg });
  const r1 = await gate.acquire({ featureId: 'image.generate', chatType: 'group', groupId: '111', userId: 'same' });
  let acquired = false;
  const pending = gate.acquire({ featureId: 'image.generate', chatType: 'group', groupId: '222', userId: 'same' })
    .then((release) => { acquired = true; return release; });
  await sleep(30);
  assert.equal(acquired, false, '同一用户换群也应被每用户上限挡住');
  r1();
  const r2 = await pending;
  assert.equal(acquired, true);
  r2();
});

test('功能并发：全局上限仍然有效（回归）', async () => {
  const cfg = gateConfig({ concurrency: 1, concurrencyPerGroup: 0 });
  const gate = new FeatureGate({ getConfig: () => cfg });
  const r1 = await gate.acquire({ featureId: 'image.generate', chatType: 'group', groupId: '111', userId: 'u1' });
  let acquired = false;
  const pending = gate.acquire({ featureId: 'image.generate', chatType: 'group', groupId: '222', userId: 'u2' })
    .then((release) => { acquired = true; return release; });
  await sleep(30);
  assert.equal(acquired, false);
  r1();
  const r2 = await pending;
  r2();
});

test('功能并发：释放幂等，重复调用不会把名额算多', async () => {
  const cfg = gateConfig({ concurrency: 1 });
  const gate = new FeatureGate({ getConfig: () => cfg });
  const r1 = await gate.acquire({ featureId: 'image.generate', chatType: 'group', groupId: '111', userId: 'u1' });
  r1(); r1(); r1();
  const r2 = await gate.acquire({ featureId: 'image.generate', chatType: 'group', groupId: '111', userId: 'u1' });
  assert.ok(r2);
  r2();
});