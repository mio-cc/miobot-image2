import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWebApi } from '../dist/packages/web-api/src/index.js';
import { createDefaultConfig } from '../dist/packages/config/src/index.js';

test('suno callback: token auth, persistence and idempotency work without panel auth', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miobot-suno-callback-'));
  const callbackFile = path.join(dir, 'callbacks.jsonl');
  process.env.MIOBOT_SUNO_CALLBACK_FILE = callbackFile;
  const cfg = createDefaultConfig();
  cfg.orchestration.suno.callbackSecret = 'callback-secret';
  cfg.orchestration.suno.callbackUrl = 'https://i.mioku.cn/api/orchestration/suno/callback/callback-secret';
  const api = createWebApi({ initialConfig: cfg });
  const body = {
    code: 200,
    msg: 'success',
    data: { callbackType: 'complete', taskId: 'task-callback-1', data: [{ audio_url: 'https://cdn/song.mp3' }] },
  };
  const first = await api.handle({ method: 'POST', path: '/api/orchestration/suno/callback/callback-secret', body });
  assert.equal(first.status, 200);
  assert.equal(first.body.data.received, true);
  assert.equal(first.body.data.duplicate, false);
  const second = await api.handle({ method: 'POST', path: '/api/orchestration/suno/callback/callback-secret', body });
  assert.equal(second.status, 200);
  assert.equal(second.body.data.duplicate, true);
  const lines = fs.readFileSync(callbackFile, 'utf8').trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
  const stored = JSON.parse(lines[0]);
  assert.equal(stored.taskId, 'task-callback-1');
  assert.equal(stored.callbackType, 'complete');
  const wrong = await api.handle({ method: 'POST', path: '/api/orchestration/suno/callback/wrong', body });
  assert.equal(wrong.status, 401);
  const missing = await api.handle({ method: 'POST', path: '/api/orchestration/suno/callback/callback-secret', body: { data: { callbackType: 'complete' } } });
  assert.equal(missing.status, 400);
  delete process.env.MIOBOT_SUNO_CALLBACK_FILE;
});