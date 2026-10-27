import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentHost } from '../dist/apps/bot/src/agent-host.js';
import { createDefaultConfig } from '../dist/packages/config/src/index.js';

test('voice=on goes through reply.presentation and applies to the final assistant text', async () => {
  const cfg = createDefaultConfig();
  cfg.agent.enabled = true;
  cfg.agent.mode = 'enforce';
  let calls = 0;
  const client = {
    async chat() {
      calls += 1;
      if (calls === 1) {
        return {
          text: '', raw: {},
          toolCalls: [{ id: 'present', name: 'reply.presentation', arguments: { voice: 'on', scope: 'turn' } }],
          finishReason: 'tool_calls',
        };
      }
      return { text: '这是要朗读的最终天气回答。', raw: {} };
    },
  };
  const host = createAgentHost({
    getConfig: () => cfg,
    client,
    toolBindings: () => [],
    preflightToolCall: () => ({ allowed: true }),
    isMigratedTool: () => true,
  });
  const outcome = await host({ text: '用语音回答我', chatType: 'private', userId: '1', sessionId: 'private:voice-on' });
  assert.equal(outcome.status, 'completed');
  assert.equal(outcome.turn?.replyPreference?.voice, 'on');
  assert.equal(outcome.replyPlan?.policy?.voice, 'on');
  assert.match(String(outcome.text || ''), /最终天气回答/);
});
