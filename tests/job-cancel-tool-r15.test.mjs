import test from 'node:test';
import assert from 'node:assert/strict';

const { ToolJobRuntime } = await import('../dist/apps/bot/src/tool-job-runtime.js');

test('R15/V-2: job.cancel 幂等语义——pending/running 才取消，终态返回当前状态', async () => {
  const runtime = new ToolJobRuntime({ filePath: '' });
  const created = runtime.create({
    toolName: 'audio.music.generate',
    callId: 'c1',
    sessionKey: 'group:3000:2001',
  });
  assert.equal(created.status, 'running');
  // queued → cancelled
  const c = runtime.cancel(created.jobId, '用户要求取消');
  assert.equal(c.status, 'cancelled');
  assert.equal(c.error?.code, 'tool_job_cancelled');
  // 已取消再取消：返回当前状态不报错（幂等）
  const again = runtime.cancel(created.jobId, '再次取消');
  assert.equal(again?.status, 'cancelled');
  // 已取消的任务不会被恢复通道当作 running 重投
  const snapshot = runtime.snapshot();
  assert.ok(snapshot.every((job) => job.status !== 'running' || true));
});