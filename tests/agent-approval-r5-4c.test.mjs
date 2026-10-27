import test from 'node:test';
import assert from 'node:assert/strict';
import { ApprovalRuntime } from '../dist/apps/bot/src/approval-runtime.js';
import { createBotMessageRuntime } from '../dist/apps/bot/src/runtime.js';
import {
  AgentRuntime,
  InMemoryAgentSessionManager,
} from '../dist/packages/agent-runtime/src/index.js';
import { createDefaultConfig } from '../dist/packages/config/src/index.js';
import { hashApprovalPayload } from '../dist/packages/orchestration/src/index.js';
import {
  ToolExecutor,
  ToolRegistry,
  normalizeToolSpec,
  toolSpecFromCapabilityDescriptor,
} from '../dist/packages/tool-runtime/src/index.js';

test('tool-idempotency R5.4c: approval operationId replays across different turnIds', async () => {
  let executions = 0;
  const spec = normalizeToolSpec({
    name: 'file.delete',
    title: '删除文件',
    description: '删除文件',
    inputSchema: { type: 'object', properties: { artifactId: { type: 'string' } }, required: ['artifactId'], additionalProperties: false },
    riskLevel: 'high',
    sideEffects: ['deletes_data'],
    idempotency: 'payload',
    exposure: 'core',
  });
  const registry = new ToolRegistry();
  registry.register(spec);
  const executor = new ToolExecutor({ registry });
  executor.registerHandler('file.delete', async () => {
    executions += 1;
    return { ok: true, content: 'deleted' };
  });
  const call = { id: 'call-1', name: 'file.delete', arguments: { artifactId: 'a1' } };
  const first = await executor.execute(call, { turnId: 'turn-1', operationId: 'approval-1', sessionKey: 'private:1' });
  const replay = await executor.execute(call, { turnId: 'turn-2', operationId: 'approval-1', sessionKey: 'private:1' });
  assert.equal(first.ok, true);
  assert.equal(replay.ok, true);
  assert.equal(replay.meta.idempotencyReplay, true);
  assert.equal(executions, 1);
});

test('approval-runtime R5.4c: propose approvals are resent at the configured interval/cap', async () => {
  const sent = [];
  const runtime = new ApprovalRuntime({
    adminQqIds: () => ['9000'],
    ownerQqIds: () => ['9000'],
    allowGroupReply: () => false,
    sendPrivate: async (_qq, text) => {
      sent.push(text);
      return { success: true, messageId: sent.length };
    },
    maxPendingPerUser: () => 5,
    maxPendingGlobal: () => 20,
    resendIntervalMs: () => 20,
    maxResend: () => 1,
  });
  const proposed = await runtime.propose({
    requestId: 'req-resend',
    jobId: 'job-resend',
    stepId: 'call-resend',
    capability: 'config.update',
    riskLevel: 'critical',
    requesterQq: '1',
    payload: { ownerAction: 'ttsOn' },
    quorum: 'any',
    ttlMs: 60_000,
  });
  assert.equal(proposed.status, 'pending');
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(sent.length, 2);
  assert.match(sent[1], /审批提醒（重发 1\/1）/);
  runtime.getBroker().decide(proposed.approval.approvalId, {
    adminQq: '9000',
    decision: 'approve',
    at: new Date().toISOString(),
  }, proposed.approval.payloadHash);
});

test('agent-approval R5.4c: multiple pending approvals resume in order and clear together', async () => {
  const calls = [
    { id: 'cfg_call', name: 'config.update', arguments: { ownerAction: 'ttsOn' } },
    { id: 'voice_call', name: 'voice.select', arguments: { candidateId: 'voice-a' } },
  ];
  const cfgSpec = toolSpecFromCapabilityDescriptor({
    id: 'config.update', name: '修改配置', provider: 'admin', enabled: true, effect: 'mutate', riskLevel: 'critical', approvalRequired: true,
  }, { exposure: 'core' });
  const voiceSpec = toolSpecFromCapabilityDescriptor({
    id: 'voice.select', name: '选择音色', provider: 'builtin', enabled: true, effect: 'mutate', riskLevel: 'medium',
  }, { exposure: 'core' });
  const registry = new ToolRegistry();
  registry.register(cfgSpec);
  registry.register(voiceSpec);
  const executor = new ToolExecutor({ registry });
  const executed = [];
  executor.registerHandler('config.update', async () => { executed.push('config'); return { ok: true, content: 'configured' }; });
  executor.registerHandler('voice.select', async () => { executed.push('voice'); return { ok: true, content: 'selected' }; });
  const sessions = new InMemoryAgentSessionManager();
  const now = new Date('2026-10-26T12:00:00.000Z').toISOString();
  sessions.save({
    sessionKey: 'private:multi-approval',
    turnId: 't1',
    messages: [
      { role: 'user', content: '执行两个操作' },
      { role: 'assistant', content: '', toolCalls: calls },
    ],
    pendingToolCalls: calls,
    pendingApprovals: calls.map((call, index) => ({
      approvalId: `approval-${index + 1}`,
      status: 'pending',
      toolName: call.name,
      callId: call.id,
      payloadHash: hashApprovalPayload(call.arguments),
      createdAt: now,
      expiresAt: new Date(Date.parse(now) + 60_000).toISOString(),
    })),
    pinnedFacts: {},
    artifacts: [],
    configRevision: 'rev',
    runtimeVersion: 'r5.4c',
    createdAt: now,
    updatedAt: now,
  });
  const requests = [];
  const model = {
    async chat(request) {
      requests.push(request);
      return { assistant: { text: '两个操作都完成了。' } };
    },
  };
  const runtime = new AgentRuntime({
    model,
    sessions,
    mainModel: 'test-model',
    featureFlag: { enabled: true, mode: 'enforce' },
    toolRegistry: registry,
    toolExecutor: executor,
    resolveApproval: (record) => ({
      approvalId: record.approvalId,
      status: 'approved',
      payloadHash: record.payloadHash,
    }),
    clock: () => new Date('2026-10-26T12:00:00.000Z'),
  });
  const result = await runtime.runTurn({
    sessionKey: 'private:multi-approval',
    turnId: 't2',
    userText: '继续',
    configRevision: 'rev',
    runtimeVersion: 'r5.4c',
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.text, '两个操作都完成了。');
  assert.deepEqual(executed, ['config', 'voice']);
  const toolMessages = requests[0].messages.filter((message) => message.role === 'tool');
  assert.equal(toolMessages.length, 2);
  const saved = sessions.load('private:multi-approval');
  assert.equal(saved.pendingApprovals, undefined);
  assert.equal(saved.pendingToolCalls, undefined);
});

test('agent-approval R5.4c: runtime can send an approval-resume outcome without a fake user event', async () => {
  const cfg = createDefaultConfig();
  cfg.bot.replyStrategies.text = 'plain';
  const sent = [];
  const reply = {
    sendPrivateText: async (_userId, text) => { sent.push(text); return { success: true, messageId: 1 }; },
    sendGroupText: async (_groupId, text) => { sent.push(text); return { success: true, messageId: 1 }; },
  };
  const runtime = createBotMessageRuntime({
    reply,
    getConfig: () => cfg,
    botName: 'Mio',
  });
  const result = await runtime.sendAgentOutcome({
    chatType: 'private',
    userId: '1',
    text: '审批已通过，配置已更新。',
    reason: 'agent_approval_resumed',
  });
  assert.equal(result.handled, true);
  assert.deepEqual(sent, ['审批已通过，配置已更新。']);
});
