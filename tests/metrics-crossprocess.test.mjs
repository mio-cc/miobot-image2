import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createMetrics, createFileMetricsStore } from '../dist/packages/core/src/metrics.js';
import { createAdminService } from '../dist/packages/admin-service/src/index.js';

/**
 * 指标跨进程。
 * 消息流在 bot 进程，面板在 web 进程，两边只能靠一个文件交换数据。
 * 之前 /api/metrics 一个生产者都没有，总览页四张卡和 24 小时图永远是 0。
 */

function tempMetricsFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miobot-metrics-'));
  return path.join(dir, 'metrics.json');
}

test('bot 侧写、web 侧读：同一个文件对得上', () => {
  const file = tempMetricsFile();

  // bot 进程
  const producer = createMetrics({ store: createFileMetricsStore(file), flushDebounceMs: 0 });
  producer.record('message', 3);
  producer.record('image', 2);
  producer.recordDuration('image', 4000);
  producer.flush();

  assert.ok(fs.existsSync(file), '应当落盘');

  // web 进程
  const reader = createMetrics({ store: createFileMetricsStore(file) });
  const snap = reader.snapshot();
  assert.equal(snap.totals.message, 3);
  assert.equal(snap.totals.image, 2);
  assert.equal(snap.averages.image, 4000);
});

test('reload 之后能看到 bot 后来写入的数据（否则面板永远停在启动那一刻）', () => {
  const file = tempMetricsFile();
  const producer = createMetrics({ store: createFileMetricsStore(file), flushDebounceMs: 0 });
  const reader = createMetrics({ store: createFileMetricsStore(file) });

  producer.record('chat', 1);
  producer.flush();
  assert.equal(reader.snapshot().totals.chat, 1);

  // bot 又处理了几条消息
  producer.record('chat', 5);
  producer.flush();

  assert.equal(reader.snapshot().totals.chat, 1, '没 reload 前读的是缓存');
  reader.reload();
  assert.equal(reader.snapshot().totals.chat, 6, 'reload 后必须看到新数据');
});

test('GET /api/metrics 每次都重读文件', async () => {
  const file = tempMetricsFile();
  const producer = createMetrics({ store: createFileMetricsStore(file), flushDebounceMs: 0 });
  const service = createAdminService({
    initialConfig: { panel: { passwordSeed: 'pw' } },
    metrics: createMetrics({ store: createFileMetricsStore(file) }),
  });
  const auth = { authorization: `Bearer ${service.repository.getAuthSnapshot().token}` };

  producer.record('image', 1);
  producer.flush();
  let res = await service.handle({ method: 'GET', path: '/api/metrics', headers: auth });
  assert.equal(res.body.totals.image, 1);

  producer.record('image', 9);
  producer.flush();
  res = await service.handle({ method: 'GET', path: '/api/metrics', headers: auth });
  assert.equal(res.body.totals.image, 10, '面板刷新一次就该看到 bot 新记的数据');
});

test('指标文件损坏不影响接口返回', async () => {
  const file = tempMetricsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ 这不是 JSON', 'utf8');
  const reader = createMetrics({ store: createFileMetricsStore(file) });
  const snap = reader.snapshot();
  assert.equal(snap.totals.message, 0, '坏文件当空处理即可，不能抛');
  assert.equal(snap.hourLabels.length, 24);
});
