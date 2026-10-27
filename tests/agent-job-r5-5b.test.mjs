import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ToolJobRuntime } from '../dist/apps/bot/src/tool-job-runtime.js';
import { OrchestrationEnforcer } from '../dist/apps/bot/src/orchestration-enforce.js';
import { createDefaultConfig } from '../dist/packages/config/src/index.js';
import { toolSuccess } from '../dist/packages/tool-runtime/src/index.js';

test('tool-job R5.5b: cancel aborts the background handler and marks the job cancelled', async () => {
  const jobs = new ToolJobRuntime();
  const job = jobs.create({ toolName: 'video.generate', callId: 'video-call', sessionKey: 'private:1' });
  let aborted = false;
  const running = jobs.run(job.jobId, (signal) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => {
      aborted = true;
      reject(new Error('aborted'));
    }, { once: true });
  }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  const cancelled = jobs.cancel(job.jobId, 'user_cancelled');
  assert.equal(cancelled.status, 'cancelled');
  await running;
  assert.equal(aborted, true);
  assert.equal(jobs.get(job.jobId).status, 'cancelled');
});

test('tool-job R5.5b: interrupted job can be reconciled from a remote probe result', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'miobot-job-reconcile-'));
  const file = path.join(dir, 'jobs.json');
  const first = new ToolJobRuntime({ filePath: file });
  const job = first.create({ toolName: 'video.generate', callId: 'video-call', sessionKey: 'private:2' });
  first.recordExternalTask(job.jobId, 'remote-video-1');
  const completed = [];
  const restarted = new ToolJobRuntime({ filePath: file, onComplete: (record) => completed.push(record) });
  assert.equal(restarted.get(job.jobId).error.code, 'tool_job_interrupted');
  const result = toolSuccess('video-call', 'video.generate', {
    jobId: job.jobId,
    outputs: [{ kind: 'video', url: 'https://example.test/reconciled.mp4' }],
  });
  const reconciled = restarted.reconcileInterrupted(job.jobId, result);
  assert.equal(reconciled.status, 'succeeded');
  assert.equal(reconciled.result.outputs[0].url, 'https://example.test/reconciled.mp4');
  assert.equal(completed.length, 1);
  await fs.rm(dir, { recursive: true, force: true });
});

test('orchestration R5.5b: external task probe is exposed for agent job recovery', async () => {
  const cfg = createDefaultConfig();
  const enforcer = new OrchestrationEnforcer({
    getConfig: () => cfg,
    app: {},
    client: { async chat() { return { text: '', raw: {} }; } },
    externalTaskProbe: async ({ capability, taskId }) => ({
      status: 'success',
      outputs: [{ kind: 'image', url: `https://example.test/${capability}/${taskId}.png`, priority: 10 }],
    }),
  });
  const probe = await enforcer.probeExternalTask('image.generate', 'prompt-1');
  assert.equal(probe.status, 'success');
  assert.match(probe.outputs[0].url, /image\.generate\/prompt-1\.png/);
});
