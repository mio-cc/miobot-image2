import test from 'node:test';
import assert from 'node:assert/strict';

import {
  imageEditTransportsFor,
  isReasoningModel,
  normalizeModelId,
  stripEffortSuffix,
  stripProviderPrefix,
  supportsReasoningEffort,
  supportsResponseFormat,
  supportsTemperature,
  tokenParamFor,
} from '../dist/packages/model/src/capability/params.js';
import { openAiDialect } from '../dist/packages/model/src/dialects/openai.js';

/**
 * 请求参数分流。每条断言都对应一个上游会直接 400 的真实场景——
 * 这些错误都不带可自动降级的提示，不分流就是必然失败。
 */

const NODE = { baseUrl: 'https://api.example.com/v1', apiKey: 'k' };

test('模型名归一化: 剥掉 provider 前缀与档位后缀', () => {
  assert.equal(stripProviderPrefix('openai/gpt-5.6-sol'), 'gpt-5.6-sol');
  assert.equal(stripProviderPrefix('gpt-4o'), 'gpt-4o');
  assert.equal(stripEffortSuffix('gpt-5.6-sol(high)'), 'gpt-5.6-sol');
  assert.equal(normalizeModelId('openai/gpt-5.6-sol(high)'), 'gpt-5.6-sol');
});

test('推理模型识别: gpt-5-chat 不算推理模型', () => {
  for (const m of ['o1', 'o3', 'o4-mini', 'gpt-5', 'gpt-5.6-sol', 'gpt-5.3-codex']) {
    assert.equal(isReasoningModel(m), true, `${m} 应是推理模型`);
  }
  for (const m of ['gpt-4o', 'gpt-4.1', 'gpt-5-chat-latest', 'claude-opus-5', 'gemini-3.6-flash']) {
    assert.equal(isReasoningModel(m), false, `${m} 不应是推理模型`);
  }
});

test('输出长度参数: 推理模型必须用 max_completion_tokens', () => {
  assert.equal(tokenParamFor('o3'), 'max_completion_tokens');
  assert.equal(tokenParamFor('gpt-5.6-sol'), 'max_completion_tokens');
  assert.equal(tokenParamFor('openai/gpt-5(high)'), 'max_completion_tokens');
  assert.equal(tokenParamFor('gpt-4o'), 'max_tokens');
  assert.equal(tokenParamFor('claude-opus-5'), 'max_tokens');
});

test('reasoning_effort: o1-mini / o1-preview / gpt-5-chat 不接受', () => {
  assert.equal(supportsReasoningEffort('o3'), true);
  assert.equal(supportsReasoningEffort('gpt-5.6-sol'), true);
  assert.equal(supportsReasoningEffort('o1-mini'), false);
  assert.equal(supportsReasoningEffort('o1-preview'), false);
  assert.equal(supportsReasoningEffort('gpt-5-chat-latest'), false);
  assert.equal(supportsReasoningEffort('gpt-4o'), false);
});

test('temperature: 推理模型不接受', () => {
  assert.equal(supportsTemperature('gpt-4o'), true);
  assert.equal(supportsTemperature('o3'), false);
});

test('response_format: gpt-image 系列不能带', () => {
  assert.equal(supportsResponseFormat('gpt-image-2'), false);
  assert.equal(supportsResponseFormat('gpt-image-1'), false);
  assert.equal(supportsResponseFormat('chatgpt-image-latest'), false);
  assert.equal(supportsResponseFormat('dall-e-3'), true);
  assert.equal(supportsResponseFormat('grok-imagine-image'), true);
});

test('改图请求体形态: 官方 multipart 优先, xAI JSON 优先', () => {
  assert.equal(imageEditTransportsFor('gpt-image-2')[0], 'multipart');
  assert.equal(imageEditTransportsFor('grok-imagine-image-quality')[0], 'json-image');
});

test('buildChat: 推理模型发 max_completion_tokens 且不发 temperature', () => {
  const plan = openAiDialect.buildChat(NODE, {
    model: 'o3', messages: [{ role: 'user', content: 'hi' }],
    maxTokens: 8000, temperature: 0.7, reasoningEffort: 'high',
  });
  assert.equal(plan.body.max_completion_tokens, 8000);
  assert.equal('max_tokens' in plan.body, false, '不应出现 max_tokens');
  assert.equal('temperature' in plan.body, false, '推理模型不接受 temperature');
  assert.equal(plan.body.reasoning_effort, 'high');
});

test('buildChat: 普通模型仍走 max_tokens 且保留 temperature', () => {
  const plan = openAiDialect.buildChat(NODE, {
    model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }],
    maxTokens: 2000, temperature: 0.7, reasoningEffort: 'high',
  });
  assert.equal(plan.body.max_tokens, 2000);
  assert.equal(plan.body.temperature, 0.7);
  assert.equal('reasoning_effort' in plan.body, false, '非推理模型不应下发 reasoning_effort');
});

test('buildChat: o1-mini 不下发 reasoning_effort', () => {
  const plan = openAiDialect.buildChat(NODE, {
    model: 'o1-mini', messages: [{ role: 'user', content: 'hi' }], reasoningEffort: 'high',
  });
  assert.equal('reasoning_effort' in plan.body, false);
});

test('buildImageGeneration: gpt-image 不带 response_format, dall-e 带', () => {
  const gptImage = openAiDialect.buildImageGeneration(NODE, { model: 'gpt-image-2', prompt: 'cat' });
  assert.equal('response_format' in gptImage.body, false);

  const dalle = openAiDialect.buildImageGeneration(NODE, { model: 'dall-e-3', prompt: 'cat' });
  assert.equal(dalle.body.response_format, 'b64_json');
});

test('buildImageEdit: gpt-image 同样不带 response_format', () => {
  const plan = openAiDialect.buildImageEdit(NODE, {
    model: 'gpt-image-2', prompt: '换成夜晚', images: ['https://x/a.png'],
  });
  assert.equal('response_format' in plan.body, false);
  assert.deepEqual(plan.body.images, [{ image_url: 'https://x/a.png' }]);
});

test('buildVision: 同样按模型分流 token 参数', () => {
  const plan = openAiDialect.buildVision(NODE, {
    model: 'gpt-5.6-sol', prompt: '看图', imageUrls: ['https://x/a.png'], maxTokens: 4000,
  });
  assert.equal(plan.body.max_completion_tokens, 4000);
  assert.equal('max_tokens' in plan.body, false);
});
