import test from 'node:test';
import assert from 'node:assert/strict';

import { createDefaultConfig } from '../dist/packages/config/src/index.js';
import { createBotMessageRuntime } from '../dist/apps/bot/src/main.js';
import { createAgentHost } from '../dist/apps/bot/src/agent-host.js';
import { createAgentToolPreflight } from '../dist/apps/bot/src/agent-tool-policy.js';
import { ApprovalRuntime } from '../dist/apps/bot/src/approval-runtime.js';
import { ReplyPreferenceStore } from '../dist/apps/bot/src/reply-preference-store.js';
import { InMemoryToolIdempotencyStore, toolPending, toolSuccess } from '../dist/packages/tool-runtime/src/index.js';
import { InMemoryAgentSessionManager } from '../dist/packages/agent-runtime/src/index.js';

function baseConfig() {
  const cfg = createDefaultConfig();
  cfg.bot.botQqId = '10000';
  cfg.bot.ownerQQs = ['1'];
  cfg.bot.whitelistPrivate = ['2000'];
  cfg.bot.whitelistGroups = ['3000'];
  cfg.bot.replyStrategies.text = 'plain';
  cfg.agent.enabled = true;
  cfg.agent.mode = 'enforce';
  cfg.toolRegistry.enabled = true;
  cfg.replyPolicy.enabled = true;
  return cfg;
}

function approvalRuntime(cfg) {
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

test('agent-job R11: async suspension is silent — no fixed status text, no plan text output', async () => {
  const cfg = baseConfig();
  const sessions = new InMemoryAgentSessionManager({});
  let handlerCalls = 0;
  let jobState = { status: 'running' };
  const bindings = [{
    spec: {
      name: 'image.generate', title: 't', description: 'd', exposure: 'core', riskLevel: 'low',
      sideEffects: ['creates_artifact'],
      inputSchema: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'], additionalProperties: false },
    },
    handler: async (call) => {
      handlerCalls += 1;
      return toolPending(call.id, 'job-1', { toolName: call.name, content: '已提交生成任务' });
    },
  }];
  let normalChatCalls = 0;
  const client = {
    async chat() {
      normalChatCalls += 1;
      if (normalChatCalls === 1) {
        return {
          text: '', raw: {},
          toolCalls: [{ id: 'c1', name: 'image.generate', arguments: { prompt: '一只猫' } }],
          toolCallIssues: [], finishReason: 'tool_calls',
        };
      }
      return { text: '还在画，先等等。', raw: {}, finishReason: 'stop' };
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
    sessions,
    replyPreferenceStore: new ReplyPreferenceStore({ maxRecords: 10 }),
    idempotencyStore: new InMemoryToolIdempotencyStore(),
    toolBindings: () => bindings,
    preflightToolCall: createAgentToolPreflight({
      getConfig: () => cfg,
      resolveRole: () => 'user',
      approvalRuntime: approvalRuntime(cfg),
      approvalMode: 'suspend',
    }),
    resolveJob: (record) => ({ jobId: record.jobId, status: jobState.status, ...(jobState.result ? { result: jobState.result } : {}) }),
  });

  // 第一轮：工具返回 pending job → 挂起
  const first = await host({ text: '画一只猫', chatType: 'private', userId: '2000', sessionId: 'private:2000', userRole: 'user' });
  assert.equal(handlerCalls, 1);
  assert.equal(first.status, 'suspended');
  assert.equal(first.reason, 'agent_job_pending');
  // R11 核心：静默吸收——无固定状态文案
  assert.equal(first.silent, true, '挂起必须标记 silent');
  assert.equal(first.text, undefined, '不得回填「任务已提交」固定文案');
  const firstOutputs = (first.replyPlan?.groups || []).flatMap((group) => group.outputs || []);
  assert.equal(firstOutputs.filter((output) => output.kind === 'text').length, 0, 'ReplyPlan 不得含状态文本输出');

  // 第二轮（job 仍 running，用户新消息）：正常回复当前消息，但不得注入旧 job 产物
  const again = await host({ text: '写好了吗', chatType: 'private', userId: '2000', sessionId: 'private:2000', userRole: 'user' });
  assert.equal(again.status, 'completed');
  assert.equal(again.silent, undefined);
  assert.equal(again.text, '还在画，先等等。');
  const againOutputs = (again.replyPlan?.groups || []).flatMap((group) => group.outputs || []);
  assert.equal(againOutputs.some((output) => output.kind === 'image'), false, '不得把旧图片注入当前回复');

  // job 完成 → resume 通道 → 模型继续 → 最终文本正常 handoff
  jobState = { status: 'succeeded', result: toolSuccess('c1', 'image.generate', {
    outputs: [{ kind: 'image', url: 'https://example.test/cat.png', priority: 20 }],
  }) };
  let finalCalls = 0;
  client.chat = async () => {
    finalCalls += 1;
    return { text: '猫画好了，看看这张。', raw: {}, finishReason: 'stop' };
  };
  const final = await host({ text: '异步任务结果已就绪，请根据工具结果继续完成原操作。', resumeJob: true, chatType: 'private', userId: '2000', sessionId: 'private:2000', userRole: 'user' });
  assert.equal(final.status, 'completed');
  assert.equal(final.silent, undefined);
  assert.equal(final.text, '猫画好了，看看这张。');
  const finalOutputs = (final.replyPlan?.groups || []).flatMap((group) => group.outputs || []);
  assert.ok(finalOutputs.some((output) => output.kind === 'image' && output.url?.includes('cat.png')), '最终产物经 ReplyPlan 送达');
});

test('agent-job R11: runtime absorbs silent suspension without any user-visible send', async () => {
  const cfg = baseConfig();
  const sent = [];
  const reply = {
    sendGroupText: async (g, t) => { sent.push(['groupText', g, t]); return { success: true, messageId: 1 }; },
    sendPrivateText: async (u, t) => { sent.push(['privateText', u, t]); return { success: true, messageId: 1 }; },
    sendGroupImage: async (g, u) => { sent.push(['groupImage', g, u]); return { success: true, messageId: 1 }; },
    sendPrivateImage: async (u, f) => { sent.push(['privateImage', u, f]); return { success: true, messageId: 1 }; },
    sendGroupRecord: async () => { sent.push(['groupRecord']); return { success: true, messageId: 1 }; },
    sendPrivateRecord: async () => { sent.push(['privateRecord']); return { success: true, messageId: 1 }; },
    sendGroupFile: async () => { sent.push(['groupFile']); return { success: true, messageId: 1 }; },
    sendPrivateFile: async () => { sent.push(['privateFile']); return { success: true, messageId: 1 }; },
  };
  const problems = [];
  const runtime = createBotMessageRuntime({
    app: { handle: async () => ({ kind: 'chat', handled: false }), engine: { async handleExplicit() { return null; } }, sessions: { clear() {}, get: () => [], append() {} }, registry: () => ({}), client: {} },
    reply,
    getConfig: () => cfg,
    selfId: () => '10000',
    botName: 'Mio',
    reportProblem: async (input) => { problems.push(input.kind); return true; },
    agentRuntime: async () => ({ handled: true, reason: 'agent_job_pending', silent: true }),
  });
  const result = await runtime.handleMessageEvent({
    post_type: 'message', message_type: 'private', user_id: 2000, message_id: 71,
    raw_message: '画一只猫', message: [{ type: 'text', data: { text: '画一只猫' } }],
  });
  assert.equal(result.handled, true);
  assert.equal(result.kind, 'agent-job-pending-silent');
  assert.equal(sent.length, 0, `静默挂起期间不得有任何用户可见发送：${JSON.stringify(sent)}`);
  // 不落入 enforce 失败分支（否则会发受控失败话术）
  assert.equal(problems.length, 0, `不得上报失败：${JSON.stringify(problems)}`);
});