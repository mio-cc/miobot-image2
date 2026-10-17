import test from 'node:test';
import assert from 'node:assert/strict';

import { createDefaultConfig, normalizeConfig } from '../dist/packages/config/src/index.js';
import { FeatureGate, FeatureLimitError } from '../dist/apps/bot/src/feature-gate.js';

test('feature gate: prompt limit, cooldown, and daily quota', async () => {
  let now = 1_000_000;
  const cfg = normalizeConfig(createDefaultConfig());
  cfg.bot.features['image.generate'].limits = {
    cooldownSec: 2, userDailyLimit: 2, groupDailyLimit: 2, maxPromptChars: 5, sendDelayMs: 123, concurrency: 0,
  };
  const gate = new FeatureGate({ getConfig: () => cfg, now: () => now });
  assert.equal(gate.sendDelayMs('image.generate'), 123);
  const release = await gate.acquire({ featureId: 'image.generate', chatType: 'group', groupId: '1', userId: '2', promptChars: 5 });
  release();
  await assert.rejects(() => gate.acquire({ featureId: 'image.generate', chatType: 'group', groupId: '1', userId: '2', promptChars: 6 }), /输入太长/);
  await assert.rejects(() => gate.acquire({ featureId: 'image.generate', chatType: 'group', groupId: '1', userId: '2', promptChars: 5 }), /操作太快/);
  now += 3000;
  const second = await gate.acquire({ featureId: 'image.generate', chatType: 'group', groupId: '1', userId: '2', promptChars: 5 });
  second();
  now += 3000;
  await assert.rejects(() => gate.acquire({ featureId: 'image.generate', chatType: 'group', groupId: '1', userId: '2', promptChars: 5 }), /用户上限/);
});

test('feature gate: concurrency waits for release', async () => {
  const cfg = normalizeConfig(createDefaultConfig());
  cfg.bot.features['image.generate'].limits = {
    cooldownSec: 0, userDailyLimit: 0, groupDailyLimit: 0, maxPromptChars: 0, sendDelayMs: 0, concurrency: 1,
  };
  const gate = new FeatureGate({ getConfig: () => cfg });
  const first = await gate.acquire({ featureId: 'image.generate', chatType: 'private', userId: '2' });
  let secondResolved = false;
  const secondPromise = gate.acquire({ featureId: 'image.generate', chatType: 'private', userId: '2' }).then((release) => { secondResolved = true; release(); });
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(secondResolved, false);
  first();
  await secondPromise;
  assert.equal(secondResolved, true);
});

test('feature gate: FeatureLimitError carries feature id', async () => {
  const cfg = normalizeConfig(createDefaultConfig());
  cfg.bot.features['help'].limits.maxPromptChars = 1;
  const gate = new FeatureGate({ getConfig: () => cfg });
  await assert.rejects(
    () => gate.acquire({ featureId: 'help', chatType: 'private', userId: '1', promptChars: 2 }),
    (error) => error instanceof FeatureLimitError && error.featureId === 'help',
  );
});
