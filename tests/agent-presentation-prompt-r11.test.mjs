import test from 'node:test';
import assert from 'node:assert/strict';

import { createDefaultConfig } from '../dist/packages/config/src/index.js';
import { createBotMessageRuntime } from '../dist/apps/bot/src/main.js';
import { createAgentHost, buildAgentSystemPrompt } from '../dist/apps/bot/src/agent-host.js';
import { createAgentToolPreflight } from '../dist/apps/bot/src/agent-tool-policy.js';
import { ApprovalRuntime } from '../dist/apps/bot/src/approval-runtime.js';
import { ReplyPreferenceStore } from '../dist/apps/bot/src/reply-preference-store.js';
import { InMemoryToolIdempotencyStore } from '../dist/packages/tool-runtime/src/index.js';
import { InMemoryAgentSessionManager } from '../dist/packages/agent-runtime/src/index.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('presentation R11: system prompt explicitly teaches reply.presentation for voice-off requests', async () => {
  const { REPLY_PRESENTATION_TOOL_SPEC } = await import('../dist/packages/agent-runtime/src/index.js');
  const cfg = createDefaultConfig();
  const prompt = buildAgentSystemPrompt(cfg);
  // 模型此前不知道该能力——prompt 必须显式教学（「用文字发送/语音复制不了」→ voice=off）。
  assert.ok(prompt.includes('reply.presentation'), '系统提示词必须提到 reply.presentation');
  assert.match(prompt, /用文字发送|别发语音|复制不了/);
  assert.match(prompt, /voice="off"/);
  assert.match(prompt, /scope="(turn|session|user)"/);
  // 工具 schema 描述也要带中文触发词（模型主要读 schema 描述）。
  assert.match(REPLY_PRESENTATION_TOOL_SPEC.description, /用文字发送|语音.{0,6}(复制|保存)/);
  assert.match(REPLY_PRESENTATION_TOOL_SPEC.description, /voice:\s*"off"|voice:"off"/);
});

test('presentation R11: model calling reply.presentation(voice=off) makes the final reply plain text — no auto-TTS record', async () => {
  const cfg = createDefaultConfig();
  cfg.bot.botQqId = '10000';
  cfg.bot.ownerQQs = ['1'];
  cfg.agent.enabled = true;
  cfg.agent.mode = 'enforce';
  cfg.toolRegistry.enabled = true;
  cfg.replyPolicy.enabled = true;

  const sent = [];
  const reply = {
    sendGroupText: async (g, t) => { sent.push(['groupText', g, t]); return { success: true, messageId: 1 }; },
    sendPrivateText: async (u, t) => { sent.push(['privateText', u, t]); return { success: true, messageId: 1 }; },
    sendGroupImage: async (g, u) => { sent.push(['groupImage', g, u]); return { success: true, messageId: 1 }; },
    sendPrivateImage: async (u, f) => { sent.push(['privateImage', u, f]); return { success: true, messageId: 1 }; },
    sendGroupRecord: async () => { sent.push(['groupRecord']); return { success: true, messageId: 1 }; },
    sendPrivateRecord: async () => { sent.push(['privateRecord']); return { success: true, messageId: 1 }; },
    sendGroupFile: async () => { sent.push(['groupFile']); return { success: true, messageId: 1 }; },
    sendPrivateFile: async () => { sent.push(['privateFile']); return { success: true, messageId: 1 }; },
  };
  // auto-TTS 通道：若偏好未生效，这里会被调用并登记 record。
  let ttsSynthesized = 0;
  const voice = async () => {
    ttsSynthesized += 1;
    return 'file:///share/fake-voice.mp3';
  };
  const voiceEligible = async () => true;

  const scripts = [
    // 第 1 轮：模型按提示词调用 presentation(voice=off, scope=turn)
    {
      text: '', raw: {},
      toolCalls: [{ id: 'c1', name: 'reply.presentation', arguments: { voice: 'off', scope: 'turn' } }],
      toolCallIssues: [], finishReason: 'tool_calls',
    },
    // 第 2 轮：最终文字回答（559 字级别的长歌词文本）
    { text: '这是你要的歌词文字版本：\n[Verse]\n…（长文本）', raw: {}, finishReason: 'stop' },
  ];
  let idx = 0;
  const client = {
    async chat() { return scripts[idx++] || { text: 'ok', raw: {} }; },
    can: () => true,
    async vision() { return { text: '', raw: {} }; },
    async generateImages() { return { images: [], raw: {} }; },
    async editImage() { return { images: [], raw: {} }; },
    async interrogate() { return { text: '', raw: {} }; },
    async generateVideo() { return { videos: [], raw: {}, pending: true }; },
  };

  const host = createAgentHost({
    getConfig: () => cfg,
    client,
    sessions: new InMemoryAgentSessionManager({}),
    replyPreferenceStore: new ReplyPreferenceStore({ maxRecords: 10 }),
    idempotencyStore: new InMemoryToolIdempotencyStore(),
    toolBindings: () => [],
    preflightToolCall: createAgentToolPreflight({
      getConfig: () => cfg,
      resolveRole: () => 'user',
      approvalRuntime: new ApprovalRuntime({
        adminQqIds: () => ['900'], ownerQqIds: () => ['1'],
        allowGroupReply: () => true, allowedGroupIds: () => ['3000'],
        sendPrivate: async () => ({ success: true, messageId: 1 }),
        sendGroup: async () => ({ success: true, messageId: 1 }),
        maxPendingPerUser: () => 3, maxPendingGlobal: () => 50,
        resendIntervalMs: () => 0, maxResend: () => 0,
        onDecision: () => {}, audit: () => {}, persist: () => {},
      }),
      approvalMode: 'suspend',
    }),
  });

  const runtime = createBotMessageRuntime({
    app: { handle: async () => ({ kind: 'chat', handled: false }), engine: { async handleExplicit() { return null; } }, sessions: { clear() {}, get: () => [], append() {} }, registry: () => ({}), client: {} },
    reply,
    getConfig: () => cfg,
    selfId: () => '10000',
    botName: 'Mio',
    voice,
    voiceEligible,
    fetchGroupHistory: async () => [],
    reportProblem: async () => true,
    agentRuntime: async (input) => {
      const outcome = await host({ ...input, userRole: 'user' });
      return {
        handled: outcome.handled,
        ...(outcome.text ? { text: outcome.text } : {}),
        ...(outcome.replyPlan ? { replyPlan: outcome.replyPlan } : {}),
        ...(outcome.reason ? { reason: outcome.reason } : {}),
      };
    },
  });

  // 用户说「用文字发送啊语音我又复制不了」
  await runtime.handleMessageEvent({
    post_type: 'message', message_type: 'private', user_id: 2000, message_id: 91,
    raw_message: '用文字发送啊语音我又复制不了', message: [{ type: 'text', data: { text: '用文字发送啊语音我又复制不了' } }],
  });
  await sleep(300);

  // 偏好生效：最终回复必须是纯文本，不得触发任何 TTS/record。
  assert.equal(ttsSynthesized, 0, `voice=off 偏好下不得触发 auto-TTS，实际触发 ${ttsSynthesized} 次`);
  assert.equal(sent.filter((s) => s[0] === 'privateRecord' || s[0] === 'groupRecord').length, 0, '不得发送 record 语音');
  const textSends = sent.filter((s) => s[0] === 'privateText' || s[0] === 'groupText');
  assert.ok(textSends.length >= 1, `文字回复必须送达: ${JSON.stringify(sent)}`);
  assert.match(String(textSends[0]?.[2] || ''), /歌词文字版本/, '最终歌词文本应作为文字送达');
});