import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeConfig } from '../dist/packages/config/src/index.js';
import { classifyFileIntent } from '../dist/apps/bot/src/file-intent.js';

function cfg(overrides = {}) {
  const config = normalizeConfig({});
  Object.assign(config.fileIntent, {
    enabled: true,
    nodeIndex: 0,
    model: 'classifier-model',
    timeoutMs: 3000,
    minConfidence: 0.6,
    prefilter: true,
    ...overrides,
  });
  return config.fileIntent;
}

test('file intent: config default enabled and falls back to freeMode model', () => {
  const config = normalizeConfig({});
  assert.equal(config.fileIntent.enabled, true);
  assert.equal(config.fileIntent.prefilter, true);
  assert.equal(config.fileIntent.model, config.freeMode.model);
});

test('file intent: model can identify a file request beyond regex', async () => {
  let captured = null;
  const decision = await classifyFileIntent({
    text: '把刚才的内容整理一下，我要能下载的资料',
    config: cfg(),
    fallback: { shouldGenerate: false },
    client: {
      async chat(_node, req) {
        captured = req;
        return { text: '{"intent":"file.generate","fileType":"md","confidence":0.92,"reason":"用户要求可下载资料"}' };
      },
    },
  });
  assert.equal(decision.shouldGenerate, true);
  assert.equal(decision.fileType, 'md');
  assert.equal(decision.source, 'model');
  assert.equal(captured.model, 'classifier-model');
});

test('file intent: model chat decision wins over regex candidate', async () => {
  const decision = await classifyFileIntent({
    text: '帮我写一句节日祝福',
    config: cfg(),
    fallback: { shouldGenerate: true, fileType: 'txt' },
    client: { async chat() { return { text: '{"intent":"chat","fileType":null,"confidence":0.95}' }; } },
  });
  assert.equal(decision.shouldGenerate, false);
  assert.equal(decision.source, 'model');
});

test('file intent: classifier failure falls back to regex', async () => {
  const decision = await classifyFileIntent({
    text: '生成一份 md 文档',
    config: cfg(),
    fallback: { shouldGenerate: true, fileType: 'md' },
    client: { async chat() { throw new Error('upstream down'); } },
  });
  assert.equal(decision.shouldGenerate, true);
  assert.equal(decision.fileType, 'md');
  assert.equal(decision.source, 'regex');
});

test('file intent: prefilter skips ordinary chat without calling the model', async () => {
  let calls = 0;
  const decision = await classifyFileIntent({
    text: '今天天气不错',
    config: cfg(),
    fallback: { shouldGenerate: false },
    client: { async chat() { calls += 1; return { text: '{}' }; } },
  });
  assert.equal(calls, 0);
  assert.equal(decision.shouldGenerate, false);
  assert.equal(decision.source, 'skipped');
});
