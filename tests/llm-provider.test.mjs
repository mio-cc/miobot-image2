import test from 'node:test';
import assert from 'node:assert/strict';

import { TaskQueue } from '../dist/packages/core/src/index.js';
import {
  OpenAICompatibleAdapter,
  extractBase64Images,
  parseImageResponse,
  parseTextCompletionResponse,
} from '../dist/packages/llm/src/index.js';

const node = { name: 'Test Node', provider: 'openai', baseUrl: 'http://localhost:8317/v1', apiKey: 'test-key' };

test('llm parser: parses chat choices message content', () => {
  const result = parseTextCompletionResponse({ choices: [{ message: { content: 'hello text' } }] });
  assert.equal(result.text, 'hello text');
});

test('llm parser: parses text from multimodal content parts', () => {
  const result = parseTextCompletionResponse({ choices: [{ message: { content: [{ type: 'text', text: 'line 1' }, { type: 'text', text: 'line 2' }] } }] });
  assert.equal(result.text, 'line 1\nline 2');
});

test('llm adapter: createText sends OpenAI-compatible chat request', async () => {
  const calls = [];
  const adapter = new OpenAICompatibleAdapter({
    node,
    requestIdFactory: () => 'req_text',
    transport: async (request) => {
      calls.push(request);
      return { status: 200, data: { choices: [{ message: { content: 'ok' } }] } };
    },
  });

  const result = await adapter.createText({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }], maxTokens: 8 });
  assert.equal(result.text, 'ok');
  assert.equal(calls[0].url, 'http://localhost:8317/v1/chat/completions');
  assert.equal(calls[0].headers.Authorization, 'Bearer test-key');
  assert.equal(calls[0].body.max_tokens, 8);
});

test('llm adapter: createVision builds image_url content and parses text', async () => {
  let captured;
  const adapter = new OpenAICompatibleAdapter({
    node,
    transport: async (request) => {
      captured = request.body;
      return { status: 200, data: { output_text: 'vision ok' } };
    },
  });

  const result = await adapter.createVision({ model: 'gpt-4o-mini', prompt: 'describe', imageUrls: ['data:image/png;base64,aaa', 'http://example.test/b.png'] });
  assert.equal(result.text, 'vision ok');
  assert.equal(captured.messages[0].content[0].text, 'describe');
  assert.equal(captured.messages[0].content[1].image_url.url, 'data:image/png;base64,aaa');
  assert.equal(captured.messages[0].content[2].image_url.url, 'http://example.test/b.png');
});

test('llm parser: parses multiple b64_json images in order without duplicating first', () => {
  const result = parseImageResponse({ data: [{ b64_json: 'img-a' }, { b64_json: 'img-b' }, { b64_json: 'img-c' }] });
  assert.deepEqual(result.images.map((image) => image.data), ['img-a', 'img-b', 'img-c']);
  assert.notEqual(result.images[1].data, result.images[0].data);
  assert.notEqual(result.images[2].data, result.images[0].data);
});

test('llm parser: supports base64 and url image fields', () => {
  const result = parseImageResponse({ data: [{ base64: 'raw-base64', mime_type: 'image/png' }, { url: 'https://example.test/image.png' }] });
  assert.deepEqual(result.images.map((image) => image.kind), ['base64', 'url']);
  assert.equal(result.images[0].mimeType, 'image/png');
  assert.equal(result.images[1].data, 'https://example.test/image.png');
});

test('llm parser: extractBase64Images returns every base64 item in order', () => {
  const images = extractBase64Images({ data: [{ b64_json: 'one' }, { url: 'https://example.test/two.png' }, { base64: 'three' }] });
  assert.deepEqual(images, ['one', 'three']);
});

test('llm parser: detects data[].error as upstream provider error', () => {
  assert.throws(
    () => parseImageResponse({ data: [{ error: { message: 'INTERNAL_ERROR', code: 'internal_server_error' } }] }),
    (error) => error?.normalized?.category === 'upstream' && /data\[0\]\.error/.test(error.message),
  );
});

test('llm parser: rejects image item missing b64_json/base64/url', () => {
  assert.throws(
    () => parseImageResponse({ data: [{ revised_prompt: 'no image here' }] }),
    (error) => error?.normalized?.category === 'validation' && /missing b64_json\/base64\/url/.test(error.message),
  );
});

test('llm adapter: generateImages parses multiple response images without first-image repetition', async () => {
  const adapter = new OpenAICompatibleAdapter({
    node,
    transport: async (request) => {
      assert.equal(request.url, 'http://localhost:8317/v1/images/generations');
      assert.equal(request.body.n, 3);
      return { status: 200, data: { data: [{ b64_json: 'a' }, { b64_json: 'b' }, { b64_json: 'c' }] } };
    },
  });
  const result = await adapter.generateImages({ model: 'gpt-image-2', prompt: 'cat', count: 3, size: '1024x1024' });
  assert.deepEqual(result.images.map((image) => image.data), ['a', 'b', 'c']);
});

test('llm adapter: editImage parses image edit responses', async () => {
  let captured;
  const adapter = new OpenAICompatibleAdapter({
    node,
    transport: async (request) => {
      captured = request.body;
      return { status: 200, data: { data: [{ b64_json: 'edited' }] } };
    },
  });
  const result = await adapter.editImage({ model: 'gpt-image-2', prompt: 'make it blue', images: ['base64://input'], mask: 'base64://mask' });
  assert.deepEqual(captured.images, [{ image_url: 'data:image/png;base64,input' }]);
  assert.deepEqual(captured.mask, { image_url: 'data:image/png;base64,mask' });
  assert.equal(result.images[0].data, 'edited');
});

test('llm adapter: editImage keeps legacy json-image request mode available', async () => {
  let captured;
  const adapter = new OpenAICompatibleAdapter({
    node,
    transport: async (request) => {
      captured = request.body;
      return { status: 200, data: { data: [{ b64_json: 'edited' }] } };
    },
  });
  await adapter.editImage({
    model: 'gpt-image-2',
    prompt: 'make it blue',
    images: ['https://example.test/input.png'],
    mask: 'https://example.test/mask.png',
    requestMode: 'json-image',
  });
  assert.equal(captured.image, 'https://example.test/input.png');
  assert.equal(captured.mask, 'https://example.test/mask.png');
  assert.equal(captured.images, undefined);
});

test('llm adapter: editImage supports multipart request mode for inline images', async () => {
  let captured;
  const adapter = new OpenAICompatibleAdapter({
    node,
    transport: async (request) => {
      captured = request;
      return { status: 200, data: { data: [{ b64_json: 'edited' }] } };
    },
  });
  await adapter.editImage({
    model: 'gpt-image-2',
    prompt: 'make it blue',
    images: ['data:image/png;base64,AQID'],
    mask: 'base64://BAUG',
    requestMode: 'multipart',
  });
  assert.ok(captured.body instanceof FormData);
  assert.equal(captured.headers['Content-Type'], undefined);
  const entries = Array.from(captured.body.entries());
  assert.ok(entries.some(([key]) => key === 'image'));
  assert.ok(entries.some(([key]) => key === 'mask'));
});

test('llm adapter: retries retryable transport failures', async () => {
  let calls = 0;
  const adapter = new OpenAICompatibleAdapter({
    node,
    retryPolicy: { retries: 2, delayMs: 1, sleep: async () => undefined },
    transport: async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' });
      return { status: 200, data: { choices: [{ message: { content: 'after retry' } }] } };
    },
  });
  const result = await adapter.createText({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(result.text, 'after retry');
  assert.equal(calls, 2);
});

test('llm adapter: task queue limits same provider/model requests', async () => {
  const queue = new TaskQueue({ defaultConcurrency: 1 });
  let running = 0;
  let maxRunning = 0;
  const release = [];
  const adapter = new OpenAICompatibleAdapter({
    node,
    queue,
    transport: async () => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((resolve) => release.push(resolve));
      running -= 1;
      return { status: 200, data: { choices: [{ message: { content: 'queued' } }] } };
    },
  });

  const first = adapter.createText({ model: 'same-model', messages: [{ role: 'user', content: '1' }] });
  const second = adapter.createText({ model: 'same-model', messages: [{ role: 'user', content: '2' }] });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(maxRunning, 1);
  assert.equal(queue.snapshot()[0].queued, 1);
  release.shift()();
  await new Promise((resolve) => setTimeout(resolve, 0));
  release.shift()();
  assert.deepEqual((await Promise.all([first, second])).map((item) => item.text), ['queued', 'queued']);
});
