import test from 'node:test';
import assert from 'node:assert/strict';

import { inferProfileByName, CHAT_PROFILE, TEXT_ONLY_PROFILE } from '../dist/packages/model/src/capability/profiles.js';
import { createCapabilityRegistry } from '../dist/packages/model/src/capability/registry.js';
import { createModelClient } from '../dist/packages/model/src/index.js';
import { normalizeConfig, createDefaultConfig } from '../dist/packages/config/src/index.js';
import { normalizeImageUrl, extractImages } from '../dist/apps/bot/src/runtime.js';

// ── profiles: 多模态模型正则匹配 ──

test('profiles: deepseek-vl2 命中 CHAT_PROFILE(非 TEXT_ONLY)', () => {
  const p = inferProfileByName('deepseek-vl2');
  assert.ok(p, 'deepseek-vl2 应有 profile');
  assert.deepEqual(p.operations, CHAT_PROFILE.operations);
  assert.ok(p.operations.includes('vision'));
});

test('profiles: deepseek-vl 命中 CHAT_PROFILE', () => {
  const p = inferProfileByName('deepseek-vl');
  assert.ok(p && p.operations.includes('vision'));
});

test('profiles: minimax-vl-01 命中 CHAT_PROFILE', () => {
  const p = inferProfileByName('MiniMax-VL-01');
  assert.ok(p && p.operations.includes('vision'));
});

test('profiles: doubao-vision 命中 CHAT_PROFILE', () => {
  const p = inferProfileByName('doubao-vision-pro');
  assert.ok(p && p.operations.includes('vision'));
});

test('profiles: deepseek-chat 仍为 TEXT_ONLY(不受 vl 规则影响)', () => {
  const p = inferProfileByName('deepseek-chat');
  assert.ok(p, 'deepseek-chat 应有 profile');
  assert.deepEqual(p.operations, TEXT_ONLY_PROFILE.operations);
  assert.ok(!p.operations.includes('vision'));
});

test('profiles: gpt-4o 仍命中 vision', () => {
  const p = inferProfileByName('gpt-4o');
  assert.ok(p && p.operations.includes('vision'));
});

test('profiles: claude-3-5-sonnet 仍命中 vision', () => {
  const p = inferProfileByName('claude-3-5-sonnet-20241022');
  assert.ok(p && p.operations.includes('vision'));
});

test('profiles: grok-2/3/4 命中 vision(xAI grok 内置视觉)', () => {
  for (const name of ['grok-2', 'grok-3', 'grok-4', 'grok-beta', 'grok-fast', 'grok-latest']) {
    const p = inferProfileByName(name);
    assert.ok(p && p.operations.includes('vision'), `${name} 应有 vision 能力`);
  }
});

test('profiles: grok-2-image 命中生图(不误判为 vision)', () => {
  const p = inferProfileByName('grok-2-image');
  assert.ok(p, 'grok-2-image 应有 profile');
  assert.ok(p.operations.includes('image.generate'), 'grok-2-image 应为生图');
  assert.ok(!p.operations.includes('vision'), 'grok-2-image 不应同时有 vision');
});

test('profiles: grok-2-vision 命中 vision', () => {
  const p = inferProfileByName('grok-2-vision');
  assert.ok(p && p.operations.includes('vision'));
});

// ── registry: 兜底为 TEXT_ONLY + overrides 生效 ──

test('registry: 未识别模型兜底为 TEXT_ONLY(不含 vision)', () => {
  const reg = createCapabilityRegistry();
  // TEXT_ONLY_PROFILE = { operations: ['chat'] }: 能 chat 但不能 vision
  assert.ok(!reg.can('some-unknown-model-xyz', 'vision'));
  assert.ok(reg.can('some-unknown-model-xyz', 'chat'));
  assert.ok(!reg.can('some-unknown-model-xyz', 'interrogate'));
});

test('registry: overrides 可给模型补 vision 能力', () => {
  const reg = createCapabilityRegistry({
    overrides: [{ model: 'my-custom-vlm', operations: ['chat', 'vision', 'interrogate'] }],
  });
  assert.ok(reg.can('my-custom-vlm', 'vision'));
  assert.ok(reg.can('my-custom-vlm', 'chat'));
  assert.ok(reg.can('my-custom-vlm', 'interrogate'));
  assert.ok(!reg.can('my-custom-vlm', 'image.generate'));
});

test('registry: overrides 用正则匹配', () => {
  const reg = createCapabilityRegistry({
    overrides: [{ model: '/^grok-\\d+$/', operations: ['chat', 'vision'] }],
  });
  assert.ok(reg.can('grok-2', 'vision'));
  assert.ok(!reg.can('grok-image', 'vision')); // grok-image 是生图,不应被这条 override 命中
});

// ── config: capabilityOverrides 归一化 ──

test('config: 默认 capabilityOverrides 为空数组', () => {
  const cfg = normalizeConfig({});
  assert.deepEqual(cfg.llm.capabilityOverrides, []);
});

test('config: capabilityOverrides 归一化保留合法 operations', () => {
  const cfg = normalizeConfig({
    llm: {
      capabilityOverrides: [
        { model: 'my-vlm', operations: ['chat', 'vision', 'bogus-op'] },
        { model: '/^test-/', operations: ['interrogate'] },
        { model: '', operations: ['chat'] }, // model 为空,过滤掉
      ],
    },
  });
  assert.equal(cfg.llm.capabilityOverrides.length, 2);
  assert.deepEqual(cfg.llm.capabilityOverrides[0].operations, ['chat', 'vision']);
  assert.deepEqual(cfg.llm.capabilityOverrides[1].operations, ['interrogate']);
});

test('config: capabilityOverrides 非数组时归一化为空', () => {
  const cfg = normalizeConfig({ llm: { capabilityOverrides: 'not-an-array' } });
  assert.deepEqual(cfg.llm.capabilityOverrides, []);
});

// ── runtime: normalizeImageUrl base64 归一化 ──

test('normalizeImageUrl: base64:// → data:image/png;base64,', () => {
  assert.equal(
    normalizeImageUrl('base64://iVBORw0KGgoAAAANSUh=='),
    'data:image/png;base64,iVBORw0KGgoAAAANSUh==',
  );
});

test('normalizeImageUrl: base64:(无//) → data:image/png;base64,', () => {
  assert.equal(
    normalizeImageUrl('base64:iVBORw0KGgo=='),
    'data:image/png;base64,iVBORw0KGgo==',
  );
});

test('normalizeImageUrl: http URL 原样保留', () => {
  assert.equal(
    normalizeImageUrl('https://example.com/img.png'),
    'https://example.com/img.png',
  );
});

test('normalizeImageUrl: data: URL 原样保留', () => {
  assert.equal(
    normalizeImageUrl('data:image/jpeg;base64,abc123=='),
    'data:image/jpeg;base64,abc123==',
  );
});

test('extractImages: base64:// 段被归一化为 data: URL', () => {
  const event = {
    message: [{ type: 'image', data: { url: 'base64://iVBORw0KGgo==' } }],
  };
  const imgs = extractImages(event);
  assert.equal(imgs.length, 1);
  assert.ok(imgs[0].startsWith('data:image/png;base64,'));
});

// ── Gemini: http 图片 URL 下载转 base64 ──

function fakeGeminiTransport(capturedBody) {
  return async (req) => {
    if (capturedBody) capturedBody.push(typeof req.body === 'string' ? JSON.parse(req.body) : req.body);
    return { status: 200, data: { candidates: [{ content: { parts: [{ text: 'gemini回答' }] } }] } };
  };
}

test('gemini: vision 时 http 图片 URL 被下载转 base64 inlineData', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = 0;
  globalThis.fetch = async (url) => {
    fetchCalled++;
    assert.equal(url, 'https://example.com/img.png');
    return {
      ok: true,
      status: 200,
      headers: { get: (h) => h === 'content-type' ? 'image/png' : null },
      arrayBuffer: async () => {
        // 1x1 transparent PNG
        const buf = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      },
    };
  };
  try {
    const captured = [];
    const client = createModelClient({
      nodes: [{ baseUrl: 'https://gen.googleapis.com', apiKey: 'g', dialect: 'gemini' }],
      transport: fakeGeminiTransport(captured),
    });
    await client.vision(0, {
      model: 'gemini-2.5-flash',
      prompt: '描述这张图',
      imageUrls: ['https://example.com/img.png'],
    });
    assert.equal(fetchCalled, 1, '应下载 1 次图片');
    assert.equal(captured.length, 1, '应发送 1 次请求');
    // 检查 body 里是 inlineData 而非 fileData
    const parts = captured[0].contents[0].parts;
    const imagePart = parts.find((p) => p.inlineData || p.fileData);
    assert.ok(imagePart, '应有图片 part');
    assert.ok(imagePart.inlineData, '应是 inlineData(下载后的 base64),非 fileData');
    assert.ok(!imagePart.fileData, '不应有 fileData');
    assert.match(imagePart.inlineData.mimeType, /image\/png/);
    assert.ok(imagePart.inlineData.data.length > 10, 'base64 数据非空');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('gemini: data: URL 不下载,原样传 inlineData', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = 0;
  globalThis.fetch = async () => { fetchCalled++; return { ok: true, status: 200, headers: { get: () => 'image/png' }, arrayBuffer: async () => new ArrayBuffer(0) }; };
  try {
    const captured = [];
    const client = createModelClient({
      nodes: [{ baseUrl: 'https://gen.googleapis.com', apiKey: 'g', dialect: 'gemini' }],
      transport: fakeGeminiTransport(captured),
    });
    await client.vision(0, {
      model: 'gemini-2.5-flash',
      prompt: '看图',
      imageUrls: ['data:image/png;base64,iVBORw0KGgo=='],
    });
    assert.equal(fetchCalled, 0, 'data: URL 不应触发下载');
    const parts = captured[0].contents[0].parts;
    const imagePart = parts.find((p) => p.inlineData);
    assert.ok(imagePart, '应有 inlineData');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('openai 方言: http 图片 URL 不下载,原样传 image_url', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = 0;
  globalThis.fetch = async () => { fetchCalled++; return { ok: true, status: 200, headers: { get: () => 'image/png' }, arrayBuffer: async () => new ArrayBuffer(0) }; };
  try {
    const captured = [];
    const transport = async (req) => {
      captured.push(typeof req.body === 'string' ? JSON.parse(req.body) : req.body);
      return { status: 200, data: { choices: [{ message: { content: '回答' } }] } };
    };
    const client = createModelClient({
      nodes: [{ baseUrl: 'https://api.openai.com/v1', apiKey: 'k', dialect: 'openai' }],
      transport,
    });
    await client.vision(0, {
      model: 'gpt-4o',
      prompt: '看图',
      imageUrls: ['https://example.com/img.png'],
    });
    assert.equal(fetchCalled, 0, 'OpenAI 方言不应下载图片');
    // OpenAI 格式: messages[0].content[1].image_url.url
    const content = captured[0].messages[0].content;
    const imagePart = content.find((p) => p.image_url);
    assert.ok(imagePart, '应有 image_url part');
    assert.equal(imagePart.image_url.url, 'https://example.com/img.png');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
