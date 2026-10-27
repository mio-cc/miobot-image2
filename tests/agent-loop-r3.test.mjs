import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AgentRuntime,
  InMemoryAgentSessionManager,
  OutputRepairBudgetTracker,
} from '../dist/packages/agent-runtime/src/index.js';
import {
  ToolExecutor,
  ToolRegistry,
  makeToolError,
  normalizeToolSpec,
} from '../dist/packages/tool-runtime/src/index.js';

const echoSpec = normalizeToolSpec({
  name: 'echo',
  title: 'Echo',
  description: 'Echo a value',
  inputSchema: {
    type: 'object',
    properties: { value: { type: 'string' } },
    required: ['value'],
    additionalProperties: false,
  },
  riskLevel: 'low',
  outputKinds: ['text'],
  exposure: 'core',
});

function modelFrom(responses, onRequest) {
  const requests = [];
  let index = 0;
  return {
    requests,
    async chat(request) {
      requests.push(request);
      onRequest?.(request, requests.length);
      const item = responses[index];
      index += 1;
      if (item === undefined) throw new Error(`unexpected model call ${index}`);
      return typeof item === 'function' ? item(request, index) : item;
    },
  };
}

function harness(options = {}) {
  let handlerCalls = 0;
  let active = 0;
  let maxActive = 0;
  let preflightCalls = 0;
  const handler = options.handler || (async (call) => {
    handlerCalls += 1;
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, options.handlerDelayMs || 0));
    active -= 1;
    return { ok: true, content: JSON.stringify(call.arguments) };
  });
  const registry = new ToolRegistry();
  registry.register(echoSpec);
  for (const item of options.extraSpecs || []) registry.register(item);
  const executor = new ToolExecutor({ registry, maxCallsPerBatch: 16 });
  executor.registerHandler('echo', handler);
  const model = modelFrom(options.responses || [], options.onRequest);
  const sessions = new InMemoryAgentSessionManager({ clock: () => new Date('2026-10-26T12:00:00.000Z') });
  const runtime = new AgentRuntime({
    model,
    sessions,
    mainModel: 'test-model',
    featureFlag: { enabled: true, mode: options.mode || 'enforce' },
    toolRegistry: registry,
    toolExecutor: executor,
    limits: options.limits,
    repairLimits: options.repairLimits,
    enablePlanTool: false,
    toolSearchEnabled: options.toolSearchEnabled,
    contextMaxChars: options.contextMaxChars,
    toolResultMaxChars: options.toolResultMaxChars,
    maxPinnedFacts: options.maxPinnedFacts,
    clock: () => new Date('2026-10-26T12:00:00.000Z'),
    drainSteeringMessages: options.drainSteeringMessages,
    ...(options.preflightToolCall ? {
      preflightToolCall: async (input) => {
        preflightCalls += 1;
        return options.preflightToolCall(input);
      },
    } : {}),
  });
  return {
    runtime, model, sessions, registry, executor,
    get handlerCalls() { return handlerCalls; },
    get preflightCalls() { return preflightCalls; },
    get maxActive() { return maxActive; },
  };
}

let turnCounter = 0;
function turnInput(overrides = {}) {
  turnCounter += 1;
  return {
    sessionKey: 'private:1',
    turnId: `turn-${turnCounter}`,
    userText: '你好',
    configRevision: 'rev-1',
    runtimeVersion: 'r3',
    ...overrides,
  };
}

function toolResponse(calls, extra = {}) {
  return { assistant: { text: '', toolCalls: calls }, ...extra };
}

test('agent-loop R3: plain chat returns text in one model round and never calls a tool', async () => {
  const h = harness({ responses: [{ assistant: { text: '你好，我在。' }, usage: { completionTokens: 5 } }] });
  const result = await h.runtime.runTurn(turnInput());
  assert.equal(result.status, 'completed');
  assert.equal(result.text, '你好，我在。');
  assert.equal(result.usage.modelRounds, 1);
  assert.equal(result.usage.toolRounds, 0);
  assert.equal(h.model.requests.length, 1);
  assert.equal(h.model.requests[0].toolChoice, 'auto');
  assert.ok(h.model.requests[0].tools.some((tool) => tool.name === 'echo'));
  assert.ok(h.model.requests[0].tools.some((tool) => tool.name === 'ask_user'));
  assert.equal(h.handlerCalls, 0);
});

test('agent-loop R3: assistant text is held when tool calls exist and only final text is returned', async () => {
  const h = harness({
    responses: [
      toolResponse([{ id: 'c1', name: 'echo', arguments: { value: 'x' } }], { assistant: { text: '我先调用工具', toolCalls: [{ id: 'c1', name: 'echo', arguments: { value: 'x' } }] } }),
      { assistant: { text: '最终答案' } },
    ],
  });
  const result = await h.runtime.runTurn(turnInput());
  assert.equal(result.status, 'completed');
  assert.equal(result.text, '最终答案');
  assert.equal(h.handlerCalls, 1);
  assert.equal(result.usage.toolRounds, 1);
  assert.equal(h.model.requests.length, 2);
  const secondMessages = h.model.requests[1].messages;
  assert.ok(secondMessages.some((message) => message.role === 'assistant' && message.toolCalls?.[0]?.id === 'c1'));
  assert.ok(secondMessages.some((message) => message.role === 'tool' && message.toolCallId === 'c1'));
  assert.ok(!result.messages.some((message) => message.role === 'assistant' && message.content === '我先调用工具' && !message.toolCalls?.length));
});

test('agent-loop R3: schema error is repaired in-place, then the repaired call is revalidated and executed once', async () => {
  const h = harness({
    responses: [
      toolResponse([{ id: 'c1', name: 'echo', arguments: {} }]),
      toolResponse([{ id: 'c1', name: 'echo', arguments: { value: 'fixed' } }]),
      { assistant: { text: '修复后完成' } },
    ],
    preflightToolCall: () => ({ allowed: true }),
  });
  const result = await h.runtime.runTurn(turnInput());
  assert.equal(result.status, 'completed');
  assert.equal(result.text, '修复后完成');
  assert.equal(h.handlerCalls, 1);
  assert.equal(h.preflightCalls, 1);
  assert.equal(h.model.requests.length, 3);
  const repairRequest = h.model.requests[1];
  assert.ok(repairRequest.messages.some((message) => message.role === 'tool' && message.isError === true && /missing_required_argument/.test(message.content)));
  assert.ok(repairRequest.messages.some((message) => message.role === 'user' && message.meta?.internal === true));
  const validRequest = h.model.requests[2];
  assert.ok(validRequest.messages.some((message) => message.role === 'tool' && message.isError === false));
});

test('agent-loop R3: truncated/repeated tool output is never executed and safe plain-text fallback is used without fixed UI text', async () => {
  const truncatedCall = toolResponse([{ id: 'call_t', name: 'echo', arguments: { value: 'x' } }], { truncated: true });
  const h = harness({
    responses: [
      truncatedCall,
      truncatedCall,
      { assistant: { text: '现在无法安全执行，请稍后再试。' } },
    ],
    repairLimits: {
      maxProtocolRepairs: 5,
      maxSchemaRepairsPerCall: 5,
      maxTotalOutputRepairs: 5,
      maxRepeatedErrorCount: 2,
      allowTextFallback: true,
    },
  });
  const result = await h.runtime.runTurn(turnInput());
  assert.equal(result.status, 'completed');
  assert.equal(result.text, '现在无法安全执行，请稍后再试。');
  assert.equal(result.meta.safeTextFallback, true);
  assert.equal(result.meta.repairReason, 'max_repeated_error_count');
  assert.equal(h.handlerCalls, 0);
  assert.equal(h.model.requests.length, 3);
  assert.equal(h.model.requests[2].tools.length, 0);
  assert.equal(h.model.requests[2].toolChoice, 'none');
  assert.equal(h.model.requests.filter((request) => request.messages.some((message) => message.role === 'tool')).length, 0);
});

test('agent-loop R3: ask_user suspends the turn and persists one pending question', async () => {
  const h = harness({
    responses: [toolResponse([{
      id: 'ask_1',
      name: 'ask_user',
      arguments: { question: '你要画哪只猫？', missingFields: ['subject'], options: ['橘猫', '黑猫'] },
    }])],
  });
  const input = turnInput();
  const result = await h.runtime.runTurn(input);
  assert.equal(result.status, 'suspended');
  assert.equal(result.text, '你要画哪只猫？');
  assert.equal(result.pendingQuestion.question, '你要画哪只猫？');
  assert.deepEqual(result.pendingQuestion.missingFields, ['subject']);
  assert.equal(h.handlerCalls, 0);
  const saved = h.sessions.load(input.sessionKey);
  assert.equal(saved.pendingQuestion.question, '你要画哪只猫？');
  assert.equal(saved.pendingToolCalls[0].name, 'ask_user');
});

test('agent-loop R3: shadow mode records planned tool calls without preflight or execution', async () => {
  const h = harness({
    mode: 'shadow',
    responses: [toolResponse([{ id: 'c1', name: 'echo', arguments: { value: 'shadow' } }])],
    preflightToolCall: () => ({ allowed: true }),
  });
  const result = await h.runtime.runTurn(turnInput());
  assert.equal(result.status, 'suspended');
  assert.equal(result.error.code, 'shadow_tool_calls');
  assert.equal(result.meta.shadow, true);
  assert.equal(h.handlerCalls, 0);
  assert.equal(h.preflightCalls, 0);
});

test('agent-loop R3: preflight denial with pending approval suspends and never executes the tool', async () => {
  const approval = {
    approvalId: 'approval-1',
    status: 'pending',
    toolName: 'echo',
    callId: 'c1',
    payloadHash: 'hash-1',
    createdAt: '2026-10-26T12:00:00.000Z',
  };
  const h = harness({
    responses: [toolResponse([{ id: 'c1', name: 'echo', arguments: { value: 'x' } }])],
    preflightToolCall: () => ({ allowed: false, pendingApproval: approval, error: makeToolError({ code: 'approval_required', message: 'approval required', callId: 'c1', toolName: 'echo' }) }),
  });
  const input = turnInput();
  const result = await h.runtime.runTurn(input);
  assert.equal(result.status, 'suspended');
  assert.equal(result.pendingApproval.approvalId, 'approval-1');
  assert.equal(h.handlerCalls, 0);
  assert.equal(h.preflightCalls, 1);
  assert.equal(h.sessions.load(input.sessionKey).pendingApprovals[0].approvalId, 'approval-1');
});

test('agent-loop R3: maxModelRounds is a hard cap and does not use a fixed fallback', async () => {
  const toolCall = toolResponse([{ id: 'loop', name: 'echo', arguments: { value: 'x' } }]);
  const h = harness({
    responses: [toolCall, toolCall, toolCall],
    limits: { maxModelRounds: 2, maxToolRounds: 20 },
  });
  const result = await h.runtime.runTurn(turnInput());
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'max_model_rounds');
  assert.equal(result.text, undefined);
  assert.equal(h.handlerCalls, 2);
  assert.equal(h.model.requests.length, 2);
});

test('agent-loop R3: turn timeout aborts a model call that ignores the signal', async () => {
  const h = harness({
    responses: [() => new Promise(() => {})],
    limits: { turnTimeoutMs: 100 },
  });
  const started = Date.now();
  const result = await h.runtime.runTurn(turnInput());
  const elapsed = Date.now() - started;
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'turn_timeout');
  assert.ok(elapsed >= 90 && elapsed < 1500, `elapsed=${elapsed}`);
});

test('agent-loop R3: steering messages are injected before the next model call', async () => {
  const h = harness({
    responses: [{ assistant: { text: '已按补充要求回答。' } }],
    drainSteeringMessages: () => ['补充：请用中文回答'],
  });
  const result = await h.runtime.runTurn(turnInput());
  assert.equal(result.status, 'completed');
  const lastUser = h.model.requests[0].messages.filter((message) => message.role === 'user').at(-1);
  assert.equal(lastUser.content, '补充：请用中文回答');
});

test('agent-loop R3: maxParallelTools is applied to a model tool-call batch', async () => {
  const h = harness({
    responses: [
      toolResponse([
        { id: 'c1', name: 'echo', arguments: { value: 'a' } },
        { id: 'c2', name: 'echo', arguments: { value: 'b' } },
      ]),
      { assistant: { text: '两个都完成了' } },
    ],
    handlerDelayMs: 25,
    limits: { maxParallelTools: 2 },
  });
  const result = await h.runtime.runTurn(turnInput());
  assert.equal(result.status, 'completed');
  assert.equal(result.text, '两个都完成了');
  assert.equal(h.handlerCalls, 2);
  assert.equal(h.maxActive, 2);
});

test('agent-loop R3: repair budget batch counts one round but tracks schema repair per call', () => {
  const tracker = new OutputRepairBudgetTracker({
    maxProtocolRepairs: 2,
    maxSchemaRepairsPerCall: 1,
    maxTotalOutputRepairs: 2,
    maxRepeatedErrorCount: 10,
  });
  const first = tracker.requestRepairBatch([
    { error: makeToolError({ code: 'invalid_arguments', message: 'a', callId: 'c1' }), kind: 'schema', callId: 'c1' },
    { error: makeToolError({ code: 'invalid_argument_type', message: 'b', callId: 'c2' }), kind: 'schema', callId: 'c2' },
  ]);
  assert.equal(first.allowed, true);
  assert.equal(tracker.snapshot().totalRepairs, 1);
  assert.equal(tracker.snapshot().schemaRepairsByCall.c1, 1);
  assert.equal(tracker.snapshot().schemaRepairsByCall.c2, 1);
  const second = tracker.requestRepairBatch([
    { error: makeToolError({ code: 'invalid_arguments', message: 'c', callId: 'c1' }), kind: 'schema', callId: 'c1' },
  ]);
  assert.equal(second.allowed, false);
  assert.equal(second.reason, 'max_schema_repairs_per_call');

  const sameErrorTracker = new OutputRepairBudgetTracker({ maxRepeatedErrorCount: 2, maxTotalOutputRepairs: 5, maxSchemaRepairsPerCall: 2 });
  const sameError = sameErrorTracker.requestRepairBatch([
    { error: makeToolError({ code: 'invalid_arguments', message: 'same', callId: 'c1', toolName: 'echo', path: '$.value' }), kind: 'schema', callId: 'c1' },
    { error: makeToolError({ code: 'invalid_arguments', message: 'same', callId: 'c2', toolName: 'echo', path: '$.value' }), kind: 'schema', callId: 'c2' },
  ]);
  assert.equal(sameError.allowed, true, 'same fingerprint in one model round counts once');
  assert.equal(sameErrorTracker.snapshot().totalRepairs, 1);
});

test('agent-loop R9 BUG-1: turn metadata reaches preflight and can produce a pending approval', async () => {
  let seenMetadata;
  const h = harness({
    responses: [toolResponse([{ id: 'c1', name: 'echo', arguments: { value: 'x' } }])],
    preflightToolCall: (input) => {
      seenMetadata = input.metadata;
      return {
        allowed: false,
        pendingApproval: { approvalId: 'approval_1', payloadHash: 'hash_1' },
        error: makeToolError({
          code: 'approval_required',
          message: 'approval required',
          callId: 'c1',
          toolName: 'echo',
        }),
      };
    },
  });
  const result = await h.runtime.runTurn(turnInput({
    metadata: {
      requestId: 'req_bug1',
      userId: '900',
      userRole: 'admin',
      chatType: 'group',
      groupId: '3000',
    },
  }));
  assert.equal(result.status, 'suspended');
  assert.equal(result.pendingApproval.approvalId, 'approval_1');
  assert.deepEqual(seenMetadata, {
    requestId: 'req_bug1',
    userId: '900',
    userRole: 'admin',
    chatType: 'group',
    groupId: '3000',
  });
  assert.equal(h.handlerCalls, 0);
});
test('agent-loop R9 BUG-6: toolSearchEnabled gates searchable tools', async () => {
  const searchable = normalizeToolSpec({
    name: 'searchable.tool',
    title: 'Searchable',
    description: 'searchable',
    inputSchema: { type: 'object', properties: {}, additionalProperties: true },
    riskLevel: 'low',
    outputKinds: ['text'],
    exposure: 'searchable',
  });
  const disabled = harness({
    extraSpecs: [searchable],
    toolSearchEnabled: false,
    responses: [{ assistant: { text: 'ok' } }],
  });
  await disabled.runtime.runTurn(turnInput());
  assert.equal(disabled.model.requests[0].tools.some((tool) => tool.name === 'searchable.tool'), false);

  const enabled = harness({
    extraSpecs: [searchable],
    toolSearchEnabled: true,
    responses: [{ assistant: { text: 'ok' } }],
  });
  await enabled.runtime.runTurn(turnInput());
  assert.equal(enabled.model.requests[0].tools.some((tool) => tool.name === 'searchable.tool'), true);
});

test('agent-loop R9 BUG-4: toolResultMaxChars truncates refill and maxPinnedFacts bounds session facts', async () => {
  const longText = 'X'.repeat(500);
  const h = harness({
    responses: [
      toolResponse([{ id: 'c1', name: 'echo', arguments: { value: 'x' } }]),
      { assistant: { text: 'done' } },
    ],
    handler: async () => ({ ok: true, content: longText }),
    toolResultMaxChars: 40,
    maxPinnedFacts: 2,
  });
  const result = await h.runtime.runTurn(turnInput({
    pinnedFacts: { one: 1, two: 2, three: 3, four: 4 },
  }));
  assert.equal(result.status, 'completed');
  const toolMessage = h.model.requests[1].messages.find((message) => message.role === 'tool');
  assert.ok(toolMessage.content.includes('tool result truncated'));
  assert.ok(toolMessage.content.length < longText.length);
  const saved = h.sessions.load('private:1');
  assert.deepEqual(Object.keys(saved.pinnedFacts), ['three', 'four']);
});

test('agent-loop R9 BUG-4: contextMaxChars trims persisted history from model context', async () => {
  const h = harness({ contextMaxChars: 260, responses: [{ assistant: { text: 'ok' } }] });
  h.sessions.save({
    sessionKey: 'private:1',
    turnId: 'old',
    messages: Array.from({ length: 10 }, (_, index) => ({ role: 'user', content: `history-${index}-` + 'Y'.repeat(100) })),
    pinnedFacts: {},
    artifacts: [],
    configRevision: 'rev',
    runtimeVersion: 'r3',
    createdAt: '2026-10-26T12:00:00.000Z',
    updatedAt: '2026-10-26T12:00:00.000Z',
  });
  const result = await h.runtime.runTurn(turnInput({ userText: 'current question' }));
  assert.equal(result.status, 'completed');
  const messages = h.model.requests[0].messages;
  assert.equal(messages.some((message) => String(message.content || '').includes('history-9-')), false);
  assert.ok(messages.some((message) => message.role === 'user' && message.content.includes('current question')));
});

test('agent-loop R9 BUG-9: permission deny is refilled to the model instead of terminating the turn', async () => {
  const h = harness({
    responses: [
      toolResponse([{ id: 'c1', name: 'echo', arguments: { value: 'x' } }]),
      { assistant: { text: '这个操作被权限策略拒绝了。' } },
    ],
    preflightToolCall: () => ({
      allowed: false,
      error: makeToolError({
        code: 'permission_denied',
        message: 'policy denied',
        callId: 'c1',
        toolName: 'echo',
        retryable: false,
      }),
    }),
  });
  const result = await h.runtime.runTurn(turnInput());
  assert.equal(result.status, 'completed');
  assert.equal(result.text, '这个操作被权限策略拒绝了。');
  assert.equal(h.handlerCalls, 0);
  assert.equal(h.model.requests.length, 2);
  const toolMessage = h.model.requests[1].messages.find((message) => message.role === 'tool');
  assert.ok(toolMessage);
  assert.match(toolMessage.content, /permission_denied/);
});