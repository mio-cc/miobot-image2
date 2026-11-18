// 预算治理与重复调用去重（线上时测 2026-11-18）：
//   一次「拉本周三江每本书月票数据」用了 8 个模型轮 / 16 个工具轮，几乎全砸在同一个
//   novel.platform 查询族上，最后被 maxToolRounds 硬切断，safe-text 兜底产出的真实回答
//   又被 agent-host 当成「接管失败」丢弃，用户只收到一句「可能没通过内容校验」。
// 契约：
//   1) 同工具+同参数的重复调用只真执行一次，后续回填上次结果并明确告知模型（不再打上游）；
//   2) 有副作用的工具不走这层去重（多步写操作可能是用户本意）；
//   3) 接近预算上限时注入一次内部提醒，让模型自己收敛成「用已有结果作答」；
//   4) 预算耗尽的错误文案不得被误诊成内容审核。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AgentRuntime,
  InMemoryAgentSessionManager,
} from '../dist/packages/agent-runtime/src/index.js';
import {
  ToolExecutor,
  ToolRegistry,
  normalizeToolSpec,
} from '../dist/packages/tool-runtime/src/index.js';

const echoSpec = normalizeToolSpec({
  name: 'echo',
  title: 'Echo',
  description: 'Echo a value',
  inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false },
  riskLevel: 'low',
  outputKinds: ['text'],
  exposure: 'core',
});

const writeSpec = normalizeToolSpec({
  name: 'writer',
  title: 'Writer',
  description: 'A tool with side effects',
  inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false },
  riskLevel: 'medium',
  outputKinds: ['text'],
  exposure: 'core',
  sideEffects: ['modifies_state'],
});

function harness(options = {}) {
  let handlerCalls = 0;
  let writeCalls = 0;
  const registry = new ToolRegistry();
  registry.register(echoSpec);
  registry.register(writeSpec);
  const executor = new ToolExecutor({ registry, maxCallsPerBatch: 16 });
  executor.registerHandler('echo', async (call) => {
    handlerCalls += 1;
    return { ok: true, content: 'result:' + JSON.stringify(call.arguments) };
  });
  executor.registerHandler('writer', async (call) => {
    writeCalls += 1;
    return { ok: true, content: 'wrote:' + JSON.stringify(call.arguments) };
  });
  const requests = [];
  const responses = [...(options.responses || [])];
  let index = 0;
  const model = {
    requests,
    async chat(request) {
      requests.push(JSON.parse(JSON.stringify(request.messages)));
      const item = responses[index];
      index += 1;
      if (item === undefined) return { assistant: { text: '兜底回答' } };
      return typeof item === 'function' ? item() : item;
    },
  };
  const runtime = new AgentRuntime({
    model,
    sessions: new InMemoryAgentSessionManager({}),
    mainModel: 'test-model',
    featureFlag: { enabled: true, mode: 'enforce' },
    toolRegistry: registry,
    toolExecutor: executor,
    limits: { maxModelRounds: 8, maxToolRounds: 16, ...(options.limits || {}) },
    repairLimits: options.repairLimits,
    enablePlanTool: false,
    clock: () => new Date('2026-11-18T00:00:00.000Z'),
  });
  return { runtime, model, get handlerCalls() { return handlerCalls; }, get writeCalls() { return writeCalls; } };
}

let turnCounter = 0;
function turnInput() {
  turnCounter += 1;
  return { sessionKey: 'private:dedupe', turnId: `t-${turnCounter}`, userText: '拉数据', configRevision: 'r', runtimeVersion: 'r26' };
}

function call(id, args) {
  return { assistant: { text: '', toolCalls: [{ id, name: 'echo', arguments: args }] } };
}

test('同工具同参数的重复调用只执行一次，第二次回填上次结果', async () => {
  const h = harness({
    responses: [
      call('c1', { value: 'same' }),
      call('c2', { value: 'same' }),
      { assistant: { text: '用第一次的结果作答。' } },
    ],
  });
  const result = await h.runtime.runTurn(turnInput());
  assert.equal(result.status, 'completed');
  assert.equal(h.handlerCalls, 1, '重复调用不得再次打上游');
  const toolMessages = h.model.requests.at(-1).filter((m) => m.role === 'tool');
  assert.equal(toolMessages.length, 2);
  const replay = JSON.parse(String(toolMessages[1].content));
  assert.match(String(replay.content), /DUPLICATE CALL/);
  assert.match(String(replay.content), /result:/, '复用结果里要带上一次的真实内容');
  assert.match(String(replay.content), /same/);
});

test('参数不同则正常执行，不被误判成重复', async () => {
  const h = harness({
    responses: [
      call('c1', { value: 'a' }),
      call('c2', { value: 'b' }),
      { assistant: { text: 'ok' } },
    ],
  });
  const result = await h.runtime.runTurn(turnInput());
  assert.equal(result.status, 'completed');
  assert.equal(h.handlerCalls, 2);
});

test('有副作用的工具不做这层去重（交给工具自身的幂等键）', async () => {
  // 这一层只拦「只读查询的重复」；写操作即使参数相同也应落到执行层，
  // 由 ToolExecutor 的幂等键决定是重放还是重跑——不能在上层替它省掉。
  const write = (id, value) => ({ assistant: { text: '', toolCalls: [{ id, name: 'writer', arguments: { value } }] } });
  const h = harness({
    responses: [
      write('c1', 'same'),
      write('c2', 'same'),
      { assistant: { text: 'ok' } },
    ],
  });
  const result = await h.runtime.runTurn(turnInput());
  assert.equal(result.status, 'completed');
  const toolMessages = h.model.requests.at(-1).filter((m) => m.role === 'tool');
  assert.equal(toolMessages.length, 2);
  for (const message of toolMessages) {
    assert.equal(String(message.content).includes('DUPLICATE CALL'), false, '写操作不得被上层的重复查询防护拦下');
  }
  assert.equal(h.writeCalls >= 1, true);
});

test('接近预算上限时注入一次内部提醒（不重复注入）', async () => {
  const many = (n) => Array.from({ length: n }, (_, i) => call('c' + i, { value: 'v' + i }));
  const h = harness({
    responses: [...many(8), { assistant: { text: '收尾回答' } }],
    limits: { maxModelRounds: 20, maxToolRounds: 10 },
  });
  const result = await h.runtime.runTurn(turnInput());
  assert.equal(result.status, 'completed');
  const notices = h.model.requests.filter((messages) =>
    messages.some((m) => String(m.content || '').includes('[INTERNAL BUDGET NOTICE]')));
  assert.equal(notices.length >= 1, true, '预算接近上限时必须提醒模型收敛');
  assert.equal(notices.length <= 2, true, '提醒不得每轮重复注入');
});

test('预算耗尽走 safe-text 兜底时保留真实工具结果', async () => {
  const many = (n) => Array.from({ length: n }, (_, i) => call('c' + i, { value: 'v' + i }));
  const h = harness({
    // 第 7 个工具调用会超预算 → 触发 safe-text 兜底；兜底那次模型调用拿到真实文本。
    responses: [...many(7), { assistant: { text: '这是基于已有数据的回答。' } }],
    limits: { maxModelRounds: 20, maxToolRounds: 6 },
  });
  const result = await h.runtime.runTurn(turnInput());
  assert.equal(result.status, 'completed');
  assert.equal(result.meta?.safeTextFallback, true);
  assert.equal(result.text, '这是基于已有数据的回答。');
  assert.equal((result.toolResults || []).length, 6, '兜底回答必须能带回已拿到的工具结果');
});

test('恰好用完工具轮预算时，模型能正常收尾（不必走兜底）', async () => {
  const many = (n) => Array.from({ length: n }, (_, i) => call('c' + i, { value: 'v' + i }));
  const h = harness({
    responses: [...many(6), { assistant: { text: '用这 6 条数据回答。' } }],
    limits: { maxModelRounds: 20, maxToolRounds: 6 },
  });
  const result = await h.runtime.runTurn(turnInput());
  assert.equal(result.status, 'completed');
  assert.equal(result.meta?.safeTextFallback, undefined, '正常收尾不应被标记成兜底');
  assert.equal(result.text, '用这 6 条数据回答。');
});