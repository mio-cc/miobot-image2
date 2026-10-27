import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentHost } from '../dist/apps/bot/src/agent-host.js';
import { createBotApp, createBotMessageRuntime } from '../dist/apps/bot/src/main.js';
import { createDefaultConfig } from '../dist/packages/config/src/index.js';
import { normalizeToolSpec } from '../dist/packages/tool-runtime/src/index.js';

function toolSpec(name, properties = { prompt: { type: 'string' } }, required = ['prompt']) {
  return normalizeToolSpec({
    name,
    title: name,
    description: name,
    inputSchema: { type: 'object', properties, required, additionalProperties: false },
    riskLevel: 'medium',
    outputKinds: ['image', 'audio', 'file', 'text'],
    sideEffects: ['creates_artifact'],
  });
}

function makeHost(options) {
  const cfg = createDefaultConfig();
  cfg.agent.enabled = true;
  cfg.agent.mode = 'enforce';
  cfg.agent.mainModel = 'gpt-4o-mini';
  cfg.freeMode.enabled = false;
  cfg.orchestration.reply.maxMessages = options.maxMessages || 4;
  const requests = [];
  let step = 0;
  const client = {
    async chat(_nodeIndex, request) {
      requests.push(request);
      const next = options.responses[step];
      step += 1;
      if (next instanceof Error) throw next;
      return next;
    },
  };
  const host = createAgentHost({
    getConfig: () => cfg,
    client,
    toolBindings: () => options.bindings,
    preflightToolCall: () => ({ allowed: true }),
    isReadOnlyTool: () => false,
    isMigratedTool: () => true,
  });
  return { host, cfg, requests };
}

function outputs(plan) {
  return (plan?.groups || []).flatMap((group) => (group.outputs || []).map((output) => ({ ...output, groupMode: group.mode })));
}

test('agent-reply R5.2: generated image output is bridged into ReplyPlan and final text', async () => {
  let calls = 0;
  const imageSpec = toolSpec('image.generate');
  const h = makeHost({
    responses: [
      { text: '', raw: {}, toolCalls: [{ id: 'img_1', name: 'image.generate', arguments: { prompt: '猫' } }], finishReason: 'tool_calls' },
      { text: '图片已经生成。', raw: {}, usage: { completionTokens: 5 } },
    ],
    bindings: [{
      spec: imageSpec,
      handler: async () => {
        calls += 1;
        return { ok: true, content: 'generated', outputs: [{ kind: 'image', url: 'https://example.test/cat.png', priority: 20 }] };
      },
    }],
  });
  const outcome = await h.host({ text: '画一只猫', chatType: 'private', userId: '1', sessionId: 'private:1' });
  assert.equal(calls, 1);
  assert.equal(outcome.status, 'completed');
  assert.equal(outcome.handled, true);
  assert.equal(outcome.terminal, true);
  assert.equal(outcome.text, '图片已经生成。');
  assert.ok(outcome.replyPlan);
  const planned = outputs(outcome.replyPlan);
  assert.ok(planned.some((output) => output.kind === 'image' && output.url === 'https://example.test/cat.png'));
  assert.ok(planned.some((output) => output.kind === 'text' && output.text === '图片已经生成。'));
  assert.ok(outcome.replyPlan.messageCount <= h.cfg.orchestration.reply.maxMessages);
});

test('agent-reply R5.2: audio and file outputs are forced into direct reply groups', async () => {
  const audioSpec = toolSpec('tts.speak', { text: { type: 'string' } }, ['text']);
  const fileSpec = toolSpec('file.generate', { prompt: { type: 'string' } }, ['prompt']);
  const h = makeHost({
    responses: [
      {
        text: '',
        raw: {},
        toolCalls: [
          { id: 'audio_1', name: 'tts.speak', arguments: { text: '你好' } },
          { id: 'file_1', name: 'file.generate', arguments: { prompt: '报告' } },
        ],
        finishReason: 'tool_calls',
      },
      { text: '语音和文件都准备好了。', raw: {} },
    ],
    bindings: [
      {
        spec: audioSpec,
        handler: async () => ({ ok: true, outputs: [{ kind: 'audio', url: 'https://example.test/a.mp3', priority: 30 }] }),
      },
      {
        spec: fileSpec,
        handler: async () => ({ ok: true, outputs: [{ kind: 'file', url: 'https://example.test/a.pdf', priority: 30 }] }),
      },
    ],
  });
  const outcome = await h.host({ text: '发语音和文件', chatType: 'private', userId: '1', sessionId: 'private:2' });
  assert.equal(outcome.handled, true);
  assert.ok(outcome.replyPlan);
  const planned = outputs(outcome.replyPlan);
  const audio = planned.find((output) => output.kind === 'audio');
  const file = planned.find((output) => output.kind === 'file');
  assert.ok(audio);
  assert.ok(file);
  assert.equal(audio.groupMode, 'direct');
  assert.equal(file.groupMode, 'direct');
  assert.ok(planned.filter((output) => output.kind === 'audio' || output.kind === 'file').every((output) => output.groupMode === 'direct'));
});

test('agent-reply R5.2: model failure after a successful generation is terminal and never falls back with duplicate side effects', async () => {
  const imageSpec = toolSpec('image.generate');
  const h = makeHost({
    responses: [
      { text: '', raw: {}, toolCalls: [{ id: 'img_1', name: 'image.generate', arguments: { prompt: '猫' } }], finishReason: 'tool_calls' },
      new Error('model down after tool execution'),
    ],
    bindings: [{
      spec: imageSpec,
      handler: async () => ({ ok: true, outputs: [{ kind: 'image', url: 'https://example.test/kept.png', priority: 20 }] }),
    }],
  });
  const outcome = await h.host({ text: '画猫', chatType: 'private', userId: '1', sessionId: 'private:3' });
  assert.equal(outcome.handled, true);
  assert.equal(outcome.terminal, true);
  assert.equal(outcome.reason, 'agent_side_effect_terminal');
  assert.ok(outcome.replyPlan);
  assert.ok(outputs(outcome.replyPlan).some((output) => output.kind === 'image' && output.url === 'https://example.test/kept.png'));
});

test('agent-reply R5.2: runtime sends Agent replyPlan without invoking the old engine', async () => {
  const cfg = createDefaultConfig();
  cfg.bot.botQqId = '10000';
  cfg.bot.whitelistPrivate = ['2000'];
  cfg.bot.replyStrategies.text = 'plain';
  cfg.bot.replyStrategies.image = 'plain';
  cfg.freeMode.enabled = false;
  cfg.orchestration.enabled = false;
  cfg.agent.enabled = true;
  cfg.agent.mode = 'enforce';
  const sent = [];
  const ok = () => ({ success: true, messageId: 1 });
  const reply = {
    sendGroupText: async (_g, text) => { sent.push(['groupText', text]); return ok(); },
    sendPrivateText: async (_u, text) => { sent.push(['privateText', text]); return ok(); },
    sendGroupImage: async (_g, url) => { sent.push(['groupImage', url]); return ok(); },
    sendPrivateImage: async (_u, url) => { sent.push(['privateImage', url]); return ok(); },
  };
  const fakeClient = {
    can: () => true,
    async chat() { return { text: 'OLD_ENGINE', raw: {} }; },
    async vision() { return { text: 'OLD_ENGINE', raw: {} }; },
  };
  const app = createBotApp({ getConfig: () => cfg, client: fakeClient });
  let engineCalls = 0;
  const originalHandle = app.handle.bind(app);
  app.handle = async (input) => { engineCalls += 1; return originalHandle(input); };
  const rt = createBotMessageRuntime({
    app,
    reply,
    getConfig: () => cfg,
    botName: 'Mio',
    reportProblem: async () => {},
    agentRuntime: async () => ({
      handled: true,
      replyPlan: {
        groups: [{ mode: 'direct', outputs: [{ kind: 'image', url: 'https://example.test/agent-plan.png', mergeable: false, priority: 20 }], messageCount: 1 }],
        messageCount: 1,
        truncated: [],
        warnings: [],
      },
      meta: { status: 'completed', mode: 'enforce' },
    }),
  });
  const result = await rt.handleMessageEvent({
    post_type: 'message',
    message_type: 'private',
    user_id: 2000,
    message_id: 9,
    raw_message: '画一只猫',
    sender: { user_id: 2000, nickname: '用户' },
  });
  assert.equal(result.handled, true);
  assert.equal(engineCalls, 0);
  assert.ok(sent.some(([kind, url]) => kind === 'privateImage' && url === 'https://example.test/agent-plan.png'));
  assert.ok(!sent.some(([, value]) => String(value).includes('OLD_ENGINE')));
});