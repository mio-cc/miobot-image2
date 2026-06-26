import test from 'node:test';
import assert from 'node:assert/strict';

import { createImagePromptPipeline, createModelBackedDeps } from '../dist/apps/bot/src/main.js';
import { createDefaultConfig } from '../dist/packages/config/src/index.js';

const ROUTING = { chatNodeIndex: 0, imageNodeIndex: 0, editNodeIndex: 0, interrogateNodeIndex: 0, freeModeNodeIndex: 0 };

test('pipeline.prepare: 套用本地模板(mb_1),enhance 关闭不调用 LLM', async () => {
  const cfg = createDefaultConfig(); // enhanceEnabled 默认 false, 含模板 mb_1
  const calls = [];
  const client = { chat: async (_i, r) => { calls.push(r); return { text: 'X', raw: {} }; } };
  const pipe = createImagePromptPipeline(client, () => cfg);
  const out = await pipe.prepare({ prompt: '赛博猫', templateId: 'mb_1' });
  assert.match(out, /赛博猫/); // 模板把用户主体填入
  assert.notEqual(out, '赛博猫'); // 确实套了模板(变长)
  assert.equal(calls.length, 0); // enhance 关闭,无 LLM 调用
});

test('pipeline.prepare: enhance 开启 -> 调 LLM 润色', async () => {
  const cfg = createDefaultConfig();
  cfg.llm.enhanceEnabled = true;
  cfg.llm.enhanceModel = 'gpt-4o-mini';
  const calls = [];
  const client = { chat: async (_i, r) => { calls.push(r); return { text: 'ENHANCED PROMPT', raw: {} }; } };
  const pipe = createImagePromptPipeline(client, () => cfg);
  const out = await pipe.prepare({ prompt: '猫' });
  assert.equal(out, 'ENHANCED PROMPT');
  assert.equal(calls.length, 1);
});

test('pipeline.prepare: 润色失败 -> 回退原 prompt,不抛', async () => {
  const cfg = createDefaultConfig();
  cfg.llm.enhanceEnabled = true;
  cfg.llm.enhanceModel = 'gpt-4o-mini';
  const client = { chat: async () => { throw new Error('upstream 500'); } };
  const pipe = createImagePromptPipeline(client, () => cfg);
  assert.equal(await pipe.prepare({ prompt: '猫' }), '猫');
});

test('pipeline.safeRewrite: 启用时改写,未启用时返回 undefined', async () => {
  const on = createDefaultConfig();
  on.llm.safeRewriteOnFailure = true;
  on.llm.enhanceModel = 'gpt-4o-mini';
  const pipeOn = createImagePromptPipeline({ chat: async () => ({ text: 'SAFE', raw: {} }) }, () => on);
  assert.equal(await pipeOn.safeRewrite('x'), 'SAFE');

  const off = createDefaultConfig();
  off.llm.safeRewriteOnFailure = false;
  const pipeOff = createImagePromptPipeline({ chat: async () => ({ text: 'SAFE', raw: {} }) }, () => off);
  assert.equal(await pipeOff.safeRewrite('x'), undefined);
});

test('deps.generateImages: 首次失败 -> 安全改写后重试成功', async () => {
  const cfg = createDefaultConfig();
  cfg.llm.safeRewriteOnFailure = true;
  cfg.llm.enhanceModel = 'gpt-4o-mini';
  const genPrompts = [];
  let failedOnce = false;
  const client = {
    chat: async () => ({ text: 'SAFE PROMPT', raw: {} }),
    generateImages: async (_i, r) => {
      genPrompts.push(r.prompt);
      if (!failedOnce) { failedOnce = true; throw new Error('content policy violation'); }
      return { images: [{ kind: 'base64', data: 'OK', mimeType: 'image/png', index: 0 }], raw: {} };
    },
  };
  const pipe = createImagePromptPipeline(client, () => cfg);
  const deps = createModelBackedDeps({ client, getRouting: () => ROUTING, pipeline: pipe });
  const r = await deps.generateImages({ model: 'gpt-image-2', prompt: '猫' });
  assert.deepEqual(r.images, ['data:image/png;base64,OK']);
  assert.equal(genPrompts.length, 2);
  assert.equal(genPrompts[0], '猫');         // 首次用原 prompt(enhance 关)
  assert.equal(genPrompts[1], 'SAFE PROMPT'); // 重试用安全改写
});
