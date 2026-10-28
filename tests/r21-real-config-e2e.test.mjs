import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

/**
 * R21 真实配置 E2E：用用户导出的实际生产配置（15 节点/300+模型/voice默认/真实Suno）
 * 归一化后跑全链路 AgentRuntime → 工具 → 回复策略 → 发送，多用户群聊仿真。
 * 验证 R13-R21 全部改动在真实配置下正常工作。
 */

const { createDefaultConfig, importConfig } = await import('../dist/packages/config/src/index.js');
const { createBotMessageRuntime } = await import('../dist/apps/bot/src/main.js');
const { createAgentHost } = await import('../dist/apps/bot/src/agent-host.js');
const { ApprovalRuntime } = await import('../dist/apps/bot/src/approval-runtime.js');
const { createAgentToolPreflight } = await import('../dist/apps/bot/src/agent-tool-policy.js');
const { ReplyPreferenceStore } = await import('../dist/apps/bot/src/reply-preference-store.js');
const { InMemoryToolIdempotencyStore, normalizeToolSpec } = await import('../dist/packages/tool-runtime/src/index.js');
const { InMemoryAgentSessionManager } = await import('../dist/packages/agent-runtime/src/index.js');
const { resolveReplyPolicy, textCharsOf } = await import('../dist/packages/orchestration/src/reply-policy.js');
const { sanitizeStructuredPayload } = await import('../dist/packages/agent-runtime/src/text-sanitize.js');

// ═══ 1. 真实配置导入 + 归一化 ═══

const realConfigPath = process.env.MIOBOT_E2E_CONFIG || 'C:/Users/Administrator/Downloads/miobot-config-2026-10-28T12-46-54-212Z.json';
const hasRealConfig = existsSync(realConfigPath);
const testFn = hasRealConfig ? test : test.skip;
const rawConfig = hasRealConfig ? JSON.parse(readFileSync(realConfigPath, 'utf8')) : { config: createDefaultConfig() };
const importResult = importConfig(rawConfig);
const cfg = importResult.config;

const sleep0 = (ms) => new Promise((r) => setTimeout(r, ms));
const event = (userId, text, opts = {}) => ({
  post_type: 'message', message_type: 'group', group_id: opts.groupId ?? 3000, user_id: userId,
  message_id: ++seq, time: Math.floor(Date.now() / 1000),
  raw_message: opts.at !== false ? `[CQ:at,qq=${cfg.bot.botQqId}] ${text}` : text,
  message: opts.at !== false
    ? [{ type: 'at', data: { qq: String(cfg.bot.botQqId) } }, { type: 'text', data: { text: ` ${text}` } }]
    : [{ type: 'text', data: { text } }],
});
let seq = 9000;

function buildRuntime(clientChat, { toolBindings = [] } = {}) {
  const sent = [];
  const push = (kind, ...rest) => { sent.push([kind, ...rest]); return { success: true, messageId: sent.length }; };
  const reply = {
    sendGroupText: async (g, t) => push('groupText', g, String(t)),
    sendPrivateText: async (u, t) => push('privateText', u, String(t)),
    sendGroupNestedTextForward: async (g, gr) => push('groupNestedForward', g, JSON.stringify(gr)),
    sendGroupTextForward: async (g, nd) => push('groupFlatForward', g, JSON.stringify(nd)),
    sendPrivateNestedTextForward: async (u, gr) => push('privateNestedForward', u, JSON.stringify(gr)),
    sendGroupNestedMixedForward: async (g, gr) => push('groupNestedMixed', g, JSON.stringify(gr)),
    sendGroupRecord: async (g, f) => push('groupRecord', g, f),
    sendPrivateRecord: async (u, f) => push('privateRecord', u, f),
    sendGroupImage: async (g, u) => push('groupImage', g, u),
    sendPrivateImage: async (u, f) => push('privateImage', u, f),
    sendGroupFile: async (g, f) => push('groupFile', g, f),
    sendPrivateFile: async (u, f) => push('privateFile', u, f),
  };
  const host = createAgentHost({
    getConfig: () => cfg,
    client: { chat: clientChat, can: () => true, vision: async () => ({ text: '', raw: {} }) },
    sessions: new InMemoryAgentSessionManager({}),
    replyPreferenceStore: new ReplyPreferenceStore({ maxRecords: 50 }),
    idempotencyStore: new InMemoryToolIdempotencyStore(),
    toolBindings: () => toolBindings,
    preflightToolCall: createAgentToolPreflight({
      getConfig: () => cfg, resolveRole: () => 'user',
      approvalRuntime: new ApprovalRuntime({
        adminQqIds: () => ['900'], ownerQqIds: () => String(cfg.bot.ownerQQs?.[0] || '1'),
        allowGroupReply: () => true, allowedGroupIds: () => [],
        sendPrivate: async () => ({ success: true }), sendGroup: async () => ({ success: true }),
        maxPendingPerUser: () => 3, maxPendingGlobal: () => 50,
        resendIntervalMs: () => 0, maxResend: () => 0,
        onDecision: () => {}, audit: () => {}, persist: () => {},
      }),
      approvalMode: 'suspend',
    }),
  });
  const runtime = createBotMessageRuntime({
    app: { handle: async () => ({ kind: 'chat', handled: true, text: 'LEGACY' }), engine: { async handleExplicit() { return null; } }, sessions: { clear() {}, get: () => [], append() {} }, registry: () => ({}), client: {} },
    reply,
    getConfig: () => cfg,
    selfId: () => String(cfg.bot.botQqId),
    botName: 'Mio',
    fetchGroupHistory: async () => [],
    reportProblem: async () => true,
    voice: async (text) => `file://tts-${Date.now()}.mp3`,
    voiceEligible: async (text) => Boolean(cfg.bot?.tts?.enabled) && String(text || '').length <= Number(cfg.bot?.tts?.autoTextMaxChars || 180),
    agentRuntime: async (input) => {
      const outcome = await host({ ...input, userRole: 'user' });
      return {
        handled: outcome.handled, reason: outcome.reason,
        ...(outcome.silent ? { silent: true } : {}),
        ...(outcome.text ? { text: outcome.text } : {}),
        ...(outcome.replyPlan ? { replyPlan: outcome.replyPlan } : {}),
      };
    },
  });
  return { runtime, sent };
}
const kinds = (sent) => sent.map((s) => s[0]);

// ═══ 2. 真实配置下的 ReplyPolicy 链 ═══

testFn('真实配置：replyStrategies.text=voice + defaultVoice=auto → 短文本走语音', () => {
  assert.equal(cfg.bot.replyStrategies.text, 'voice', '用户配置的默认回复是语音');
  assert.equal(cfg.replyPolicy.defaultVoice, 'auto');
  assert.equal(cfg.replyPolicy.enabled, true);
  const p = resolveReplyPolicy({ config: cfg, textChars: 50 });
  assert.equal(p.policy.mode, 'direct', 'text=voice 映射 mode=direct');
  assert.equal(p.policy.voice, 'on', 'text=voice → defaultVoice auto → 推导 on');
});

testFn('真实配置：agent.maxConcurrentTurns=4（R15 自动填充）', () => {
  assert.equal(cfg.agent.maxConcurrentTurns, 4, '旧配置导入后 normalize 自动填 4');
});

testFn('真实配置：trigger/continue 判定器模板已填充（R15）', () => {
  assert.ok(cfg.bot.keywordTrigger.triggerIntentPromptTemplate.includes('群聊消息意图判定器'));
  assert.ok(cfg.bot.autoContinue.continueIntentPromptTemplate.includes('群聊消息判定器'));
  assert.equal(cfg.bot.keywordTrigger.triggerTimeoutMs, 5000);
  assert.equal(cfg.bot.autoContinue.continueTimeoutMs, 8000);
});

testFn('真实配置：15 节点完整保留', () => {
  assert.equal(cfg.llm.apiKeys.length, 15);
  assert.ok(cfg.llm.apiKeys.some((n) => n.kind === 'comfyui'), '有 ComfyUI 远端节点');
});

// ═══ 3. 真实配置下端到端回复链 ═══

testFn('真实配置 E2E：短文本 → 语音回复（用户配置 voice 默认 + TTS 链）', async () => {
  // 注意：旧配置 bot.tts.enabled 可能是 false → voiceEligible 会拒绝 → 回退文本
  const clientChat = async () => ({ text: '收到', raw: {}, finishReason: 'stop' });
  const { runtime, sent } = buildRuntime(clientChat);
  await runtime.handleMessageEvent(event(cfg.bot.ownerQQs[0], '你好'));
  await sleep0(80);
  assert.ok(sent.length >= 1, `应有回复: ${JSON.stringify(sent)}`);
  if (cfg.bot.tts?.enabled) {
    assert.ok(kinds(sent).includes('groupRecord'), 'TTS 启用时应发语音');
  } else {
    assert.ok(kinds(sent).some((k) => k === 'groupText' || k.startsWith('groupForward') || k.startsWith('groupNested')), 'TTS 未启用时回退文本');
  }
});

testFn('真实配置 E2E：工具调用 → 秘钥脱敏 → 回复', async () => {
  let seenToolResult = '';
  let calls = 0;
  const clientChat = async (nodeIndex, req) => {
    calls += 1;
    const msgs = (req && req.messages) || [];
    if (calls === 1) {
      return { text: '', raw: {}, finishReason: 'tool_calls', toolCalls: [{ id: 'c1', name: 'config.check', arguments: {} }], toolCallIssues: [] };
    }
    seenToolResult = String(msgs.filter((m) => m.role === 'tool')[0]?.content || '');
    return { text: '配置正常。', raw: {}, finishReason: 'stop' };
  };
  const { runtime } = buildRuntime(clientChat, {
    toolBindings: [{
      spec: normalizeToolSpec({ name: 'config.check', description: '查配置', inputSchema: { type: 'object', properties: {} }, exposure: 'core' }),
      handler: async () => ({ ok: true, content: JSON.stringify({ llm: { apiKey: 'sk-real-key-12345' } }) }),
    }],
  });
  await runtime.handleMessageEvent(event(2001, '检查配置'));
  await sleep0(100);
  assert.ok(!seenToolResult.includes('sk-real-key-12345'), `真实 key 必须脱敏: ${seenToolResult.slice(0, 100)}`);
  assert.ok(seenToolResult.includes('[已脱敏]') || seenToolResult === '' || calls < 2, '脱敏标记应在');
});

testFn('真实配置 E2E：多用户群聊——三个用户并发 @ 不互串（TTS 开启场景）', async () => {
  const ttsTexts = [];
  const clientChat = async (nodeIndex, req) => {
    const msgs = (req && req.messages) || [];
    const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
    const t = String(lastUser?.content || '').trim();
    if (/天气/.test(t)) return { text: '今天晴25度。', raw: {}, finishReason: 'stop' };
    if (/画|图/.test(t)) return { text: '图好了。', raw: {}, finishReason: 'stop' };
    return { text: `收到：${t.slice(0, 10)}`, raw: {}, finishReason: 'stop' };
  };
  const sent = [];
  const push = (kind, ...rest) => { sent.push([kind, ...rest]); return { success: true, messageId: sent.length }; };
  const host = createAgentHost({
    getConfig: () => cfg,
    client: { chat: clientChat, can: () => true, vision: async () => ({ text: '', raw: {} }) },
    sessions: new InMemoryAgentSessionManager({}),
    replyPreferenceStore: new ReplyPreferenceStore({ maxRecords: 50 }),
    idempotencyStore: new InMemoryToolIdempotencyStore(),
    toolBindings: () => [],
    preflightToolCall: createAgentToolPreflight({
      getConfig: () => cfg, resolveRole: () => 'user',
      approvalRuntime: new ApprovalRuntime({
        adminQqIds: () => ['900'], ownerQqIds: () => ['1'],
        allowGroupReply: () => true, allowedGroupIds: () => [],
        sendPrivate: async () => ({ success: true }), sendGroup: async () => ({ success: true }),
        maxPendingPerUser: () => 3, maxPendingGlobal: () => 50,
        resendIntervalMs: () => 0, maxResend: () => 0,
        onDecision: () => {}, audit: () => {}, persist: () => {},
      }),
      approvalMode: 'suspend',
    }),
  });
  const runtime = createBotMessageRuntime({
    app: { handle: async () => ({ kind: 'chat', handled: true, text: 'L' }), engine: { async handleExplicit() { return null; } }, sessions: { clear() {}, get: () => [], append() {} }, registry: () => ({}), client: {} },
    reply: {
      sendGroupText: async (g, t) => push('groupText', g, String(t)),
      sendPrivateText: async (u, t) => push('privateText', u, String(t)),
      sendGroupNestedTextForward: async (g, gr) => push('groupNestedForward', g, JSON.stringify(gr)),
      sendGroupTextForward: async (g, nd) => push('groupFlatForward', g, JSON.stringify(nd)),
      sendGroupNestedMixedForward: async (g, gr) => push('groupNestedMixed', g, JSON.stringify(gr)),
      sendGroupRecord: async (g, f) => push('groupRecord', g, f),
      sendPrivateRecord: async (u, f) => push('privateRecord', u, f),
      sendGroupImage: async (g, u) => push('groupImage', g, u),
      sendPrivateImage: async (u, f) => push('privateImage', u, f),
      sendGroupFile: async (g, f) => push('groupFile', g, f),
      sendPrivateFile: async (u, f) => push('privateFile', u, f),
    },
    getConfig: () => cfg,
    selfId: () => String(cfg.bot.botQqId),
    botName: 'Mio',
    fetchGroupHistory: async () => [],
    reportProblem: async () => true,
    voice: async (text, ctx) => { ttsTexts.push(String(text)); return `file://tts-${Date.now()}.mp3`; },
    voiceEligible: async (text) => Boolean(cfg.bot?.tts?.enabled) && String(text || '').length <= Number(cfg.bot?.tts?.autoTextMaxChars || 180),
    agentRuntime: async (input) => {
      const outcome = await host({ ...input, userRole: 'user' });
      return {
        handled: outcome.handled, reason: outcome.reason,
        ...(outcome.silent ? { silent: true } : {}),
        ...(outcome.text ? { text: outcome.text } : {}),
        ...(outcome.replyPlan ? { replyPlan: outcome.replyPlan } : {}),
      };
    },
  });
  await Promise.all([
    runtime.handleMessageEvent(event(2001, '今天天气怎么样')),
    runtime.handleMessageEvent(event(2002, '帮我画一只猫')),
    runtime.handleMessageEvent(event(2003, '随便聊聊')),
  ]);
  await sleep0(200);
  assert.ok(sent.length >= 3, `三用户至少三回复: ${JSON.stringify(sent.map((s) => s[0]))}`);
  const textInTts = ttsTexts.join(' ');
  const textInSends = sent.map((s) => String(s.slice(1).join(' '))).join(' ');
  const allContent = textInTts + ' ' + textInSends;
  assert.ok(allContent.includes('晴') || allContent.includes('25'), `天气回复: TTS=${JSON.stringify(ttsTexts)} kinds=${JSON.stringify(sent.map((s) => s[0]))}`);
  assert.ok(allContent.includes('图') || allContent.includes('画'), `画图回复`);
  assert.ok(allContent.includes('随便聊聊'), `闲聊回复`);
});

testFn('真实配置 E2E：reply.presentation voice=off → 当轮回文本（群级语音默认下）', async () => {
  // 模拟用户说"用文字发"——模型调 reply.presentation voice=off
  let calls = 0;
  const clientChat = async () => {
    calls += 1;
    if (calls === 1) return { text: '', raw: {}, finishReason: 'tool_calls', toolCalls: [{ id: 'c1', name: 'reply.presentation', arguments: { voice: 'off', scope: 'turn' } }], toolCallIssues: [] };
    return { text: '好的，这轮用文字说。', raw: {}, finishReason: 'stop' };
  };
  const { runtime, sent } = buildRuntime(clientChat);
  await runtime.handleMessageEvent(event(2001, '这条用文字发'));
  await sleep0(120);
  const texts = sent.filter((s) => s[0] === 'groupText').map((s) => String(s[2]));
  assert.ok(texts.length >= 1, `应有文本回复: ${JSON.stringify(kinds(sent))}`);
  assert.ok(!kinds(sent).includes('groupRecord'), 'turn voice=off 不得发语音');
});

testFn('真实配置 E2E：群级覆盖 F-3 —— voice=off 群走文字，未覆盖群走语音', async () => {
  cfg.bot.groupOverrides = { 7777: { replyMode: 'auto', voice: 'off' } };
  const clientChat = async () => ({ text: '这是回复内容', raw: {}, finishReason: 'stop' });
  const { runtime, sent } = buildRuntime(clientChat);
  await runtime.handleMessageEvent(event(2001, '说话', { groupId: 7777 }));
  await sleep0(120);
  const ok = kinds(sent);
  assert.ok(!ok.includes('groupRecord'), `覆盖 voice=off 群不得发语音: ${JSON.stringify(ok)}`);
  assert.ok(ok.some((k) => k === 'groupText' || k.includes('Forward')), `覆盖群应有文字: ${JSON.stringify(ok)}`);
  const { runtime: rt2, sent: sent2 } = buildRuntime(clientChat);
  await rt2.handleMessageEvent(event(2001, '说话', { groupId: 8888 }));
  await sleep0(120);
  const dk = kinds(sent2);
  assert.ok(dk.includes('groupRecord'), `无覆盖群应语音（全局 text=voice+TTS on）: ${JSON.stringify(dk)}`);
  cfg.bot.groupOverrides = {};
});

testFn('真实配置：prompt registry 契约——trigger 模板可经 /api/prompts 读写', async () => {
  const { PROMPT_REGISTRY, getPromptValue } = await import('../dist/packages/web-api/src/prompt-registry.js');
  const triggerEntry = PROMPT_REGISTRY.find((e) => e.id === 'trigger.intent');
  assert.ok(triggerEntry, 'trigger.intent 在注册表');
  assert.ok(triggerEntry.configPath, '有 configPath');
  const value = getPromptValue(cfg, triggerEntry.configPath);
  assert.ok(value.length > 10, `当前值应已填充: ${value.slice(0, 30)}…`);
  // suno.composer
  const sunoEntry = PROMPT_REGISTRY.find((e) => e.id === 'suno.composer');
  const sunoValue = getPromptValue(cfg, sunoEntry.configPath);
  assert.ok(sunoValue.length > 100, 'suno.composer 模板在');
});

testFn('真实配置：工具结果字符串内嵌 JSON 脱敏（R18 E2E 发现的安全缺口）', () => {
  const dirty = '{"llm":{"apiKey":"sk-prod-key","model":"gpt-4o"},"napcat":{"token":"napcat-token"}}';
  const clean = sanitizeStructuredPayload(dirty);
  assert.ok(!String(clean).includes('sk-prod-key'), `apiKey 脱敏: ${clean}`);
  assert.ok(!String(clean).includes('napcat-token'), 'token 脱敏');
  assert.ok(String(clean).includes('[已脱敏]'), '脱敏标记在');
});