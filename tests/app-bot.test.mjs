import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createBotApp,
  createModelBackedDeps,
  artifactToString,
  toModelNodes,
  toEngineRoutingConfig,
  toBotRouting,
} from '../dist/apps/bot/src/main.js';
import { createDefaultConfig } from '../dist/packages/config/src/index.js';

function makeClient() {
  const calls = [];
  return {
    calls,
    can: (model, op) => {
      if (op === 'vision') return /gpt-4o/.test(model);
      if (op === 'image.generate' || op === 'image.edit') return /image|dall|flux/.test(model);
      if (op === 'interrogate') return /gpt-4o/.test(model);
      return true;
    },
    chat: async (idx, req) => { calls.push(['chat', idx, req]); return { text: 'CHAT', raw: {} }; },
    vision: async (idx, req) => { calls.push(['vision', idx, req]); return { text: 'VISION', raw: {} }; },
    generateImages: async (idx, req) => { calls.push(['generate', idx, req]); return { images: [{ kind: 'base64', data: 'AAAA', mimeType: 'image/png', index: 0 }], raw: {} }; },
    editImage: async (idx, req) => { calls.push(['edit', idx, req]); return { images: [{ kind: 'url', data: 'http://x/a.png', index: 0 }], raw: {} }; },
    interrogate: async (idx, req) => { calls.push(['interrogate', idx, req]); return { text: 'DESC', raw: {} }; },
  };
}

test('config-bridge: toModelNodes maps apiKeys -> ModelNode with default openai dialect', () => {
  const cfg = createDefaultConfig();
  cfg.llm.apiKeys = [{ name: 'n1', baseUrl: 'http://a', key: 'sk-1', enabled: true, models: ['gpt-4o-mini'], modelsFetchedAt: '' }];
  const nodes = toModelNodes(cfg);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].dialect, 'openai');
  assert.equal(nodes[0].baseUrl, 'http://a');
  assert.equal(nodes[0].apiKey, 'sk-1');
  assert.deepEqual(nodes[0].models, ['gpt-4o-mini']);
});

test('config-bridge: inferDialect honors explicit dialect / provider, falls back to openai', () => {
  const cfg = createDefaultConfig();
  cfg.llm.apiKeys = [
    { name: 'a', baseUrl: 'http://a', key: '', enabled: true, models: [], modelsFetchedAt: '', dialect: 'anthropic' },
    { name: 'b', baseUrl: 'http://b', key: '', enabled: true, models: [], modelsFetchedAt: '', provider: 'gemini' },
    { name: 'c', baseUrl: 'http://c', key: '', enabled: true, models: [], modelsFetchedAt: '', provider: 'some-proxy' },
  ];
  const nodes = toModelNodes(cfg);
  assert.equal(nodes[0].dialect, 'anthropic');
  assert.equal(nodes[1].dialect, 'gemini');
  assert.equal(nodes[2].dialect, 'openai');
});

test('config-bridge: routing config + node indexes pulled from AppConfig', () => {
  const cfg = createDefaultConfig();
  cfg.llm.chatModel = 'gpt-4o-mini';
  cfg.llm.imageModel = 'gpt-image-2';
  cfg.llm.chatNodeIndex = 0;
  cfg.freeMode.model = 'gpt-4o-mini';
  const routing = toEngineRoutingConfig(cfg);
  assert.equal(routing.chatModel, 'gpt-4o-mini');
  assert.equal(routing.imageModel, 'gpt-image-2');
  assert.equal(routing.freeModeModel, 'gpt-4o-mini');
  const r = toBotRouting(cfg);
  assert.equal(typeof r.chatNodeIndex, 'number');
  assert.equal(typeof r.imageNodeIndex, 'number');
});

test('deps: chat without images -> client.chat with user message', async () => {
  const client = makeClient();
  const deps = createModelBackedDeps({ client, getRouting: () => ({ chatNodeIndex: 2, imageNodeIndex: 0, editNodeIndex: 0, interrogateNodeIndex: 0, freeModeNodeIndex: 0 }) });
  const r = await deps.chat({ model: 'gpt-4o-mini', text: '你好' });
  assert.equal(r.text, 'CHAT');
  assert.deepEqual(client.calls[0], ['chat', 2, { model: 'gpt-4o-mini', messages: [{ role: 'user', content: '你好' }] }]);
});

test('deps: chat with images on vision-capable model -> client.vision', async () => {
  const client = makeClient();
  const deps = createModelBackedDeps({ client, getRouting: () => ({ chatNodeIndex: 1, imageNodeIndex: 0, editNodeIndex: 0, interrogateNodeIndex: 0, freeModeNodeIndex: 0 }) });
  const r = await deps.chat({ model: 'gpt-4o', text: '这是什么', images: ['http://x/i.png'] });
  assert.equal(r.text, 'VISION');
  assert.equal(client.calls[0][0], 'vision');
  assert.equal(client.calls[0][1], 1);
  assert.deepEqual(client.calls[0][2].imageUrls, ['http://x/i.png']);
});

test('deps: generate/edit convert artifacts to strings; interrogate maps images->imageUrls', async () => {
  const client = makeClient();
  const deps = createModelBackedDeps({ client, getRouting: () => ({ chatNodeIndex: 0, imageNodeIndex: 5, editNodeIndex: 6, interrogateNodeIndex: 7, freeModeNodeIndex: 0 }) });

  const gen = await deps.generateImages({ model: 'gpt-image-2', prompt: 'cat', size: '1024x1024', count: 2 });
  assert.deepEqual(gen.images, ['data:image/png;base64,AAAA']);
  assert.equal(client.calls[0][1], 5);

  const edit = await deps.editImage({ model: 'gpt-image-2', prompt: 'bg', images: ['data:image/png;base64,XX'] });
  assert.deepEqual(edit.images, ['http://x/a.png']);
  assert.equal(client.calls[1][1], 6);

  const desc = await deps.interrogate({ model: 'gpt-4o', images: ['http://x/i.png'], prompt: 'p' });
  assert.equal(desc.text, 'DESC');
  assert.deepEqual(client.calls[2][2], { model: 'gpt-4o', imageUrls: ['http://x/i.png'], prompt: 'p' });
});

test('artifactToString: base64 -> data URL, url -> passthrough', () => {
  assert.equal(artifactToString({ kind: 'base64', data: 'QQ', mimeType: 'image/jpeg', index: 0 }), 'data:image/jpeg;base64,QQ');
  assert.equal(artifactToString({ kind: 'base64', data: 'QQ', index: 0 }), 'data:image/png;base64,QQ');
  assert.equal(artifactToString({ kind: 'url', data: 'http://x/a.png', index: 0 }), 'http://x/a.png');
});

test('createBotApp: end-to-end 画一只猫 -> image.generate via injected client', async () => {
  const client = makeClient();
  const app = createBotApp({ getConfig: () => createDefaultConfig(), client });
  const r = await app.handle({ text: '画一只猫' });
  assert.equal(r.kind, 'image.generate');
  assert.deepEqual(r.images, ['data:image/png;base64,AAAA']);
  assert.equal(client.calls[0][0], 'generate');
});

test('createBotApp: chat fallback when image model lacks capability (gated to chat)', async () => {
  const client = makeClient();
  const cfg = createDefaultConfig();
  cfg.llm.imageModel = 'deepseek-chat'; // 纯文本模型
  cfg.llm.editModel = 'deepseek-chat';
  const app = createBotApp({ getConfig: () => cfg, client });
  const r = await app.handle({ text: '画一只猫' });
  assert.equal(r.kind, 'chat');
  assert.equal(client.calls.some((c) => c[0] === 'generate'), false);
});
