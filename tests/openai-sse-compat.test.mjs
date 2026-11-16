// OpenAI 方言的 SSE 兼容（2026-11-16 实测 api.howtofix.id）：
// 部分中转网关即使没请求 stream，也硬回 text/event-stream（nemotron-vl-free / beam-free）。
// 旧解析器只认 JSON 对象，这类模型在 harness 里永远「响应解析失败」。
// 契约：非流式请求收到 SSE 时，自动重组为 chat.completion 再走原解析路径。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCapabilityRegistry, createModelClient, parseOpenAiSseText } from '../dist/packages/model/src/index.js';

const SSE_SAMPLE = [
  'data: {"id":"c1","object":"chat.completion.chunk","model":"beam-free","choices":[{"index":0,"finish_reason":null,"delta":{"role":"assistant","reasoning_content":"用"}}]}',
  'data: {"id":"c1","object":"chat.completion.chunk","model":"beam-free","choices":[{"index":0,"finish_reason":null,"delta":{"role":"assistant","content":"你"}}]}',
  'data: {"id":"c1","object":"chat.completion.chunk","model":"beam-free","choices":[{"index":0,"finish_reason":"stop","delta":{"role":"assistant","content":"好"}}]}',
  'data: {"id":"c1","object":"chat.completion.chunk","model":"beam-free","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":3,"total_tokens":13}}',
  'data: [DONE]',
].join('\n');

test('parseOpenAiSseText 把 SSE 重组为普通 completion 对象', () => {
  const obj = parseOpenAiSseText(SSE_SAMPLE);
  assert.ok(obj);
  assert.equal(obj.choices[0].message.content, '你好');
  assert.equal(obj.choices[0].finish_reason, 'stop');
  assert.deepEqual(obj.usage, { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 });
});

test('SSE 只有 reasoning 时用 reasoning 兜底', () => {
  const obj = parseOpenAiSseText('data: {"choices":[{"delta":{"reasoning_content":"结论是：对"}}]}');
  assert.equal(obj?.choices[0].message.content, '结论是：对');
});

test('非流式请求收到 SSE：ModelClient 正常返回文本与 usage', async () => {
  const reg = createCapabilityRegistry();
  const client = createModelClient({
    nodes: () => [{ name: 'sse', baseUrl: 'https://sse.test/v1', dialect: 'openai', apiKey: 'k', models: ['beam-free'] }],
    registry: () => reg,
    retries: 0,
    failover: false,
    transport: async () => ({ status: 200, data: SSE_SAMPLE }),
  });
  const res = await client.chat(0, { model: 'beam-free', messages: [{ role: 'user', content: '只回：你好' }], maxTokens: 32 });
  assert.equal(res.text, '你好');
  assert.equal(res.finishReason, 'stop');
  assert.equal(res.usage?.promptTokens, 10);
  assert.equal(res.usage?.completionTokens, 3);
});

test('vision 走同一 SSE 兼容路径', async () => {
  const reg = createCapabilityRegistry();
  const client = createModelClient({
    nodes: () => [{ name: 'sse', baseUrl: 'https://sse.test/v1', dialect: 'openai', apiKey: 'k', models: ['vl-free'] }],
    registry: () => reg,
    retries: 0,
    failover: false,
    transport: async () => ({ status: 200, data: 'data: {"choices":[{"delta":{"content":"一张图"}}]}' }),
  });
  const res = await client.vision(0, { model: 'vl-free', prompt: '是什么', imageUrls: ['data:image/png;base64,xx'], maxTokens: 16 });
  assert.equal(res.text, '一张图');
});

test('text/plain 的 JSON 字符串也能解析（有的网关不打 json content-type）', async () => {
  const reg = createCapabilityRegistry();
  const client = createModelClient({
    nodes: () => [{ name: 'plain', baseUrl: 'https://plain.test/v1', dialect: 'openai', apiKey: 'k' }],
    registry: () => reg,
    retries: 0,
    failover: false,
    transport: async () => ({ status: 200, data: JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }) }),
  });
  const res = await client.chat(0, { model: 'x', messages: [{ role: 'user', content: 'hi' }], maxTokens: 16 });
  assert.equal(res.text, 'ok');
});

test('既不是 JSON 也不是 SSE → 可读错误', async () => {
  const reg = createCapabilityRegistry();
  const client = createModelClient({
    nodes: () => [{ name: 'bad', baseUrl: 'https://bad.test/v1', dialect: 'openai', apiKey: 'k' }],
    registry: () => reg,
    retries: 0,
    failover: false,
    transport: async () => ({ status: 200, data: '<html>gateway error</html>' }),
  });
  await assert.rejects(
    () => client.chat(0, { model: 'x', messages: [{ role: 'user', content: 'hi' }], maxTokens: 16 }),
    (err) => err.code === 'unparseable_response',
  );
});