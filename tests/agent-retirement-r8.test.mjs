import test from 'node:test';
import assert from 'node:assert/strict';
import { createBotApp, createBotMessageRuntime } from '../dist/apps/bot/src/main.js';
import { createDefaultConfig } from '../dist/packages/config/src/index.js';

function makeReply() {
  const sent = [];
  const ok = () => ({ success: true, messageId: 1 });
  return {
    sent,
    sendGroupText: async (_g, text) => { sent.push(['groupText', String(text)]); return ok(); },
    sendPrivateText: async (_u, text) => { sent.push(['privateText', String(text)]); return ok(); },
  };
}

function makeModelClient(text) {
  return {
    async chat() { return { text, raw: {} }; },
    can: () => true,
    async vision() { return { text, raw: {} }; },
    async generateImages() { return { images: [], raw: {} }; },
    async editImage() { return { images: [], raw: {} }; },
    async interrogate() { return { text, raw: {} }; },
    async generateVideo() { return { videos: [], raw: {}, pending: true }; },
  };
}

function setup(mode, agentOutcome, withOrchestration = false) {
  const cfg = createDefaultConfig();
  cfg.bot.botQqId = '10000';
  cfg.bot.whitelistPrivate = ['2000'];
  cfg.bot.replyStrategies.text = 'plain';
  cfg.freeMode.enabled = true;
  cfg.agent.enabled = mode !== 'off';
  cfg.agent.mode = mode;
  cfg.orchestration.enabled = withOrchestration;
  cfg.orchestration.mode = 'enforce';
  const client = makeModelClient('OLD_PLANNER_RESULT');
  const reply = makeReply();
  const app = createBotApp({ getConfig: () => cfg, client });
  let engineCalls = 0;
  const originalHandle = app.handle.bind(app);
  app.handle = async (input) => { engineCalls += 1; return originalHandle(input); };
  let orchestrationCalls = 0;
  let agentCalls = 0;
  const rt = createBotMessageRuntime({
    app,
    reply,
    getConfig: () => cfg,
    botName: 'Mio',
    ...(agentOutcome !== undefined ? { agentRuntime: async () => { agentCalls += 1; return agentOutcome; } } : {}),
    ...(withOrchestration ? {
      enforceOrchestration: async () => {
        orchestrationCalls += 1;
        return { handled: true, result: { kind: 'chat', decision: { kind: 'chat' }, handled: true, text: 'OLD_ORCHESTRATION' } };
      },
    } : {}),
    reportProblem: async () => {},
  });
  return {
    rt, reply, cfg,
    get engineCalls() { return engineCalls; },
    get orchestrationCalls() { return orchestrationCalls; },
    get agentCalls() { return agentCalls; },
  };
}

function event(messageId) {
  return {
    post_type: 'message', message_type: 'private', user_id: 2000, message_id: messageId,
    raw_message: '你好', sender: { user_id: 2000, nickname: '用户' },
  };
}

test('agent-retirement R8: enforce failure never calls old orchestration or BotEngine', async () => {
  const h = setup('enforce', { handled: false, reason: 'agent_not_handled' }, true);
  const result = await h.rt.handleMessageEvent(event(1));
  assert.equal(result.handled, true);
  assert.equal(result.kind, 'agent-enforce-failed');
  assert.equal(h.agentCalls, 1);
  assert.equal(h.orchestrationCalls, 0);
  assert.equal(h.engineCalls, 0);
  assert.ok(h.reply.sent.some(([, text]) => text.includes('这次没有处理成功')));
  assert.ok(!h.reply.sent.some(([, text]) => text.includes('OLD_PLANNER_RESULT')));
  assert.ok(!h.reply.sent.some(([, text]) => text.includes('OLD_ORCHESTRATION')));
});

test('agent-retirement R9: shadow runs the agent, never sends output and never touches a deleted old chain', async () => {
  const h = setup('shadow', { handled: true, text: 'SHADOW_ONLY' }, false);
  const result = await h.rt.handleMessageEvent(event(2));
  // P0-1 修复后：shadow 不向用户发送任何固定配置提示（也不发 Agent 产物），消息按未处理返回。
  assert.equal(result.handled, false);
  assert.equal(result.reason, 'agent-shadow');
  assert.equal(h.agentCalls, 1);
  assert.equal(h.engineCalls, 0);
  assert.equal(h.orchestrationCalls, 0);
  assert.equal(h.reply.sent.length, 0);
});

test('agent-retirement R9: off falls back to the legacy engine and never notifies users with config text', async () => {
  const h = setup('off', { handled: true, text: 'AGENT_MUST_NOT_RUN' }, false);
  const result = await h.rt.handleMessageEvent(event(3));
  // P0-1 方式二：off 回退旧自然语言引擎（app.handle）；Agent 不被调用；
  // 用户不会收到任何"请到后台开启"之类的固定配置提示。
  assert.equal(h.agentCalls, 0);
  assert.equal(h.orchestrationCalls, 0);
  assert.ok(!h.reply.sent.some(([, text]) => text.includes('未启用 Agent') || text.includes('shadow 模式')), JSON.stringify(h.reply.sent));
  // 旧引擎接管并回复(或至少消息被处理),不再是静默 agent-off。
  assert.notEqual(result.reason, 'agent-off');
});

test('agent-retirement R8: enforce without an injected AgentRuntime also fails closed', async () => {
  const h = setup('enforce', undefined, true);
  const result = await h.rt.handleMessageEvent(event(4));
  assert.equal(result.handled, true);
  assert.equal(result.kind, 'agent-enforce-failed');
  assert.equal(h.agentCalls, 0);
  assert.equal(h.orchestrationCalls, 0);
  assert.equal(h.engineCalls, 0);
  assert.ok(h.reply.sent.some(([, text]) => text.includes('这次没有处理成功')));
});
