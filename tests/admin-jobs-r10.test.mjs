import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWebApi } from '../dist/packages/web-api/src/index.js';

test('R10 admin jobs: orchestration jobs and agent tool jobs are merged with source labels', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'miobot-jobs-'));
  const oldRuntime = process.env.MIOBOT_RUNTIME_DIR;
  try {
    await fs.writeFile(path.join(dir, 'orchestration-pending-jobs.json'), JSON.stringify({
      jobs: [{ jobId: 'orch-1', status: 'running', capability: 'image.generate' }],
    }));
    await fs.writeFile(path.join(dir, 'agent-tool-jobs.json'), JSON.stringify({
      jobs: [{ jobId: 'agent-1', status: 'succeeded', toolName: 'audio.music.generate' }],
    }));
    process.env.MIOBOT_RUNTIME_DIR = dir;
    const api = createWebApi();
    const login = await api.handle({ method: 'POST', path: '/api/login', body: { password: 'change-me-on-first-login' } });
    assert.equal(login.status, 200);
    const result = await api.handle({
      method: 'GET', path: '/api/orchestration/jobs',
      headers: { authorization: `Bearer ${login.body.auth.token}` },
    });
    assert.equal(result.status, 200);
    const jobs = result.body.jobs;
    assert.ok(jobs.some((job) => job.jobId === 'orch-1' && job.source === 'orchestration'));
    assert.ok(jobs.some((job) => job.jobId === 'agent-1' && job.source === 'agent'));
  } finally {
    if (oldRuntime === undefined) delete process.env.MIOBOT_RUNTIME_DIR;
    else process.env.MIOBOT_RUNTIME_DIR = oldRuntime;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
