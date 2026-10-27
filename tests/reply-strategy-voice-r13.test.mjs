import test from 'node:test';
import assert from 'node:assert/strict';

import { createDefaultConfig } from '../dist/packages/config/src/index.js';
import { resolveReplyPolicy, textCharsOf } from '../dist/packages/orchestration/src/reply-policy.js';
import { normalizeStrategy } from '../dist/packages/reply/src/index.js';

const baseConfig = () => {
  const cfg = createDefaultConfig();
  cfg.replyPolicy.enabled = true;
  cfg.replyPolicy.allowModelOverride = true;
  cfg.replyPolicy.allowSessionPreferences = true;
  cfg.replyPolicy.allowUserPreferences = true;
  return cfg;
};

// ═══ R13：后台 bot.replyStrategies.text=voice（语音回复）必须进入 Agent 回复策略 ═══

test('R13: strategy enum accepts voice (normalization + engine fallback intact)', () => {
  const cfg = createDefaultConfig();
  cfg.bot.replyStrategies.text = 'voice';
  const normalized = JSON.parse(JSON.stringify(cfg));
  assert.equal(normalized.bot.replyStrategies.text, 'voice');
  assert.equal(normalizeStrategy('voice'), 'voice');
  assert.equal(normalizeStrategy('voice', 'forward'), 'voice');
  assert.equal(normalizeStrategy('bogus', 'forward'), 'forward');
  // 引擎对不支持 voice 的通道：voice 落默认分支直发文本（normalizeStrategy 语义不变）
  assert.equal(normalizeStrategy(undefined, 'forward'), 'forward');
});

test('R13: backend text=voice (no explicit preference) resolves policy.voice=on and mode=direct', () => {
  const cfg = baseConfig();
  cfg.bot.replyStrategies.text = 'voice';
  const { policy } = resolveReplyPolicy({ config: cfg, textChars: 50 });
  assert.equal(policy.voice, 'on', '后台默认语音回复时 policy.voice 必须为 on');
  assert.equal(policy.mode, 'direct', 'voice 是文本表现策略，消息 mode 保持 direct 直发形态');
  assert.equal(policy.forcedForward, false);
});

test('R13: backend text=voice still honors replyPolicy.defaultVoice=off', () => {
  const cfg = baseConfig();
  cfg.bot.replyStrategies.text = 'voice';
  cfg.replyPolicy.defaultVoice = 'off';
  const { policy } = resolveReplyPolicy({ config: cfg, textChars: 50 });
  // 显式后台默认语音=off 优先于 text=voice 的隐式 on
  assert.equal(policy.voice, 'off');
});

test('R13: explicit turn voice preference still beats backend default chain', () => {
  const cfg = baseConfig();
  cfg.bot.replyStrategies.text = 'voice';
  const withOff = resolveReplyPolicy({
    config: cfg,
    textChars: 50,
    turnPreference: { voice: 'off' },
  });
  assert.equal(withOff.policy.voice, 'off', 'turn voice=off 必须覆盖后台 voice 默认');
  const withOn = resolveReplyPolicy({
    config: cfg,
    textChars: 50,
    turnPreference: { voice: 'on' },
  });
  assert.equal(withOn.policy.voice, 'on');
});

test('R13: backend text=voice with long text still forced forward (voice suppressed by hard constraint)', () => {
  const cfg = baseConfig();
  cfg.bot.replyStrategies.text = 'voice';
  const longText = '字'.repeat(cfg.replyPolicy.forcedForwardThreshold + 10);
  const { policy } = resolveReplyPolicy({ config: cfg, textChars: textCharsOf([{ kind: 'text', text: longText }]) });
  // 协议硬约束优先：超长文本强制合并转发（语音不能进合并转发），TTS 前提在发送层不成立
  assert.equal(policy.forcedForward, true, '超长文本必须强制 forward');
  assert.equal(policy.mode, 'direct');
});

test('R13: session/user preference chain unchanged (voice preference)', () => {
  const cfg = baseConfig();
  cfg.bot.replyStrategies.text = 'plain';
  const sessionOn = resolveReplyPolicy({
    config: cfg,
    textChars: 10,
    sessionPreference: { voice: 'on' },
  });
  assert.equal(sessionOn.policy.voice, 'on');
  const backendDefault = resolveReplyPolicy({ config: cfg, textChars: 10 });
  assert.equal(backendDefault.policy.voice, cfg.replyPolicy.defaultVoice);
});