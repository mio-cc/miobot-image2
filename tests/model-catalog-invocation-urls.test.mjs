// 目录自带推理 URL（实测 2026-11-19）：
//   fal 的 /models 返回 items[].modelUrl 就是该模型的推理地址。
//   读它之后，「该往哪发」由网关自己声明，不再需要主机映射规则，
//   换网关/换域名/目录与推理再分家都不用改代码。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelClient, createCapabilityRegistry } from '../dist/packages/model/src/index.js';
import { extractModelIds, extractModelInvocationUrls } from '../dist/apps/admin/src/adapters.js';

const CATALOG = {
  items: [
    { id: 'openai/gpt-image-2.6/sunburst/text-to-image', modelUrl: 'https://fal.run/openai/gpt-image-2.6/sunburst/text-to-image' },
    { id: 'openai/gpt-image-2/edit', modelUrl: 'https://fal.run/openai/gpt-image-2/edit' },
    { id: 'no-url-model' },
    { id: 'relative-url-model', modelUrl: '/some/relative/path' },
  ],
};

test('目录解析：取 id 与绝对推理 URL，相对路径/缺失一律忽略', () => {
  assert.deepEqual(extractModelIds(CATALOG), [
    'no-url-model',
    'openai/gpt-image-2.6/sunburst/text-to-image',
    'openai/gpt-image-2/edit',
    'relative-url-model',
  ]);
  const urls = extractModelInvocationUrls(CATALOG);
  assert.equal(urls['openai/gpt-image-2.6/sunburst/text-to-image'], 'https://fal.run/openai/gpt-image-2.6/sunburst/text-to-image');
  assert.equal(urls['openai/gpt-image-2/edit'], 'https://fal.run/openai/gpt-image-2/edit');
  assert.equal(urls['no-url-model'], undefined);
  assert.equal(urls['relative-url-model'], undefined, '相对路径不能当推理地址');
});

test('目录解析：兼容 one-api/new-api 的信封形状', () => {
  const wrapped = { code: 0, msg: 'ok', data: { object: 'list', data: CATALOG.items } };
  assert.equal(extractModelIds(wrapped).length, 4);
  assert.equal(Object.keys(extractModelInvocationUrls(wrapped)).length, 2);
});

test('目录给了推理 URL 时优先使用，不再拼 baseUrl', async () => {
  let seenUrl;
  const client = createModelClient({
    nodes: () => [{
      name: 'fal',
      dialect: 'fal',
      baseUrl: 'https://fal.ai/api',
      apiKey: 'k',
      models: ['openai/gpt-image-2/edit'],
      modelInvocationUrls: { 'openai/gpt-image-2/edit': 'https://fal.run/openai/gpt-image-2/edit' },
    }],
    registry: () => createCapabilityRegistry(),
    retries: 0,
    failover: false,
    transport: async (request) => {
      seenUrl = request.url;
      return { status: 200, data: { images: [{ url: 'https://cdn.test/a.png' }] } };
    },
  });
  await client.editImage(0, { model: 'openai/gpt-image-2/edit', prompt: 'x', images: ['https://img.test/a.png'], timeoutMs: 5000 });
  assert.equal(seenUrl, 'https://fal.run/openai/gpt-image-2/edit');
});

test('目录没给 URL 的模型回退到 baseUrl 拼接（自建代理仍可用）', async () => {
  let seenUrl;
  const client = createModelClient({
    nodes: () => [{
      name: 'proxy',
      dialect: 'fal',
      baseUrl: 'https://my-proxy.test',
      apiKey: 'k',
      models: ['fal-ai/flux/schnell'],
      modelInvocationUrls: { 'other/model': 'https://elsewhere.test/other/model' },
    }],
    registry: () => createCapabilityRegistry(),
    retries: 0,
    failover: false,
    transport: async (request) => {
      seenUrl = request.url;
      return { status: 200, data: { images: [{ url: 'https://cdn.test/a.png' }] } };
    },
  });
  await client.generateImages(0, { model: 'fal-ai/flux/schnell', prompt: 'x', count: 1, timeoutMs: 5000 });
  assert.equal(seenUrl, 'https://my-proxy.test/fal-ai/flux/schnell');
});