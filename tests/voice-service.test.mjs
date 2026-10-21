import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FishAudioVoiceService, VoiceSearchCapabilityHandler } from '../dist/apps/bot/src/voice-service.js';
import { createDefaultConfig } from '../dist/packages/config/src/index.js';

function makeConfig() {
  const cfg = createDefaultConfig();
  cfg.bot.tts.apiKey = 'fish-test-key';
  cfg.bot.tts.enabled = true;
  cfg.bot.tts.model = 's2.1-pro-free';
  cfg.orchestration.voice = {
    ...cfg.orchestration.voice,
    enabled: true,
    allowedScopes: 'both',
    userCanChange: true,
    licensedOnly: false,
    maxCandidates: 3,
    candidateTtlMs: 600000,
    previewMaxChars: 40,
    previewCooldownMs: 0,
    previewDailyLimit: 10,
    voicesApiUrl: 'https://api.fish.audio/model',
  };
  return cfg;
}

test('voice: FishAudio search, scope isolation, sample preview and selection', async () => {
  const cfg = makeConfig();
  const prefFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'miobot-voice-')), 'prefs.json');
  const service = new FishAudioVoiceService({ getConfig: () => cfg, preferenceFile: prefFile });
  const originalFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (url) => {
    requested.push(String(url));
    if (String(url).includes('api.fish.audio/model')) {
      return new Response(JSON.stringify({
        total: 2,
        items: [
          { _id: 'voice-public-1', type: 'tts', state: 'trained', visibility: 'public', title: '温柔女声', tags: ['female', 'gentle'], languages: ['zh'], licensed: false, task_count: 10, samples: [{ audio: 'https://platform.r2.fish.audio/sample1.mp3' }], author: { nickname: 'tester' } },
          { _id: 'voice-public-2', type: 'tts', state: 'trained', visibility: 'public', title: '成熟男声', tags: ['male', 'mature'], languages: ['zh'], licensed: true, task_count: 5, samples: [] },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (String(url).includes('sample1.mp3')) return new Response(Buffer.from('ID3-sample'), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
    throw new Error('unexpected fetch ' + url);
  };
  try {
    const scope = { chatType: 'group', groupId: 'g1', userId: 'u1' };
    const found = await service.search(scope, { tags: ['female', 'gentle'], language: ['zh'] });
    assert.equal(found.candidates.length, 2);
    assert.ok(requested[0].includes('self=false'));
    assert.ok(requested[0].includes('tag=female'));
    assert.ok(requested[0].includes('tag=gentle'));
    assert.ok(requested[0].includes('language=zh'));
    const candidates = service.listCandidates(scope);
    assert.equal(candidates.length, 2);
    assert.equal(service.listCandidates({ chatType: 'group', groupId: 'g2', userId: 'u1' }).length, 0);
    assert.equal(service.listCandidates({ chatType: 'group', groupId: 'g1', userId: 'u2' }).length, 0);

    const preview = await service.preview(scope, { index: 1 });
    assert.ok(preview.audioFile.startsWith('base64://'));
    assert.equal(preview.candidate.voiceId, 'voice-public-1');
    const selected = service.select(scope, { index: 1 });
    assert.equal(selected.voiceId, 'voice-public-1');
    const effective = service.effectiveTts(cfg.bot.tts, scope);
    assert.equal(effective.voiceId, 'voice-public-1');
    assert.equal(service.current({ chatType: 'group', groupId: 'g2', userId: 'u1' }), undefined);
    assert.equal(JSON.parse(fs.readFileSync(prefFile, 'utf8')).preferences['group:g1:u1'].voiceId, 'voice-public-1');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('voice: missing preferences triggers one structured clarification', async () => {
  const cfg = makeConfig();
  const service = new FishAudioVoiceService({ getConfig: () => cfg, preferenceFile: path.join(os.tmpdir(), 'miobot-voice-empty.json') });
  const handler = new VoiceSearchCapabilityHandler(service);
  const result = await handler.execute({
    request: { chat: { type: 'private', userId: 'u1' }, user: { qq: 'u1' } },
    plan: { planId: 'p1' }, step: { id: 's1', capability: 'voice.search', args: {} },
  });
  assert.equal(result.status, 'needs_input');
  assert.ok(result.diagnostics.missingInformation.includes('声音风格'));
  assert.equal(result.diagnostics.question, undefined);
});