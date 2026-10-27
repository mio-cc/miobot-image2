import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentHost } from '../dist/apps/bot/src/agent-host.js';
import { createDefaultConfig } from '../dist/packages/config/src/index.js';
import { ReplyPreferenceStore } from '../dist/apps/bot/src/reply-preference-store.js';

test('autoContinue preference window: same window persists, new window falls back', async () => {
  const cfg = createDefaultConfig();
  cfg.agent.enabled = true;
  cfg.agent.mode = 'enforce';
  cfg.agent.mainModel = 'mock';
  cfg.replyPolicy.defaultVoice = 'auto';
  const store = new ReplyPreferenceStore({ maxRecords: 100 });
  let calls = 0;
  const client = {
    async chat() {
      calls += 1;
      if (calls === 1) return { text: '', raw: {}, toolCalls: [{ id: 'p1', name: 'reply.presentation', arguments: { voice: 'off', scope: 'session' } }], finishReason: 'tool_calls' };
      return { text: '收到。', raw: {}, finishReason: 'stop' };
    },
  };
  const host = createAgentHost({
    getConfig: () => cfg,
    client,
    replyPreferenceStore: store,
    preflightToolCall: () => ({ allowed: true }),
  });
  const first = await host({ text: '这次用文字', chatType: 'group', groupId: 'g1', userId: 'u1', sessionId: 'group:g1:u1', replyPreferenceSessionKey: 'group:g1:u1::window:w1' });
  assert.equal(first.replyPlan?.policy?.voice, 'off');
  const second = await host({ text: '继续', chatType: 'group', groupId: 'g1', userId: 'u1', sessionId: 'group:g1:u1', replyPreferenceSessionKey: 'group:g1:u1::window:w1' });
  assert.equal(second.replyPlan?.policy?.voice, 'off', '同一延续窗口应继续沿用');
  const third = await host({ text: '新窗口', chatType: 'group', groupId: 'g1', userId: 'u1', sessionId: 'group:g1:u1', replyPreferenceSessionKey: 'group:g1:u1::window:w2' });
  assert.notEqual(third.replyPlan?.policy?.voice, 'off', '新窗口必须回落后台配置');
});