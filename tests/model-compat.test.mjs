import test from 'node:test';
import assert from 'node:assert/strict';

import { createCapabilityRegistry, createModelClient, ModelError } from '../dist/packages/model/src/index.js';

// ── 能力识别：区分 生图 / 多模态 / 纯文本 ─────────────────────────
test('capability: grok-2-image 识别为生图，不是聊天/视觉', () => {
  const reg = createCapabilityRegistry();
  assert.equal(reg.can('grok-2-image', 'image.generate'), true);
  assert.equal(reg.can('grok-2-image', 'image.edit'), false);
  assert.equal(reg.can('grok-2-image', 'chat'), false);
  assert.equal(reg.can('grok-2-image', 'vision'), false);
});

test('capability: gemini 原生生图 vs gemini 对话 区分正确', () => {
  const reg = createCapabilityRegistry();
  assert.equal(reg.can('gemini-2.5-flash-image', 'image.generate'), true);
  assert.equal(reg.can('gemini-2.5-flash-image', 'image.edit'), true);
  assert.equal(reg.can('gemini-1.5-pro', 'image.generate'), false);
  assert.equal(reg.can('gemini-1.5-pro', 'vision'), true);
  assert.equal(reg.can('imagen-3.0', 'image.generate'), true);
});

test('capability: grok 视觉/文本、qwen 系列、dall-e-2 区分', () => {
  const reg = createCapabilityRegistry();
  assert.equal(reg.can('grok-2-vision-1212', 'vision'), true);
  assert.equal(reg.can('qwen-image', 'image.generate'), true);
  assert.equal(reg.can('qwen2.5-vl-7b-instruct', 'vision'), true);
  assert.equal(reg.can('qwen-plus', 'chat'), true);
  assert.equal(reg.can('qwen-plus', 'vision'), false);
  assert.equal(reg.can('dall-e-2', 'image.edit'), true);
  assert.equal(reg.can('dall-e-3', 'image.edit'), false);
});

// ── 参数规整：按档案剔除不支持的 size/quality ─────────────────────────
function fakeTransport(handler) {
  const calls = [];
  const fn = async (req) => { calls.push(req); return handler(req, calls.length); };
  fn.calls = calls;
  return fn;
}

test('shaping: grok-2-image 生图不携带 size/quality（避免上游报错）', async () => {
  const transport = fakeTransport(() => ({ status: 200, data: { data: [{ b64_json: 'AAAA' }] } }));
  const client = createModelClient({ nodes: [{ baseUrl: 'https://api.x.ai/v1', apiKey: 'k', dialect: 'openai' }], transport });
  const r = await client.generateImages(0, { model: 'grok-2-image', prompt: 'cat', size: '1024x1024', quality: 'high', count: 3 });
  assert.equal(r.images[0].data, 'AAAA');
  const body = transport.calls[0].body;
  assert.equal('size' in body, false);
  assert.equal('quality' in body, false);
  assert.equal(body.n, 3); // grok 支持 n
});

test('shaping: gpt-image 合法 size 透传、非法 size 被剔除', async () => {
  const transport = fakeTransport(() => ({ status: 200, data: { data: [{ b64_json: 'AAAA' }] } }));
  const client = createModelClient({ nodes: [{ baseUrl: 'https://a/v1', apiKey: 'k' }], transport });
  await client.generateImages(0, { model: 'gpt-image-2', prompt: 'cat', size: '1024x1024' });
  assert.equal(transport.calls[0].body.size, '1024x1024');
  await client.generateImages(0, { model: 'gpt-image-2', prompt: 'cat', size: '999x999' });
  assert.equal('size' in transport.calls[1].body, false);
});

test('shaping: dall-e-3 强制 n=1（不支持多图）', async () => {
  const transport = fakeTransport(() => ({ status: 200, data: { data: [{ b64_json: 'AAAA' }] } }));
  const client = createModelClient({ nodes: [{ baseUrl: 'https://a/v1', apiKey: 'k' }], transport });
  await client.generateImages(0, { model: 'dall-e-3', prompt: 'cat', count: 5 });
  assert.equal(transport.calls[0].body.n, 1);
});

// ── Gemini 原生生图：generateContent + 解析 inlineData ─────────────────────────
test('gemini: 原生生图走 generateContent，解析 inlineData 为 base64 图', async () => {
  const transport = fakeTransport((req) => {
    assert.match(req.url, /:generateContent$/);
    assert.deepEqual(req.body.generationConfig.responseModalities, ['TEXT', 'IMAGE']);
    return { status: 200, data: { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'ZZZ' } }] } }] } };
  });
  const client = createModelClient({ nodes: [{ baseUrl: 'https://gen.googleapis.com', apiKey: 'g', dialect: 'gemini' }], transport });
  const r = await client.generateImages(0, { model: 'gemini-2.5-flash-image', prompt: '一只猫', size: '1024x1024' });
  assert.equal(r.images[0].kind, 'base64');
  assert.equal(r.images[0].data, 'ZZZ');
  assert.equal(r.images[0].mimeType, 'image/png');
  // size 被规整剔除（Gemini 不接受）
  assert.equal('size' in transport.calls[0].body, false);
});

test('gemini: 对话模型上请求生图被能力门控拦截（不发请求）', async () => {
  const transport = fakeTransport(() => ({ status: 200, data: {} }));
  const client = createModelClient({ nodes: [{ baseUrl: 'https://gen.googleapis.com', apiKey: 'g', dialect: 'gemini' }], transport });
  await assert.rejects(
    () => client.generateImages(0, { model: 'gemini-1.5-pro', prompt: 'x' }),
    (e) => e instanceof ModelError && e.code === 'capability_unsupported',
  );
  assert.equal(transport.calls.length, 0);
});

test('override: 用户可强制声明某模型支持生图且无 size', () => {
  const reg = createCapabilityRegistry({ overrides: [{ model: 'my-grok-img', operations: ['image.generate'], supportsSize: false, supportsQuality: false }] });
  assert.equal(reg.can('my-grok-img', 'image.generate'), true);
  assert.equal(reg.profileOf('my-grok-img').supportsSize, false);
});
