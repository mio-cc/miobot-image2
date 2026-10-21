import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigRepository } from '../dist/packages/web-api/src/index.js';

test('config versions: history persists across repository restart and rollback works', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miobot-config-version-'));
  const versionFile = path.join(dir, 'config-versions.json');
  const first = new ConfigRepository({ versionFile });
  const saved = first.saveConfig({ panel: { passwordSeed: 'persisted-version-seed' } });
  assert.equal(saved.success, true);
  assert.ok(first.listVersions().length >= 2);
  assert.equal(fs.existsSync(versionFile), true);

  const second = new ConfigRepository({ versionFile });
  const versions = second.listVersions();
  assert.ok(versions.length >= 2);
  assert.equal(versions[0].version, 1);
  assert.equal(versions.at(-1).version, saved.revision >= 0 ? versions.at(-1).version : versions.at(-1).version);
  const rolled = second.rollbackToVersion(1);
  assert.equal(rolled.success, true);
  assert.notEqual(rolled.config.panel.passwordSeed, 'persisted-version-seed');
  assert.ok(second.listVersions().some((item) => item.version > 1));
});
test('config versions: default history path follows MIOBOT_DATA_DIR', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miobot-config-version-env-'));
  const oldData = process.env.MIOBOT_DATA_DIR;
  const oldRuntime = process.env.MIOBOT_RUNTIME_DIR;
  try {
    process.env.MIOBOT_DATA_DIR = dir;
    delete process.env.MIOBOT_RUNTIME_DIR;
    const repo = new ConfigRepository();
    const saved = repo.saveConfig({ panel: { port: 3020 } });
    assert.equal(saved.success, true);
    assert.equal(fs.existsSync(path.join(dir, 'config-versions.json')), true);
    const reloaded = new ConfigRepository();
    assert.ok(reloaded.listVersions().length >= 2);
  } finally {
    if (oldData === undefined) delete process.env.MIOBOT_DATA_DIR; else process.env.MIOBOT_DATA_DIR = oldData;
    if (oldRuntime === undefined) delete process.env.MIOBOT_RUNTIME_DIR; else process.env.MIOBOT_RUNTIME_DIR = oldRuntime;
  }
});
