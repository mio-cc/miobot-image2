import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { createWebApi } = await import('../dist/packages/web-api/src/index.js');

test('R22 logs endpoint rejects arbitrary file paths', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miobot-logs-path-'));
  const oldData = process.env.MIOBOT_DATA_DIR;
  process.env.MIOBOT_DATA_DIR = dir;
  try {
    const api = createWebApi();
    const login = await api.handle({ method: 'POST', path: '/api/login', body: { password: 'change-me-on-first-login' } });
    assert.equal(login.status, 200);
    const headers = { authorization: `Bearer ${login.body.auth.token}` };
    for (const file of ['../secret.jsonl', '/etc/passwd', 'nested/x.jsonl', 'config.json']) {
      const res = await api.handle({ method: 'GET', path: '/api/logs', query: { file }, headers });
      assert.equal(res.status, 400, `must reject ${file}`);
    }
    const normal = await api.handle({ method: 'GET', path: '/api/logs', query: { file: 'bot-logs.jsonl' }, headers });
    assert.equal(normal.status, 200);
  } finally {
    if (oldData === undefined) delete process.env.MIOBOT_DATA_DIR; else process.env.MIOBOT_DATA_DIR = oldData;
  }
});
