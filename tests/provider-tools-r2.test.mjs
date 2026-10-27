import test from 'node:test';
import assert from 'node:assert/strict';
import {
  anthropicToolAdapter,
  geminiToolAdapter,
  jsonToolAdapter,
  openAiToolAdapter,
  toAnthropicMessages,
  toGeminiContents,
  toJsonFallbackMessages,
  toOpenAiMessages,
  buildJsonFallbackSystemPrompt,
  buildJsonToolCatalog,
} from '../dist/packages/provider-tools/src/index.js';
import { normalizeToolSpec } from '../dist/packages/tool-runtime/src/index.js';
import { classifyProviderError } from '../dist/packages/model/src/index.js';

const imageSpec = normalizeToolSpec({
  name: 'image.generate',
  title: '图片生成',
  description: '生成图片',
  inputSchema: {
    type: 'object',
    properties: { prompt: { type: 'string' } },
    required: ['prompt'],
    additionalProperties: false,
  },
  riskLevel: 'medium',
  outputKinds: ['image'],
});

const imageResult = {
  callId: 'call_1',
  toolName: 'image.generate',
  ok: true,
  content: 'queued',
  outputs: [{ kind: 'image', url: 'https://example.test/a.png' }],
};

test('provider-tools R2: OpenAI builds provider-safe schemas and parses canonical calls', () => {
  const tools = openAiToolAdapter.buildTools([imageSpec]);
  assert.equal(tools[0].type, 'function');
  assert.equal(tools[0].function.name, 'image_generate');
  assert.equal(tools[0].function.parameters.required[0], 'prompt');
  assert.equal(openAiToolAdapter.buildToolChoice('required'), 'required');

  const parsed = openAiToolAdapter.parseToolResponse({
    choices: [{
      finish_reason: 'tool_calls',
      message: { content: null, tool_calls: [{ id: 'call_1', function: { name: 'image_generate', arguments: '{"prompt":"猫"}' } }] },
    }],
  }, { toolNames: ['image.generate'] });
  assert.equal(parsed.issues.length, 0);
  assert.equal(parsed.toolCalls[0].id, 'call_1');
  assert.equal(parsed.toolCalls[0].name, 'image.generate');
  assert.deepEqual(parsed.toolCalls[0].arguments, { prompt: '猫' });

  const malformed = openAiToolAdapter.parseToolResponse({
    choices: [{ message: { tool_calls: [{ id: 'bad', function: { name: 'image_generate', arguments: '{bad' } }] } }],
  }, { toolNames: ['image.generate'] });
  assert.ok(malformed.issues.some((issue) => issue.code === 'malformed_json'));

  const appended = openAiToolAdapter.appendToolResult([
    { role: 'assistant', content: '', toolCalls: parsed.toolCalls },
  ], imageResult);
  const wire = toOpenAiMessages(appended, { toolNames: ['image.generate'] });
  assert.equal(wire[0].tool_calls[0].function.name, 'image_generate');
  assert.equal(wire[1].role, 'tool');
  assert.equal(wire[1].tool_call_id, 'call_1');
  assert.match(wire[1].content, /"ok":true/);
});

test('provider-tools R2: Anthropic builds native tools and merges tool results', () => {
  const tools = anthropicToolAdapter.buildTools([imageSpec]);
  assert.deepEqual(anthropicToolAdapter.buildToolChoice('required'), { type: 'any' });
  assert.equal(tools[0].name, 'image_generate');
  assert.ok(tools[0].input_schema);

  const parsed = anthropicToolAdapter.parseToolResponse({
    content: [
      { type: 'text', text: 'drawing' },
      { type: 'tool_use', id: 'toolu_1', name: 'image_generate', input: { prompt: '猫' } },
    ],
    stop_reason: 'tool_use',
  }, { toolNames: ['image.generate'] });
  assert.equal(parsed.issues.length, 0);
  assert.equal(parsed.toolCalls[0].name, 'image.generate');
  assert.equal(parsed.toolCalls[0].id, 'toolu_1');

  const mapped = toAnthropicMessages([
    { role: 'user', content: '画猫' },
    { role: 'assistant', content: '', toolCalls: [
      { id: 'toolu_1', name: 'image.generate', arguments: { prompt: '猫' } },
      { id: 'toolu_2', name: 'image.generate', arguments: { prompt: '狗' } },
    ] },
    { role: 'tool', toolCallId: 'toolu_1', name: 'image.generate', content: '{"ok":true}' },
    { role: 'tool', toolCallId: 'toolu_2', name: 'image.generate', content: '{"ok":true}', isError: false },
  ], { toolNames: ['image.generate'] });
  assert.equal(mapped.messages.length, 3);
  assert.equal(mapped.messages[1].content[0].type, 'tool_use');
  assert.equal(mapped.messages[1].content[0].name, 'image_generate');
  assert.equal(mapped.messages[2].role, 'user');
  assert.equal(mapped.messages[2].content.length, 2);
  assert.ok(mapped.messages[2].content.every((block) => block.type === 'tool_result'));
});

test('provider-tools R2: Gemini function calls work without provider ids and refill as functionResponse', () => {
  const tools = geminiToolAdapter.buildTools([imageSpec]);
  assert.deepEqual(geminiToolAdapter.buildToolChoice('auto'), { functionCallingConfig: { mode: 'AUTO' } });
  assert.equal(tools[0].functionDeclarations[0].name, 'image_generate');

  const parsed = geminiToolAdapter.parseToolResponse({
    candidates: [{ content: { parts: [{ functionCall: { name: 'image_generate', args: { prompt: '猫' } } }] }, finishReason: 'STOP' }],
  }, { toolNames: ['image.generate'] });
  assert.equal(parsed.issues.length, 0);
  assert.equal(parsed.toolCalls[0].name, 'image.generate');
  assert.match(parsed.toolCalls[0].id, /^gemini_call_/);

  const mapped = toGeminiContents([
    { role: 'user', content: '画猫' },
    { role: 'assistant', content: '', toolCalls: parsed.toolCalls },
    { role: 'tool', toolCallId: parsed.toolCalls[0].id, name: 'image.generate', content: '{"ok":true,"content":"queued"}' },
  ], { toolNames: ['image.generate'] });
  assert.equal(mapped.contents[1].role, 'model');
  assert.equal(mapped.contents[1].parts[0].functionCall.name, 'image_generate');
  assert.equal(mapped.contents[2].role, 'user');
  assert.equal(mapped.contents[2].parts[0].functionResponse.name, 'image_generate');
  assert.equal(mapped.contents[2].parts[0].functionResponse.response.ok, true);
});

test('provider-tools R2: JSON fallback parses envelopes, rejects malformed/truncated calls, and refills results', () => {
  const catalog = buildJsonToolCatalog([imageSpec]);
  assert.equal(catalog.tools[0].name, 'image.generate');
  const prompt = buildJsonFallbackSystemPrompt([imageSpec]);
  assert.match(prompt, /toolCalls/);
  assert.match(prompt, /image\.generate/);

  const parsed = jsonToolAdapter.parseToolResponse('{"text":"","toolCalls":[{"id":"call_1","name":"image.generate","arguments":{"prompt":"猫"}}]}', {
    toolNames: ['image.generate'],
  });
  assert.equal(parsed.issues.length, 0);
  assert.equal(parsed.toolCalls[0].name, 'image.generate');
  assert.deepEqual(parsed.toolCalls[0].arguments, { prompt: '猫' });

  const malformed = jsonToolAdapter.parseToolResponse('{"toolCalls":[', {});
  assert.ok(malformed.issues.some((issue) => issue.code === 'malformed_json'));

  const truncated = jsonToolAdapter.parseToolResponse('{"toolCalls":[{"id":"x","name":"image.generate","arguments":{"prompt":"c', {
    finishReason: 'length',
  });
  assert.ok(truncated.issues.some((issue) => issue.code === 'truncated_output'));
  assert.equal(truncated.truncated, true);

  const plain = jsonToolAdapter.parseToolResponse('正常聊天', {});
  assert.equal(plain.toolCalls.length, 0);
  assert.equal(plain.text, '正常聊天');

  const appended = jsonToolAdapter.appendToolResult([], imageResult);
  const messages = toJsonFallbackMessages(appended);
  assert.equal(messages[0].role, 'user');
  const envelope = JSON.parse(messages[0].content);
  assert.equal(envelope.type, 'tool_result');
  assert.equal(envelope.callId, 'call_1');
  assert.equal(envelope.result.ok, true);
});

test('provider-tools R2: provider errors classify auth/rate/quota/context/content/network/server', () => {
  assert.equal(classifyProviderError({ status: 401, body: { error: { code: 'invalid_api_key', message: 'Invalid API key' } } }).kind, 'authentication');
  assert.equal(classifyProviderError({ status: 429, body: { error: { code: 'rate_limit_exceeded', message: 'slow down' } } }).retryable, true);
  assert.equal(classifyProviderError({ status: 429, body: { error: { code: 'insufficient_quota', message: 'billing' } } }).kind, 'quota_exceeded');
  assert.equal(classifyProviderError({ status: 400, body: { error: { code: 'context_length_exceeded', message: 'too long' } } }).kind, 'context_length');
  assert.equal(classifyProviderError({ status: 400, body: { error: { code: 'content_filter', message: 'blocked' } } }).kind, 'content_filter');
  assert.equal(classifyProviderError({ error: new Error('ECONNRESET') }).kind, 'network');
  assert.equal(classifyProviderError({ status: 503, body: { error: { message: 'overloaded' } } }).kind, 'overloaded');
  assert.equal(classifyProviderError({ status: 500, body: { error: { message: 'boom' } } }).kind, 'server');
});
