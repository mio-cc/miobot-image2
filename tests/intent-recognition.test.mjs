import test from 'node:test';
import assert from 'node:assert/strict';

import { FEATURE_DEFINITIONS } from '../dist/packages/shared/src/features.js';
import { normalizeConfig } from '../dist/packages/config/src/index.js';
import { classifyNaturalLanguageIntent } from '../dist/apps/bot/src/intent-recognition.js';
import { NATURAL_INTENT_CATALOG } from '../dist/apps/bot/src/runtime.js';

function cfg(overrides = {}) {
  const config = normalizeConfig({});
  Object.assign(config.intentRecognition, {
    enabled: true,
    nodeIndex: 0,
    model: 'intent-model',
    timeoutMs: 3000,
    minConfidence: 0.65,
    ...overrides,
  });
  return config.intentRecognition;
}

const catalog = [
  { id: 'chat', label: '普通聊天', effect: 'answer', description: '普通聊天' },
  { id: 'file.generate', label: '生成文件', effect: 'generate', description: '生成可下载文件' },
  { id: 'search.web', label: '联网搜索', effect: 'retrieve', description: '搜索最新信息' },
  { id: 'file.read', label: '读取文件', effect: 'retrieve', description: '读取文件', requires: 'files' },
];

test('intent recognition: default capability is enabled and inherits a model', () => {
  const config = normalizeConfig({});
  assert.equal(config.intentRecognition.enabled, true);
  assert.equal(config.intentRecognition.minConfidence, 0.65);
  assert.equal(config.intentRecognition.model, config.freeMode.model);
});

test('intent recognition: model maps natural language to a command and extracts args', async () => {
  let prompt = '';
  const decision = await classifyNaturalLanguageIntent({
    text: '帮我弄一份介绍 DeepSeek 的文件，最好 Word 能直接发我',
    config: cfg(),
    catalog,
    context: { chatType: 'group', hasImages: false, hasFiles: false },
    fallback: { intent: 'chat', args: '', confidence: 0 },
    client: { async chat(_node, req) { prompt = req.messages[0].content; return { text: '{"intent":"file.generate","args":"介绍 DeepSeek","fileType":"docx","confidence":0.94}' }; } },
  });
  assert.equal(decision.intent, 'file.generate');
  assert.equal(decision.args, '介绍 DeepSeek');
  assert.equal(decision.fileType, 'docx');
  assert.equal(decision.source, 'model');
  assert.match(prompt, /帮我弄一份介绍/);
  assert.match(prompt, /file\.generate/);
  assert.match(prompt, /先判断用户真正想要的结果类型/);
  assert.match(prompt, /话题词、对象词和自然景象词只描述内容/);
  assert.match(prompt, /"effect":"generate"/);
  assert.match(prompt, /"effect":"retrieve"/);
});

test('intent recognition: model can return chat for ordinary conversation', async () => {
  const decision = await classifyNaturalLanguageIntent({
    text: '今天心情不错',
    config: cfg(),
    catalog,
    context: { chatType: 'private', hasImages: false, hasFiles: false },
    fallback: { intent: 'chat', args: '今天心情不错', confidence: 0 },
    client: { async chat() { return { text: '{"intent":"chat","args":"今天心情不错","confidence":0.98}' }; } },
  });
  assert.equal(decision.intent, 'chat');
  assert.equal(decision.source, 'model');
});

test('intent recognition: invalid model output falls back to regex intent', async () => {
  const decision = await classifyNaturalLanguageIntent({
    text: '生成一份 PDF 报告',
    config: cfg(),
    catalog,
    context: { chatType: 'private', hasImages: false, hasFiles: false },
    fallback: { intent: 'file.generate', args: '生成一份 PDF 报告', fileType: 'pdf', confidence: 1 },
    client: { async chat() { throw new Error('classifier down'); } },
  });
  assert.equal(decision.intent, 'file.generate');
  assert.equal(decision.fileType, 'pdf');
  assert.equal(decision.source, 'regex');
});

test('intent recognition: file.read is rejected without files and falls back', async () => {
  const decision = await classifyNaturalLanguageIntent({
    text: '总结一下这个文件',
    config: cfg(),
    catalog,
    context: { chatType: 'private', hasImages: false, hasFiles: false },
    fallback: { intent: 'chat', args: '总结一下这个文件', confidence: 0 },
    client: { async chat() { return { text: '{"intent":"file.read","confidence":0.9}' }; } },
  });
  assert.equal(decision.intent, 'chat');
  assert.equal(decision.source, 'regex');
});

test('intent recognition: legacy catalog carries effect metadata instead of topic rules', () => {
  assert.ok(NATURAL_INTENT_CATALOG.length >= 10);
  for (const item of NATURAL_INTENT_CATALOG) {
    assert.ok(item.effect, item.id + ' should have effect');
  }
  const byId = new Map(NATURAL_INTENT_CATALOG.map((item) => [item.id, item]));
  assert.equal(byId.get('image.generate')?.effect, 'generate');
  assert.equal(byId.get('search.web')?.effect, 'retrieve');
  assert.equal(byId.get('image.edit')?.effect, 'transform');
  assert.equal(byId.get('file.read')?.effect, 'retrieve');
  assert.equal(NATURAL_INTENT_CATALOG.some((item) => /天气请求必须/.test(item.description)), false);
  const music = NATURAL_INTENT_CATALOG.find((item) => item.id === 'audio.music.generate');
  assert.ok(music);
  assert.equal(music.effect, 'generate');
  assert.ok(FEATURE_DEFINITIONS.some((item) => item.id === 'audio.music.generate' && item.implemented));
});