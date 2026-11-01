import test from 'node:test';
import assert from 'node:assert/strict';
import { createBotApp, createBotMessageRuntime } from '../dist/apps/bot/src/main.js';
import { createDefaultConfig } from '../dist/packages/config/src/index.js';

test('contextPolicy R9 BUG-4: 群上下文唯一真源 contextPolicy（旧 bot.groupContext 已删除）', async () => {
  const cfg = createDefaultConfig();
  cfg.bot.botQqId = '10000';
  cfg.bot.whitelistGroups = ['3000'];
  cfg.bot.replyStrategies.text = 'plain';
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

test('config 迁移: 旧 bot.groupContext 由 normalize 收口到 contextPolicy（Harness Memory Layer）', async () => {
  const { normalizeConfig } = await import('../dist/packages/config/src/index.js');
  // 场景一：contextPolicy 群上下文字段全为默认 → 旧值回填（含 skipForward/includeImages 无条件接管）。
  const migrated = normalizeConfig({
    bot: { botQqId: '10000', groupContext: { enabled: true, messageCount: 30, skipForward: false, includeImages: true, maxChars: 4000 } },
    contextPolicy: {},
  });
  assert.equal(migrated.contextPolicy.groupContextSkipForward, false, 'skipForward 无条件接管（旧字段曾是唯一来源）');
  assert.equal(migrated.contextPolicy.groupContextIncludeImages, true);
  assert.equal(migrated.contextPolicy.groupContextMessages, 30);
  assert.equal(migrated.contextPolicy.groupContextMaxChars, 4000);
  // 场景二：contextPolicy 已被用户定制（Agent 页改过）→ 不回填，尊重用户现值。
  const customized = normalizeConfig({
    bot: { botQqId: '10000', groupContext: { enabled: false, messageCount: 5, maxChars: 1000 } },
    contextPolicy: { groupContextMessages: 100 },
  });
  assert.equal(customized.contextPolicy.groupContextMessages, 100, '定制过的 contextPolicy 不被迁移覆盖');
  assert.equal(customized.contextPolicy.groupContextSkipForward, true, 'skipForward 旧字段为默认值时迁回默认');
  // normalize 输出不再携带旧字段。
  assert.equal(migrated.bot.groupContext, undefined, 'bot.groupContext 已从配置形态删除');
});
