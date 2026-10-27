import test from 'node:test';
import assert from 'node:assert/strict';
import { createBotApp, createBotMessageRuntime } from '../dist/apps/bot/src/main.js';
import { agentSessionKey, hasPendingAgentClarification } from '../dist/apps/bot/src/pending-clarification.js';
import { createDefaultConfig } from '../dist/packages/config/src/index.js';

test('pending clarification R9 BUG-3: agent session pendingQuestion is discoverable by runtime bridge', () => {
  const sessions = {
    load(key) {
      return key === 'group:3000:900' ? { pendingQuestion: { question: '哪个文件？' } } : undefined;
    },
  };
  assert.equal(agentSessionKey('group', 3000, 900), 'group:3000:900');
  assert.equal(agentSessionKey('private', undefined, 900), 'private:900');
  assert.equal(hasPendingAgentClarification(sessions, { chatType: 'group', groupId: 3000, userId: 900 }), true);
  assert.equal(hasPendingAgentClarification(sessions, { chatType: 'group', groupId: 3000, userId: 901 }), false);
});

test('pending clarification R9 BUG-3: attachment-only group answer reaches AgentRuntime without @', async () => {
  const cfg = createDefaultConfig();
  cfg.bot.botQqId = '10000';
  cfg.bot.whitelistGroups = ['3000'];
  cfg.bot.replyStrategies.text = 'plain';
  cfg.agent.enabled = true;
  cfg.agent.mode = 'enforce';
  const sent = [];
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
  let seen;
  const rt = createBotMessageRuntime({
    app,
    getConfig: () => cfg,
    botName: 'Mio',
    reply: {
      sendGroupText: async (_groupId, text) => { sent.push(String(text)); return { success: true, messageId: 1 }; },
      sendPrivateText: async (_userId, text) => { sent.push(String(text)); return { success: true, messageId: 1 }; },
    },
    hasPendingClarification: () => true,
    prepareInputImages: async () => ['data:image/png;base64,AAAA'],
    agentRuntime: async (input) => {
      agentCalls += 1;
      seen = input;
      return { handled: true, text: '收到图片回答。' };
    },
    reportProblem: async () => {},
  });
  const result = await rt.handleMessageEvent({
    post_type: 'message',
    message_type: 'group',
    group_id: 3000,
    user_id: 900,
    message_id: 77,
    raw_message: '[CQ:image,file=answer.png]',
    sender: { user_id: 900, nickname: '用户' },
  });
  assert.equal(result.handled, true);
  assert.equal(agentCalls, 1);
  assert.equal(seen.text, '');
  assert.equal(seen.images.length, 1);
  assert.ok(sent.some((text) => text.includes('收到图片回答')));
});
