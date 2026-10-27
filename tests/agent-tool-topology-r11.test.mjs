import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentHost } from '../dist/apps/bot/src/agent-host.js';
import { createDefaultConfig } from '../dist/packages/config/src/index.js';
import { InMemoryAgentSessionManager } from '../dist/packages/agent-runtime/src/index.js';
import { normalizeToolSpec } from '../dist/packages/tool-runtime/src/index.js';

function spec(name, properties, required, description) {
  return normalizeToolSpec({
    name, title: name, description,
    inputSchema: { type: 'object', properties, required, additionalProperties: false },
    outputKinds: ['text'], riskLevel: 'low', exposure: 'core',
  });
}

test('agent topology: file.read result is reused by file.generate in a later round', async () => {
  const cfg = createDefaultConfig();
  cfg.agent.enabled = true;
  cfg.agent.mode = 'enforce';
  cfg.agent.mainModel = 'mock';
  cfg.toolRegistry.enabled = true;
  const calls = [];
  const requests = [];
  let round = 0;
  const client = {
    async chat(_node, request) {
      requests.push(request);
      round += 1;
      if (round === 1) {
        return { text: '', raw: {}, finishReason: 'tool_calls', toolCalls: [
          { id: 'read-1', name: 'file.read', arguments: { path: 'input.txt' } },
        ] };
      }
      if (round === 2) {
        const toolMessage = request.messages.find((message) => message.role === 'tool');
        assert.ok(toolMessage);
        assert.match(String(toolMessage.content || ''), /文件内容标记/);
        return { text: '', raw: {}, finishReason: 'tool_calls', toolCalls: [
          { id: 'write-1', name: 'file.generate', arguments: { name: 'summary.txt', content: '摘要来自文件内容标记' } },
        ] };
      }
      return { text: '文件摘要已生成', raw: {}, finishReason: 'stop' };
    },
  };
  const host = createAgentHost({
    getConfig: () => cfg,
    client,
    sessions: new InMemoryAgentSessionManager(),
    toolBindings: () => [
      { spec: spec('file.read', { path: { type: 'string' } }, ['path'], '读取文件'), handler: async (call) => {
        calls.push({ name: call.name, args: call.arguments });
        return { ok: true, content: '文件内容标记：测试文本', outputs: [{ kind: 'text', text: '文件内容标记：测试文本' }] };
      } },
      { spec: spec('file.generate', { name: { type: 'string' }, content: { type: 'string' } }, ['name', 'content'], '生成文件'), handler: async (call) => {
        calls.push({ name: call.name, args: call.arguments });
        return { ok: true, content: 'FILE_OK', outputs: [{ kind: 'text', text: 'FILE_OK' }] };
      } },
    ],
    preflightToolCall: () => ({ allowed: true }),
    isReadOnlyTool: (name) => name === 'file.read',
    isMigratedTool: () => true,
  });
  const outcome = await host({ text: '读取文件并生成摘要', chatType: 'private', userId: '1', sessionId: 'private:1', userRole: 'user' });
  assert.equal(outcome.status, 'completed');
  assert.equal(outcome.handled, true);
  assert.deepEqual(calls.map((call) => call.name), ['file.read', 'file.generate']);
  assert.match(String(calls[1].args.content), /文件内容标记/);
  assert.equal(requests.length, 3);
  assert.match(outcome.text, /摘要已生成/);
});

test('agent topology: music history result is reused by lyrics lookup', async () => {
  const cfg = createDefaultConfig();
  cfg.agent.enabled = true;
  cfg.agent.mode = 'enforce';
  cfg.agent.mainModel = 'mock';
  cfg.toolRegistry.enabled = true;
  const calls = [];
  let round = 0;
  const client = {
    async chat(_node, request) {
      round += 1;
      if (round === 1) return { text: '', raw: {}, finishReason: 'tool_calls', toolCalls: [{ id: 'history-1', name: 'audio.music.history', arguments: {} }] };
      if (round === 2) {
        const tool = request.messages.find((message) => message.role === 'tool');
        assert.ok(tool);
        assert.match(String(tool.content || ''), /hist-1/);
        return { text: '', raw: {}, finishReason: 'tool_calls', toolCalls: [{ id: 'lyrics-1', name: 'audio.music.lyrics', arguments: { recordId: 'hist-1' } }] };
      }
      return { text: '歌词已找到', raw: {}, finishReason: 'stop' };
    },
  };
  const host = createAgentHost({
    getConfig: () => cfg, client, sessions: new InMemoryAgentSessionManager(),
    toolBindings: () => [
      { spec: spec('audio.music.history', {}, [], '歌曲历史'), handler: async (call) => { calls.push(call.name); return { ok: true, content: '歌曲历史 recordId=hist-1', outputs: [{ kind: 'text', text: '歌曲历史 recordId=hist-1' }] }; } },
      { spec: spec('audio.music.lyrics', { recordId: { type: 'string' } }, ['recordId'], '歌词'), handler: async (call) => { calls.push(call.name); return { ok: true, content: '歌词内容', outputs: [{ kind: 'text', text: '歌词内容' }] }; } },
    ],
    preflightToolCall: () => ({ allowed: true }),
    isReadOnlyTool: () => true,
    isMigratedTool: () => true,
  });
  const outcome = await host({ text: '查历史歌词', chatType: 'private', userId: '1', sessionId: 'private:history', userRole: 'user' });
  assert.equal(outcome.status, 'completed');
  assert.deepEqual(calls, ['audio.music.history', 'audio.music.lyrics']);
});
