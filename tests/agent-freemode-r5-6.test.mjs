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
    sendGroupImage: async (_g, url) => { sent.push(['groupImage', String(url)]); return ok(); },
    sendPrivateImage: async (_u, url) => { sent.push(['privateImage', String(url)]); return ok(); },
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
    async generateVideo() { return { videos: [], raw: {}, pending: false }; },
  };
}

function setup(agentMode, agentOutcome, engineText = 'OLD_FREE_MODE') {
  const cfg = createDefaultConfig();
  cfg.bot.botQqId = '10000';
  cfg.bot.whitelistPrivate = ['2000'];
  cfg.bot.replyStrategies.text = 'plain';
  cfg.bot.replyStrategies.image = 'plain';
  cfg.freeMode.enabled = true;
  cfg.orchestration.enabled = false;
  cfg.agent.enabled = agentMode !== 'off';
  cfg.agent.mode = agentMode === 'off' ? 'off' : agentMode;
  const client = makeModelClient(engineText);
  const reply = makeReply();
  const app = createBotApp({ getConfig: () => cfg, client });
  let engineCalls = 0;
  const originalHandle = app.handle.bind(app);
  app.handle = async (input) => {
    engineCalls += 1;
    return originalHandle(input);
  };
  let agentCalls = 0;
  const rt = createBotMessageRuntime({
    app,
    reply,
    getConfig: () => cfg,
    botName: 'Mio',
    agentRuntime: async () => {
      agentCalls += 1;
      return agentOutcome;
    },
    reportProblem: async () => {},
  });
  return {
    rt, reply, cfg,
    get engineCalls() { return engineCalls; },
    get agentCalls() { return agentCalls; },
  };
}

function privateEvent(messageId, rawMessage = '你好') {
  return {
    post_type: 'message',
    message_type: 'private',
    user_id: 2000,
    message_id: messageId,
    raw_message: rawMessage,
    sender: { user_id: 2000, nickname: '用户' },
  };
}

test('agent-freemode R5.6: enforce freeMode text is handled only by AgentRuntime', async () => {
  const h = setup('enforce', { handled: true, text: 'AGENT_FREE_TEXT' });
  const result = await h.rt.handleMessageEvent(privateEvent(1));
  assert.equal(result.handled, true);
  assert.equal(result.kind, 'chat');
  assert.equal(h.agentCalls, 1);
  assert.equal(h.engineCalls, 0);
  assert.ok(h.reply.sent.some(([kind, text]) => kind === 'privateText' && text.includes('AGENT_FREE_TEXT')));
  assert.ok(!h.reply.sent.some(([, text]) => text.includes('OLD_FREE_MODE')));
});

test('agent-freemode R5.6: freeMode generation ReplyPlan keeps the old engine at zero calls', async () => {
  const plan = {
    groups: [{ mode: 'direct', outputs: [{ kind: 'image', url: 'https://example.test/freemode.png', mergeable: false, priority: 20 }], messageCount: 1 }],
    messageCount: 1,
    truncated: [],
    warnings: [],
  };
  const h = setup('enforce', { handled: true, replyPlan: plan });
  const result = await h.rt.handleMessageEvent(privateEvent(2, '画一只猫'));
  assert.equal(result.handled, true);
  assert.equal(h.agentCalls, 1);
  assert.equal(h.engineCalls, 0);
  assert.ok(h.reply.sent.some(([kind, url]) => kind === 'privateImage' && url === 'https://example.test/freemode.png'));
  assert.ok(!h.reply.sent.some(([, value]) => String(value).includes('OLD_FREE_MODE')));
});

test('agent-freemode R9: shadow never sends output; enforce terminates without any old chain', async () => {
  const shadow = setup('shadow', { handled: true, text: 'SHADOW_MUST_NOT_SEND' });
  await shadow.rt.handleMessageEvent(privateEvent(3));
  // P0-1 修复后：shadow 不发送任何内容（包括固定配置提示），消息未处理返回。
  assert.equal(shadow.agentCalls, 1);
  assert.equal(shadow.engineCalls, 0);
  assert.equal(shadow.reply.sent.length, 0);

  const fallback = setup('enforce', { handled: false, reason: 'agent_not_handled' });
  await fallback.rt.handleMessageEvent(privateEvent(4));
  assert.equal(fallback.agentCalls, 1);
  assert.equal(fallback.engineCalls, 0);
  assert.equal(fallback.reply.sent.length, 0, 'Agent enforce 失败不得发送固定兜底文案');
  assert.ok(!fallback.reply.sent.some(([, text]) => text.includes('OLD_FREE_MODE')));
});

test('agent-freemode R5.6: exact commands still bypass AgentRuntime', async () => {
  const cfg = createDefaultConfig();
  cfg.bot.botQqId = '10000';
  cfg.bot.whitelistPrivate = ['2000'];
  // /help is a built-in command alias
  cfg.bot.replyStrategies.text = 'plain';
  cfg.freeMode.enabled = true;
  cfg.orchestration.enabled = false;
  cfg.agent.enabled = true;
  cfg.agent.mode = 'enforce';
  const client = makeModelClient('OLD_FREE_MODE');
  const reply = makeReply();
  const app = createBotApp({ getConfig: () => cfg, client });
  let agentCalls = 0;
  const rt = createBotMessageRuntime({
    app,
    reply,
    getConfig: () => cfg,
    botName: 'Mio',
    agentRuntime: async () => {
      agentCalls += 1;
      return { handled: true, text: 'AGENT_MUST_NOT_STEAL_COMMAND' };
    },
    reportProblem: async () => {},
  });
  const result = await rt.handleMessageEvent(privateEvent(5, '/help'));
  assert.equal(result.handled, true);
  assert.equal(agentCalls, 0);
  assert.ok(!reply.sent.some(([, text]) => text.includes('AGENT_MUST_NOT_STEAL_COMMAND')));
});
