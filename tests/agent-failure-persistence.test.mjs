// 失败轮次落库回归（线上时测 2026-11-15）：
//   "看本周三江带上每本书的月票数据" 与 "你倒是找啊" 都是 agent turn 失败
//   （provider 模型名错误 / max_model_rounds）。旧实现 failedResult 不写 session，
//   这两轮的 user 消息与工具结果全部消失，下一句"转图表发我"只能看到更早的无关内容，
//   于是把上一轮自己的状态报告当成数据源画成图。
// 契约：失败轮次必须把本轮 user 消息与工具往返保留在会话历史里。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultConfig } from '../dist/packages/config/src/index.js';
import { createAgentHost } from '../dist/apps/bot/src/agent-host.js';
import { InMemoryToolIdempotencyStore, normalizeToolSpec } from '../dist/packages/tool-runtime/src/index.js';
import { InMemoryAgentSessionManager, createAgentRuntime } from '../dist/packages/agent-runtime/src/index.js';

function baseConfig() {
  const cfg = createDefaultConfig();
  cfg.bot.botQqId = '10000';
  cfg.agent.enabled = true;
  cfg.agent.mode = 'enforce';
  cfg.toolRegistry.enabled = true;
  return cfg;
}

function hostFor(cfg, client, sessions, bindings = []) {
  return createAgentHost({
    getConfig: () => cfg,
    client,
    sessions,
    idempotencyStore: new InMemoryToolIdempotencyStore(),
    toolBindings: () => bindings,
    preflightToolCall: () => ({ allowed: true }),
    isReadOnlyTool: () => false,
    isMigratedTool: () => true,
  });
}

test('failure persistence: provider error keeps the user turn in session history', async () => {
  const cfg = baseConfig();
  const sessions = new InMemoryAgentSessionManager({});
  const client = {
    async chat() { throw new Error('The supported API model names are deepseek-flash, deepseek-v4-pro'); },
    can: () => true,
  };
  const host = hostFor(cfg, client, sessions);
  const outcome = await host({ text: '看本周三江带上每本书的月票数据', chatType: 'group', groupId: '1098867961', userId: '2238639363', sessionId: 'group:1098867961:2238639363', userRole: 'user' });
  assert.equal(outcome.status, 'failed');
  const session = sessions.load('group:1098867961:2238639363');
  const userMessages = (session?.messages || []).filter((message) => message.role === 'user');
  assert.equal(userMessages.length, 1, 'failed turn must keep the user message so a later "quote above" still works');
  assert.match(String(userMessages[0].content), /月票/);
});

test('failure persistence: failed tool round keeps user message and tool exchange', async () => {
  const cfg = baseConfig();
  cfg.agent.maxModelRounds = 2;
  cfg.agent.maxToolRounds = 8;
  const sessions = new InMemoryAgentSessionManager({});
  const spec = normalizeToolSpec({
    name: 'novel.platform',
    title: 'novel.platform',
    description: 'news platform',
    inputSchema: { type: 'object', properties: { action: { type: 'string' } }, additionalProperties: true },
    riskLevel: 'low',
    outputKinds: ['text'],
    exposure: 'core',
  });
  let calls = 0;
  const client = {
    async chat() {
      calls += 1;
      return {
        text: '',
        raw: {},
        toolCalls: [{ id: 'c' + calls, name: 'novel.platform', arguments: { action: 'list' } }],
        finishReason: 'tool_calls',
      };
    },
    can: () => true,
  };
  const host = hostFor(cfg, client, sessions, [
    { spec, handler: async (call) => ({ ok: true, callId: call.id, toolName: 'novel.platform', content: 'snapshot ' + calls }) },
  ]);
  const outcome = await host({ text: '你倒是找啊', chatType: 'group', groupId: '1098867961', userId: '2238639363', sessionId: 'group:1098867961:2238639363', userRole: 'user' });
  assert.equal(outcome.status, 'failed');
  assert.ok(calls >= 1, 'tool must have been attempted');
  const session = sessions.load('group:1098867961:2238639363');
  const messages = session?.messages || [];
  assert.ok(messages.some((message) => message.role === 'user' && String(message.content).includes('你倒是找啊')), 'user turn must survive a failed agent turn');
  assert.ok(messages.some((message) => (message.toolCalls || []).some((call) => call.name === 'novel.platform')), 'assistant tool calls must survive');
  assert.ok(messages.some((message) => message.role === 'tool'), 'tool results must survive');
});

test('failure persistence: resume turn does not fabricate a user message', async () => {
  const cfg = baseConfig();
  const sessions = new InMemoryAgentSessionManager({
    initialSessions: [{
      sessionKey: 'group:1:2',
      turnId: 't0',
      messages: [{ role: 'user', content: '原始请求' }],
      pendingFacts: {},
      pinnedFacts: {},
      artifacts: [],
      configRevision: 'r',
      runtimeVersion: 'r5-agent-loop',
      pendingJobs: [{ jobId: 'job-x', toolName: 'report.render', callId: 'call-x', status: 'running', createdAt: '2026-11-15T11:04:34.000Z' }],
      pendingToolCalls: [{ id: 'call-x', name: 'report.render', arguments: {} }],
    }],
  });
  const client = {
    async chat() { throw new Error('provider down'); },
    can: () => true,
  };
  const host = createAgentHost({
    getConfig: () => cfg,
    client,
    sessions,
    idempotencyStore: new InMemoryToolIdempotencyStore(),
    toolBindings: () => [],
    preflightToolCall: () => ({ allowed: true }),
    isReadOnlyTool: () => false,
    isMigratedTool: () => true,
    resolveJob: () => ({ jobId: 'job-x', status: 'succeeded', result: { ok: true, callId: 'call-x', toolName: 'report.render', content: 'rendered' } }),
  });
  const outcome = await host({
    text: '异步任务结果已就绪，请根据工具结果继续完成原操作。',
    chatType: 'group', groupId: '1', userId: '2', sessionId: 'group:1:2', userRole: 'user',
    resumeJob: true, resumeJobId: 'job-x', availableToolNames: [],
  });
  assert.equal(outcome.status, 'failed');
  const session = sessions.load('group:1:2');
  const userMessages = (session?.messages || []).filter((message) => message.role === 'user');
  assert.equal(userMessages.length, 1, 'resume notification must not be persisted as a user message');
  assert.equal(String(userMessages[0].content), '原始请求');
});

test('failure persistence: pre-context failure keeps prior history and appends the user turn', async () => {
  const sessions = new InMemoryAgentSessionManager({
    initialSessions: [{
      sessionKey: 'group:5:6',
      turnId: 't0',
      messages: [
        { role: 'user', content: '看本周三江带上每本书的月票数据' },
        { role: 'assistant', content: '这条数据我拉不到。' },
      ],
      pinnedFacts: {},
      artifacts: [],
      configRevision: 'r',
      runtimeVersion: 'r5-agent-loop',
    }],
  });
  // 上下文组装在 persistedMessages 建立之前就抛出（例如依赖不可用）。
  const runtime = createAgentRuntime({
    sessions,
    model: { async chat() { return { assistant: { text: 'ok' }, raw: {} }; }, can: () => true },
    mainModel: 'x',
    featureFlag: { enabled: true, mode: 'enforce' },
    contextBuilder: { build() { throw new Error('context dependency unavailable'); } },
  });
  const outcome = await runtime.runTurn({ sessionKey: 'group:5:6', turnId: 't1', userText: '你倒是找啊' });
  assert.equal(outcome.status, 'failed');
  const messages = sessions.load('group:5:6')?.messages || [];
  assert.equal(messages.length, 3, 'prior history must be preserved (not collapsed to one message)');
  assert.equal(messages[0].content, '看本周三江带上每本书的月票数据');
  assert.equal(messages[1].content, '这条数据我拉不到。');
  assert.equal(messages[2].content, '你倒是找啊');
});
