import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SunoSongHistoryStore } from '../dist/apps/bot/src/suno-song-history.js';
import { SunoHistoryCapabilityHandler, SunoReplayCapabilityHandler, SunoReplaceSectionCapabilityHandler } from '../dist/apps/bot/src/capability-suno-library.js';
import { SunoCapabilityHandler } from '../dist/apps/bot/src/capability-suno.js';
import { PendingJobStore } from '../dist/apps/bot/src/pending-job-store.js';
import { OrchestrationEnforcer } from '../dist/apps/bot/src/orchestration-enforce.js';
import { createDefaultConfig } from '../dist/packages/config/src/index.js';
import { builtinCapabilityDescriptors } from '../dist/packages/orchestration/src/index.js';

function tempStore() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'miobot-suno-history-')), 'history.json');
  return { file, store: new SunoSongHistoryStore({ filePath: file, maxRecords: () => 20 }) };
}

function invocation(args = {}, capability = 'audio.music.replay') {
  return {
    plan: { planId: 'p', requestId: 'r', goal: 'song', steps: [] },
    step: { id: 's', capability, args },
    request: { requestId: 'r', text: '刚才那首', chat: { type: 'private', userId: '1' }, user: { qq: '1', role: 'user' }, attachments: [] },
  };
}

function addSong(store, overrides = {}) {
  return store.add({
    chatType: 'private', userQq: '1', requestText: '雨夜日语女声歌曲', taskId: 'task-1', audioId: 'audio-1',
    title: '雨夜', lyrics: '[Verse] 雨夜的路灯', audioUrl: 'https://cdn.example/song-1.mp3', duration: 123, model: 'V6', style: 'city pop',
    ...overrides,
  });
}

test('Suno song history: stable sequence, scoped lookup and formatted list', () => {
  const { store } = tempStore();
  const scope = store.scopeKey('private', undefined, '1');
  const first = addSong(store, { title: '第一首', audioUrl: 'https://cdn/one.mp3' });
  const second = addSong(store, { title: '第二首', audioUrl: 'https://cdn/two.mp3' });
  assert.equal(first.seq, 1);
  assert.equal(second.seq, 2);
  assert.deepEqual(store.list(scope).map((item) => item.seq), [2, 1]);
  assert.equal(store.find(scope, { sequence: 1 })?.title, '第一首');
  assert.equal(store.find(scope, { title: '第二首' })?.audioUrl, 'https://cdn/two.mp3');
  assert.match(store.formatList(scope), /#1 第一首/);
  assert.match(store.formatList(scope), /#2 第二首/);
  assert.match(store.promptContext(scope), /recordId/);
});

test('Suno history/replay capabilities: list and resend existing audio', async () => {
  const { store } = tempStore();
  addSong(store);
  const history = new SunoHistoryCapabilityHandler(store);
  const listed = await history.execute(invocation({}, 'audio.music.history'));
  assert.equal(listed.status, 'success');
  assert.match(listed.outputs[0].text, /雨夜/);
  assert.equal(listed.outputs[0].meta.role, 'suno_history');

  const replay = new SunoReplayCapabilityHandler(store);
  const missing = await replay.execute(invocation({}));
  assert.equal(missing.status, 'needs_input');
  assert.match(missing.outputs[0].text, /雨夜/);

  const selected = await replay.execute(invocation({ sequence: 1 }));
  assert.equal(selected.status, 'success');
  assert.equal(selected.outputs[0].url, 'https://cdn.example/song-1.mp3');
  assert.equal(selected.outputs[0].meta.historySeq, 1);
});

test('Suno generation records selected song in history', async () => {
  const { store } = tempStore();
  const cfg = createDefaultConfig();
  cfg.orchestration.suno.enabled = true;
  const handler = new SunoCapabilityHandler({
    getConfig: () => cfg,
    history: store,
    createClient: () => ({
      async create() { return { id: 'task-history', raw: {} }; },
      async wait() { return { id: 'task-history', status: 'success', raw: {}, outputs: [{ url: 'https://cdn/history.mp3', audioId: 'audio-history', title: '历史歌曲', duration: 88 }] }; },
    }),
  });
  const result = await handler.execute({
    ...invocation({ request: '历史歌曲' }, 'audio.music.generate'),
    request: { requestId: 'r', text: '历史歌曲', chat: { type: 'private', userId: '1' }, user: { qq: '1', role: 'user' }, attachments: [] },
  });
  assert.equal(result.status, 'success');
  assert.equal(result.outputs[0].meta.historySeq, 1);
  const scope = store.scopeKey('private', undefined, '1');
  const record = store.list(scope)[0];
  assert.equal(record.audioUrl, 'https://cdn/history.mp3');
  assert.equal(record.audioId, 'audio-history');
});

test('Suno replace-section capability uses stored source and records the edited song', async () => {
  const { store } = tempStore();
  const source = addSong(store);
  const cfg = createDefaultConfig();
  cfg.orchestration.suno.enabled = true;
  let captured = null;
  const handler = new SunoReplaceSectionCapabilityHandler({
    getConfig: () => cfg,
    store,
    createClient: () => ({
      async replaceSection(input) { captured = input; return { id: 'edit-task', raw: {} }; },
      async wait() { return { id: 'edit-task', status: 'success', raw: {}, outputs: [{ url: 'https://cdn/edited.mp3', audioId: 'audio-edited', title: '雨夜（编辑版）', lyrics: '新的副歌', duration: 120 }] }; },
    }),
  });
  const result = await handler.execute(invocation({ sequence: source.seq, startSeconds: 30, endSeconds: 45, change: '把副歌改得更有力量', tags: 'rock' }, 'audio.music.replace_section'));
  assert.equal(result.status, 'success');
  assert.equal(result.outputs[0].url, 'https://cdn/edited.mp3');
  assert.equal(captured.taskId, 'task-1');
  assert.equal(captured.audioId, 'audio-1');
  assert.equal(captured.infillStartS, 30);
  assert.equal(captured.infillEndS, 45);
  assert.equal(store.list(store.scopeKey('private', undefined, '1')).length, 2);
});

test('Suno ambiguous replay asks a model question and sends numbered history as forward', async () => {
  const { store } = tempStore();
  addSong(store, { title: '雨夜', audioUrl: 'https://cdn/rain.mp3' });
  const cfg = createDefaultConfig();
  cfg.orchestration.enabled = true;
  cfg.orchestration.mode = 'enforce';
  cfg.orchestration.planner.enabled = true;
  cfg.orchestration.planner.actionAlignmentGuardEnabled = false;
  cfg.orchestration.suno.enabled = true;
  let clarificationCalls = 0;
  const enforcer = new OrchestrationEnforcer({
    getConfig: () => cfg,
    sunoHistory: store,
    app: { sessions: { clear() {} }, engine: {}, handle: async () => ({}) },
    client: { async chat() { clarificationCalls += 1; return { text: JSON.stringify({ question: '你想重发哪一首歌？请告诉我序号或歌名。', missingInformation: [] }) }; } },
  });
  const plan = {
    planId: 'replay-clarify', requestId: 'r', goal: '重发歌曲',
    understanding: { goal: '重发歌曲', desiredOutcome: 'retrieve', constraints: [], missingInformation: [], confidence: 1 },
    steps: [{ id: 'replay', capability: 'audio.music.replay', args: {} }],
    confidence: 1, source: 'model',
  };
  const result = await enforcer.handle({ text: '再发一下刚才那首', chatType: 'private', userId: '1', plan });
  assert.equal(result.handled, true);
  assert.equal(clarificationCalls, 1);
  const outputs = result.result.replyPlan.groups.flatMap((group) => group.outputs);
  const historyOutput = outputs.find((output) => output.meta?.role === 'suno_history');
  const questionOutput = outputs.find((output) => output.meta?.role === 'clarification_question');
  assert.ok(historyOutput);
  assert.ok(questionOutput);
  assert.match(historyOutput.text, /#1 雨夜/);
  assert.equal(historyOutput.mergeable, true);
  assert.equal(questionOutput.mergeable, false);
  const historyGroup = result.result.replyPlan.groups.find((group) => group.outputs.some((output) => output.meta?.role === 'suno_history'));
  assert.ok(historyGroup);
  assert.notEqual(historyGroup.mode, 'direct');
});

test('Suno clarification answer can resolve a song by rank using forwarded history context', async () => {
  const { store } = tempStore();
  addSong(store, { title: '第一首', audioUrl: 'https://cdn/first.mp3' });
  addSong(store, { title: '第二首', audioUrl: 'https://cdn/second.mp3' });
  const cfg = createDefaultConfig();
  cfg.orchestration.enabled = true;
  cfg.orchestration.mode = 'enforce';
  cfg.orchestration.planner.enabled = true;
  cfg.orchestration.planner.actionAlignmentGuardEnabled = false;
  cfg.orchestration.suno.enabled = true;
  const prompts = [];
  let call = 0;
  const enforcer = new OrchestrationEnforcer({
    getConfig: () => cfg,
    sunoHistory: store,
    pendingJobs: new PendingJobStore(),
    app: { sessions: { clear() {} }, engine: {}, handle: async () => ({}) },
    client: {
      async chat(_nodeIndex, input) {
        call += 1;
        prompts.push(JSON.stringify(input));
        if (call === 1) return { text: JSON.stringify({ question: '你要重发哪一首歌？', missingInformation: [] }) };
        return { text: JSON.stringify({ resolved: true, plan: {
          planId: 'replay-resolved', requestId: 'r', goal: '重发第二首',
          understanding: { goal: '重发第二首', desiredOutcome: 'retrieve', constraints: [], missingInformation: [], confidence: 1 },
          steps: [{ id: 'replay', capability: 'audio.music.replay', args: { sequence: 2 } }],
          confidence: 1, source: 'model',
        } }) };
      },
    },
  });
  const plan = {
    planId: 'replay-ask', requestId: 'r', goal: '重发歌曲',
    understanding: { goal: '重发歌曲', desiredOutcome: 'retrieve', constraints: [], missingInformation: [], confidence: 1 },
    steps: [{ id: 'replay', capability: 'audio.music.replay', args: {} }],
    confidence: 1, source: 'model',
  };
  const first = await enforcer.handle({ text: '再发一下刚才那首', chatType: 'private', userId: '1', plan });
  assert.equal(first.handled, true);
  assert.match(first.result.replyPlan.groups.flatMap((group) => group.outputs).map((output) => output.text || '').join('\n'), /#1 第一首/);
  const second = await enforcer.handle({ text: '第二首', chatType: 'private', userId: '1' });
  assert.equal(second.handled, true);
  assert.equal(second.result.audio?.[0], 'https://cdn/second.mp3');
  assert.equal(call, 2);
  assert.match(prompts[1], /第一首/);
  assert.match(prompts[1], /第二首/);
});

test('Suno replace-section infers a natural-language target section from timestamped lyrics', async () => {
  const { store } = tempStore();
  const source = addSong(store, { duration: 120, lyrics: '[Verse] 旧主歌\\n[Chorus] 旧副歌' });
  const cfg = createDefaultConfig();
  cfg.orchestration.suno.enabled = true;
  let captured = null;
  let modelPrompt = '';
  const handler = new SunoReplaceSectionCapabilityHandler({
    getConfig: () => cfg,
    store,
    client: {
      async chat(_nodeIndex, input) {
        modelPrompt = JSON.stringify(input);
        return { text: JSON.stringify({ startSeconds: 40, endSeconds: 55, prompt: '更有力量的摇滚副歌', tags: 'rock, powerful', lyrics: '新的副歌', fullLyrics: '[Verse] 旧主歌\\n[Chorus] 新的副歌' }) };
      },
    },
    createClient: () => ({
      async getTimestampedLyrics() { return { alignedWords: [
        { word: '[Chorus] 旧副歌', startS: 39.5, endS: 56, success: true },
      ] }; },
      async replaceSection(input) { captured = input; return { id: 'edit-task-inferred', raw: {} }; },
      async wait() { return { id: 'edit-task-inferred', status: 'success', raw: {}, outputs: [{ url: 'https://cdn/edited-inferred.mp3', audioId: 'audio-edited-inferred', title: '编辑版', duration: 120 }] }; },
    }),
  });
  const result = await handler.execute(invocation({ sequence: source.seq, change: '把副歌改得更有力量' }, 'audio.music.replace_section'));
  assert.equal(result.status, 'success');
  assert.equal(captured.infillStartS, 40);
  assert.equal(captured.infillEndS, 55);
  assert.equal(captured.prompt, '更有力量的摇滚副歌');
  assert.match(modelPrompt, /Chorus/);
  assert.equal(result.diagnostics.inferredSection, true);
});

test('planner manifest exposes history, replay and replace-section as separate capabilities', () => {
  const descriptors = builtinCapabilityDescriptors();
  const byId = new Map(descriptors.map((item) => [item.id, item]));
  assert.equal(byId.get('audio.music.history')?.effect, 'retrieve');
  assert.equal(byId.get('audio.music.replay')?.effect, 'retrieve');
  assert.equal(byId.get('audio.music.replace_section')?.effect, 'transform');
  assert.notEqual(byId.get('audio.music.replay')?.description, byId.get('audio.music.history')?.description);
  assert.deepEqual(byId.get('audio.music.replay')?.outputKinds, ['audio']);
  assert.deepEqual(byId.get('audio.music.history')?.outputKinds, ['text']);
});