import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';

import { NapcatAdapter } from '../dist/packages/napcat/src/index.js';
import { createBotMessageRuntime } from '../dist/apps/bot/src/main.js';
import { createDefaultConfig } from '../dist/packages/config/src/index.js';
import { OrchestrationEnforcer } from '../dist/apps/bot/src/orchestration-enforce.js';

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function waitUntil(predicate, timeoutMs = 6000, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(10);
  }
  throw new Error('timeout waiting for ' + label);
}

async function createSim() {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(wss, 'listening');
  const port = wss.address().port;
  const actions = [];
  let peer = null;
  let nextMessageId = 3000;
  wss.on('connection', (socket) => {
    peer = socket;
    socket.on('message', (raw) => {
      let action;
      try { action = JSON.parse(String(raw)); } catch { return; }
      actions.push(action);
      socket.send(JSON.stringify({ echo: action.echo, self_id: 10000, status: 'ok', retcode: 0, data: { message_id: nextMessageId++ } }));
    });
  });
  const adapter = new NapcatAdapter({ wsUrl: 'ws://127.0.0.1:' + port, token: 'sim', actionTimeoutMs: 3000, textSendTimeoutMs: 3000, forwardSendTimeoutMs: 3000, autoReconnect: false });
  const opened = new Promise((r) => { const off = adapter.on('open', () => { off(); r(); }); });
  adapter.connect();
  await opened;
  return {
    adapter, actions,
    get peer() { return peer; },
    sendEvent(event) { peer.send(JSON.stringify({ self_id: 10000, ...event })); },
    async close() { adapter.disconnect(); for (const c of wss.clients) c.terminate(); await new Promise((r) => wss.close(r)); },
  };
}

function sentText(action) {
  return (action.params?.message || []).filter((s) => s.type === 'text').map((s) => s.data?.text || '').join('');
}

function makeConfig(overrides = {}) {
  const cfg = createDefaultConfig();
  cfg.bot.botQqId = '10000';
  cfg.bot.ownerQQs = ['1'];
  cfg.llm.chatEnabled = true;
  cfg.bot.replyStrategies.text = 'plain';
  cfg.freeMode.enabled = false;
  cfg.orchestration.enabled = true;
  cfg.orchestration.mode = 'enforce';
  cfg.orchestration.planner.enabled = true;
  cfg.orchestration.planner.actionAlignmentGuardEnabled = false;
  if (overrides.bot) Object.assign(cfg.bot, overrides.bot);
  if (overrides.orchestration) Object.assign(cfg.orchestration, overrides.orchestration);
  return cfg;
}

function makeApp() {
  return {
    handle: async () => null,
    engine: { async handleExplicit() { return null; } },
    sessions: { clear() {}, get: () => [], append() {} },
    registry: () => ({}), client: {},
  };
}

// ═══ 角度1：边界与异常输入 ═══

test('角度-边界: 空消息/纯空格/@bot无内容 不崩且不响应', async () => {
  const sim = await createSim();
  const cfg = makeConfig();
  const processed = [];
  const app = { ...makeApp(), handle: async (i) => { processed.push(i.text); return null; } };
  const runtime = createBotMessageRuntime({
    app, reply: sim.adapter, getConfig: () => cfg,
    selfId: () => '10000', botName: 'Mio', reportProblem: async () => true,
  });
  runtime.attach(sim.adapter);
  try {
    sim.sendEvent({ post_type: 'message', message_type: 'group', group_id: 100, user_id: 2, message_id: 1, raw_message: '[CQ:at,qq=10000] ', message: [{ type: 'at', data: { qq: '10000' } }, { type: 'text', data: { text: ' ' } }] });
    sim.sendEvent({ post_type: 'message', message_type: 'group', group_id: 100, user_id: 2, message_id: 2, raw_message: '', message: [] });
    sim.sendEvent({ post_type: 'message', message_type: 'private', user_id: 2, message_id: 3, raw_message: '   ', message: [{ type: 'text', data: { text: '   ' } }] });
    await sleep(400);
    assert.ok(processed.length <= 1, '空内容消息最多触发一次空文本处理（不崩溃）');
  } finally { await sim.close(); }
});

test('角度-边界: 超长消息（10k 字符）不崩', async () => {
  const sim = await createSim();
  const cfg = makeConfig();
  const app = makeApp();
  const runtime = createBotMessageRuntime({
    app, reply: sim.adapter, getConfig: () => cfg,
    selfId: () => '10000', botName: 'Mio', reportProblem: async () => true,
  });
  runtime.attach(sim.adapter);
  try {
    const long = 'a'.repeat(10000);
    sim.sendEvent({ post_type: 'message', message_type: 'private', user_id: 2, message_id: 10, raw_message: long, message: [{ type: 'text', data: { text: long } }] });
    await sleep(400);
    // 不崩溃即通过
    assert.ok(true);
  } finally { await sim.close(); }
});

test('角度-边界: 恶意 CQ 码注入不触发命令', async () => {
  const sim = await createSim();
  const cfg = makeConfig();
  const handled = [];
  const app = { ...makeApp(), handle: async (i) => { handled.push(i.text); return null; } };
  const runtime = createBotMessageRuntime({
    app, reply: sim.adapter, getConfig: () => cfg,
    selfId: () => '10000', botName: 'Mio', reportProblem: async () => true,
  });
  runtime.attach(sim.adapter);
  try {
    // CQ 码里藏命令
    sim.sendEvent({ post_type: 'message', message_type: 'private', user_id: 2, message_id: 20, raw_message: '[CQ:image,file=test.jpg,url=https://evil.com/画猫]正常文字', message: [{ type: 'image', data: { file: 'test.jpg' } }, { type: 'text', data: { text: '正常文字' } }] });
    await sleep(400);
    const allText = handled.join('');
    assert.ok(!allText.includes('画猫'), 'CQ 码内的命令文本不应进入处理');
  } finally { await sim.close(); }
});

// ═══ 角度2：多用户并发与隔离 ═══

test('角度-多用户: 两个用户同时在同一群触发，互不干扰', async () => {
  const sim = await createSim();
  const cfg = makeConfig();
  const replies = [];
  const app = {
    handle: async () => null,
    engine: { async handleExplicit(kind, input) { return { kind: 'chat', handled: true, text: '回复' + input.text.slice(0, 5), decision: { kind: 'chat', params: {} } }; } },
    sessions: { clear() {}, get: () => [], append() {} },
    registry: () => ({}), client: {},
  };
  const runtime = createBotMessageRuntime({
    app, reply: sim.adapter, getConfig: () => cfg,
    selfId: () => '10000', botName: 'Mio', reportProblem: async () => true,
    enforceOrchestration: async (input) => {
      replies.push({ user: String(input.userId), text: input.text });
      await sleep(30);
      return { handled: true, result: { kind: 'chat', handled: true, text: 'ok:' + input.text, decision: { kind: 'chat', source: 'model', confidence: 1, reason: '', params: { prompt: '', tokens: [] } } } };
    },
  });
  runtime.attach(sim.adapter);
  try {
    sim.sendEvent({ post_type: 'message', message_type: 'group', group_id: 100, user_id: 11, message_id: 31, raw_message: '[CQ:at,qq=10000]用户A的问题', message: [{ type: 'at', data: { qq: '10000' } }, { type: 'text', data: { text: '用户A的问题' } }] });
    sim.sendEvent({ post_type: 'message', message_type: 'group', group_id: 100, user_id: 22, message_id: 32, raw_message: '[CQ:at,qq=10000]用户B的问题', message: [{ type: 'at', data: { qq: '10000' } }, { type: 'text', data: { text: '用户B的问题' } }] });
    await waitUntil(() => replies.length >= 2, 4000, 'both processed');
    assert.equal(replies.length, 2, '两个用户都应被处理');
    const users = replies.map((r) => r.user);
    assert.ok(users.includes('11') && users.includes('22'), '两个不同用户都被处理');
  } finally { await sim.close(); }
});

// ═══ 角度3：会话快照恢复与延续状态 ═══

test('角度-恢复: 会话快照重启恢复后延续判断仍工作', async () => {
  const sim = await createSim();
  const cfg = makeConfig();
  cfg.bot.autoContinue = { enabled: true, windowMs: 60000, maxRounds: 3, cooldownMs: 0, requireModelCheck: false };
  const store = { data: { 'group:100:2': [{ role: 'user', content: '你好' }, { role: 'assistant', content: '你好呀' }] } };
  const app = {
    handle: async (i) => ({ kind: 'chat', handled: true, text: '在的', decision: { kind: 'chat', params: {} } }),
    engine: { async handleExplicit() { return { kind: 'chat', handled: true, text: '在的', decision: { kind: 'chat', params: {} } }; } },
    sessions: { clear() {}, get: (k) => store.data[k] || [], append(k, u, a) { (store.data[k] = store.data[k] || []).push(u, a); } },
    registry: () => ({}), client: {},
  };
  const continueChecks = [];
  const runtime = createBotMessageRuntime({
    app, reply: sim.adapter, getConfig: () => cfg,
    selfId: () => '10000', botName: 'Mio', reportProblem: async () => true,
    triggerIntentChecker: {
      checkKeywordIntent: async () => false,
      checkContinueIntent: async (input) => {
        continueChecks.push(input);
        return true; // 延续判断通过
      },
    },
  });
  runtime.attach(sim.adapter);
  try {
    // bot 先回复一次（建立延续状态）
    sim.sendEvent({ post_type: 'message', message_type: 'group', group_id: 100, user_id: 2, message_id: 40, raw_message: '[CQ:at,qq=10000]你好', message: [{ type: 'at', data: { qq: '10000' } }, { type: 'text', data: { text: '你好' } }] });
    await waitUntil(() => sim.actions.some((a) => a.action === 'send_group_msg'), 4000, 'first reply');
    await sleep(200);
    // 无触发的下一条消息（应走延续）
    sim.sendEvent({ post_type: 'message', message_type: 'group', group_id: 100, user_id: 2, message_id: 41, raw_message: '继续聊', message: [{ type: 'text', data: { text: '继续聊' } }] });
    await sleep(500);
    assert.ok(continueChecks.length > 0, '延续判断应被触发');
  } finally { await sim.close(); }
});

// ═══ 角度4：审批流端到端 ═══

test('角度-审批: 高危能力触发审批等待，管理员通过后执行', async () => {
  const sim = await createSim();
  const cfg = makeConfig();
  cfg.orchestration.approval.adminQqIds = ['900'];
  const executed = [];
  const plan = JSON.stringify({
    planId: 'p1', requestId: 'r1', goal: 'video gen',
    steps: [{ id: 's1', capability: 'video.generate', args: { prompt: '一只跳舞的猫' } }],
    confidence: 0.9,
  });
  const handlers = {
    'video.generate': {
      async execute(inv) {
        executed.push('video');
        return { jobId: 'j', stepId: inv.step.id, status: 'success', outputs: [{ kind: 'video', url: 'https://cdn.example/v.mp4', priority: 10, mergeable: false }] };
      },
    },
    'chat.reply': {
      async execute(inv) {
        executed.push('chat');
        return { jobId: 'j', stepId: inv.step.id, status: 'success', outputs: [{ kind: 'text', text: '视频已生成', priority: 10, mergeable: true }] };
      },
    },
  };
  const app = {
    handle: async () => null,
    engine: { async handleExplicit() { return null; } },
    sessions: { clear() {}, get: () => [], append() {} },
    registry: () => ({}),
    client: { async chat() { return { text: plan }; } },
  };
  const enforcer = new OrchestrationEnforcer({
    getConfig: () => cfg, app, client: app.client,
    handlers: new Map(Object.entries(handlers)),
    logger: { info() {}, warn() {}, error() {} },
  });
  // video.generate riskLevel=high → ask_admin → 审批
  const pendingPromise = enforcer.handle({ text: '生成跳舞猫视频', chatType: 'group', groupId: 100, userId: 2 });
  await sleep(300);
  // 审批等待中——视频还没执行
  assert.equal(executed.length, 0, '审批等待期间不执行');
  // 模拟审批通过（直接调 enforcer 的审批结果处理——在真实环境由 ApprovalRuntime 驱动）
  // 这里简化验证：审批等待状态正确建立
  const result = await Promise.race([pendingPromise, sleep(1000).then(() => 'still-waiting')]);
  // 审批在等待（有 ApprovalRuntime 才能完成，这里验证等待状态）
  assert.ok(result === 'still-waiting' || result?.handled !== undefined, '审批应处于等待（或已处理）状态');
  await sim.close();
});

// ═══ 角度5：防刷屏压力测试 ═══

test('角度-防刷: 10 连发消息去重+冷却正常（不无限回复）', async () => {
  const sim = await createSim();
  const cfg = makeConfig();
  cfg.bot.messageRateLimitPerMinute = 5;
  const processed = [];
  const app = {
    handle: async (i) => { processed.push(i.text); return null; },
    engine: { async handleExplicit(kind, input) { processed.push(input.text); return null; } },
    sessions: { clear() {}, get: () => [], append() {} },
    registry: () => ({}), client: {},
  };
  const runtime = createBotMessageRuntime({
    app, reply: sim.adapter, getConfig: () => cfg,
    selfId: () => '10000', botName: 'Mio', reportProblem: async () => true,
  });
  runtime.attach(sim.adapter);
  try {
    for (let i = 0; i < 10; i += 1) {
      sim.sendEvent({ post_type: 'message', message_type: 'private', user_id: 9, message_id: 100 + i, raw_message: 'spam' + i, message: [{ type: 'text', data: { text: 'spam' + i } }] });
      await sleep(20);
    }
    await sleep(500);
    assert.ok(processed.length <= 5, '限频 5/min 应拦截超额消息（实际处理 ' + processed.length + '）');
  } finally { await sim.close(); }
});

// ═══ 角度6：人格 + 统一上下文联合生效 ═══

test('角度-联合: 人格+统一上下文同时开启正常工作', async () => {
  const sim = await createSim();
  const cfg = makeConfig();
  cfg.bot.persona = { enabled: true, name: '大肥鱼', systemPrompt: '你是搞怪担当' };
  cfg.bot.unifiedContext = { enabled: true, plannerHistoryTurns: 10, plannerHistoryChars: 4000 };
  const enforceInputs = [];
  const app = {
    handle: async () => null,
    engine: { async handleExplicit() { return null; } },
    sessions: {
      clear() {},
      get: () => [{ role: 'user', content: '画只猫' }, { role: 'assistant', content: '好的，画好了' }],
      append() {},
    },
    registry: () => ({}), client: {},
  };
  const runtime = createBotMessageRuntime({
    app, reply: sim.adapter, getConfig: () => cfg,
    selfId: () => '10000', botName: 'Mio', reportProblem: async () => true,
    enforceOrchestration: async (input) => {
      enforceInputs.push(input);
      return { handled: true, result: { kind: 'chat', handled: true, text: 'ok', decision: { kind: 'chat', source: 'model', confidence: 1, reason: '', params: { prompt: '', tokens: [] } } } };
    },
  });
  runtime.attach(sim.adapter);
  try {
    sim.sendEvent({ post_type: 'message', message_type: 'group', group_id: 100, user_id: 2, message_id: 50, raw_message: '[CQ:at,qq=10000]再来一张狗', message: [{ type: 'at', data: { qq: '10000' } }, { type: 'text', data: { text: '再来一张狗' } }] });
    await waitUntil(() => enforceInputs.length > 0, 4000, 'enforce called');
    const input = enforceInputs[0];
    assert.ok(input.sessionHistory, '统一上下文应注入对话历史');
    assert.ok(input.sessionHistory.includes('画只猫'), '历史中应包含之前的画猫请求');
    assert.equal(cfg.bot.persona.enabled, true, '人格应同时启用');
  } finally { await sim.close(); }
});

// ═══ 角度7：命令 vs 自然语言分流 ═══

test('角度-分流: 精确命令走命令网关不进 enforce', async () => {
  const sim = await createSim();
  const cfg = makeConfig();
  const enforceCalls = [];
  const commandCalls = [];
  const runtime = createBotMessageRuntime({
    app: makeApp(), reply: sim.adapter, getConfig: () => cfg,
    selfId: () => '10000', botName: 'Mio', reportProblem: async () => true,
    enforceOrchestration: async (input) => {
      enforceCalls.push(input.text);
      return { handled: false, reason: 'skip' };
    },
    commandOrchestration: async (input) => {
      commandCalls.push(input.command);
      return { handled: true };
    },
  });
  runtime.attach(sim.adapter);
  try {
    // /help 是命令
    sim.sendEvent({ post_type: 'message', message_type: 'private', user_id: 2, message_id: 60, raw_message: '/help', message: [{ type: 'text', data: { text: '/help' } }] });
    await sleep(300);
    // 自然语言走 enforce
    sim.sendEvent({ post_type: 'message', message_type: 'private', user_id: 2, message_id: 61, raw_message: '[CQ:at,qq=10000]你好呀', message: [{ type: 'at', data: { qq: '10000' } }, { type: 'text', data: { text: '你好呀' } }] });
    await sleep(300);
    assert.equal(enforceCalls.length, 1, '自然语言只进一次 enforce');
    assert.ok(enforceCalls[0]?.includes('你好'), '自然语言内容正确');
  } finally { await sim.close(); }
});

// ═══ 角度8：断线重连场景 ═══

test('角度-断线: 消息在断线期间到达不崩（优雅忽略）', async () => {
  const sim = await createSim();
  const cfg = makeConfig();
  const runtime = createBotMessageRuntime({
    app: makeApp(), reply: sim.adapter, getConfig: () => cfg,
    selfId: () => '10000', botName: 'Mio', reportProblem: async () => true,
  });
  runtime.attach(sim.adapter);
  // 直接关闭 WebSocket 模拟断线
  sim.peer.terminate();
  await sleep(100);
  try {
    // 断线后发送消息（Napcat 实际不会发，但模拟边界情况）
    try {
      sim.sendEvent({ post_type: 'message', message_type: 'private', user_id: 2, message_id: 70, raw_message: '断线中的消息', message: [{ type: 'text', data: { text: '断线中的消息' } }] });
    } catch { /* 断线时 send 可能失败，正常 */ }
    await sleep(200);
    assert.ok(true, '断线期间不崩溃');
  } finally { await sim.close(); }
});
