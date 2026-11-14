import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { WebApi, ConfigRepository, derivePanelToken } from '../dist/packages/web-api/src/index.js';

test('backup API: manual creation, size statistics, individual/all cleanup', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miobot-backup-api-'));
  const oldData = process.env.MIOBOT_DATA_DIR;
  const oldConfig = process.env.MIOBOT_CONFIG_PATH;
  const oldState = process.env.MIOBOT_CANVAS_STATE_PATH;
  const oldAssets = process.env.MIOBOT_CANVAS_ASSET_DIR;
  process.env.MIOBOT_DATA_DIR = dir;
  process.env.MIOBOT_CONFIG_PATH = path.join(dir, 'config.json');
  process.env.MIOBOT_CANVAS_STATE_PATH = path.join(dir, 'canvas-state.json');
  process.env.MIOBOT_CANVAS_ASSET_DIR = path.join(dir, 'canvas-assets');
  fs.writeFileSync(process.env.MIOBOT_CONFIG_PATH, JSON.stringify({ smoke: true }));
  fs.writeFileSync(process.env.MIOBOT_CANVAS_STATE_PATH, JSON.stringify({ nodes: [] }));
  fs.mkdirSync(process.env.MIOBOT_CANVAS_ASSET_DIR, { recursive: true });
  fs.writeFileSync(path.join(process.env.MIOBOT_CANVAS_ASSET_DIR, 'image.txt'), 'image fixture');
  try {
    const repository = new ConfigRepository();
    const api = new WebApi({ repository });
    const token = derivePanelToken(repository.getConfig().panel.passwordSeed);
    const headers = { authorization: `Bearer ${token}` };

    const empty = await api.handle({ method: 'GET', path: '/api/system/backups', headers });
    assert.equal(empty.status, 200, JSON.stringify(empty.body));
    assert.equal(empty.body.backups.length, 0);

    const created = await api.handle({ method: 'POST', path: '/api/system/backups', headers, body: { config: true, canvasState: true, canvasAssets: true } });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.equal(created.body.backups.length, 3);
    assert.ok(created.body.backups.every((item) => Number(item.size) > 0));

    const listed = await api.handle({ method: 'GET', path: '/api/system/backups', headers });
    assert.equal(listed.body.backups.length, 3);
    assert.ok(Number(listed.body.totalBytes) > 0);

    const one = listed.body.backups[0].name;
    const deletedOne = await api.handle({ method: 'DELETE', path: '/api/system/backups/' + encodeURIComponent(one), headers });
    assert.equal(deletedOne.status, 200, JSON.stringify(deletedOne.body));
    assert.equal(deletedOne.body.removed, 1);

    const deletedAll = await api.handle({ method: 'DELETE', path: '/api/system/backups?all=1', headers });
    assert.equal(deletedAll.status, 200, JSON.stringify(deletedAll.body));
    assert.equal(deletedAll.body.removed, 2);
    assert.ok(Number(deletedAll.body.freedBytes) > 0);

    const final = await api.handle({ method: 'GET', path: '/api/system/backups', headers });
    assert.equal(final.body.backups.length, 0);
  } finally {
    if (oldData === undefined) delete process.env.MIOBOT_DATA_DIR; else process.env.MIOBOT_DATA_DIR = oldData;
    if (oldConfig === undefined) delete process.env.MIOBOT_CONFIG_PATH; else process.env.MIOBOT_CONFIG_PATH = oldConfig;
    if (oldState === undefined) delete process.env.MIOBOT_CANVAS_STATE_PATH; else process.env.MIOBOT_CANVAS_STATE_PATH = oldState;
    if (oldAssets === undefined) delete process.env.MIOBOT_CANVAS_ASSET_DIR; else process.env.MIOBOT_CANVAS_ASSET_DIR = oldAssets;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
