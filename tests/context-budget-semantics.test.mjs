import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { AgentRuntime, DefaultAgentContextBuilder, InMemoryAgentSessionManager } from '../dist/packages/agent-runtime/src/index.js';

/**
 * 上限语义清理（A，2026-11-07）回归护栏：
 * historyMaxChars = 模型请求总字符预算（JSON 序列化长度，含 system 块与结构开销），
 * 不是"历史"上限。本文件锁三件事：
 * 1. context-builder 暴露各注入段实际字符数与裁剪计数（观测数据源）；
 * 2. 总量 ≥80% 预算时打一条 warn（各段字符数与占比），同会话 10 分钟冷却防刷屏；
 * 3. 配置注册表与面板源码不再把它叫"历史上限"。
 */

let turnCounter = 0;
function turnInput(overrides = {}) {
  turnCounter += 1;
  return {
    sessionKey: `budget-${turnCounter}`,
    turnId: `turn-${turnCounter}`,
    userText: '你好',
    configRevision: 'rev-1',
    runtimeVersion: 'r-budget',
    ...overrides,
  };
}

test('预算观测: build 结果带各注入段字符数与裁剪计数，system 块不参与裁剪', () => {
  const builder = new DefaultAgentContextBuilder();
  const bigGroup = 'G'.repeat(300);
  const bigMemory = 'M'.repeat(200);
  const built = builder.build({
    session: { sessionKey: 's', turnId: 't', messages: [], pinnedFacts: {}, artifacts: [], configRevision: '', runtimeVersion: '', createdAt: '', updatedAt: '' },
    userText: '问题',
    systemSections: ['SYS'.repeat(50)],
    groupContext: bigGroup,
    memoryContext: bigMemory,
    maxChars: 10_000,
  });
  const byLabel = Object.fromEntries((built.sectionChars || []).map((section) => [section.label, section.chars]));
  assert.ok((byLabel['System'] || 0) >= 150, 'System 段字符数可见');
  assert.ok((byLabel['Group context'] || 0) >= 300, 'Group context 段字符数可见');
  assert.ok((byLabel['Memory context'] || 0) >= 200, 'Memory context 段字符数可见');
  assert.equal(built.trimmedMessages, undefined, '未触顶时无裁剪计数');

  // 触顶：历史消息被从最旧开始丢弃并计数，system 块始终保留
  const history = [];
  for (let i = 0; i < 20; i += 1) history.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: 'H'.repeat(200) + i });
  const trimmed = builder.build({
    session: { sessionKey: 's', turnId: 't', messages: history, pinnedFacts: {}, artifacts: [], configRevision: '', runtimeVersion: '', createdAt: '', updatedAt: '' },
    userText: '问题',
    systemSections: ['SYS'.repeat(50)],
    maxChars: 1_500,
  });
  assert.ok((trimmed.trimmedMessages || 0) > 0, '超预算时应记录裁剪丢弃的历史消息数');
  assert.equal(trimmed.messages[0].role, 'system', '裁剪后 system 块仍在首位（当前不参与裁剪）');
});

test('预算告警: 总量 ≥80% 预算时 warn 一次，同会话冷却，不同会话互不影响', async () => {
  const warns = [];
  const logger = { warn: (message, data) => warns.push({ message, data }) };
  const makeRuntime = () => new AgentRuntime({
    model: { chat: async () => ({ assistant: { text: '好的' } }) },
    sessions: new InMemoryAgentSessionManager({}),
    mainModel: 'test-model',
    featureFlag: { enabled: true, mode: 'enforce' },
    contextMaxChars: 600,
    logger,
    clock: () => new Date('2026-11-07T12:00:00.000Z'),
  });
  const bigContext = { groupContext: 'X'.repeat(480) };
  // 同一 sessionKey 连打两轮：第一轮告警，第二轮被冷却节流
  const key = `cooldown-${Date.now()}`;
  const r1 = makeRuntime();
  await r1.runTurn(turnInput({ sessionKey: key, metadata: bigContext }));
  assert.equal(warns.length, 1, '总量超 80% 预算时应恰好 warn 一次');
  assert.equal(warns[0].message, '上下文接近总预算阈值');
  const data = warns[0].data;
  assert.equal(data.budget, 600);
  assert.ok(data.estimatedChars >= 480, 'warn 应带实际总量估算');
  assert.ok(data.ratio >= 0.8, '占比达到 80% 阈值：' + data.ratio);
  assert.ok(Array.isArray(data.sections) && data.sections.length > 0, 'warn 应带各注入段字符数与占比');
  assert.ok(data.sections[0].share > 0, '段占比可读');
  await r1.runTurn(turnInput({ sessionKey: key, metadata: bigContext, turnId: 'turn-x' }));
  assert.equal(warns.length, 1, '同会话 10 分钟冷却内不得重复 warn（防刷屏）');
  // 不同会话不受冷却影响
  await makeRuntime().runTurn(turnInput({ sessionKey: `${key}-other`, metadata: bigContext }));
  assert.equal(warns.length, 2, '不同会话各自告警一次');
});

test('预算告警: 常规会话（远低于预算）零输出', async () => {
  const warns = [];
  const runtime = new AgentRuntime({
    model: { chat: async () => ({ assistant: { text: '好的' } }) },
    sessions: new InMemoryAgentSessionManager({}),
    mainModel: 'test-model',
    featureFlag: { enabled: true, mode: 'enforce' },
    contextMaxChars: 12_000,
    logger: { warn: (message, data) => warns.push({ message, data }) },
    clock: () => new Date('2026-11-07T12:00:00.000Z'),
  });
  await runtime.runTurn(turnInput({ metadata: { groupContext: 'Y'.repeat(200) } }));
  assert.equal(warns.length, 0, '低于 80% 阈值不打 warn');
});

test('预算语义 wiring: 配置/面板/装配层不再称"历史上限"，且告警链路已接线', () => {
  const v3 = readFileSync(path.resolve(process.cwd(), 'packages/config/src/v3.ts'), 'utf8');
  assert.ok(v3.includes("'模型请求总字符预算'"), '配置字段注册表应使用总预算文案');
  assert.ok(!v3.includes("'对话历史字符上限'"), '旧的"对话历史字符上限"文案应删除');
  const agentPage = readFileSync(path.resolve(process.cwd(), 'web-panel/src/pages/AgentPage.vue'), 'utf8');
  assert.ok(agentPage.includes('模型请求总字符预算'), 'Agent 页应使用总预算文案');
  assert.ok(agentPage.includes('system 注入块目前不参与裁剪'), '面板应说明 system 块当前不参与裁剪');
  assert.ok(agentPage.includes('三层上限互相独立'), '面板应说明三层上限的独立关系');
  const loop = readFileSync(path.resolve(process.cwd(), 'packages/agent-runtime/src/agent-loop.ts'), 'utf8');
  assert.ok(/CONTEXT_BUDGET_WARN_RATIO = 0\.8/.test(loop), '80% 告警阈值应有具名常量');
  assert.ok(/CONTEXT_BUDGET_WARN_COOLDOWN_MS = 10 \* 60_000/.test(loop), '冷却时长应有具名常量');
  const host = readFileSync(path.resolve(process.cwd(), 'apps/bot/src/agent-host.ts'), 'utf8');
  assert.ok(/\.\.\.\(options\.logger \? \{ logger: options\.logger \} : \{\}\),/.test(host), 'agent-host 应把 logger 注入 AgentRuntime（告警链路）');
});
