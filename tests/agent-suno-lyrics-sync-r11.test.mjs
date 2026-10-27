import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentHost } from '../dist/apps/bot/src/agent-host.js';
import { createBotMessageRuntime } from '../dist/apps/bot/src/main.js';
import { createDefaultConfig } from '../dist/packages/config/src/index.js';
import { InMemoryAgentSessionManager } from '../dist/packages/agent-runtime/src/index.js';
import { InMemoryToolIdempotencyStore, normalizeToolSpec, toolSuccess } from '../dist/packages/tool-runtime/src/index.js';

function spec() {
  return normalizeToolSpec({
    name: 'audio.music.generate', title: '音乐生成', description: '生成歌曲',
    inputSchema: { type: 'object', properties: { request: { type: 'string' } }, required: ['request'], additionalProperties: false },
    outputKinds: ['audio'], riskLevel: 'medium', sideEffects: ['creates_artifact'], queue: 'audio', exposure: 'core',
  });
}

function hostFor(lyricsSync) {
  const cfg = createDefaultConfig();
  cfg.agent.enabled = true; cfg.agent.mode = 'enforce'; cfg.agent.mainModel = 'mock';
  cfg.toolRegistry.enabled = true;
  cfg.replyPolicy.enabled = true;
  cfg.replyPolicy.hardMaxMessages = 3;
  cfg.orchestration.reply.maxMessages = 3;
  cfg.orchestration.reply.maxResultItems = 20;
  cfg.orchestration.suno.sendLyricsWithMusic = lyricsSync;
  let round = 0;
  const client = {
    async chat() {
      round += 1;
      if (round === 1) return { text: '', raw: {}, finishReason: 'tool_calls', toolCalls: [{ id: 'c1', name: 'audio.music.generate', arguments: { request: '写一首测试歌' } }] };
      return { text: '', raw: {}, finishReason: 'stop' };
    },
    can: () => true,
  };
  return createAgentHost({
    getConfig: () => cfg,
    client,
    sessions: new InMemoryAgentSessionManager({}),
    idempotencyStore: new InMemoryToolIdempotencyStore(),
    toolBindings: () => [{ spec: spec(), handler: async (call) => toolSuccess(call.id, call.name, {
      outputs: [{ kind: 'audio', url: 'https://cdn.test/song.mp3', priority: 10, mergeable: false, meta: { title: '测试歌名', lyrics: '第一句真实歌词\n第二句真实歌词' } }],
    }) }],
    preflightToolCall: () => ({ allowed: true }),
    isMigratedTool: () => true,
  });
}

function outputs(plan) { return (plan?.groups || []).flatMap((group) => group.outputs || []); }

test('agent suno: sendLyricsWithMusic adds real lyrics text before audio', async () => {
  const outcome = await hostFor(true)({ text: '写一首测试歌', chatType: 'private', userId: '1', sessionId: 'private:suno-lyrics', userRole: 'user' });
  assert.equal(outcome.handled, true);
  const list = outputs(outcome.replyPlan);
  const lyrics = list.find((output) => output.kind === 'text' && output.meta?.role === 'suno_lyrics');
  const audio = list.find((output) => output.kind === 'audio');
  assert.ok(lyrics, JSON.stringify(list));
  assert.ok(audio, JSON.stringify(list));
  assert.match(lyrics.text, /测试歌名/);
  assert.match(lyrics.text, /第一句真实歌词/);
  assert.equal(lyrics.meta.skipTts, true);
  assert.equal(lyrics.meta.disableVoice, true);
});

test('agent suno: lyrics sync off keeps audio-only result', async () => {
  const outcome = await hostFor(false)({ text: '写一首测试歌', chatType: 'private', userId: '2', sessionId: 'private:suno-lyrics-off', userRole: 'user' });
  assert.equal(outcome.handled, true);
  const list = outputs(outcome.replyPlan);
  assert.equal(list.some((output) => output.kind === 'audio'), true);
  assert.equal(list.some((output) => output.kind === 'text' && output.meta?.role === 'suno_lyrics'), false);
});

test('agent suno: lyrics text and audio dispatch together without auto-TTS', async () => {
  const outcome = await hostFor(true)({ text: '写一首测试歌', chatType: 'private', userId: '3', sessionId: 'private:suno-lyrics-send', userRole: 'user' });
  const sent = [];
  let voiceCalls = 0;
  const reply = {
    sendPrivateText: async (_u, text) => { sent.push(['text', text]); return { success: true, messageId: 1 }; },
    sendPrivateRecord: async (_u, file) => { sent.push(['record', file]); return { success: true, messageId: 2 }; },
  };
  const runtime = createBotMessageRuntime({
    reply, getConfig: () => { const c = createDefaultConfig(); c.orchestration.suno.sendLyricsWithMusic = true; return c; },
    botName: 'Mio', voice: async () => { voiceCalls += 1; return 'file:///unexpected.mp3'; },
  });
  const result = await runtime.sendAgentOutcome({ chatType: 'private', userId: '3', replyPlan: outcome.replyPlan });
  assert.equal(result.handled, true);
  assert.equal(voiceCalls, 0, '歌词+音频计划不应再走 auto-TTS');
  assert.ok(sent.some(([kind, value]) => kind === 'text' && /第一句真实歌词/.test(value)));
  assert.ok(sent.some(([kind]) => kind === 'record'));
});
