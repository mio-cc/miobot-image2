import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SchedulerService, buildDailyReport } from '../dist/apps/bot/src/scheduler.js';

test('scheduler T3.1: 到点触发一次、当日不重发、重启不重发', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miobot-sched-'));
  const file = path.join(dir, 'scheduled-jobs.json');
  const ran = [];
  let now = new Date('2026-10-24T08:31:00');
  const s = new SchedulerService({ filePath: file, now: () => now, run: async (job) => { ran.push(job.type); return 'x'; } });
  s.register({ id: 'r', kind: 'daily', type: 'daily-report', hour: 8, minute: 30, enabled: true });
  await s.start();
  await s.tick?.();
  assert.equal(ran.length, 1);
  // 同日再 tick 不重发。
  now = new Date('2026-10-24T12:00:00');
  await s.tick?.();
  assert.equal(ran.length, 1);
  s.stop();
  // 重启（新实例，读持久化 lastRunDay）同日不重发；次日触发。
  const s2 = new SchedulerService({ filePath: file, now: () => now, run: async () => { ran.push('restart'); return 'x'; } });
  await s2.start();
  await s2.tick?.();
  assert.equal(ran.length, 1, '重启后当日不重发');
  now = new Date('2026-10-25T08:31:00');
  await s2.tick?.();
  assert.equal(ran.length, 2, '次日触发');
  s2.stop();
});

test('scheduler T3.1: buildDailyReport 从 trace 与状态文件聚合', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miobot-report-'));
  const today = new Date();
  const iso = today.toISOString();
  fs.writeFileSync(path.join(dir, 'orchestration-traces.jsonl'), [
    JSON.stringify({ timestamp: iso, stage: 'request', summary: '收到编排请求' }),
    JSON.stringify({ timestamp: iso, stage: 'plan', summary: 'planner 失败，回退旧链路 fallback_legacy' }),
    JSON.stringify({ timestamp: iso, stage: 'reply', summary: '执行前置校验失败，已拦截不回退旧链路' }),
    JSON.stringify({ timestamp: iso, stage: 'reply', summary: '无可投递输出，已附加确定性任务摘要' }),
    JSON.stringify({ timestamp: '2020-01-01T00:00:00Z', stage: 'request', summary: '老数据不应统计' }),
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'suno-song-history.json'), JSON.stringify({ records: [{ id: 'a' }, { id: 'b' }] }));
  fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify({ 'private:1': [] }));
  const text = await buildDailyReport({ traceFile: path.join(dir, 'orchestration-traces.jsonl'), dataDir: dir, now: () => today });
  assert.match(text, /请求 1/);
  assert.match(text, /规划 1/);
  assert.match(text, /回退旧链路 1/);
  assert.match(text, /前置拦截 1/);
  assert.match(text, /摘要兜底 1/);
  assert.match(text, /歌曲历史 2/);
  assert.match(text, /活跃会话 1/);
});

test('scheduler T3.6: buildDailyReport 汇总模型用量（按 requestId 取最后快照）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miobot-report-usage-'));
  const today = new Date();
  const iso = today.toISOString();
  fs.writeFileSync(path.join(dir, 'orchestration-traces.jsonl'), [
    JSON.stringify({ timestamp: iso, requestId: 'req-a', stage: 'request', summary: '收到编排请求', data: { usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0, modelCalls: 0 } } }),
    JSON.stringify({ timestamp: iso, requestId: 'req-a', stage: 'plan', summary: '生成执行计划', data: { usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150, cost: 0.01, modelCalls: 1 } } }),
    JSON.stringify({ timestamp: iso, requestId: 'req-a', stage: 'reply', summary: 'composer 完成', data: { usage: { promptTokens: 130, completionTokens: 80, totalTokens: 210, cost: 0.02, modelCalls: 2 } } }),
    JSON.stringify({ timestamp: iso, requestId: 'req-b', stage: 'request', summary: '收到编排请求', data: { usage: { promptTokens: 40, completionTokens: 10, totalTokens: 50, cost: 0, modelCalls: 1 } } }),
  ].join('\n'));
  const text = await buildDailyReport({ traceFile: path.join(dir, 'orchestration-traces.jsonl'), dataDir: dir, now: () => today });
  // req-a 取最后快照（130/80/210/2 次调用），req-b（40/10/50/1 次）→ 合计 170/90/260/3 次、$0.02
  assert.match(text, /模型用量：输入 170 · 输出 90 · 合计 260 tokens（3 次调用，中转计费 \$0\.0200）/);
});
