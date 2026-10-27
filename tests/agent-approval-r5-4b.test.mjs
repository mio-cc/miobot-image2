import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ApprovalRuntime } from '../dist/apps/bot/src/approval-runtime.js';
import { createAgentHost } from '../dist/apps/bot/src/agent-host.js';
import { createAgentToolPreflight } from '../dist/apps/bot/src/agent-tool-policy.js';
import { InMemoryAgentSessionManager } from '../dist/packages/agent-runtime/src/index.js';
import { createDefaultConfig } from '../dist/packages/config/src/index.js';
import { hashApprovalPayload } from '../dist/packages/orchestration/src/index.js';
import { toolSpecFromCapabilityDescriptor } from '../dist/packages/tool-runtime/src/index.js';

function approvalRuntime(initialApprovals = []) {
  return new ApprovalRuntime({
    adminQqIds: () => ['9000'],
    ownerQqIds: () => ['9000'],
    allowGroupReply: () => false,
    sendPrivate: async () => ({ success: true, messageId: 1 }),
    initialApprovals,
    maxPendingPerUser: () => 5,
    maxPendingGlobal: () => 20,
    resendIntervalMs: () => 0,
    maxResend: () => 0,
  });
}

function sessionPersist(filePath) {
  return (sessions) => {
    const temp = filePath + '.tmp';
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(temp, JSON.stringify({ version: 1, sessions }), 'utf8');
    renameSync(temp, filePath);
  };
}

test('approval-runtime R5.4b: propose returns pending without waiting for admin decision', async () => {
  const runtime = approvalRuntime();
  const started = Date.now();
  const proposed = await runtime.propose({
    requestId: 'req-1',
    jobId: 'job-1',
    stepId: 'call-1',
    capability: 'config.update',
    riskLevel: 'critical',
    requesterQq: '1',
    payload: { ownerAction: 'ttsOn' },
    quorum: 'any',
    ttlMs: 60_000,
  });
  assert.equal(proposed.status, 'pending');
  assert.ok(proposed.approval?.approvalId);
  assert.ok(Date.now() - started < 1000);

  const decided = runtime.getBroker().decide(proposed.approval.approvalId, {
    adminQq: '9000',
    decision: 'approve',
    at: new Date().toISOString(),
  }, proposed.approval.payloadHash);
  assert.equal(decided.status, 'approved');
  assert.equal(runtime.getBroker().get(proposed.approval.approvalId).status, 'approved');
});

test('agent-approval R5.4b: pending approval survives restart and resumes the original tool call once', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'miobot-agent-approval-'));
  const sessionsFile = path.join(dir, 'agent-sessions.json');
  const cfg = createDefaultConfig();
  cfg.agent.enabled = true;
  cfg.agent.mode = 'enforce';
  cfg.agent.mainModel = 'gpt-4o-mini';
  cfg.freeMode.enabled = false;
  cfg.orchestration.approval.enabled = true;
  cfg.orchestration.approval.quorum = 'any';
  cfg.orchestration.approval.timeoutMs = 60_000;

  const spec = toolSpecFromCapabilityDescriptor({
    id: 'config.update', name: '修改配置', provider: 'admin', enabled: true, effect: 'mutate', riskLevel: 'critical', approvalRequired: true,
  }, { exposure: 'core' });

  let modelCalls = 0;
  let handlerCalls = 0;
  const modelRequests = [];
  const client = {
    async chat(_nodeIndex, request) {
      modelRequests.push(request);
      modelCalls += 1;
      if (modelCalls === 1) {
        return {
          text: '',
          raw: {},
          toolCalls: [{ id: 'cfg_call_1', name: 'config.update', arguments: { ownerAction: 'ttsOn' } }],
          finishReason: 'tool_calls',
        };
      }
      return { text: '配置已经更新。', raw: {}, usage: { completionTokens: 4 } };
    },
  };
  const bindings = () => [{
    spec,
    handler: async () => {
      handlerCalls += 1;
      return { ok: true, content: '配置已更新' };
    },
  }];

  const approval1 = approvalRuntime();
  const preflight1 = createAgentToolPreflight({
    getConfig: () => cfg,
    resolveRole: () => 'admin',
    approvalRuntime: approval1,
    approvalMode: 'suspend',
  });
  const manager1 = new InMemoryAgentSessionManager({ persist: sessionPersist(sessionsFile) });
  const host1 = createAgentHost({
    getConfig: () => cfg,
    client,
    sessions: manager1,
    toolBindings: bindings,
    preflightToolCall: preflight1,
    resolveApproval: () => ({ approvalId: 'unused', status: 'pending' }),
  });
  const first = await host1({ text: '开启语音', chatType: 'private', userId: '1', sessionId: 'private:approval-restart' });
  assert.equal(first.status, 'suspended');
  assert.equal(first.handled, true);
  assert.equal(first.reason, 'agent_approval_pending');
  assert.equal(handlerCalls, 0);

  const persisted1 = JSON.parse(await fs.readFile(sessionsFile, 'utf8'));
  const pendingSession = persisted1.sessions.find((item) => item.sessionKey === 'private:approval-restart');
  assert.ok(pendingSession);
  assert.equal(pendingSession.pendingApprovals.length, 1);
  const approvalId = pendingSession.pendingApprovals[0].approvalId;
  const approval = approval1.getBroker().get(approvalId);
  assert.equal(approval.status, 'pending');
  const decided = approval1.getBroker().decide(approvalId, {
    adminQq: '9000',
    decision: 'approve',
    at: new Date().toISOString(),
  }, approval.payloadHash);
  assert.equal(decided.status, 'approved');

  const approval2 = approvalRuntime(approval1.getBroker().snapshot());
  const manager2 = new InMemoryAgentSessionManager({
    initialSessions: persisted1.sessions,
    persist: sessionPersist(sessionsFile),
  });
  const resolveApproval = (record) => {
    const broker = approval2.getBroker();
    broker.expire();
    const current = broker.get(record.approvalId);
    return current
      ? { approvalId: current.approvalId, status: current.status, payloadHash: current.payloadHash }
      : { approvalId: record.approvalId, status: 'expired' };
  };
  const preflight2 = createAgentToolPreflight({
    getConfig: () => cfg,
    resolveRole: () => 'admin',
    approvalRuntime: approval2,
    approvalMode: 'suspend',
  });
  const host2 = createAgentHost({
    getConfig: () => cfg,
    client,
    sessions: manager2,
    toolBindings: bindings,
    preflightToolCall: preflight2,
    resolveApproval,
  });
  const second = await host2({ text: '审批好了，继续', chatType: 'private', userId: '1', sessionId: 'private:approval-restart' });
  assert.equal(handlerCalls, 1);
  assert.equal(second.status, 'completed');
  assert.equal(second.text, '配置已经更新。');
  assert.equal(second.handled, true);
  const toolMessage = modelRequests[1].messages.find((message) => message.role === 'tool' && message.toolCallId === 'cfg_call_1');
  assert.ok(toolMessage);
  assert.match(toolMessage.content, /ok/);

  const persisted2 = JSON.parse(await fs.readFile(sessionsFile, 'utf8'));
  const resumedSession = persisted2.sessions.find((item) => item.sessionKey === 'private:approval-restart');
  assert.equal(resumedSession.pendingApprovals, undefined);
  assert.equal(resumedSession.pendingToolCalls, undefined);
  await fs.rm(dir, { recursive: true, force: true });
});

test('agent-approval R5.4b: rejected approval becomes a tool error and never executes the side effect', async () => {
  const cfg = createDefaultConfig();
  cfg.agent.enabled = true;
  cfg.agent.mode = 'enforce';
  cfg.agent.mainModel = 'gpt-4o-mini';
  cfg.freeMode.enabled = false;
  cfg.orchestration.approval.enabled = true;
  cfg.orchestration.approval.quorum = 'any';
  cfg.orchestration.approval.timeoutMs = 60_000;
  const spec = toolSpecFromCapabilityDescriptor({
    id: 'file.delete', name: '删除文件', provider: 'builtin', enabled: true, effect: 'delete', riskLevel: 'high', approvalRequired: true,
  }, { exposure: 'core' });
  let calls = 0;
  let handlerCalls = 0;
  const requests = [];
  const client = {
    async chat(_nodeIndex, request) {
      requests.push(request);
      calls += 1;
      if (calls === 1) {
        return {
          text: '',
          raw: {},
          toolCalls: [{ id: 'delete_call_1', name: 'file.delete', arguments: { artifactId: 'a1' } }],
          finishReason: 'tool_calls',
        };
      }
      return { text: '删除操作未获批准。', raw: {} };
    },
  };
  const approval = approvalRuntime();
  const manager = new InMemoryAgentSessionManager();
  const preflight = createAgentToolPreflight({
    getConfig: () => cfg,
    resolveRole: () => 'admin',
    approvalRuntime: approval,
    approvalMode: 'suspend',
  });
  const resolveApproval = (record) => {
    const current = approval.getBroker().get(record.approvalId);
    return current
      ? { approvalId: current.approvalId, status: current.status, payloadHash: current.payloadHash }
      : { approvalId: record.approvalId, status: 'expired' };
  };
  const host = createAgentHost({
    getConfig: () => cfg,
    client,
    sessions: manager,
    toolBindings: () => [{
      spec,
      handler: async () => {
        handlerCalls += 1;
        return { ok: true, content: 'deleted' };
      },
    }],
    preflightToolCall: preflight,
    resolveApproval,
  });
  const first = await host({ text: '删除 a1', chatType: 'private', userId: '1', sessionId: 'private:reject' });
  assert.equal(first.status, 'suspended');
  const pending = manager.load('private:reject').pendingApprovals[0];
  const current = approval.getBroker().get(pending.approvalId);
  const rejected = approval.getBroker().decide(pending.approvalId, {
    adminQq: '9000',
    decision: 'reject',
    at: new Date().toISOString(),
    reason: 'not allowed',
  }, current.payloadHash);
  assert.equal(rejected.status, 'rejected');

  const second = await host({ text: '审批结果如何？', chatType: 'private', userId: '1', sessionId: 'private:reject' });
  assert.equal(handlerCalls, 0);
  assert.equal(second.status, 'completed');
  assert.equal(second.text, '删除操作未获批准。');
  const toolMessage = requests[1].messages.find((message) => message.role === 'tool' && message.toolCallId === 'delete_call_1');
  assert.ok(toolMessage);
  assert.match(toolMessage.content, /approval_required/);
});