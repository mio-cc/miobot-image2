import test from 'node:test';
import assert from 'node:assert/strict';

import { createDefaultConfig } from '../dist/packages/config/src/index.js';
import { ApprovalRuntime } from '../dist/apps/bot/src/approval-runtime.js';
import { createAgentHost } from '../dist/apps/bot/src/agent-host.js';
import { createAgentToolPreflight } from '../dist/apps/bot/src/agent-tool-policy.js';
import { ReplyPreferenceStore } from '../dist/apps/bot/src/reply-preference-store.js';
import { InMemoryToolIdempotencyStore } from '../dist/packages/tool-runtime/src/index.js';
import { InMemoryAgentSessionManager } from '../dist/packages/agent-runtime/src/index.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function baseConfig() {
  const cfg = createDefaultConfig();
  cfg.bot.botQqId = '10000';
  cfg.bot.ownerQQs = ['1'];
  cfg.orchestration.approval.adminQqIds = ['900'];
  cfg.agent.enabled = true;
  cfg.agent.mode = 'enforce';
  cfg.toolRegistry.enabled = true;
  cfg.replyPolicy.enabled = true;
  cfg.replyPolicy.defaultVoice = 'auto';
  return cfg;
}

function makeApprovalRuntime(cfg) {
  return new ApprovalRuntime({
    adminQqIds: () => cfg.orchestration.approval.adminQqIds,
    ownerQqIds: () => cfg.bot.ownerQQs,
    allowGroupReply: () => true,
    allowedGroupIds: () => ['3000'],
    sendPrivate: async () => ({ success: true, messageId: 1 }),
    sendGroup: async () => ({ success: true, messageId: 1 }),
    maxPendingPerUser: () => 3,
    maxPendingGlobal: () => 50,
    resendIntervalMs: () => 0,
    maxResend: () => 0,
    onDecision: () => {},
    audit: () => {},
    persist: () => {},
  });
}

// ═══ P1-A：turn scope 偏好不得跨轮泄漏 ═══

test('P1-A: reply.presentation scope=turn 只影响当轮，下一轮恢复后台默认', async () => {
  const cfg = baseConfig();
  const store = new ReplyPreferenceStore({ maxRecords: 100 });
  const sessions = new InMemoryAgentSessionManager({});
  const scripts = [
    // 第 1 轮：模型请求 voice=off 仅当轮
    {
      text: '',
      toolCalls: [{ id: 'c1', name: 'reply.presentation', arguments: { voice: 'off', scope: 'turn' } }],
      finishReason: 'tool_calls',
    },
    { text: '这轮就不发语音了。', raw: {}, finishReason: 'stop' },
  ];
  let idx = 0;
  const client = {
    async chat() { return scripts[idx++] || { text: 'ok', raw: {} }; },
    can: () => true,
    async vision() { return { text: '', raw: {} }; },
    async generateImages() { return { images: [], raw: {} }; },
    async editImage() { return { images: [], raw: {} }; },
    async interrogate() { return { text: '', raw: {} }; },
    async generateVideo() { return { videos: [], raw: {}, pending: true }; },
  };
  const host = createAgentHost({
    getConfig: () => cfg,
    client,
    sessions,
    replyPreferenceStore: store,
    idempotencyStore: new InMemoryToolIdempotencyStore(),
    toolBindings: () => [],
    preflightToolCall: createAgentToolPreflight({
      getConfig: () => cfg,
      resolveRole: () => 'user',
      approvalRuntime: makeApprovalRuntime(cfg),
      approvalMode: 'suspend',
    }),
  });

  // 第 1 轮：presentation(turn) + 最终文本
  const turn1 = await host({ text: '这次别发语音', chatType: 'private', userId: '7', sessionId: 'private:7', userRole: 'user' });
  assert.equal(turn1.status, 'completed');
  assert.equal(turn1.replyPlan?.policy?.voice, 'off', 'turn 内 voice=off 应生效');

  // 第 2 轮：普通消息——不得继承第 1 轮的 turn 偏好
  const turn2 = await host({ text: '再聊一句', chatType: 'private', userId: '7', sessionId: 'private:7', userRole: 'user' });
  assert.equal(turn2.status, 'completed');
  assert.equal(turn2.replyPlan?.policy?.voice, 'auto', `下一轮必须恢复后台默认 voice，实际=${turn2.replyPlan?.policy?.voice}`);
  // store 里也没有 session 持久化（scope=turn 不落库）
  assert.equal(store.get('session', 'private:7'), undefined, 'turn 偏好不得写入 session store');
});

test('P1-A: scope=session 的 presentation 偏好跨轮持久生效', async () => {
  const cfg = baseConfig();
  const store = new ReplyPreferenceStore({ maxRecords: 100 });
  const sessions = new InMemoryAgentSessionManager({});
  const scripts = [
    {
      text: '',
      toolCalls: [{ id: 'c1', name: 'reply.presentation', arguments: { voice: 'off', scope: 'session' } }],
      finishReason: 'tool_calls',
    },
    { text: '这个会话都用文字。', raw: {}, finishReason: 'stop' },
  ];
  let idx = 0;
  const client = {
    async chat() { return scripts[idx++] || { text: 'ok', raw: {} }; },
    can: () => true,
    async vision() { return { text: '', raw: {} }; },
    async generateImages() { return { images: [], raw: {} }; },
    async editImage() { return { images: [], raw: {} }; },
    async interrogate() { return { text: '', raw: {} }; },
    async generateVideo() { return { videos: [], raw: {}, pending: true }; },
  };
  const host = createAgentHost({
    getConfig: () => cfg,
    client,
    sessions,
    replyPreferenceStore: store,
    idempotencyStore: new InMemoryToolIdempotencyStore(),
    toolBindings: () => [],
    preflightToolCall: createAgentToolPreflight({
      getConfig: () => cfg,
      resolveRole: () => 'user',
      approvalRuntime: makeApprovalRuntime(cfg),
      approvalMode: 'suspend',
    }),
  });
  await host({ text: '这会儿不方便听语音', chatType: 'private', userId: '8', sessionId: 'private:8', userRole: 'user' });
  const turn2 = await host({ text: '继续聊', chatType: 'private', userId: '8', sessionId: 'private:8', userRole: 'user' });
  assert.equal(turn2.replyPlan?.policy?.voice, 'off', 'session scope 应跨轮生效');
  assert.equal(store.get('session', 'private:8')?.voice, 'off');
});

// ═══ P1-B：动态 MCP/plugin/session.clear 成功 handoff ═══

test('P1-B: dynamic plugin tool success hands off instead of agent_tool_path_not_migrated', async () => {
  const cfg = baseConfig();
  const sessions = new InMemoryAgentSessionManager({});
  let executed = 0;
  const dynamicBindings = [
    {
      spec: {
        name: 'plugin.echo',
        title: 'plugin echo',
        description: 'echo plugin tool',
        exposure: 'core',
        riskLevel: 'low',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
      },
      handler: async (call) => {
        executed += 1;
        return { ok: true, content: `echo:${call.arguments?.text}`, outputs: [{ kind: 'text', text: `echo:${call.arguments?.text}` }] };
      },
    },
    {
      spec: {
        name: 'session.clear',
        title: 'clear session',
        description: 'clear session',
        exposure: 'core',
        riskLevel: 'low',
        inputSchema: { type: 'object', properties: {}, additionalProperties: true },
      },
      handler: async () => ({ ok: true, content: 'cleared', outputs: [] }),
    },
    {
      spec: {
        name: 'mcp.joke.random',
        title: 'mcp joke',
        description: 'mcp tool',
        exposure: 'searchable',
        riskLevel: 'low',
        inputSchema: { type: 'object', properties: {}, additionalProperties: true },
      },
      handler: async () => ({ ok: true, content: 'a joke', outputs: [{ kind: 'text', text: 'a joke' }] }),
    },
  ];
  const scripts = [
    {
      text: '',
      toolCalls: [{ id: 'c1', name: 'plugin.echo', arguments: { text: 'hi' } }],
      finishReason: 'tool_calls',
    },
    { text: '已经回声了。', raw: {}, finishReason: 'stop' },
  ];
  let idx = 0;
  const client = {
    async chat() { return scripts[idx++] || { text: 'ok', raw: {} }; },
    can: () => true,
    async vision() { return { text: '', raw: {} }; },
    async generateImages() { return { images: [], raw: {} }; },
    async editImage() { return { images: [], raw: {} }; },
    async interrogate() { return { text: '', raw: {} }; },
    async generateVideo() { return { videos: [], raw: {}, pending: true }; },
  };
  const host = createAgentHost({
    getConfig: () => cfg,
    client,
    sessions,
    replyPreferenceStore: new ReplyPreferenceStore({ maxRecords: 10 }),
    idempotencyStore: new InMemoryToolIdempotencyStore(),
    toolBindings: () => dynamicBindings,
    preflightToolCall: createAgentToolPreflight({
      getConfig: () => cfg,
      resolveRole: () => 'user',
      approvalRuntime: makeApprovalRuntime(cfg),
      approvalMode: 'suspend',
    }),
  });
  const outcome = await host({ text: 'echo 一下', chatType: 'group', groupId: 3000, userId: '9', sessionId: 'group:3000:9', userRole: 'user' });
  assert.equal(executed, 1, 'plugin handler must run');
  assert.equal(outcome.status, 'completed');
  assert.equal(outcome.handled, true, `动态工具成功后必须 handoff，reason=${outcome.reason}`);
  assert.notEqual(outcome.reason, 'agent_tool_path_not_migrated');
  assert.ok(outcome.text.includes('回声'), `最终文本应送达: ${outcome.text}`);
});

// ═══ P1-C：toolRegistry.exposure 后台覆盖真实生效 ═══

test('P1-C: cfg.toolRegistry.exposure overrides descriptor-inferred exposure in bindings', async () => {
  const { createCapabilityToolBinding } = await import('../dist/apps/bot/src/capability-tool-adapter.js');
  const cfg = createDefaultConfig();
  cfg.toolRegistry.enabled = true;
  cfg.toolRegistry.exposure = {
    'web.search': 'hidden',      // 后台隐藏
    'image.generate': 'searchable', // 后台降级
    'help': 'core',              // 后台提升
  };
  const descriptor = (id) => ({
    id,
    name: id,
    description: id,
    inputSchema: { type: 'object', properties: {}, additionalProperties: true },
    riskLevel: 'low',
    enabled: true,
  });
  const makeBinding = (id) => {
    const configuredExposure = cfg.toolRegistry?.exposure?.[id];
    return createCapabilityToolBinding(descriptor(id), async () => ({ ok: true, outputs: [] }), {
      ...(configuredExposure ? { exposure: configuredExposure } : {}),
    });
  };
  assert.equal(makeBinding('web.search').spec.exposure, 'hidden');
  assert.equal(makeBinding('image.generate').spec.exposure, 'searchable');
  assert.equal(makeBinding('help').spec.exposure, 'core');
  // 未配置的工具保持推导缺省
  const unconfigured = makeBinding('file.read');
  assert.notEqual(unconfigured.spec.exposure, 'hidden');
});

// ═══ P1-D：legacy bot 分支移除后不再引用不存在文件 ═══

test('P1-D: miobot-service.mjs no longer references deleted bot-runtime.mjs; legacy bot rejected explicitly', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const service = fs.readFileSync(path.resolve('scripts/miobot-service.mjs'), 'utf8');
  assert.equal(service.includes("'scripts/bot-runtime.mjs'"), false, '不得再引用已删除的 bot-runtime.mjs');
  assert.ok(service.includes('MIOBOT_BOT_RUNTIME=legacy'), 'legacy 请求应有明确报错说明');
  assert.ok(fs.existsSync(path.resolve('scripts/bot-runtime-v2.mjs')), 'v2 入口存在');
  assert.ok(fs.existsSync(path.resolve('scripts/local-verify-server.mjs')), 'web legacy 入口保留');
});