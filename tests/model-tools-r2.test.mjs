import test from 'node:test';
import assert from 'node:assert/strict';
import {
  anthropicDialect,
  customDialect,
  createModelClient,
  geminiDialect,
  openAiDialect,
} from '../dist/packages/model/src/index.js';
import { normalizeToolSpec } from '../dist/packages/tool-runtime/src/index.js';

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

const node = { baseUrl: 'https://provider.example/v1', apiKey: 'k', dialect: 'openai' };
const messages = [
  { role: 'user', content: '画一只猫' },
  {
    role: 'assistant',
    content: '',
    toolCalls: [{ id: 'call_1', name: 'image.generate', arguments: { prompt: '猫' } }],
  },
  { role: 'tool', toolCallId: 'call_1', name: 'image.generate', content: '{"ok":true,"content":"queued"}' },
];

test('model R2: OpenAI dialect builds native tools and refills tool result messages', () => {
  const plan = openAiDialect.buildChat(node, {
    model: 'gpt-4o',
    messages,
    toolSpecs: [imageSpec],
    toolChoice: 'required',
  });
  assert.equal(plan.body.tools[0].type, 'function');
  assert.equal(plan.body.tools[0].function.name, 'image_generate');
  assert.equal(plan.body.tool_choice, 'required');
  assert.equal(plan.body.messages[1].tool_calls[0].function.name, 'image_generate');
  assert.equal(plan.body.messages[2].role, 'tool');
  assert.equal(plan.body.messages[2].tool_call_id, 'call_1');

  const parsed = openAiDialect.parseChat({
    choices: [{
      finish_reason: 'tool_calls',
      message: { content: null, tool_calls: [{ id: 'call_1', function: { name: 'image_generate', arguments: '{"prompt":"猫"}' } }] },
    }],
  }, { toolProtocol: 'native', toolNames: ['image.generate'] });
  assert.equal(parsed.toolCalls[0].name, 'image.generate');
  assert.equal(parsed.toolCalls[0].id, 'call_1');
  assert.equal(parsed.finishReason, 'tool_calls');
});

test('model R2: Anthropic dialect builds native tools and parses tool_use blocks', () => {
  const plan = anthropicDialect.buildChat({ ...node, baseUrl: 'https://api.anthropic.com' }, {
    model: 'claude-sonnet',
    messages,
    toolSpecs: [imageSpec],
    toolChoice: 'auto',
  });
  assert.equal(plan.body.tools[0].name, 'image_generate');
  assert.deepEqual(plan.body.tool_choice, { type: 'auto' });
  const assistant = plan.body.messages.find((message) => message.role === 'assistant');
  const toolResult = plan.body.messages.find((message) => message.role === 'user' && Array.isArray(message.content));
  assert.equal(assistant.content[0].type, 'tool_use');
  assert.equal(toolResult.content[0].type, 'tool_result');

  const parsed = anthropicDialect.parseChat({
    content: [{ type: 'tool_use', id: 'toolu_1', name: 'image_generate', input: { prompt: '猫' } }],
    stop_reason: 'tool_use',
  }, { toolProtocol: 'native', toolNames: ['image.generate'] });
  assert.equal(parsed.toolCalls[0].name, 'image.generate');
  assert.equal(parsed.toolCalls[0].id, 'toolu_1');
  assert.equal(parsed.finishReason, 'tool_use');
});

test('model R2: Gemini dialect builds functionDeclarations/toolConfig and parses functionCall', () => {
  const plan = geminiDialect.buildChat({ ...node, baseUrl: 'https://generativelanguage.googleapis.com', dialect: 'gemini' }, {
    model: 'gemini-2.5-flash',
    messages,
    toolSpecs: [imageSpec],
    toolChoice: 'required',
  });
  assert.equal(plan.body.tools[0].functionDeclarations[0].name, 'image_generate');
  assert.deepEqual(plan.body.toolConfig, { functionCallingConfig: { mode: 'ANY' } });
  assert.equal(plan.body.contents[1].role, 'model');
  assert.equal(plan.body.contents[1].parts[0].functionCall.name, 'image_generate');
  assert.equal(plan.body.contents[2].role, 'user');
  assert.equal(plan.body.contents[2].parts[0].functionResponse.name, 'image_generate');

  const parsed = geminiDialect.parseChat({
    candidates: [{ content: { parts: [{ functionCall: { name: 'image_generate', args: { prompt: '猫' } } }] }, finishReason: 'STOP' }],
  }, { toolProtocol: 'native', toolNames: ['image.generate'] });
  assert.equal(parsed.toolCalls[0].name, 'image.generate');
  assert.match(parsed.toolCalls[0].id, /^gemini_call_/);
});

test('model R2: unsupported/custom provider uses JSON fallback prompt and parses envelope', () => {
  const plan = customDialect.buildChat({ baseUrl: 'https://custom.example', apiKey: 'k', dialect: 'custom' }, {
    model: 'custom-model',
    messages: [{ role: 'user', content: '画一只猫' }],
    toolSpecs: [imageSpec],
    toolProtocol: 'json-fallback',
  });
  assert.equal(plan.body.tools, undefined);
  assert.equal(plan.body.messages[0].role, 'system');
  assert.match(plan.body.messages[0].content, /image\.generate/);
  assert.match(plan.body.messages[0].content, /toolCalls/);

  const parsed = customDialect.parseChat({
    choices: [{
      finish_reason: 'stop',
      message: { content: '{"text":"","toolCalls":[{"id":"call_1","name":"image.generate","arguments":{"prompt":"猫"}}]}' },
    }],
  }, { toolProtocol: 'json-fallback', toolNames: ['image.generate'] });
  assert.equal(parsed.toolCalls[0].name, 'image.generate');
  assert.deepEqual(parsed.toolCalls[0].arguments, { prompt: '猫' });
});

test('model R2: ModelClient passes canonical tools and returns canonical tool calls end-to-end', async () => {
  const calls = [];
  const transport = async (request) => {
    calls.push(request);
    return {
      status: 200,
      data: {
        choices: [{
          finish_reason: 'tool_calls',
          message: { content: null, tool_calls: [{ id: 'call_42', function: { name: 'image_generate', arguments: '{"prompt":"猫"}' } }] },
        }],
      },
    };
  };
  const client = createModelClient({
    nodes: [{ baseUrl: 'https://api.example/v1', apiKey: 'k', dialect: 'openai' }],
    transport,
  });
  const result = await client.chat(0, {
    model: 'gpt-4o',
    messages: [{ role: 'user', content: '画猫' }],
    toolSpecs: [imageSpec],
    toolChoice: 'required',
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.tools[0].function.name, 'image_generate');
  assert.equal(calls[0].body.tool_choice, 'required');
  assert.equal(result.toolCalls[0].name, 'image.generate');
  assert.equal(result.toolCalls[0].id, 'call_42');
});

test('model R9 BUG-7: array response content joins with a real newline', () => {
  const result = openAiDialect.parseChat({
    choices: [{
      message: { content: [{ type: 'text', text: '第一行' }, { type: 'text', text: '第二行' }] },
    }],
  });
  assert.equal(result.text, '第一行\n第二行');
});