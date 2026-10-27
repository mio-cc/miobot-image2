import test from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultConfig } from '../dist/packages/config/src/index.js';
import { resolveAsyncJobTimeoutMs } from '../dist/apps/bot/src/async-job-timeout.js';

test('async job timeout: ComfyUI queue + generation is not clamped to default tool timeout', () => {
  const cfg = createDefaultConfig();
  cfg.llm.imageNodeIndex = 0;
  cfg.llm.imageTimeoutMs = 900_000;
  cfg.llm.apiKeys[0].kind = 'comfyui';
  cfg.llm.apiKeys[0].comfyui = {
    profiles: [], pollTimeoutMs: 600_000, pollIntervalMs: 2_000,
    maxBatchSize: 1, maxConcurrent: 1, maxQueue: 10, queueTimeoutMs: 900_000,
  };
  const timeout = resolveAsyncJobTimeoutMs(cfg, 'image.generate', 120_000);
  assert.ok(timeout >= 900_000 + 600_000 + 60_000, `timeout=${timeout}`);
});

test('async job timeout: code render includes browser stage budget', () => {
  const cfg = createDefaultConfig();
  cfg.codeRender.enabled = true;
  cfg.codeRender.timeoutMs = 30_000;
  cfg.browserRender.timeoutMs = 45_000;
  const timeout = resolveAsyncJobTimeoutMs(cfg, 'code.render', 120_000);
  assert.ok(timeout >= 30_000 + 45_000 + 60_000, `timeout=${timeout}`);
});

test('async job timeout: ComfyUI pollTimeoutMs=0 means wait for completion, not a 15m cap', () => {
  const cfg = createDefaultConfig();
  cfg.llm.imageNodeIndex = 0;
  cfg.llm.apiKeys[0].kind = 'comfyui';
  cfg.llm.apiKeys[0].comfyui = {
    profiles: [], pollTimeoutMs: 0, pollIntervalMs: 2_000,
    maxBatchSize: 1, maxConcurrent: 1, maxQueue: 10, queueTimeoutMs: 0,
  };
  assert.equal(resolveAsyncJobTimeoutMs(cfg, 'image.generate', 120_000), 0);
});

test('async job timeout: Suno and TTS use their own long-running budgets', () => {
  const cfg = createDefaultConfig();
  cfg.orchestration.suno.timeoutMs = 600_000;
  cfg.orchestration.suno.pollIntervalMs = 5_000;
  cfg.bot.tts.timeoutMs = 60_000;
  cfg.bot.tts.preprocess.timeoutMs = 30_000;
  assert.ok(resolveAsyncJobTimeoutMs(cfg, 'audio.music.generate', 120_000) >= 600_000);
  assert.ok(resolveAsyncJobTimeoutMs(cfg, 'tts.speak', 120_000) >= 90_000);
});
