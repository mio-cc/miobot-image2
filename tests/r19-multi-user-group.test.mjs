import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * R19 多用户群聊仿真：一个群多个虚拟用户（小安/老王/小美/路人甲/bot自己），
 * 以真实 QQ 节奏发各类型消息（@提问/无@闲聊/连发追问/生图挂起/取消/偏好表达）。
 * 脚本化模型按消息内容自主路由（无关键词路由代码——规则只在 mock 模型里）。
 * 验证：多用户上下文隔离 / 并发 / 异步不阻塞他人 / 偏好按用户隔离 / 续话窗口 / 自消息回环 / 触发纪律。
 */

const { createBotMessageRuntime } = await import('../dist/apps/bot/src/main.js');
const { createDefaultConfig } = await import('../dist/packages/config/src/index.js');
const { createAgentHost } = await import('../dist/apps/bot/src/agent-host.js');
const { ApprovalRuntime } = await import('../dist/apps/bot/src/approval-runtime.js');
const { createAgentToolPreflight } = await import('../dist/apps/bot/src/agent-tool-policy.js');
const { ReplyPreferenceStore } = await import('../dist/apps/bot/src/reply-preference-store.js');
const { InMemoryToolIdempotencyStore, normalizeToolSpec } = await import('../dist/packages/tool-runtime/src/index.js');
const { InMemoryAgentSessionManager } = await import('../dist/packages/agent-runtime/src/index.js');

const sleep0 = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 虚拟用户 ──
const AN = 2001;   // 小安（重度用户：生图/取消/偏好）
const WANG = 2002; // 老王（问天气）
const MEI = 2003;  // 小美（闲聊）
const PASSERBY = 2004; // 路人甲（不@bot）
const BOT = 10000; // bot 自己

let seq = 9000;
const event = (userId, text, opts = {}) => {
  seq += 1;
  const at = opts.at !== false;
  return {
    post_type: 'message', message_type: 'group', group_id: opts.groupId ?? 3000, user_id: userId,
    message_id: seq, time: Math.floor(Date.now() / 1000),
    raw_message: at ? `[CQ:at,qq=10000] ${text}` : text,
    message: at
      ? [{ type: 'at', data: { qq: '10000' } }, { type: 'text', data: { text: ` ${text}` } }]
      : [{ type: 'text', data: { text } }],
  };
};

/** 脚本化模型：按最后一条 user 消息内容决策（模拟"模型为大脑"）。 */
function ruleModel(log) {
  const calls = [];
  const chat = async (nodeIndex, req) => {
    const messages = (req && req.messages) || [];
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const t = String(lastUser?.content || '').trim();
    calls.push(t);
    log.push({ lastUserText: t, seenUserMsgs: messages.filter((m) => m.role === 'user').map((m) => String(m.content).slice(0, 24)) });
    const didPresentation = messages.some((m) => m.role === 'assistant' && (m.toolCalls || []).some((c) => c.name === 'reply.presentation'));
    const didCancel = messages.some((m) => m.role === 'assistant' && (m.toolCalls || []).some((c) => c.name === 'job.cancel'));
    const didImage = messages.some((m) => m.role === 'assistant' && (m.toolCalls || []).some((c) => c.name === 'image.generate'));
    if (/画|来一张图|生成图/.test(t) && !didImage) {
      return { text: '', raw: {}, finishReason: 'tool_calls', toolCalls: [{ id: `img_${calls.length}`, name: 'image.generate', arguments: { prompt: t } }], toolCallIssues: [] };
    }
    if (/算了|不要了|取消/.test(t) && !didCancel) {
      return { text: '', raw: {}, finishReason: 'tool_calls', toolCalls: [{ id: `cancel_${calls.length}`, name: 'job.cancel', arguments: {} }], toolCallIssues: [] };
    }
    if (/文字发|用文字/.test(t) && !didPresentation) {
      return { text: '', raw: {}, finishReason: 'tool_calls', toolCalls: [{ id: `pres_${calls.length}`, name: 'reply.presentation', arguments: { voice: 'off', scope: 'session' } }], toolCallIssues: [] };
    }
    if (/天气/.test(t)) return { text: '今天晴，25 度，适合出门。', raw: {}, finishReason: 'stop' };
    return { text: `收到：${t.slice(0, 20)}`, raw: {}, finishReason: 'stop' };
  };
  return { chat, calls };
}

function buildGroupHarness({ cfg, modelChat, bindings = [], imagePending = false, continueChecker } = {}) {
  const sent = [];
  const modelLog = [];
  const cancelCalls = [];
  const imageCalls = [];
  const client = { chat: modelChat(modelLog), can: () => true };
  const host = createAgentHost({
    getConfig: () => cfg,
    client,
    sessions: new InMemoryAgentSessionManager({}),
    replyPreferenceStore: new ReplyPreferenceStore({ maxRecords: 50 }),
    idempotencyStore: new InMemoryToolIdempotencyStore(),
    toolBindings: () => [
      {
        spec: normalizeToolSpec({ name: 'image.generate', description: '生图', inputSchema: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] }, exposure: 'core' }),
        handler: async () => { imageCalls.push(1); return imagePending
          ? { ok: true, pending: true, jobId: `job_${imageCalls.length}`, content: '已提交生成任务' }
          : { ok: true, outputs: [{ kind: 'image', url: 'https://img.test/r19.png' }] }; },
      },
      {
        spec: normalizeToolSpec({ name: 'job.cancel', description: '取消任务', inputSchema: { type: 'object', properties: {} }, exposure: 'core' }),
        handler: async () => { cancelCalls.push(1); return { ok: true, content: '已取消任务 job_1。' }; },
      },
      ...bindings,
    ],
    preflightToolCall: createAgentToolPreflight({
      getConfig: () => cfg,
      resolveRole: () => 'user',
      approvalRuntime: new ApprovalRuntime({
        adminQqIds: () => ['900'], ownerQqIds: () => ['1'],
        allowGroupReply: () => true, allowedGroupIds: () => [],
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
    app: { handle: async () => ({ kind: 'chat', handled: true, text: 'LEGACY' }), engine: { async handleExplicit() { return null; } }, sessions: { clear() {}, get: () => [], append() {} }, registry: () => ({}), client: {} },
    reply: {
      sendGroupText: async (g, t) => { sent.push(['groupText', g, String(t)]); return { success: true, messageId: sent.length }; },
      sendPrivateText: async (u, t) => { sent.push(['privateText', u, String(t)]); return { success: true, messageId: sent.length }; },
      sendGroupNestedTextForward: async (g, gr) => { sent.push(['groupNestedForward', g, JSON.stringify(gr)]); return { success: true, messageId: sent.length }; },
      sendGroupTextForward: async (g, nd) => { sent.push(['groupFlatForward', g, JSON.stringify(nd)]); return { success: true, messageId: sent.length }; },
      sendGroupNestedMixedForward: async (g, gr) => { sent.push(['groupNestedMixed', g, JSON.stringify(gr)]); return { success: true, messageId: sent.length }; },
      sendPrivateNestedTextForward: async (u, gr) => { sent.push(['privateNestedForward', u, JSON.stringify(gr)]); return { success: true, messageId: sent.length }; },
      sendPrivateNestedMixedForward: async (u, gr) => { sent.push(['privateNestedMixed', u, JSON.stringify(gr)]); return { success: true, messageId: sent.length }; },
      sendGroupRecord: async (g, f) => { sent.push(['groupRecord', g, f]); return { success: true, messageId: sent.length }; },
      sendPrivateRecord: async (u, f) => { sent.push(['privateRecord', u, f]); return { success: true, messageId: sent.length }; },
      sendGroupImage: async (g, u) => { sent.push(['groupImage', g, u]); return { success: true, messageId: sent.length }; },
      sendPrivateImage: async (u, f) => { sent.push(['privateImage', u, f]); return { success: true, messageId: sent.length }; },
      sendGroupFile: async (g, f) => { sent.push(['groupFile', g, f]); return { success: true, messageId: sent.length }; },
      sendPrivateFile: async (u, f) => { sent.push(['privateFile', u, f]); return { success: true, messageId: sent.length }; },
    },
    getConfig: () => cfg,
    selfId: () => '10000',
    botName: 'Mio',
    fetchGroupHistory: async () => [],
    reportProblem: async () => true,
    // voice/voiceEligible 模拟 start.ts 真实接线（遵循 shouldUseTts 语义）
    voice: async (text) => `file://tts-${Date.now()}.mp3`,
    voiceEligible: async (text) => Boolean(cfg.bot?.tts?.enabled) && String(text || '').length <= Number(cfg.bot?.tts?.autoTextMaxChars || 180),
    ...(continueChecker ? { triggerIntentChecker: continueChecker } : {}),
    agentRuntime: async (input) => {
      const outcome = await host({ ...input, userRole: 'user' });
      return {
        handled: outcome.handled,
        reason: outcome.reason,
        ...(outcome.silent ? { silent: true } : {}),
        ...(outcome.text ? { text: outcome.text } : {}),
        ...(outcome.replyPlan ? { replyPlan: outcome.replyPlan } : {}),
      };
    },
  });
  return { runtime, sent, modelLog, cancelCalls, imageCalls };
}

const baseCfg = (over = {}) => {
  const cfg = createDefaultConfig();
  cfg.agent.enabled = true;
  cfg.agent.mode = 'enforce';
  cfg.agent.maxConcurrentTurns = 8;
  cfg.bot.replyStrategies.text = 'plain';
  cfg.replyPolicy.enabled = true;
  Object.assign(cfg, over);
  return cfg;
};

const texts = (sent) => sent.filter((s) => s[0] === 'groupText').map((s) => String(s[2]));
const kinds = (sent) => sent.map((s) => s[0]);

// ═══ 场景 1：多用户 @ 交错——上下文隔离与正确路由 ═══

test('R19/群聊1: 三个用户先后@bot，各自问题的回复互不串话', async () => {
  const log = [];
  const { chat } = ruleModel(log);
  const { runtime, sent } = buildGroupHarness({ cfg: baseCfg(), modelChat: () => chat });
  await runtime.handleMessageEvent(event(AN, '帮我画一只猫'));
  await sleep0(80);
  await runtime.handleMessageEvent(event(WANG, '今天天气怎么样'));
  await sleep0(60);
  await runtime.handleMessageEvent(event(MEI, '随便聊聊'));
  await sleep0(60);
  const replies = texts(sent);
  assert.equal(replies.length, 3, `三用户三回复: ${JSON.stringify(replies)}`);
  // 每个回复的内容对应各自的问题（脚本模型按所见 user 文本回答）
  assert.ok(replies.some((t) => t.includes('猫')), '小安的生图链有回复');
  assert.ok(replies.some((t) => t.includes('晴')), '老王的天气回复');
  assert.ok(replies.some((t) => t.includes('随便聊聊')), '小美的闲聊回复');
  assert.ok(kinds(sent).includes('groupImage'), '生图产物送达');
  // 上下文隔离：老王的模型输入不得含小安的问题
  const wangCall = log.find((l) => l.lastUserText.includes('天气'));
  assert.ok(wangCall, '老王的模型调用存在');
  assert.ok(!JSON.stringify(wangCall.seenUserMsgs).includes('帮我画一只猫'), '跨用户上下文不得串session');
});

// ═══ 场景 2：触发纪律——无@闲聊静默 + bot 自消息回环过滤 ═══

test('R19/群聊2: 路人不@闲聊零响应；bot 自己的消息不触发回环', async () => {
  const log = [];
  const { chat } = ruleModel(log);
  const { runtime, sent } = buildGroupHarness({ cfg: baseCfg(), modelChat: () => chat });
  await runtime.handleMessageEvent(event(PASSERBY, '今天中午吃什么好', { at: false }));
  await runtime.handleMessageEvent(event(PASSERBY, '哈哈这个梗绝了', { at: false }));
  await runtime.handleMessageEvent(event(BOT, '大家好我是bot')); // bot 自己
  await sleep0(80);
  assert.equal(log.length, 0, `无@消息不得触发模型，实际 ${JSON.stringify(log)}`);
  assert.equal(sent.length, 0, '零发送');
});

// ═══ 场景 3：同群多用户并发——不同用户互不取代（superseded 只作用同会话） ═══

test('R19/群聊3: 两个用户同时@bot——都得到回复（跨用户无 superseded）', async () => {
  const log = [];
  const { chat } = ruleModel(log);
  const { runtime, sent } = buildGroupHarness({ cfg: baseCfg({ agent: { ...createDefaultConfig().agent, enabled: true, mode: 'enforce', maxConcurrentTurns: 8 } }), modelChat: () => chat });
  const p1 = runtime.handleMessageEvent(event(AN, '第一个问题：你好呀'));
  const p2 = runtime.handleMessageEvent(event(WANG, '第二个问题：天气如何'));
  const [h1, h2] = await Promise.all([p1, p2]);
  await sleep0(60);
  assert.equal(String(h1.kind).startsWith('chat'), true, `A 正常: ${JSON.stringify(h1)}`);
  assert.equal(String(h2.kind).startsWith('chat'), true, `B 正常: ${JSON.stringify(h2)}`);
  assert.equal(texts(sent).length, 2, `两用户两条回复（无跨用户取代）: ${JSON.stringify(texts(sent))}`);
  assert.ok(texts(sent).some((t) => t.includes('第一个问题')), 'A 的回复在');
  assert.ok(texts(sent).some((t) => t.includes('晴')), 'B 的天气回复在');
});

// ═══ 场景 4：异步不阻塞他人——A 生图挂起期间 B 秒得回复 ═══

test('R19/群聊4: 小安的生图挂起不阻塞老王——老王立即得到天气回复', async () => {
  const log = [];
  const { chat } = ruleModel(log);
  const { runtime, sent } = buildGroupHarness({ cfg: baseCfg(), modelChat: () => chat, imagePending: true });
  const hA = await runtime.handleMessageEvent(event(AN, '来一张图：星空下的灯塔'));
  assert.equal(hA.kind, 'agent-job-pending-silent', `A 应静默挂起: ${JSON.stringify(hA)}`);
  const hB = await runtime.handleMessageEvent(event(WANG, '天气如何'));
  await sleep0(60);
  assert.equal(texts(sent).length, 1, 'B 一条回复，A 挂起期间零发送');
  assert.ok(texts(sent)[0].includes('晴'), 'B 的天气回复送达');
  assert.equal(kinds(sent).includes('groupImage'), false, 'A 的图未生成前不发占位图');
});

// ═══ 场景 5：偏好按用户隔离——A 说"用文字"只影响 A ═══

test('R19/群聊5: 小安设置 voice=off（session）——只影响小安，老王照常语音', async () => {
  const log = [];
  const { chat } = ruleModel(log);
  const cfg = baseCfg();
  cfg.bot.tts.enabled = true;                 // TTS 可用
  cfg.bot.groupOverrides = { 3000: { voice: 'on' } }; // 群默认语音
  const { runtime, sent } = buildGroupHarness({
    cfg,
    modelChat: () => chat,
    bindings: [],
  });
  // 传真实 voice/voiceEligible（模拟 start.ts 行为：合成走 tts）
  const withVoice = new Proxy(runtime, {});
  void withVoice;
  // A：表达偏好 + 问答（同一轮）
  await runtime.handleMessageEvent(event(AN, '用文字发：给我讲个故事'));
  await sleep0(100);
  const anTexts = texts(sent);
  assert.equal(anTexts.length, 1, `小安一条文本回复: ${JSON.stringify(anTexts)}`);
  assert.ok(anTexts[0].includes('收到'), '小安得到文本回复');
  assert.equal(kinds(sent).includes('groupRecord'), false, '小安 voice=off 不发语音');
  // B：正常问话 → 群默认语音
  await runtime.handleMessageEvent(event(WANG, '天气如何'));
  await sleep0(100);
  assert.ok(kinds(sent).includes('groupRecord'), `老王照常收到群默认语音: ${JSON.stringify(kinds(sent))}`);
});

// ═══ 场景 6：续话窗口——A 无@追问接上；路人的无关消息不触发 ═══

test('R19/群聊6: autoContinue——A 的无@追问被续答；路人闲聊仍静默', async () => {
  const log = [];
  const { chat } = ruleModel(log);
  const cfg = baseCfg();
  cfg.bot.autoContinue.enabled = true;
  cfg.bot.autoContinue.windowMs = 60_000;
  cfg.bot.autoContinue.requireModelCheck = true;
  // 续话判定 mock：小安的追问=true，路人=false（模拟真实判定模型语义）
  const checker = {
    checkContinueIntent: async (input) => !String(input.userText || '').includes('中午吃'),
    checkKeywordIntent: async () => false,
  };
  const { runtime, sent } = buildGroupHarness({ cfg, modelChat: () => chat, continueChecker: checker });
  await runtime.handleMessageEvent(event(AN, '介绍一下你自己'));
  await sleep0(80);
  assert.equal(texts(sent).length, 1, '首轮回复');
  // A 无@追问（autoContinue 窗口内）
  await runtime.handleMessageEvent(event(AN, '再多说一点', { at: false }));
  await sleep0(120);
  assert.equal(texts(sent).length, 2, `A 的无@追问应被续答: ${JSON.stringify(texts(sent))}`);
  // 路人无@闲聊 → 判定不续 → 静默
  const before = log.length;
  await runtime.handleMessageEvent(event(PASSERBY, '中午吃什么呢', { at: false }));
  await sleep0(120);
  assert.equal(log.length, before, '路人闲聊不得触发模型调用');
});

// ═══ 场景 7：取消语义——A 挂起后说"算了"→ job.cancel 工具被调 + 友好回复 ═══

test('R19/群聊7: 小安挂起后说"算了"——模型调用 job.cancel 并告知用户', async () => {
  const log = [];
  const { chat } = ruleModel(log);
  const { runtime, sent, cancelCalls } = buildGroupHarness({ cfg: baseCfg(), modelChat: () => chat, imagePending: true });
  await runtime.handleMessageEvent(event(AN, '来一张图：赛博城市'));
  await sleep0(40);
  assert.equal(sent.length, 0, '挂起静默');
  await runtime.handleMessageEvent(event(AN, '算了不要了'));
  await sleep0(100);
  assert.ok(cancelCalls.length >= 1, `job.cancel 工具应被模型调用: ${cancelCalls.length}`);
  const replies = texts(sent);
  assert.ok(replies.length >= 1, `应给用户取消确认: ${JSON.stringify(replies)}`);
  assert.ok(replies.some((t) => t.includes('收到：算了') || t.includes('取消')), '回复内容自然确认');
});

// ═══ 场景 8：跨群隔离——群 X 的对话不进群 Y 的模型上下文 ═══

test('R19/群聊8: 跨群隔离——X 群消息不得出现在 Y 群的模型输入', async () => {
  const log = [];
  const { chat } = ruleModel(log);
  const { runtime, sent } = buildGroupHarness({ cfg: baseCfg(), modelChat: () => chat });
  await runtime.handleMessageEvent(event(AN, '我在X群说的悄悄话', { groupId: 1111 }));
  await sleep0(60);
  await runtime.handleMessageEvent(event(MEI, '我在Y群问个好', { groupId: 2222 }));
  await sleep0(60);
  const yCall = log.find((l) => l.lastUserText.includes('Y群'));
  assert.ok(yCall, 'Y 群模型调用存在');
  assert.ok(!JSON.stringify(yCall.seenUserMsgs).includes('X群'), 'X 群上下文不得泄漏进 Y 群');
  assert.equal(texts(sent).length, 2, '两群各一条回复');
});

// ═══ 场景 9：群内多用户高频混发——触发纪律 + 各自回复归属 ═══

test('R19/群聊9: 五条混合消息（@/无@/bot自/挂起/取消）按序处理各归其位', async () => {
  const log = [];
  const { chat } = ruleModel(log);
  const { runtime, sent, cancelCalls } = buildGroupHarness({ cfg: baseCfg(), modelChat: () => chat, imagePending: true });
  const jobs = [
    runtime.handleMessageEvent(event(MEI, '聊天：今天真开心')),          // @ 闲聊 → 回复
    runtime.handleMessageEvent(event(PASSERBY, '无触发闲聊', { at: false })), // 忽略
    runtime.handleMessageEvent(event(BOT, 'bot自消息')),                // 回环过滤
    runtime.handleMessageEvent(event(AN, '来一张图：雪山日出')),          // 挂起静默
    runtime.handleMessageEvent(event(WANG, '天气怎么样')),              // 回复
  ];
  await Promise.all(jobs);
  await sleep0(150);
  const replies = texts(sent);
  assert.equal(replies.length, 2, `恰两条文本回复（闲聊+天气）: ${JSON.stringify(replies)}`);
  assert.ok(replies.some((t) => t.includes('开心')), '小美的回复');
  assert.ok(replies.some((t) => t.includes('晴')), '老王的回复');
  assert.equal(kinds(sent).includes('groupImage'), false, '挂起不发图');
  void cancelCalls;
});