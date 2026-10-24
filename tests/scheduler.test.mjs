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

test('scheduler T4.3: once 任务到点触发一次，不重发，重启后清理', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miobot-sched-once-'));
  const file = path.join(dir, 'scheduled-jobs.json');
  const ran = [];
  let now = new Date('2026-10-24T10:00:00');
  const s = new SchedulerService({ filePath: file, now: () => now, run: async (job) => { ran.push(job.type + ':' + JSON.stringify(job.payload || {})); return 'x'; } });
  s.register({ id: 'rem1', kind: 'once', hour: 0, minute: 0, runAt: '2026-10-24T10:05:00', type: 'reminder', enabled: true, payload: { remindText: '喝水', userId: '9' } });
  s.register({ id: 'rem2', kind: 'once', hour: 0, minute: 0, runAt: '2026-10-24T11:00:00', type: 'reminder', enabled: true, payload: { remindText: '未来任务' } });
  await s.start();
  await s.tick?.();
  assert.equal(ran.length, 0, '未到点不触发');
  now = new Date('2026-10-24T10:06:00');
  await s.tick?.();
  assert.deepEqual(ran, ['reminder:{"remindText":"喝水","userId":"9"}'], '到点触发一次并携带 payload');
  now = new Date('2026-10-24T10:07:00');
  await s.tick?.();
  assert.equal(ran.length, 1, 'once 任务不重发');
  s.stop();
  // 重启：已完成 once 任务被清理，未来任务保留
  const s2 = new SchedulerService({ filePath: file, now: () => now, run: async () => { ran.push('restart-run'); return 'x'; } });
  await s2.start();
  assert.equal(s2.list().length, 1, '已完成的 once 任务应清理');
  assert.equal(s2.list()[0].id, 'rem2');
  s2.stop();
});

test('scheduler T4.3: task.schedule 能力 handler——时间/文本解析与 needs_input 语义', async () => {
  const { ScheduleCapabilityHandler } = await import('../dist/apps/bot/src/capability-schedule.js');
  const scheduled = [];
  const now = new Date('2026-10-24T10:00:00');
  const handler = new ScheduleCapabilityHandler({
    now: () => now,
    schedule: async (input) => { scheduled.push(input); return { id: 'rem_1' }; },
  });
  const invocation = (args) => ({
    request: { requestId: 'r', chat: { type: 'private', userId: '9' }, user: { qq: '9', role: 'user' }, text: 'x' },
    plan: { planId: 'p', requestId: 'r', goal: 'notify', steps: [] },
    step: { id: 's1', capability: 'task.schedule', args },
    dependencyResults: {},
  });
  // 缺时间 → needs_input（绝不静默猜）
  const noTime = await handler.execute(invocation({ remindText: '喝水' }));
  assert.equal(noTime.status, 'needs_input');
  assert.ok(JSON.stringify(noTime.diagnostics.missingInformation).includes('提醒时间'));
  // 时间已过去 → needs_input
  const past = await handler.execute(invocation({ remindText: '喝水', at: '2026-10-23T09:00:00' }));
  assert.equal(past.status, 'needs_input');
  // 缺文本 → needs_input
  const noText = await handler.execute(invocation({ inMinutes: 30 }));
  assert.equal(noText.status, 'needs_input');
  // inMinutes → success + 注册
  const ok = await handler.execute(invocation({ remindText: '喝水', inMinutes: 30 }));
  assert.equal(ok.status, 'success');
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].remindText, '喝水');
  // now 为本地时区 2026-10-24T10:00（+08:00 环境）→ 30 分钟后即 02:30Z
  assert.equal(scheduled[0].runAt, new Date(now.getTime() + 30 * 60_000).toISOString());
  assert.deepEqual(scheduled[0].target, { chatType: 'private', userId: '9' });
  assert.ok(ok.outputs[0].text.includes('喝水'));
  // ISO at → success
  const iso = await handler.execute(invocation({ remindText: '开会', at: '2026-10-24T15:00:00+08:00' }));
  assert.equal(iso.status, 'success');
  assert.equal(scheduled[1].runAt, '2026-10-24T07:00:00.000Z');
  // 群聊目标快照 groupId
  const groupInvocation = {
    request: { requestId: 'r', chat: { type: 'group', groupId: '123', userId: '9' }, user: { qq: '9', role: 'user' }, text: 'x' },
    plan: { planId: 'p', requestId: 'r', goal: 'notify', steps: [] },
    step: { id: 's1', capability: 'task.schedule', args: { remindText: 'x', inMinutes: 5 } },
    dependencyResults: {},
  };
  await handler.execute(groupInvocation);
  assert.deepEqual(scheduled[2].target, { chatType: 'group', groupId: '123', userId: '9' });
});

test('scheduler 事故修复: 安静窗口判断——03:00-06:30 内为真，白天/凌晨为假', async () => {
  const { withinQuietWindow } = await import('../dist/apps/bot/src/scheduler.js');
  assert.equal(withinQuietWindow(new Date('2026-10-25T03:00:00')), true);
  assert.equal(withinQuietWindow(new Date('2026-10-25T04:30:00')), true);
  assert.equal(withinQuietWindow(new Date('2026-10-25T06:29:00')), true);
  assert.equal(withinQuietWindow(new Date('2026-10-25T06:30:00')), false, '06:30 整点出窗');
  assert.equal(withinQuietWindow(new Date('2026-10-25T11:13:00')), false, '事故时间点（白天补跑）必须为假');
  assert.equal(withinQuietWindow(new Date('2026-10-25T02:59:00')), false);
});
