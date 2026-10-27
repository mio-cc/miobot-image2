import test from 'node:test';
import assert from 'node:assert/strict';
import { createBotApp, createBotMessageRuntime } from '../dist/apps/bot/src/main.js';
import { createDefaultConfig } from '../dist/packages/config/src/index.js';

function makeReply() {
  const sent = [];
  const ok = () => ({ success: true, messageId: 1 });
  return {
    sent,
    sendGroupText: async (groupId, text) => { sent.push({ groupId: String(groupId), kind: 'groupText', text: String(text) }); return ok(); },
    sendPrivateText: async (userId, text) => { sent.push({ userId: String(userId), kind: 'privateText', text: String(text) }); return ok(); },
  };
}

test('freeMode R9 soak: concurrent group messages stay session-isolated under agent enforce', async () => {
  const cfg = createDefaultConfig();
  cfg.bot.botQqId = '10000';
  cfg.bot.whitelistGroups = ['5000'];
  cfg.bot.replyStrategies.text = 'plain';
  cfg.freeMode.enabled = true;
  cfg.orchestration.enabled = false;
  cfg.agent.enabled = true;
  cfg.agent.mode = 'enforce';
  const reply = makeReply();
  const app = createBotApp({
    getConfig: () => cfg,
    client: {
      async chat() { throw new Error('legacy model path must not be used'); },
      can: () => true,
      async vision() { throw new Error('legacy vision path must not be used'); },
      async generateImages() { return { images: [], raw: {} }; },
      async editImage() { return { images: [], raw: {} }; },
      async interrogate() { return { text: '', raw: {} }; },
      async generateVideo() { return { videos: [], raw: {}, pending: true }; },
    },
  });
  let agentCalls = 0;
  let legacyCalls = 0;
  const originalHandle = app.handle.bind(app);
  app.handle = async (input) => { legacyCalls += 1; return originalHandle(input); };
  const rt = createBotMessageRuntime({
    app,
    reply,
    getConfig: () => cfg,
    botName: 'Mio',
    agentRuntime: async (input) => {
      agentCalls += 1;
      return { handled: true, text: `R:${input.userId}:${input.text}` };
    },
    reportProblem: async () => {},
  });

  const users = 10;
  const rounds = 3;
  let messageId = 1;
  const results = [];
  for (let round = 0; round < rounds; round += 1) {
    const events = [];
    for (let user = 1; user <= users; user += 1) {
      const text = `msg-${user}-${round}`;
      events.push({
        post_type: 'message',
        message_type: 'group',
        group_id: 5000,
        user_id: 2000 + user,
        message_id: messageId++,
        raw_message: `[CQ:at,qq=10000] ${text}`,
        sender: { user_id: 2000 + user, nickname: `用户${user}` },
      });
    }
    const batch = await Promise.all(events.map((event) => rt.handleMessageEvent(event)));
    results.push(...batch);
  }

  assert.equal(results.filter((result) => result.handled).length, users * rounds);
  assert.equal(agentCalls, users * rounds);
  assert.equal(legacyCalls, 0);
  assert.equal(reply.sent.length, users * rounds);
  const values = new Set(reply.sent.map((item) => item.text));
  for (let round = 0; round < rounds; round += 1) {
    for (let user = 1; user <= users; user += 1) {
      assert.ok(values.has(`R:${2000 + user}:msg-${user}-${round}`), `missing reply for user ${user} round ${round}`);
    }
  }
  assert.ok(reply.sent.every((item) => item.kind === 'groupText' && item.groupId === '5000'));
});
