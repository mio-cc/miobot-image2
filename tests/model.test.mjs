import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createCapabilityRegistry,
  createModelClient,
  openAiDialect,
  anthropicDialect,
  geminiDialect,
  huggingFaceDialect,
  customDialect,
  ModelError,
} from '../dist/packages/model/src/index.js';

// ── 能力注册表 ──────────────────────────────────────────────

test('capability: 内置档案推断', () => {
  const reg = createCapabilityRegistry();
  assert.equal(reg.can('gpt-image-2', 'image.generate'), true);
  assert.equal(reg.can('gpt-image-2', 'image.edit'), true);
  assert.equal(reg.can('dall-e-3', 'image.edit'), false);
  assert.equal(reg.can('dall-e-3', 'image.generate'), true);
  assert.equal(reg.can('gpt-4o', 'vision'), true);
  assert.equal(reg.can('deepseek-chat', 'vision'), false);
  assert.equal(reg.can('deepseek-chat', 'chat'), true);
});

test('capability: 用户覆盖（精确 + 正则）', () => {
  const reg = createCapabilityRegistry({ overrides: [
    { model: 'my-image-model', operations: ['image.generate'] },
    { model: '/^flux-.+/i', operations: ['image.generate', 'image.edit'] },
  ] });
  assert.equal(reg.can('my-image-model', 'image.generate'), true);
  assert.equal(reg.can('my-image-model', 'chat'), false);
  assert.equal(reg.can('flux-pro', 'image.edit'), true);
});

// ── 方言请求构造 ──────────────────────────────────────────────

test('openai: chat 请求形状', () => {
  const plan = openAiDialect.buildChat({ baseUrl: 'https://api.x.com/v1', apiKey: 'k' }, { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(plan.url, 'https://api.x.com/v1/chat/completions');
  assert.equal(plan.headers.Authorization, 'Bearer k');
  assert.equal(plan.body.model, 'gpt-4o');
});

test('anthropic: system 拆分 + x-api-key + max_tokens', () => {
  const plan = anthropicDialect.buildChat(
    { baseUrl: 'https://api.anthropic.com', apiKey: 'sk' },
    { model: 'claude-3-5-sonnet', messages: [{ role: 'system', content: 'be nice' }, { role: 'user', content: 'hi' }] },
  );
  assert.equal(plan.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(plan.headers['x-api-key'], 'sk');
  assert.equal(plan.headers['anthropic-version'], '2023-06-01');
  assert.equal(plan.body.system, 'be nice');
  assert.equal(plan.body.max_tokens, 1024);
  assert.equal(plan.body.messages.length, 1);
});

test('anthropic: 解析 content blocks', () => {
  const r = anthropicDialect.parseChat({ content: [{ type: 'text', text: '你好' }] });
  assert.equal(r.text, '你好');
});

test('gemini: url 带模型 + contents + 头', () => {
  const plan = geminiDialect.buildChat({ baseUrl: 'https://gen.googleapis.com', apiKey: 'g' }, { model: 'gemini-1.5-pro', messages: [{ role: 'user', content: 'hi' }] });
  assert.match(plan.url, /\/v1beta\/models\/gemini-1\.5-pro:generateContent$/);
  assert.equal(plan.headers['x-goog-api-key'], 'g');
  assert.ok(Array.isArray(plan.body.contents));
});

test('gemini: 解析 candidates', () => {
  const r = geminiDialect.parseChat({ candidates: [{ content: { parts: [{ text: 'hello' }] } }] });
  assert.equal(r.text, 'hello');
});

test('huggingface: legacy-inference 用 inputs，解析 generated_text', () => {
  const node = { baseUrl: 'https://api-inference.huggingface.co', apiKey: 't', requestMode: 'legacy-inference' };
  const plan = huggingFaceDialect.buildChat(node, { model: 'gpt2', messages: [{ role: 'user', content: 'hi' }] });
  assert.match(plan.url, /\/models\/gpt2$/);
  assert.ok('inputs' in plan.body);
  assert.equal(huggingFaceDialect.parseChat([{ generated_text: 'out' }]).text, 'out');
});

test('huggingface: openai-chat 模式走 /chat/completions', () => {
  const node = { baseUrl: 'https://router.huggingface.co/v1', apiKey: 't', requestMode: 'openai-chat' };
  const plan = huggingFaceDialect.buildChat(node, { model: 'meta-llama/x', messages: [{ role: 'user', content: 'hi' }] });
  assert.match(plan.url, /\/chat\/completions$/);
});

test('custom: 自定义鉴权头与路径', () => {
  const node = { baseUrl: 'https://my.api', apiKey: 'k', custom: { chatPath: '/v2/talk', authHeader: 'X-Key', authPrefix: '' } };
  const plan = customDialect.buildChat(node, { model: 'm', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(plan.url, 'https://my.api/v2/talk');
  assert.equal(plan.headers['X-Key'], 'k');
});

// ── ModelClient 端到端（fake transport）──────────────────────────────────────

function fakeTransport(handler) {
  const calls = [];
  const fn = async (req) => { calls.push(req); return handler(req, calls.length); };
  fn.calls = calls;
  return fn;
}

test('client: chat 经 fake transport 返回文本', async () => {
  const transport = fakeTransport(() => ({ status: 200, data: { choices: [{ message: { content: '回答' } }] } }));
  const client = createModelClient({ nodes: [{ baseUrl: 'https://a/v1', apiKey: 'k' }], transport });
  const r = await client.chat(0, { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(r.text, '回答');
});

test('client: 能力门控 —— 在纯文本模型上生图直接报错', async () => {
  const transport = fakeTransport(() => ({ status: 200, data: {} }));
  const client = createModelClient({ nodes: [{ baseUrl: 'https://a/v1' }], transport });
  await assert.rejects(
    () => client.generateImages(0, { model: 'deepseek-chat', prompt: 'x' }),
    (e) => e instanceof ModelError && e.code === 'capability_unsupported',
  );
  assert.equal(transport.calls.length, 0); // 未发任何请求
});

test('client: 按节点方言选择（anthropic 节点用 x-api-key 并解析 blocks）', async () => {
  const transport = fakeTransport((req) => {
    assert.equal(req.headers['x-api-key'], 'sk');
    return { status: 200, data: { content: [{ type: 'text', text: 'claude说' }] } };
  });
  const client = createModelClient({ nodes: [{ baseUrl: 'https://api.anthropic.com', apiKey: 'sk', dialect: 'anthropic' }], transport });
  const r = await client.chat(0, { model: 'claude-3-5-sonnet', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(r.text, 'claude说');
});

test('client: failover —— 主节点 500，切到同名模型的备用节点', async () => {
  const transport = fakeTransport((req) => {
    if (req.url.includes('primary')) return { status: 500, data: { error: { message: 'boom' } } };
    return { status: 200, data: { choices: [{ message: { content: 'backup回答' } }] } };
  });
  const client = createModelClient({
    nodes: [
      { name: 'primary', baseUrl: 'https://primary/v1', apiKey: 'k', models: ['gpt-4o'] },
      { name: 'backup', baseUrl: 'https://backup/v1', apiKey: 'k', models: ['gpt-4o'] },
    ],
    transport,
  });
  const r = await client.chat(0, { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(r.text, 'backup回答');
});

test('client: 无备用节点时 500 抛出', async () => {
  const transport = fakeTransport(() => ({ status: 500, data: { error: { message: 'boom' } } }));
  const client = createModelClient({ nodes: [{ baseUrl: 'https://only/v1', apiKey: 'k', models: ['gpt-4o'] }], transport });
  await assert.rejects(() => client.chat(0, { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }));
});

test('client: 生图解析 b64_json', async () => {
  const transport = fakeTransport(() => ({ status: 200, data: { data: [{ b64_json: 'AAAA' }] } }));
  const client = createModelClient({ nodes: [{ baseUrl: 'https://a/v1', apiKey: 'k' }], transport });
  const r = await client.generateImages(0, { model: 'gpt-image-2', prompt: 'cat' });
  assert.equal(r.images[0].kind, 'base64');
  assert.equal(r.images[0].data, 'AAAA');
});
