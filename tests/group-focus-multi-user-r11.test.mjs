import test from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultConfig } from '../dist/packages/config/src/index.js';
import { createBotMessageRuntime } from '../dist/apps/bot/src/main.js';

function setup() {
  const cfg = createDefaultConfig();
  cfg.agent.enabled = true;
  cfg.agent.mode = 'enforce';
  cfg.bot.botQqId = '10000';
  cfg.bot.ownerQQs = ['1'];
  cfg.bot.whitelistGroups = ['3000'];
  cfg.bot.replyStrategies.text = 'plain';
  cfg.bot.autoContinue = {
    enabled: true, windowMs: 60000, maxRounds: 3,
    cooldownMs: 5000, requireModelCheck: true, focusMaxMessages: 20,
  };
  const agentInputs = [];
  const checkerCalls = [];
  const sent = [];
  const reply = {
    sendGroupText: async (g, t) => { sent.push({ method: 'groupText', group: String(g), text: t }); return { success: true, messageId: sent.length }; },
    sendPrivateText: async (u, t) => { sent.push({ method: 'privateText', userId: String(u), text: t }); return { success: true, messageId: sent.length }; },
    sendGroupRecord: async () => { sent.push({ method: 'groupRecord' }); return { success: true, messageId: sent.length }; },
    sendPrivateRecord: async () => { sent.push({ method: 'privateRecord' }); return { success: true, messageId: sent.length }; },
  };
  const checker = {
    async checkKeywordIntent() { return false; },
    async checkContinueIntent(input) {
      checkerCalls.push(input);
      if (/吃什么/.test(input.userText)) return false;
      return true;
    },
  };
  const runtime = createBotMessageRuntime({
    app: {
      handle: async () => ({ kind: 'chat', handled: false }),
      engine: { handleExplicit: async () => null },
      sessions: { clear() {}, get: () => [], append() {} },
      registry: () => ({}), client: {},
    },
    reply,
    getConfig: () => cfg,
    selfId: () => '10000',
    botName: 'Mio',
    fetchGroupHistory: async () => [],
    triggerIntentChecker: checker,
    reportProblem: async () => true,
    agentRuntime: async (input) => {
      agentInputs.push({ userId: String(input.userId), sessionId: input.sessionId, text: input.text, groupContext: input.groupContext });
      return { handled: true, text: `回复给${input.userId}:${input.text}` };
    },
  });
  let nextMessageId = 9000;
  const event = (userId, text, mention = false) => ({
    post_type: 'message', message_type: 'group', group_id: 3000,
    user_id: userId, message_id: nextMessageId++, sender: { nickname: `用户${userId}` },
    raw_message: `${mention ? '[CQ:at,qq=10000] ' : ''}${text}`,
    message: [...(mention ? [{ type: 'at', data: { qq: '10000' } }] : []), { type: 'text', data: { text } }],
  });
  return { runtime, event, agentInputs, checkerCalls, sent };
}

test('group focus R11: users stay isolated, interjections do not steal the conversation', async () => {
  const h = setup();
  await h.runtime.handleMessageEvent(h.event(1001, '帮我记住这个话题', true));
  await h.runtime.handleMessageEvent(h.event(1001, '再展开一点'));
  const unrelated = await h.runtime.handleMessageEvent(h.event(1002, '今天吃什么'));
  await h.runtime.handleMessageEvent(h.event(1002, '我也问个问题', true));
  const aAfterB = await h.runtime.handleMessageEvent(h.event(1001, '继续这个话题'));
  await h.runtime.handleMessageEvent(h.event(1002, '我这个也继续'));

  assert.equal(unrelated.handled, false, 'B 的无关插话不能回复');
  assert.equal(aAfterB.handled, true, 'A 在 B 插话后仍应被接住');
  assert.deepEqual(
    h.agentInputs.map((item) => item.sessionId),
    ['group:3000:1001', 'group:3000:1001', 'group:3000:1002', 'group:3000:1001', 'group:3000:1002'],
    '不同用户必须使用不同 session',
  );
  assert.ok(h.agentInputs.filter((item) => item.userId === '1002').length >= 2);
  const focusChecks = h.checkerCalls.filter((item) => item.focusMode === true);
  assert.ok(focusChecks.some((item) => item.userText === '今天吃什么' && item.isOriginalUser === false));
  assert.ok(focusChecks.some((item) => item.userText === '继续这个话题'));
  assert.ok(focusChecks.every((item) => typeof item.groupContext === 'string' && item.groupContext.length > 0));
});

test('group focus R11: the observed window is bounded by message budget', async () => {
  // 用独立 runtime 配置缩小关注窗口；不影响上面的隔离用例。
  const cfg = createDefaultConfig();
  cfg.agent.enabled = true; cfg.agent.mode = 'enforce';
  cfg.bot.botQqId = '10000'; cfg.bot.ownerQQs = ['1']; cfg.bot.whitelistGroups = ['3000'];
  cfg.bot.replyStrategies.text = 'plain';
  cfg.bot.autoContinue = { enabled: true, windowMs: 60000, maxRounds: 3, cooldownMs: 5000, requireModelCheck: true, focusMaxMessages: 1 };
  const inputs = [];
  const runtime = createBotMessageRuntime({
    app: { handle: async () => ({ kind: 'chat', handled: false }), engine: { handleExplicit: async () => null }, sessions: { clear() {}, get: () => [], append() {} }, registry: () => ({}), client: {} },
    reply: { sendGroupText: async () => ({ success: true, messageId: 1 }), sendPrivateText: async () => ({ success: true, messageId: 1 }) },
    getConfig: () => cfg, selfId: () => '10000', botName: 'Mio', fetchGroupHistory: async () => [],
    triggerIntentChecker: { checkKeywordIntent: async () => false, checkContinueIntent: async () => true },
    reportProblem: async () => true,
    agentRuntime: async (input) => { inputs.push(input.text); return { handled: true, text: '回复' }; },
  });
  let id = 9500;
  const ev = (uid, text, mention = false) => ({ post_type: 'message', message_type: 'group', group_id: 3000, user_id: uid, message_id: id++, sender: { nickname: `用户${uid}` }, raw_message: `${mention ? '[CQ:at,qq=10000] ' : ''}${text}`, message: [...(mention ? [{ type: 'at', data: { qq: '10000' } }] : []), { type: 'text', data: { text } }] });
  await runtime.handleMessageEvent(ev(1001, '触发', true));
  await runtime.handleMessageEvent(ev(1002, '我也接一句'));
  await runtime.handleMessageEvent(ev(1002, '第二句'));
  assert.equal(inputs.length, 2, '第一句在关注窗口内可回复，第二句预算耗尽后不能回复');
});
