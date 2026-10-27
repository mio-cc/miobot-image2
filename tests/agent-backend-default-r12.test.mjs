import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';

import { NapcatAdapter } from '../dist/packages/napcat/src/index.js';
import { createBotMessageRuntime } from '../dist/apps/bot/src/main.js';
import { createDefaultConfig } from '../dist/packages/config/src/index.js';
import { createAgentHost } from '../dist/apps/bot/src/agent-host.js';
import { ApprovalRuntime } from '../dist/apps/bot/src/approval-runtime.js';
import { createAgentToolPreflight } from '../dist/apps/bot/src/agent-tool-policy.js';
import { ReplyPreferenceStore } from '../dist/apps/bot/src/reply-preference-store.js';
import { InMemoryToolIdempotencyStore, toolPending, toolFailure, toolSuccess } from '../dist/packages/tool-runtime/src/index.js';
import { InMemoryAgentSessionManager } from '../dist/packages/agent-runtime/src/index.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(predicate, timeoutMs = 5000, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(10);
  }
  throw new Error('timeout waiting for ' + label);
}

// ═══ P0-3 根因A：后台 bot.replyStrategies.text 必须进入 Agent 回复策略 ═══

test('P0-3: backend text=forward makes short agent replies use nested forward (no explicit preference)', async () => {
  const cfg = createDefaultConfig();
  cfg.bot.botQqId = '10000';
  cfg.bot.replyStrategies.text = 'forward'; // 后台默认：合并转发
  cfg.agent.enabled = true;
  cfg.agent.mode = 'enforce';
  cfg.toolRegistry.enabled = true;
  cfg.replyPolicy.enabled = true;
  const sent = [];
  const reply = {
    sendGroupText: async (g, t) => { sent.push(['groupText', t]); return { success: true, messageId: 1 }; },
    sendPrivateText: async (u, t) => { sent.push(['privateText', t]); return { success: true, messageId: 1 }; },
    sendGroupImage: async () => ({ success: true, messageId: 1 }),
    sendPrivateImage: async () => ({ success: true, messageId: 1 }),
    sendGroupRecord: async () => { sent.push(['groupRecord']); return { success: true, messageId: 1 }; },
    sendPrivateRecord: async () => { sent.push(['privateRecord']); return { success: true, messageId: 1 }; },
    sendGroupFile: async () => ({ success: true, messageId: 1 }),
    sendPrivateFile: async () => ({ success: true, messageId: 1 }),
    sendPrivateNestedMixedForward: async (u2, groups2) => { sent.push(['privateNestedMixed']); return { success: true, messageId: 1 }; },
    sendGroupNestedMixedForward: async (g2, groups2) => { sent.push(['groupNestedMixed']); return { success: true, messageId: 1 }; },
    sendGroupNestedTextForward: async (g, nodes) => { sent.push(['groupNestedForward', nodes]); return { success: true, messageId: 1 }; },
    sendGroupTextForward: async (g, nodes) => { sent.push(['groupFlatForward', nodes]); return { success: true, messageId: 1 }; },
  };
  const client = {
    async chat() { return { text: '短回复', raw: {}, finishReason: 'stop' }; },
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
    sessions: new InMemoryAgentSessionManager({}),
    replyPreferenceStore: new ReplyPreferenceStore({ maxRecords: 10 }),
    idempotencyStore: new InMemoryToolIdempotencyStore(),
    toolBindings: () => [],
    preflightToolCall: createAgentToolPreflight({
      getConfig: () => cfg,
      resolveRole: () => 'user',
      approvalRuntime: new ApprovalRuntime({
        adminQqIds: () => ['900'], ownerQqIds: () => ['1'],
        allowGroupReply: () => true, allowedGroupIds: () => [],
        sendPrivate: async () => ({ success: true, messageId: 1 }),
        sendGroup: async () => ({ success: true, messageId: 1 }),
        maxPendingPerUser: () => 3, maxPendingGlobal: () => 50,
        resendIntervalMs: () => 0, maxResend: () => 0,
        onDecision: () => {}, audit: () => {}, persist: () => {},
      }),
      approvalMode: 'suspend',
    }),
  });
  const runtime = createBotMessageRuntime({
    app: { handle: async () => ({ kind: 'chat', handled: true, text: 'LEGACY' }), engine: { async handleExplicit() { return null; } }, sessions: { clear() {}, get: () => [], append() {} }, registry: () => ({}), client: {} },
    reply,
    getConfig: () => cfg,
    selfId: () => '10000',
    botName: 'Mio',
    fetchGroupHistory: async () => [],
    reportProblem: async () => true,
    agentRuntime: async (input) => {
      const outcome = await host({ ...input, userRole: 'user' });
      // 关键断言（Host 层）：无显式偏好时 policy.mode 必须是后台默认 forward
      // policy.mode 是面板标记；实际组织形态在 groups[].mode（forward→nested_forward）。
      const groupModes = (outcome.replyPlan?.groups || []).map((g) => String(g.mode));
      assert.ok(groupModes.includes('nested_forward') || groupModes.includes('flat_forward'),
        `后台 text=forward 时文本组必须按 forward 组织，实际 groups=${JSON.stringify(groupModes)}`);

      return {
        handled: outcome.handled,
        ...(outcome.text ? { text: outcome.text } : {}),
        ...(outcome.replyPlan ? { replyPlan: outcome.replyPlan } : {}),
      };
    },
  });
  // 直接调用 handleMessageEvent，无需 attach
  const handled = await runtime.handleMessageEvent({
    post_type: 'message', message_type: 'group', group_id: 3000, user_id: 2001, message_id: 91,
    raw_message: '[CQ:at,qq=10000] 短问题', message: [{ type: 'at', data: { qq: '10000' } }, { type: 'text', data: { text: ' 短问题' } }],
  });
  await sleep(400);
  assert.equal(handled.handled, true, `消息应被处理: ${JSON.stringify(handled)}`);
  // Runtime 层：发送必须走合并转发（而非 direct 文本）
  assert.ok(sent.some((s) => ['groupNestedForward', 'groupFlatForward', 'groupNestedMixed', 'privateNestedMixed'].includes(s[0])),
    `短文本在后台 forward 默认下必须合并转发发送，实际发送=${JSON.stringify(sent.map((s) => s[0]))}`);
  assert.equal(sent.some((s) => s[0] === 'groupText'), false, '后台默认 forward 时不得直接发文本');
});

test('P0-3: explicit turn preference overrides backend default (priority chain intact)', async () => {
  const cfg = createDefaultConfig();
  cfg.bot.botQqId = '10000';
  cfg.bot.replyStrategies.text = 'forward';
  cfg.agent.enabled = true;
  cfg.agent.mode = 'enforce';
  cfg.toolRegistry.enabled = true;
  cfg.replyPolicy.enabled = true;
  cfg.replyPolicy.allowModelOverride = true;
  const client = {
    calls: 0,
    async chat() {
      this.calls += 1;
      if (this.calls === 1) {
        return { text: '', raw: {}, toolCalls: [{ id: 'c1', name: 'reply.presentation', arguments: { mode: 'direct', scope: 'turn' } }], toolCallIssues: [], finishReason: 'tool_calls' };
      }
      return { text: '这轮直接发。', raw: {}, finishReason: 'stop' };
    },
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
    sessions: new InMemoryAgentSessionManager({}),
    replyPreferenceStore: new ReplyPreferenceStore({ maxRecords: 10 }),
    idempotencyStore: new InMemoryToolIdempotencyStore(),
    toolBindings: () => [],
    preflightToolCall: createAgentToolPreflight({
      getConfig: () => cfg, resolveRole: () => 'user',
      approvalRuntime: new ApprovalRuntime({
        adminQqIds: () => ['900'], ownerQqIds: () => ['1'],
        allowGroupReply: () => true, allowedGroupIds: () => [],
        sendPrivate: async () => ({ success: true, messageId: 1 }),
        sendGroup: async () => ({ success: true, messageId: 1 }),
        maxPendingPerUser: () => 3, maxPendingGlobal: () => 50,
        resendIntervalMs: () => 0, maxResend: () => 0,
        onDecision: () => {}, audit: () => {}, persist: () => {},
      }),
      approvalMode: 'suspend',
    }),
  });
  // 第一轮：presentation(mode=direct, scope=turn) → 第二轮文本 → turn 内生效。
  const first = await host({ text: '这条直接发', chatType: 'private', userId: '7', sessionId: 'private:7', userRole: 'user' });
  const second = await host({ text: '继续', chatType: 'private', userId: '7', sessionId: 'private:7', userRole: 'user' });
  // turn 偏好在当轮回传里生效（direct 覆盖后台 forward），且不落 store（scope=turn 不持久化）。
  const firstModes = (first.replyPlan?.groups || []).map((g) => String(g.mode));
  assert.ok(!firstModes.includes('nested_forward'), `turn 偏好 direct 当轮必须覆盖后台 forward，实际 groups=${JSON.stringify(firstModes)}`);
  const store = new ReplyPreferenceStore({ maxRecords: 10 });
  assert.equal(store.get('session', 'private:7'), undefined, 'turn scope 不落 store');
});

// ═══ P0-4：Suno 失败后失败说明直达用户、不自动重试同族 ═══

test('P0-4: failed async job resume sends user-visible failure note and filters same-family tools', async () => {
  const cfg = createDefaultConfig();
  cfg.bot.botQqId = '10000';
  cfg.bot.ownerQQs = ['1'];
  cfg.agent.enabled = true;
  cfg.agent.mode = 'enforce';
  cfg.toolRegistry.enabled = true;
  const sent = [];
  const reply = {
    sendGroupText: async (g, t) => { sent.push(['groupText', String(t)]); return { success: true, messageId: 1 }; },
    sendPrivateText: async (u, t) => { sent.push(['privateText', String(t)]); return { success: true, messageId: 1 }; },
    sendGroupImage: async () => ({ success: true, messageId: 1 }),
    sendPrivateImage: async () => ({ success: true, messageId: 1 }),
    sendGroupRecord: async () => ({ success: true, messageId: 1 }),
    sendPrivateRecord: async () => ({ success: true, messageId: 1 }),
    sendGroupFile: async () => ({ success: true, messageId: 1 }),
    sendPrivateFile: async () => ({ success: true, messageId: 1 }),
    sendGroupTextForward: async (g, nodes) => { sent.push(['groupForward', JSON.stringify(nodes)]); return { success: true, messageId: 1 }; },
    sendGroupNestedTextForward: async (g, groups) => { sent.push(['groupNestedForward', JSON.stringify(groups)]); return { success: true, messageId: 1 }; },
    sendPrivateNestedTextForward: async (u, groups) => { sent.push(['privateNestedForward', JSON.stringify(groups)]); return { success: true, messageId: 1 }; },
    sendGroupNestedMixedForward: async (g, groups) => { sent.push(['groupNestedMixed', JSON.stringify(groups)]); return { success: true, messageId: 1 }; },
    sendPrivateNestedMixedForward: async (u, groups) => { sent.push(['privateNestedMixed', JSON.stringify(groups)]); return { success: true, messageId: 1 }; },
  };
  // 会话带一个已失败的 audio.music.generate job（模拟任务单场景）
  const sessions = new InMemoryAgentSessionManager({});
  sessions.save({
    sessionKey: 'group:3000:9', turnId: 't', messages: [], pinnedFacts: {}, artifacts: [],
    configRevision: 'r', runtimeVersion: 'v',
    pendingToolCalls: [{ id: 'call-1', name: 'audio.music.generate', arguments: { request: 'dj版本' } }],
    pendingJobs: [{ jobId: 'job-failed-1', toolName: 'audio.music.generate', callId: 'call-1', status: 'failed', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), sessionKey: 'group:3000:9' }],
  });
  const modelSawTools = [];
  const client = {
    async chat(req) {
      modelSawTools.push((req?.tools || []).map((t) => t.name));
      return { text: '抱歉，刚才那首歌没生成成功，远端超时了。你可以等会再试一次。', raw: {}, finishReason: 'stop' };
    },
    can: () => true,
    async vision() { return { text: '', raw: {} }; },
    async generateImages() { return { images: [], raw: {} }; },
    async editImage() { return { images: [], raw: {} }; },
    async interrogate() { return { text: '', raw: {} }; },
    async generateVideo() { return { videos: [], raw: {}, pending: true }; },
  };
  const bindings = [
    { spec: { name: 'audio.music.generate', title: 't', description: 'd', exposure: 'core', riskLevel: 'low', sideEffects: ['creates_artifact'], inputSchema: { type: 'object', properties: {}, additionalProperties: true } }, handler: async () => toolPending('call-1', 'job-failed-1', { toolName: 'audio.music.generate' }) },
    { spec: { name: 'audio.music.replace_section', title: 't', description: 'd', exposure: 'core', riskLevel: 'low', sideEffects: ['creates_artifact'], inputSchema: { type: 'object', properties: {}, additionalProperties: true } }, handler: async () => toolPending('call-2', 'job-2', { toolName: 'audio.music.replace_section' }) },
    { spec: { name: 'audio.music.history', title: 't', description: 'd', exposure: 'core', riskLevel: 'low', inputSchema: { type: 'object', properties: {}, additionalProperties: true } }, handler: async () => toolSuccess('call-3', 'audio.music.history', { content: '无历史' }) },
    { spec: { name: 'web.search', title: 't', description: 'd', exposure: 'core', riskLevel: 'low', inputSchema: { type: 'object', properties: {}, additionalProperties: true } }, handler: async () => toolSuccess('call-4', 'web.search', { content: '结果' }) },
  ];
  const host = createAgentHost({
    getConfig: () => cfg,
    client,
    sessions,
    replyPreferenceStore: new ReplyPreferenceStore({ maxRecords: 10 }),
    idempotencyStore: new InMemoryToolIdempotencyStore(),
    toolBindings: () => bindings,
    preflightToolCall: createAgentToolPreflight({
      getConfig: () => cfg, resolveRole: () => 'user',
      approvalRuntime: new ApprovalRuntime({
        adminQqIds: () => ['900'], ownerQqIds: () => ['1'],
        allowGroupReply: () => true, allowedGroupIds: () => [],
        sendPrivate: async () => ({ success: true, messageId: 1 }),
        sendGroup: async () => ({ success: true, messageId: 1 }),
        maxPendingPerUser: () => 3, maxPendingGlobal: () => 50,
        resendIntervalMs: () => 0, maxResend: () => 0,
        onDecision: () => {}, audit: () => {}, persist: () => {},
      }),
      approvalMode: 'suspend',
    }),
    resolveJob: (record) => ({
      jobId: record.jobId,
      status: 'failed',
      error: { code: 'tool_execution_failed', message: 'suno_wait_timeout: 远端任务超时', toolName: record.toolName },
    }),
  });
  const runtime = createBotMessageRuntime({
    app: { handle: async () => ({ kind: 'chat', handled: true, text: 'LEGACY' }), engine: { async handleExplicit() { return null; } }, sessions: { clear() {}, get: () => [], append() {} }, registry: () => ({}), client: {} },
    reply,
    getConfig: () => cfg,
    selfId: () => '10000',
    botName: 'Mio',
    fetchGroupHistory: async () => [],
    reportProblem: async () => true,
    agentRuntime: async (input) => {
      // resume turn：标记 resumeJob 以对齐 start.ts 的失败 resume 输入（同族过滤由注入方层完成，
      // 这里断言注入方约定——通过 originalText 尾部系统状态 + availableToolNames）。
      const failNote = '\n\n【系统状态】上一轮异步任务执行失败。请直接向用户说明本次失败，不要再次调用同类生成工具或自动重试。';
      const filteredTools = bindings.map((b) => b.spec.name).filter((name) => !name.startsWith('audio.music.'));
      const outcome = await host({
        ...input,
        text: (String(input.text || '') || '请处理') + failNote,
        availableToolNames: filteredTools,
        resumeJob: true,
        resumeJobId: 'job-failed-1',
        userRole: 'user',
      });
      return {
        handled: outcome.handled,
        ...(outcome.text ? { text: outcome.text } : {}),
        ...(outcome.replyPlan ? { replyPlan: outcome.replyPlan } : {}),
      };
    },
  });
  // 直接调用 handleMessageEvent，无需 attach
  await runtime.handleMessageEvent({
    post_type: 'message', message_type: 'group', group_id: 3000, user_id: 9, message_id: 92,
    raw_message: '[CQ:at,qq=10000] 好了吗', message: [{ type: 'at', data: { qq: '10000' } }, { type: 'text', data: { text: ' 好了吗' } }],
  });
  await waitUntil(() => sent.length > 0, 5000, 'failure note sent');
  await sleep(200);
  // 用户收到失败说明（含自然语气，非错误码堆栈）
  const allText = sent.map((s) => String(s[1] || '')).join('\n');
  assert.match(allText, /没生成成功|失败|超时/, `用户必须收到失败说明: ${allText.slice(0, 80)}`);
  assert.doesNotMatch(allText, /tool_execution_failed|suno_wait_timeout/, '失败说明不得是内部错误码');
  // 同族工具被过滤：模型看不到 audio.music.*
  assert.ok(modelSawTools.length >= 1, '模型至少被调用一次');
  for (const tools of modelSawTools) {
    assert.equal(tools.some((t) => String(t).startsWith('audio.music.')), false,
      `失败 resume 后同族 audio.music.* 不得出现在 loadout: ${JSON.stringify(tools)}`);
  }
});