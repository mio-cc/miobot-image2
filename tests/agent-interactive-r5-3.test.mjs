import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AgentRuntime,
  InMemoryAgentSessionManager,
} from '../dist/packages/agent-runtime/src/index.js';
import { ToolExecutor, ToolRegistry } from '../dist/packages/tool-runtime/src/index.js';
import { createAgentHost } from '../dist/apps/bot/src/agent-host.js';
import {
  INTERACTIVE_CAPABILITY_TOOLS,
  MIGRATED_CAPABILITY_TOOLS,
  SIDE_EFFECT_CAPABILITY_TOOLS,
} from '../dist/apps/bot/src/capability-tool-adapter.js';
import { createDefaultConfig } from '../dist/packages/config/src/index.js';

test('agent-interactive R5.3: voice.preview and voice.select are migrated interactive tools', () => {
  assert.equal(INTERACTIVE_CAPABILITY_TOOLS.has('voice.preview'), true);
  assert.equal(INTERACTIVE_CAPABILITY_TOOLS.has('voice.select'), true);
  assert.equal(MIGRATED_CAPABILITY_TOOLS.has('voice.preview'), true);
  assert.equal(MIGRATED_CAPABILITY_TOOLS.has('voice.select'), true);
  assert.equal(SIDE_EFFECT_CAPABILITY_TOOLS.has('voice.preview'), true);
  assert.equal(SIDE_EFFECT_CAPABILITY_TOOLS.has('voice.select'), true);
});

test('agent-interactive R5.3: ask_user answer resumes the same agent turn as a tool result', async () => {
  const requests = [];
  let calls = 0;
  const model = {
    async chat(request) {
      requests.push(request);
      calls += 1;
      if (calls === 1) {
        return { assistant: { text: '', toolCalls: [{ id: 'ask_1', name: 'ask_user', arguments: { question: '你要画什么？', missingFields: ['subject'] } }] } };
      }
      return { assistant: { text: '好的，画一只橘猫。' }, usage: { completionTokens: 5 } };
    },
  };
  const registry = new ToolRegistry();
  const sessions = new InMemoryAgentSessionManager({ clock: () => new Date('2026-10-26T12:00:00.000Z') });
  const runtime = new AgentRuntime({
    model,
    sessions,
    mainModel: 'test-model',
    featureFlag: { enabled: true, mode: 'enforce' },
    toolRegistry: registry,
    toolExecutor: new ToolExecutor({ registry }),
    clock: () => new Date('2026-10-26T12:00:00.000Z'),
  });
  const base = {
    sessionKey: 'private:1',
    configRevision: 'rev',
    runtimeVersion: 'r5.3',
    userText: '画图',
  };
  const first = await runtime.runTurn({ ...base, turnId: 't1' });
  assert.equal(first.status, 'suspended');
  assert.equal(first.text, '你要画什么？');
  assert.equal(first.pendingQuestion.toolCallId, 'ask_1');

  const second = await runtime.runTurn({ ...base, turnId: 't2', userText: '一只橘猫' });
  assert.equal(second.status, 'completed');
  assert.equal(second.text, '好的，画一只橘猫。');
  assert.equal(requests.length, 2);
  const resumeMessages = requests[1].messages;
  const toolResult = resumeMessages.find((message) => message.role === 'tool' && message.toolCallId === 'ask_1');
  assert.ok(toolResult);
  assert.match(toolResult.content, /一只橘猫/);
  assert.equal(resumeMessages.some((message) => message.role === 'user' && message.content === '一只橘猫'), false);
  const saved = sessions.load('private:1');
  assert.equal(saved.pendingQuestion, undefined);
  assert.equal(saved.pendingToolCalls, undefined);
});

test('agent-interactive R5.3: AgentHost sends ask_user question without fallback and resumes it next message', async () => {
  const cfg = createDefaultConfig();
  cfg.agent.enabled = true;
  cfg.agent.mode = 'enforce';
  cfg.agent.mainModel = 'gpt-4o-mini';
  cfg.freeMode.enabled = false;
  const requests = [];
  let calls = 0;
  const client = {
    async chat(_nodeIndex, request) {
      requests.push(request);
      calls += 1;
      if (calls === 1) {
        return {
          text: '',
          raw: {},
          toolCalls: [{ id: 'ask_1', name: 'ask_user', arguments: { question: '你要画哪只猫？', missingFields: ['subject'] } }],
          finishReason: 'tool_calls',
        };
      }
      return { text: '收到，画橘猫。', raw: {}, usage: { completionTokens: 4 } };
    },
  };
  const host = createAgentHost({ getConfig: () => cfg, client });
  const first = await host({ text: '帮我画图', chatType: 'private', userId: '1', sessionId: 'private:1' });
  assert.equal(first.status, 'suspended');
  assert.equal(first.handled, true);
  assert.equal(first.terminal, true);
  assert.equal(first.reason, 'agent_ask_user');
  assert.equal(first.text, '你要画哪只猫？');
  assert.ok(first.replyPlan);

  const second = await host({ text: '橘猫', chatType: 'private', userId: '1', sessionId: 'private:1' });
  assert.equal(second.status, 'completed');
  assert.equal(second.handled, true);
  assert.equal(second.text, '收到，画橘猫。');
  const resumeToolResult = requests[1].messages.find((message) => message.role === 'tool' && message.toolCallId === 'ask_1');
  assert.ok(resumeToolResult);
  assert.match(resumeToolResult.content, /橘猫/);
});

test('agent-interactive R5.3: voice.select mutation becomes terminal if the following model call fails', async () => {
  const cfg = createDefaultConfig();
  cfg.agent.enabled = true;
  cfg.agent.mode = 'enforce';
  cfg.agent.mainModel = 'gpt-4o-mini';
  cfg.freeMode.enabled = false;
  let calls = 0;
  let selected = 0;
  const client = {
    async chat() {
      calls += 1;
      if (calls === 1) {
        return {
          text: '',
          raw: {},
          toolCalls: [{ id: 'voice_1', name: 'voice.select', arguments: { candidateId: 'voice-a' } }],
          finishReason: 'tool_calls',
        };
      }
      throw new Error('model failed after voice preference mutation');
    },
  };
  const { normalizeToolSpec } = await import('../dist/packages/tool-runtime/src/index.js');
  const host = createAgentHost({
    getConfig: () => cfg,
    client,
    toolBindings: () => [{
      spec: normalizeToolSpec({
        name: 'voice.select',
        title: '选择音色',
        description: '选择音色',
        inputSchema: { type: 'object', properties: { candidateId: { type: 'string' } }, required: ['candidateId'], additionalProperties: false },
        riskLevel: 'medium',
        sideEffects: ['modifies_state'],
        idempotency: 'payload',
        exposure: 'core',
      }),
      handler: async () => {
        selected += 1;
        return { ok: true, content: '已选择音色' };
      },
    }],
    preflightToolCall: () => ({ allowed: true }),
    isMigratedTool: (name) => name === 'voice.select',
    isReadOnlyTool: () => false,
  });
  const outcome = await host({ text: '换成这个音色', chatType: 'private', userId: '1', sessionId: 'private:9' });
  assert.equal(selected, 1);
  assert.equal(outcome.handled, true);
  assert.equal(outcome.terminal, true);
  assert.equal(outcome.reason, 'agent_side_effect_terminal');
  assert.ok(outcome.replyPlan);
});