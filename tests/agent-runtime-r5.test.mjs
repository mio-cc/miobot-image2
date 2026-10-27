import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentHost } from '../dist/apps/bot/src/agent-host.js';
import { createAgentToolPreflight } from '../dist/apps/bot/src/agent-tool-policy.js';
import { createDefaultConfig } from '../dist/packages/config/src/index.js';
import { hashApprovalPayload } from '../dist/packages/orchestration/src/index.js';
import { normalizeToolSpec } from '../dist/packages/tool-runtime/src/index.js';

test('agent-access R5: read-only tool result returns to the same model and only final text is handed off', async () => {
  const cfg = createDefaultConfig();
  cfg.agent.enabled = true;
  cfg.agent.mode = 'enforce';
  cfg.agent.mainModel = 'gpt-4o-mini';
  cfg.freeMode.enabled = false;
  const requests = [];
  let step = 0;
  const client = {
    async chat(_nodeIndex, request) {
      requests.push(request);
      step += 1;
      if (step === 1) {
        return {
          text: '',
          raw: {},
          toolCalls: [{ id: 'search_1', name: 'web.search', arguments: { query: '猫' } }],
          finishReason: 'tool_calls',
        };
      }
      return { text: '根据搜索结果，猫在这里。', raw: {}, usage: { completionTokens: 5 } };
    },
  };
  const searchSpec = normalizeToolSpec({
    name: 'web.search',
    title: '网页搜索',
    description: '搜索网页',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
    riskLevel: 'low',
    outputKinds: ['text'],
    exposure: 'core',
  });
  let handlerCalls = 0;
  const host = createAgentHost({
    getConfig: () => cfg,
    client,
    toolBindings: () => [{
      spec: searchSpec,
      handler: async () => {
        handlerCalls += 1;
        return { ok: true, content: '猫在窗台上', outputs: [{ kind: 'text', text: '猫在窗台上' }] };
      },
    }],
    preflightToolCall: () => ({ allowed: true }),
    isReadOnlyTool: (name) => name === 'web.search',
  });
  const outcome = await host({ text: '帮我查一下猫', chatType: 'private', userId: '1', sessionId: 'private:1' });
  assert.equal(handlerCalls, 1);
  assert.equal(requests.length, 2);
  assert.ok(requests[1].messages.some((message) => message.role === 'tool' && message.toolCallId === 'search_1'));
  assert.equal(outcome.status, 'completed');
  assert.equal(outcome.handled, true);
  assert.equal(outcome.text, '根据搜索结果，猫在这里。');
  assert.equal(outcome.turn.usage.toolRounds, 1);
});

test('agent-tool-policy R5: user high-risk call is denied by the config permission matrix', async () => {
  const cfg = createDefaultConfig();
  cfg.orchestration.approval.enabled = true;
  const spec = normalizeToolSpec({
    name: 'file.delete',
    title: '删除文件',
    description: '删除文件',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    riskLevel: 'high',
    sideEffects: ['deletes_data'],
  });
  let approvalCalls = 0;
  const preflight = createAgentToolPreflight({
    getConfig: () => cfg,
    resolveRole: () => 'user',
    approvalRuntime: { async request() { approvalCalls += 1; return { status: 'failed' }; } },
  });
  const decision = await preflight({
    call: { id: 'c1', name: 'file.delete', arguments: {} },
    spec,
    turnId: 't1',
    sessionKey: 'private:1',
    mode: 'enforce',
    metadata: { userRole: 'user', userId: '1', chatType: 'private' },
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.error.code, 'permission_denied');
  assert.equal(approvalCalls, 0);
});

test('agent-tool-policy R5: admin high-risk approval validates payloadHash before allowing', async () => {
  const cfg = createDefaultConfig();
  cfg.orchestration.approval.enabled = true;
  const spec = normalizeToolSpec({
    name: 'file.delete',
    title: '删除文件',
    description: '删除文件',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
    riskLevel: 'high',
    sideEffects: ['deletes_data'],
  });
  let seenInput;
  const preflight = createAgentToolPreflight({
    getConfig: () => cfg,
    resolveRole: () => 'admin',
    approvalRuntime: {
      async request(input) {
        seenInput = input;
        return {
          status: 'approved',
          approval: {
            approvalId: 'a1',
            payloadHash: hashApprovalPayload(input.payload),
          },
        };
      },
    },
  });
  const decision = await preflight({
    call: { id: 'c1', name: 'file.delete', arguments: { path: '/tmp/a' } },
    spec,
    turnId: 't1',
    sessionKey: 'private:9000',
    mode: 'enforce',
    metadata: { userRole: 'admin', userId: '9000', chatType: 'private', requestId: 'req-1' },
  });
  assert.equal(decision.allowed, true);
  assert.equal(seenInput.capability, 'file.delete');
  assert.equal(seenInput.requesterQq, '9000');
  assert.equal(seenInput.payload.path, '/tmp/a');
});

test('agent-tool-policy R5: approval rejection never allows execution', async () => {
  const cfg = createDefaultConfig();
  cfg.orchestration.approval.enabled = true;
  const spec = normalizeToolSpec({
    name: 'file.delete',
    title: '删除文件',
    description: '删除文件',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    riskLevel: 'high',
    sideEffects: ['deletes_data'],
  });
  const preflight = createAgentToolPreflight({
    getConfig: () => cfg,
    resolveRole: () => 'admin',
    approvalRuntime: { async request() { return { status: 'rejected' }; } },
  });
  const decision = await preflight({
    call: { id: 'c1', name: 'file.delete', arguments: {} },
    spec,
    turnId: 't1',
    sessionKey: 'private:9000',
    mode: 'enforce',
    metadata: { userRole: 'admin', userId: '9000', chatType: 'private' },
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.error.code, 'permission_denied');
});
