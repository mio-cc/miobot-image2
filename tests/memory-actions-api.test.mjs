import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { WebApi, ConfigRepository, derivePanelToken } from '../dist/packages/web-api/src/index.js';

test('memory actions API: retention_now/observer_stats queue correctly and prune stays compatible', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-action-api-'));
  const actionFile = path.join(dir, 'orchestration-memory-actions.jsonl');
  const oldData = process.env.MIOBOT_DATA_DIR;
  const oldAction = process.env.MIOBOT_MEMORY_ACTION_FILE;
  process.env.MIOBOT_DATA_DIR = dir;
  process.env.MIOBOT_MEMORY_ACTION_FILE = actionFile;
  try {
    const repository = new ConfigRepository();
    const api = new WebApi({ repository });
    const token = derivePanelToken(repository.getConfig().panel.passwordSeed);
    const headers = { authorization: `Bearer ${token}` };

    const dry = await api.handle({ method: 'POST', path: '/api/orchestration/memory/actions', headers, body: { type: 'retention_now', dryRun: true } });
    assert.equal(dry.status, 200, JSON.stringify(dry.body));
    const observer = await api.handle({ method: 'POST', path: '/api/orchestration/memory/actions', headers, body: { type: 'observer_stats' } });
    assert.equal(observer.status, 200, JSON.stringify(observer.body));
    const legacy = await api.handle({ method: 'POST', path: '/api/orchestration/memory/actions', headers, body: { type: 'prune' } });
    assert.equal(legacy.status, 200, JSON.stringify(legacy.body));

    const backend = await api.handle({ method: 'GET', path: '/api/orchestration/memory/backend', headers });
    assert.equal(backend.status, 200, JSON.stringify(backend.body));
    assert.equal(backend.body.success, true);
    const actions = fs.readFileSync(actionFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(actions[0].type, 'retention_now');
    assert.equal(actions[0].dryRun, true);
    assert.equal(actions[1].type, 'observer_stats');
    assert.equal(actions[2].type, 'retention_now', 'prune is normalized for old clients');
  } finally {
    if (oldData === undefined) delete process.env.MIOBOT_DATA_DIR; else process.env.MIOBOT_DATA_DIR = oldData;
    if (oldAction === undefined) delete process.env.MIOBOT_MEMORY_ACTION_FILE; else process.env.MIOBOT_MEMORY_ACTION_FILE = oldAction;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
