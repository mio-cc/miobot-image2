import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ToolJobRuntime } from '../dist/apps/bot/src/tool-job-runtime.js';

test('tool-job R9: probe attempts persist across runtime restarts', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'miobot-probe-attempts-'));
  const file = path.join(dir, 'jobs.json');
  try {
    const first = new ToolJobRuntime({ filePath: file });
    const job = first.create({ toolName: 'video.generate', callId: 'call_1', sessionKey: 'private:1' });
    assert.equal(first.recordProbeAttempt(job.jobId), 1);
    assert.equal(first.recordProbeAttempt(job.jobId), 2);
    first.recordExternalTask(job.jobId, 'req_video_1');

    const second = new ToolJobRuntime({ filePath: file });
    const restored = second.get(job.jobId);
    assert.equal(restored.probeAttempts, 2);
    assert.deepEqual(restored.externalTaskIds, ['req_video_1']);
    assert.equal(second.recordProbeAttempt(job.jobId), 3);

    const third = new ToolJobRuntime({ filePath: file });
    assert.equal(third.get(job.jobId).probeAttempts, 3);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
