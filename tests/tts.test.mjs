import test from 'node:test';
import assert from 'node:assert/strict';

import { buildTtsRequest, shouldUseTts, activeFishVoiceId } from '../dist/apps/bot/src/main.js';
import { createDefaultConfig } from '../dist/packages/config/src/index.js';

function fishTts(overrides = {}) {
  const tts = createDefaultConfig().bot.tts;
  tts.provider = 'fish-audio';
  tts.voiceId = 'voice-123';
  return Object.assign(tts, overrides);
}

test('buildTtsRequest: fish-audio 形态(/v1/tts + reference_id + prosody + model 头)', () => {
  const plan = buildTtsRequest(fishTts({ model: 's2-pro', speed: 1.2, volume: 3 }), '你好');
  assert.equal(plan.url, 'https://api.fish.audio/v1/tts');
  assert.equal(plan.headers.model, 's2-pro');
  assert.equal(plan.body.reference_id, 'voice-123');
  assert.equal(plan.body.text, '你好');
  assert.equal(plan.body.prosody.speed, 1.2);
  assert.equal(plan.body.prosody.volume, 3);
  assert.equal(plan.format, 'mp3');
});

test('buildTtsRequest: openai-compatible 形态(/audio/speech + voice + input)', () => {
  const tts = createDefaultConfig().bot.tts;
  tts.provider = 'openai-compatible';
  tts.apiUrl = ''; // 清空以测默认地址回退(显式 apiUrl 会优先)
  tts.voice = 'alloy';
  tts.format = 'wav';
  const plan = buildTtsRequest(tts, 'hello');
  assert.equal(plan.url, 'https://api.openai.com/v1/audio/speech');
  assert.equal(plan.body.model, 'tts-1');
  assert.equal(plan.body.voice, 'alloy');
  assert.equal(plan.body.input, 'hello');
  assert.equal(plan.body.response_format, 'wav');
});

test('buildTtsRequest: 自定义 apiUrl 优先', () => {
  const plan = buildTtsRequest(fishTts({ apiUrl: 'https://my.tts/v1/tts' }), 'x');
  assert.equal(plan.url, 'https://my.tts/v1/tts');
});

test('activeFishVoiceId: voiceId 优先,否则取 voiceIds[0]', () => {
  assert.equal(activeFishVoiceId(fishTts({ voiceId: 'a', voiceIds: ['b'] })), 'a');
  assert.equal(activeFishVoiceId(fishTts({ voiceId: '', voiceIds: ['b', 'c'] })), 'b');
});

test('shouldUseTts: 开关/音色/长度门槛', () => {
  assert.equal(shouldUseTts(fishTts({ enabled: false }), 'hi'), false);
  assert.equal(shouldUseTts(fishTts({ enabled: true }), 'hi'), true);
  assert.equal(shouldUseTts(fishTts({ enabled: true, voiceId: '', voiceIds: [] }), 'hi'), false);
  assert.equal(shouldUseTts(fishTts({ enabled: true, autoTextMaxChars: 3 }), 'too long text'), false);
  const oa = createDefaultConfig().bot.tts; oa.enabled = true; oa.provider = 'openai-compatible'; oa.voice = 'alloy';
  assert.equal(shouldUseTts(oa, 'hi'), true);
});
