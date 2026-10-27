import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ToolExecutor,
  ToolRegistry,
  normalizeToolSpec,
} from '../dist/packages/tool-runtime/src/index.js';
import {
  createCapabilityToolBinding,
  executionResultToToolResult,
} from '../dist/apps/bot/src/capability-tool-adapter.js';

function descriptor(overrides = {}) {
  return {
    id: 'web.search',
    version: '1.0.0',
    name: '网页搜索',
    description: '搜索网页',
    provider: 'search',
    enabled: true,
    riskLevel: 'low',
    outputKinds: ['text'],
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
    ...overrides,
  };
}

test('capability-tool R5: existing CapabilityHandler is invoked through ToolHandler contract', async () => {
  const invocations = [];
  const handler = {
    async execute(invocation) {
      invocations.push(invocation);
      return {
        jobId: invocation.plan.planId,
        status: 'success',
        outputs: [{ kind: 'text', text: '搜索结果 A', priority: 10, mergeable: true }],
        durationMs: 3,
      };
    },
  };
  const binding = createCapabilityToolBinding(descriptor(), handler);
  assert.equal(binding.spec.name, 'web.search');
  assert.equal(binding.spec.exposure, 'core');
  const result = await binding.handler(
    { id: 'call_1', name: 'web.search', arguments: { query: '猫' } },
    binding.spec,
    {
      turnId: 'turn-1',
      sessionKey: 'private:1',
      requestId: 'req-1',
      metadata: {
        chatType: 'private',
        userId: '1',
        userRole: 'user',
        userText: '查一下猫',
      },
    },
  );
  assert.equal(result.ok, true);
  assert.equal(result.content, '搜索结果 A');
  assert.equal(result.outputs[0].kind, 'text');
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0].step.capability, 'web.search');
  assert.deepEqual(invocations[0].step.args, { query: '猫' });
  assert.equal(invocations[0].request.user.role, 'user');
});

test('capability-tool R5: denied/waiting execution results become structured tool errors', () => {
  const spec = normalizeToolSpec({
    name: 'file.delete',
    title: '删除文件',
    description: '删除',
    inputSchema: { type: 'object', properties: {} },
    riskLevel: 'high',
  });
  const denied = executionResultToToolResult({
    jobId: 'j1',
    status: 'denied',
    outputs: [],
    error: 'permission denied',
    retryable: false,
  }, { id: 'c1', name: 'file.delete', arguments: {} }, spec);
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, 'permission_denied');

  const waiting = executionResultToToolResult({
    jobId: 'j2',
    status: 'waiting_approval',
    outputs: [],
  }, { id: 'c2', name: 'file.delete', arguments: {} }, spec);
  assert.equal(waiting.ok, false);
  assert.equal(waiting.error.code, 'approval_required');
});

test('tool-runtime R5: ToolExecutor idempotency prevents duplicate turn side effects', async () => {
  const registry = new ToolRegistry();
  registry.register(normalizeToolSpec({
    name: 'echo.write',
    title: 'Echo write',
    description: 'test idempotency',
    inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false },
    riskLevel: 'medium',
    sideEffects: ['modifies_state'],
    idempotency: 'turn',
    exposure: 'core',
  }));
  let calls = 0;
  const executor = new ToolExecutor({ registry });
  executor.registerHandler('echo.write', async (call) => {
    calls += 1;
    return { ok: true, content: String(call.arguments.value) };
  });
  const context = { turnId: 'turn-1', sessionKey: 'private:1' };
  const call = { id: 'call-1', name: 'echo.write', arguments: { value: 'x' } };
  const first = await executor.execute(call, context);
  const replay = await executor.execute(call, context);
  assert.equal(first.ok, true);
  assert.equal(replay.ok, true);
  assert.equal(replay.meta.idempotencyReplay, true);
  assert.equal(calls, 1);

  await executor.execute(call, { ...context, turnId: 'turn-2' });
  assert.equal(calls, 2);
});
