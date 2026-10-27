import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDefaultConfig } from '../dist/packages/config/src/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('R9 readiness: isolated runtime reports core readiness and strict external gating', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'miobot-r9-readiness-'));
  const configPath = path.join(dir, 'config.json');
  // P0-1 后语义：coreReady 只在 Agent enforce + ToolRegistry + ReplyPolicy + 可 loadout 工具时为 true。
  const cfg = createDefaultConfig();
  cfg.agent.enabled = true;
  cfg.agent.mode = 'enforce';
  cfg.toolRegistry.enabled = true;
  cfg.replyPolicy.enabled = true;
  cfg.orchestration.suno.enabled = false;
  await fs.writeFile(configPath, JSON.stringify(cfg), 'utf8');
  const env = {
    ...process.env,
    MIOBOT_RUNTIME_DIR: dir,
    MIOBOT_CONFIG_PATH: configPath,
  };
  try {
    const normal = spawnSync(process.execPath, [path.join(root, 'scripts', 'r9-readiness.mjs')], {
      cwd: root,
      env,
      encoding: 'utf8',
      timeout: 20_000,
    });
    assert.equal(normal.status, 0, normal.stderr || normal.stdout);
    const report = JSON.parse(normal.stdout);
    assert.equal(report.phase, 'R9-readiness');
    assert.equal(report.coreReady, true);
    assert.equal(report.checks.find((item) => item.id === 'schema-v3').ok, true);

    const strict = spawnSync(process.execPath, [path.join(root, 'scripts', 'r9-readiness.mjs'), '--strict-externals'], {
      cwd: root,
      env,
      encoding: 'utf8',
      timeout: 20_000,
    });
    assert.equal(strict.status, 1, 'strict externals must fail when none are configured');
    const strictReport = JSON.parse(strict.stdout);
    assert.equal(strictReport.coreReady, true);
    assert.equal(strictReport.externalsReady, false);

    // 显式关闭 Agent：coreReady 必须 false 且 exit 非 0（不再有全关也 ready 的假阳性）。
    const offCfg = createDefaultConfig();
    offCfg.agent.enabled = false;
    offCfg.agent.mode = 'off';
    await fs.writeFile(configPath, JSON.stringify(offCfg), 'utf8');
    const off = spawnSync(process.execPath, [path.join(root, 'scripts', 'r9-readiness.mjs')], {
      cwd: root,
      env,
      encoding: 'utf8',
      timeout: 20_000,
    });
    assert.notEqual(off.status, 0, 'agent off must not be core-ready');
    const offReport = JSON.parse(off.stdout);
    assert.equal(offReport.coreReady, false);
    assert.equal(offReport.flags.agentMode, 'off');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('R9 live soak: dry-run never submits external work', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'miobot-r9-soak-'));
  const configPath = path.join(dir, 'config.json');
  const cfg = createDefaultConfig();
  cfg.orchestration.suno.enabled = false;
  await fs.writeFile(configPath, JSON.stringify(cfg), 'utf8');
  try {
    const result = spawnSync(process.execPath, [
      path.join(root, 'scripts', 'r9-live-soak.mjs'),
      '--target=all',
      '--count=1',
    ], {
      cwd: root,
      env: { ...process.env, MIOBOT_RUNTIME_DIR: dir, MIOBOT_CONFIG_PATH: configPath },
      encoding: 'utf8',
      timeout: 20_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.mode, 'dry-run');
    assert.equal(report.ok, true);
    assert.deepEqual(report.results, undefined);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});