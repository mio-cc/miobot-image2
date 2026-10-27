import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveReplyPolicy } from '../dist/packages/orchestration/src/index.js';
import { createDefaultConfig } from '../dist/packages/config/src/index.js';
import { createAgentHost } from '../dist/apps/bot/src/agent-host.js';
import { createBotMessageRuntime } from '../dist/apps/bot/src/runtime.js';

test('reply-policy R6: hard caps, forced forward and preference precedence are resolved centrally', () => {
  const cfg = createDefaultConfig();
  cfg.replyPolicy.enabled = true;
  cfg.replyPolicy.hardMaxMessages = 2;
  cfg.replyPolicy.hardMaxChars = 40;
  cfg.replyPolicy.forcedForwardThreshold = 10;
  cfg.replyPolicy.defaultVoice = 'on';

  const forced = resolveReplyPolicy({ config: cfg, textChars: 20 });
  assert.equal(forced.policy.enabled, true);
  assert.equal(forced.policy.maxMessages, 2);
  assert.equal(forced.policy.maxChars, 40);
  assert.equal(forced.policy.voice, 'on');
  assert.equal(forced.policy.forcedForward, true);
  assert.equal(forced.options.preferNestedForward, true);
  assert.equal(forced.options.textFallback, 'off');

  const turnWins = resolveReplyPolicy({
    config: cfg,
    textChars: 20,
    turnPreference: { mode: 'forward', forwardStyle: 'flat', voice: 'off', reference: 'none' },
    sessionPreference: { mode: 'direct', forwardStyle: 'nested', voice: 'on' },
  });
  assert.equal(turnWins.policy.mode, 'forward');
  assert.equal(turnWins.policy.forwardStyle, 'flat');
  assert.equal(turnWins.policy.voice, 'off');
  assert.equal(turnWins.policy.reference, 'none');
  assert.equal(turnWins.options.preferNestedForward, true);
  assert.equal(turnWins.options.textFallback, 'off');

  cfg.replyPolicy.allowModelOverride = false;
  cfg.replyPolicy.allowSessionPreferences = true;
  const gated = resolveReplyPolicy({
    config: cfg,
    textChars: 5,
    turnPreference: { voice: 'off' },
    sessionPreference: { voice: 'on', forwardStyle: 'flat' },
  });
  assert.equal(gated.policy.voice, 'on');
  assert.equal(gated.policy.forwardStyle, 'flat');
});

test('reply-policy R6: AgentHost persists session preference and attaches policy to ReplyPlan', async () => {
  const cfg = createDefaultConfig();
  cfg.agent.enabled = true;
  cfg.agent.mode = 'enforce';
  cfg.agent.mainModel = 'gpt-4o-mini';
  cfg.freeMode.enabled = false;
  cfg.replyPolicy.enabled = true;
  cfg.replyPolicy.hardMaxMessages = 2;
  cfg.replyPolicy.forcedForwardThreshold = 100_000;
  let calls = 0;
  const host = createAgentHost({
    getConfig: () => cfg,
    client: {
      async chat() {
        calls += 1;
        return { text: calls === 1 ? '第一轮回复' : '第二轮回复', raw: {} };
      },
    },
  });
  const first = await host({
    text: '你好',
    chatType: 'private',
    userId: '1',
    sessionId: 'private:reply-policy',
    replyPreference: { forwardStyle: 'flat', voice: 'off', reference: 'none' },
  });
  assert.equal(first.handled, true);
  assert.ok(first.replyPlan);
  assert.equal(first.replyPlan.policy.voice, 'off');
  assert.equal(first.replyPlan.policy.forwardStyle, 'flat');
  assert.equal(first.replyPlan.policy.reference, 'none');
  assert.ok(first.replyPlan.policy.maxMessages <= 2);

  const second = await host({ text: '继续', chatType: 'private', userId: '1', sessionId: 'private:reply-policy' });
  assert.equal(second.handled, true);
  assert.equal(second.replyPlan.policy.voice, 'off');
  assert.equal(second.replyPlan.policy.forwardStyle, 'flat');
  assert.equal(second.replyPlan.policy.reference, 'none');
});

test('reply-policy R6: runtime honors plan voice=off and hard maxMessages', async () => {
  const cfg = createDefaultConfig();
  cfg.bot.replyStrategies.text = 'plain';
  let voiceCalls = 0;
  const sent = [];
  const reply = {
    sendPrivateText: async (_userId, text) => { sent.push(String(text)); return { success: true, messageId: 1 }; },
  };
  const runtime = createBotMessageRuntime({
    reply,
    getConfig: () => cfg,
    botName: 'Mio',
    voice: async () => { voiceCalls += 1; return 'file://voice.mp3'; },
    voiceEligible: () => true,
  });
  const policy = {
    enabled: true,
    maxMessages: 1,
    maxChars: 100,
    mode: 'direct',
    forwardStyle: 'flat',
    voice: 'off',
    reference: 'none',
    forcedForward: false,
  };
  const replyPlan = {
    groups: [
      { mode: 'direct', outputs: [{ kind: 'text', text: '第一条', priority: 10 }], messageCount: 1 },
      { mode: 'direct', outputs: [{ kind: 'text', text: '第二条', priority: 9 }], messageCount: 1 },
    ],
    messageCount: 2,
    truncated: [],
    warnings: [],
    policy,
  };
  const result = await runtime.sendAgentOutcome({ chatType: 'private', userId: '1', replyPlan });
  assert.equal(result.handled, true);
  assert.equal(voiceCalls, 0);
  assert.equal(sent.length, 1);
  assert.equal(sent[0], '第一条');
});
