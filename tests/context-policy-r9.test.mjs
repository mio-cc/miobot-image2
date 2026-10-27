import test from 'node:test';
import assert from 'node:assert/strict';
import { createBotApp, createBotMessageRuntime } from '../dist/apps/bot/src/main.js';
import { createDefaultConfig } from '../dist/packages/config/src/index.js';

test('contextPolicy R9 BUG-4: group context fields override legacy bot.groupContext', async () => {
  const cfg = createDefaultConfig();
  cfg.bot.botQqId = '10000';
  cfg.bot.whitelistGroups = ['3000'];
  cfg.bot.replyStrategies.text = 'plain';
  cfg.bot.groupContext.enabled = false;
  cfg.contextPolicy.groupContextEnabled = true;
  cfg.contextPolicy.groupContextMessages = 2;
  cfg.contextPolicy.groupContextMaxChars = 500;
  cfg.agent.enabled = true;
  cfg.agent.mode = 'enforce';
  let fetchedCount = 0;
  let seenGroupContext = '';
  const app = createBotApp({
    getConfig: () => cfg,
    client: {
      async chat() { throw new Error('legacy path must not run'); },
      can: () => true,
      async vision() { throw new Error('legacy path must not run'); },
      async generateImages() { return { images: [], raw: {} }; },
      async editImage() { return { images: [], raw: {} }; },
      async interrogate() { return { text: '', raw: {} }; },
      async generateVideo() { return { videos: [], raw: {}, pending: true }; },
    },
  });
  const rt = createBotMessageRuntime({
    app,
    getConfig: () => cfg,
    botName: 'Mio',
    reply: {
      sendGroupText: async () => ({ success: true, messageId: 1 }),
      sendPrivateText: async () => ({ success: true, messageId: 1 }),
    },
    fetchGroupHistory: async (_groupId, _anchor, count) => {
      fetchedCount = count;
      return [
        { message_id: 2, sender: { nickname: '甲', user_id: 1 }, raw_message: '历史消息一' },
        { message_id: 3, sender: { nickname: '乙', user_id: 2 }, raw_message: '历史消息二' },
      ];
    },
    agentRuntime: async (input) => {
      seenGroupContext = String(input.groupContext || '');
      return { handled: true, text: '已读取上下文' };
    },
    reportProblem: async () => {},
  });
  const result = await rt.handleMessageEvent({
    post_type: 'message', message_type: 'group', group_id: 3000, user_id: 900,
    message_id: 10, raw_message: '[CQ:at,qq=10000] 继续聊', sender: { user_id: 900, nickname: '用户' },
  });
  assert.equal(result.handled, true);
  assert.equal(fetchedCount, 10);
  assert.match(seenGroupContext, /历史消息一|历史消息二/);
});
