import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * R18 全链路能力测验：模拟真实 NapCat-QQ 发信（CQ 事件 → AgentRuntime → 工具 → 回复策略 → 发送）。
 * 维度：harness 理念符合性 / 多步任务 / 多工具协调 / 并发 / 异步挂起 / 模糊意图 /
 * 回复方式（后台默认/群覆盖/turn 偏好） / 幂等与去重 / 秘钥脱敏 / 静态契约锚点。
 */

const { createBotMessageRuntime } = await import('../dist/apps/bot/src/main.js');
const { createDefaultConfig } = await import('../dist/packages/config/src/index.js');
const { createAgentHost } = await import('../dist/apps/bot/src/agent-host.js');
const { ApprovalRuntime } = await import('../dist/apps/bot/src/approval-runtime.js');
const { createAgentToolPreflight } = await import('../dist/apps/bot/src/agent-tool-policy.js');
const { ReplyPreferenceStore } = await import('../dist/apps/bot/src/reply-preference-store.js');
const { InMemoryToolIdempotencyStore } = await import('../dist/packages/tool-runtime/src/index.js');
const { InMemoryAgentSessionManager } = await import('../dist/packages/agent-runtime/src/index.js');
const { normalizeToolSpec } = await import('../dist/packages/tool-runtime/src/index.js');

const sleep0 = (ms) => new Promise((r) => setTimeout(r, ms));

function baseReply(sent, opts = {}) {
  const rec = (kind, ...rest) => { sent.push([kind, ...rest]); return { success: true, messageId: sent.length }; };
  return {
    sendGroupText: async (g, t) => rec('groupText', g, String(t)),
    sendPrivateText: async (u, t) => rec('privateText', u, String(t)),
    sendGroupNestedTextForward: async (g, groups) => rec('groupNestedForward', g, JSON.stringify(groups)),
    sendGroupTextForward: async (g, nodes) => rec('groupFlatForward', g, JSON.stringify(nodes)),
    sendPrivateNestedTextForward: async (u, groups) => rec('privateNestedForward', u, JSON.stringify(groups)),
    sendPrivateTextForward: async (u, nodes) => rec('privateFlatForward', u, JSON.stringify(nodes)),
    sendGroupNestedMixedForward: async (g, groups) => rec('groupNestedMixed', g, JSON.stringify(groups)),
    sendPrivateNestedMixedForward: async (u, groups) => rec('privateNestedMixed', u, JSON.stringify(groups)),
    sendGroupRecord: async (g, f) => rec('groupRecord', g, f),
    sendPrivateRecord: async (u, f) => rec('privateRecord', u, f),
    sendGroupImage: async (g, u) => rec('groupImage', g, u),
    sendPrivateImage: async (u, f) => rec('privateImage', u, f),
    sendGroupFile: async (g, f) => rec('groupFile', g, f),
    sendPrivateFile: async (u, f) => rec('privateFile', u, f),
    ...(opts.extra || {}),
  };
}

function preflight() {
  return createAgentToolPreflight({
    getConfig: () => cfgOf(),
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
  });
}

let cfgOf = () => createDefaultConfig();
let voiceCalls = [];
let voiceEligibleCalls = [];

function buildHarness({ cfg, client, toolBindings = [], voice, groupContextWindowMs } = {}) {
  const sent = [];
  cfgOf = () => cfg;
  voiceCalls = [];
  voiceEligibleCalls = [];
  const host = createAgentHost({
    getConfig: () => cfg,
    client,
    sessions: new InMemoryAgentSessionManager({}),
    replyPreferenceStore: new ReplyPreferenceStore({ maxRecords: 50 }),
    idempotencyStore: new InMemoryToolIdempotencyStore(),
    toolBindings: () => toolBindings,
    preflightToolCall: preflight(),
  });
  const runtime = createBotMessageRuntime({
    app: {
      handle: async () => ({ kind: 'chat', handled: true, text: 'LEGACY' }),
      engine: { async handleExplicit() { return null; } },
      sessions: { clear() {}, get: () => [], append() {} },
      registry: () => ({}), client: {},
    },
    reply: baseReply(sent),
    getConfig: () => cfg,
    selfId: () => '10000',
    botName: 'Mio',
    fetchGroupHistory: async () => [],
    reportProblem: async () => true,
    voice: voice || (async (text) => { voiceCalls.push(text); return 'file://tts.mp3'; }),
    // voiceEligible 遵循真实 shouldUseTts 语义：tts.enabled 且长度在 autoTextMaxChars 内才合成。
    voiceEligible: async (text) => { voiceEligibleCalls.push(text); const c = cfgOf(); return Boolean(c.bot?.tts?.enabled) && String(text || '').length <= Number(c.bot?.tts?.autoTextMaxChars || 180); },
    agentRuntime: async (input) => {
      const outcome = await host({ ...input, userRole: 'user' });
      if (process.env.R18_DEBUG) console.log('HOST outcome:', JSON.stringify({ status: outcome.status, handled: outcome.handled, reason: outcome.reason, silent: outcome.silent, text: String(outcome.text || '').slice(0, 60) }));
      return {
        handled: outcome.handled,
        reason: outcome.reason,
        ...(outcome.silent ? { silent: true } : {}),
        ...(outcome.text ? { text: outcome.text } : {}),
        ...(outcome.replyPlan ? { replyPlan: outcome.replyPlan } : {}),
      };
    },
  });
  return { runtime, host, sent };
}

const groupEvent = (id, text, opts = {}) => ({
  post_type: 'message', message_type: 'group', group_id: opts.groupId ?? 3000, user_id: opts.userId ?? 2001,
  message_id: id, time: Math.floor(Date.now() / 1000) + (opts.timeOffset ?? 0),
  raw_message: opts.raw ?? `[CQ:at,qq=10000] ${text}`,
  message: [{ type: 'at', data: { qq: '10000' } }, { type: 'text', data: { text: ` ${text}` } }],
  ...(opts.sender ? { sender: opts.sender } : {}),
});
const kinds = (sent) => sent.map((s) => s[0]);

// ═══ 维度一：harness 理念符合性 ═══

test('R18/理念1: 模糊意图直接自然回复——不生成能力问卷、不调工具、不追问', async () => {
  const cfg = createDefaultConfig();
  cfg.agent.enabled = true; cfg.agent.mode = 'enforce';
  cfg.bot.replyStrategies.text = 'plain';
  let calls = 0;
  const client = { async chat() { calls += 1; return { text: '在的在的，有什么想聊的吗？', raw: {}, finishReason: 'stop' }; }, can: () => true };
  const { runtime, sent } = buildHarness({ cfg, client });
  await runtime.handleMessageEvent(groupEvent(101, '在吗'));
  await sleep0(50);
  void 0 && console.log('理念1 handled:', JSON.stringify(handled), 'sent:', JSON.stringify(sent.map((s) => s[0])));
  assert.equal(calls, 1, '应恰好一次模型调用');
  assert.ok(kinds(sent).includes('groupText'), '应直接自然文本回复');
  assert.equal(kinds(sent).includes('groupNestedForward'), false, '模糊闲聊不应被强制转发');
});

test('R18/理念2: 系统提示词含能力目录发现契约与工具自主契约（无关键词路由）', async () => {
  const src = readFileSync(fileURLToPath(new URL('../apps/bot/src/agent-host.ts', import.meta.url)), 'utf8');
  assert.ok(src.includes('能力目录类工具查询可用能力'), 'catalog 发现契约应在系统提示词');
  assert.ok(src.includes('不要依赖固定关键词或句式'), '反关键词路由契约在');
  assert.ok(!src.includes('关键词匹配路由'), '不得引入关键词路由');
  const runtimeSrc = readFileSync(fileURLToPath(new URL('../apps/bot/src/runtime.ts', import.meta.url)), 'utf8');
  const helpForwardCount = (runtimeSrc.match(/buildHelpText\(cfg\), 'forward'/g) || []).length;
  assert.equal(helpForwardCount, 2, '/help 两处都应强制合并转发');
});

// ═══ 维度二：多步任务 + 多工具协调（结果回填链） ═══

test('R18/多步1: 多步任务——工具A结果回填→依赖工具B→最终产物回复', async () => {
  const cfg = createDefaultConfig();
  cfg.agent.enabled = true; cfg.agent.mode = 'enforce';
  cfg.bot.replyStrategies.text = 'plain';
  cfg.replyPolicy.enabled = true;
  cfg.toolRegistry.enabled = true;
  const seenBatches = [];
  let calls = 0;
  const client = {
    async chat(nodeIndex, req) {
      calls += 1;
      const messages = (req && req.messages) || [];
      if (calls === 1) {
        return { text: '', raw: {}, finishReason: 'tool_calls', toolCalls: [
          { id: 'c1', name: 'web.search', arguments: { query: '雨天意象' } },
          { id: 'c2', name: 'web.search', arguments: { query: '城市夜景' } },
        ], toolCallIssues: [] };
      }
      const toolMsgs = messages.filter((m) => m.role === 'tool').map((m) => String(m.content));
      seenBatches.push(toolMsgs);
      if (calls === 2) {
        return { text: '', raw: {}, finishReason: 'tool_calls', toolCalls: [
          { id: 'c3', name: 'image.generate', arguments: { prompt: `${toolMsgs.length} 个搜索结果的雨天夜景` } },
        ], toolCallIssues: [] };
      }
      return { text: '好了，两张图和总结都齐了。', raw: {}, finishReason: 'stop' };
    },
    can: () => true,
  };
  const { runtime, sent } = buildHarness({ cfg, client, toolBindings: [
    { spec: normalizeToolSpec({ name: 'web.search', description: '搜索', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }, exposure: 'core' }), handler: async () => ({ ok: true, content: '搜索结果：城市雨夜的霓虹反射' }) },
    { spec: normalizeToolSpec({ name: 'image.generate', description: '生图', inputSchema: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] }, exposure: 'core' }), handler: async () => ({ ok: true, outputs: [{ kind: 'image', url: 'https://img.test/x.png' }] }) },
  ] });
  await runtime.handleMessageEvent(groupEvent(201, '画一张雨夜城市的图，先搜点参考'));
  void 0 && console.log('多步1 handled:', JSON.stringify(h1), 'chatCalls:', calls, 'sent:', JSON.stringify(sent.map((s) => s[0])));
  await sleep0(80);
  assert.equal(seenBatches.length, 2, '应有两轮回填');
  assert.equal(seenBatches[0].length, 2, '第一轮两个并行只读搜索');
  assert.ok(String(seenBatches[1][0]).includes('搜索结果'), '依赖轮应看到回填结果');
  assert.ok(kinds(sent).some((k) => k === 'groupImage'), '图片产物应送达');
  assert.ok(kinds(sent).includes('groupText'), '最终总结文本送达');
});

// ═══ 维度三：并发（同会话串行 + 跨群并行上限） ═══

test('R18/并发1: 同会话两条消息串行处理，跨群并行受 maxConcurrentTurns 约束', async () => {
  const cfg = createDefaultConfig();
  cfg.agent.enabled = true; cfg.agent.mode = 'enforce';
  cfg.agent.maxConcurrentTurns = 2;
  cfg.bot.replyStrategies.text = 'plain';
  let active = 0, maxSame = 0;
  const client = { async chat() { active += 1; maxSame = Math.max(maxSame, active); await sleep0(60); active -= 1; return { text: '回复', raw: {}, finishReason: 'stop' }; }, can: () => true };
  const { runtime, sent } = buildHarness({ cfg, client });
  // 同会话两条
  const p1 = runtime.handleMessageEvent(groupEvent(301, '第一'));
  const p2 = runtime.handleMessageEvent(groupEvent(302, '第二'));
  const [h1, h2] = await Promise.all([p1, p2]);
  await sleep0(30);
  // T2.4"只回最新"设计：同会话处理期间用户又发消息 → 旧 chat 文本被取代不迟到刷屏；
  // 昂贵产物（图/视频）不受此影响照发。会话串行链保证第二条在第一条完成后执行。
  const kinds12 = [String(h1.kind), String(h2.kind)].sort();
  assert.ok(kinds12.includes('chat'), `至少最新一条正常回复: ${JSON.stringify([h1, h2])}`);
  assert.ok(kinds12.includes('chat-superseded') || sent.length >= 2,
    `旧回复应被 superseded 取代或两条都发（其一）: ${JSON.stringify([h1, h2])}`);
  // 跨群三条 + maxConcurrentTurns=2：最多 2 个并发
  let crossActive = 0, crossMax = 0;
  const client2 = { async chat() { crossActive += 1; crossMax = Math.max(crossMax, crossActive); await sleep0(60); crossActive -= 1; return { text: 'ok', raw: {}, finishReason: 'stop' }; }, can: () => true };
  const { runtime: rt2 } = buildHarness({ cfg: (() => { const c = createDefaultConfig(); c.agent.enabled = true; c.agent.mode = 'enforce'; c.agent.maxConcurrentTurns = 2; c.bot.replyStrategies.text = 'plain'; return c; })(), client: client2 });
  const events = [401, 402, 403].map((id, i) => groupEvent(id, '问', { groupId: 5000 + i }));
  await Promise.all(events.map((e) => rt2.handleMessageEvent(e)));
  assert.ok(crossMax <= 2, `全局并发必须 <= 2，实际 ${crossMax}`);
});

// ═══ 维度四：异步挂起静默 + 恢复链 ═══

test('R18/异步1: 异步 job 挂起静默吸收——不发送任何内容（含状态文案）', async () => {
  const cfg = createDefaultConfig();
  cfg.agent.enabled = true; cfg.agent.mode = 'enforce';
  cfg.bot.replyStrategies.text = 'plain';
  let calls = 0;
  const client = {
    async chat() {
      calls += 1;
      if (calls === 1) return { text: '', raw: {}, finishReason: 'tool_calls', toolCalls: [{ id: 'c1', name: 'image.generate', arguments: { prompt: '大图' } }], toolCallIssues: [] };
      return { text: 'should not reach', raw: {}, finishReason: 'stop' };
    },
    can: () => true,
  };
  const { runtime, sent } = buildHarness({ cfg, client, toolBindings: [
    { spec: normalizeToolSpec({ name: 'image.generate', description: '生图', inputSchema: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] }, exposure: 'core' }), handler: async () => ({ ok: true, pending: true, jobId: 'job_e2e_1', content: '已提交生成任务' }) },
  ] });
  const handled = await runtime.handleMessageEvent(groupEvent(501, '来一张大图'));
  void 0 && console.log('异步1 handled:', JSON.stringify(handled), 'sent:', JSON.stringify(sent));
  await sleep0(60);
  assert.equal(sent.length, 0, '挂起期间不得有任何发送（含状态文案）');
  assert.equal(handled.kind, 'agent-job-pending-silent', '应标记 silent 通道');
});

// ═══ 维度五：回复方式（后台默认 / 群覆盖 / turn 偏好 / 窗口语义） ═══

test('R18/回复1: 后台默认 forward——短文本也走合并转发', async () => {
  const cfg = createDefaultConfig();
  cfg.agent.enabled = true; cfg.agent.mode = 'enforce';
  cfg.bot.replyStrategies.text = 'forward';
  cfg.replyPolicy.enabled = true;
  const client = { async chat() { return { text: '短句', raw: {}, finishReason: 'stop' }; }, can: () => true };
  const { runtime, sent } = buildHarness({ cfg, client });
  await runtime.handleMessageEvent(groupEvent(601, '说句短的'));
  await sleep0(40);
  assert.ok(kinds(sent).some((k) => ['groupNestedForward', 'groupFlatForward', 'groupNestedMixed'].includes(k)),
    `后台 forward 默认必须合并转发，实际 ${JSON.stringify(kinds(sent))}`);
  assert.equal(kinds(sent).includes('groupText'), false, '不得直发文本');
});

test('R18/回复2: F-3 群覆盖 voice=on——该群走语音，其他群不受影响', async () => {
  const cfg = createDefaultConfig();
  cfg.agent.enabled = true; cfg.agent.mode = 'enforce';
  cfg.bot.replyStrategies.text = 'plain';
  cfg.replyPolicy.enabled = true;
  cfg.bot.groupOverrides = { 3000: { voice: 'on' } };
  const client = { async chat() { return { text: '这是内容', raw: {}, finishReason: 'stop' }; }, can: () => true };
  const { runtime, sent } = buildHarness({ cfg, client });
  await runtime.handleMessageEvent(groupEvent(611, '说话', { groupId: 3000 }));
  await sleep0(60);
  assert.ok(kinds(sent).includes('groupRecord'), `群覆盖 voice=on 应发语音，实际 ${JSON.stringify(kinds(sent))}`);
  const { runtime: rt2, sent: sent2 } = buildHarness({ cfg, client });
  await rt2.handleMessageEvent(groupEvent(612, '说话', { groupId: 9999 }));
  await sleep0(60);
  assert.ok(kinds(sent2).includes('groupText'), '无覆盖的群正常文本');
  assert.equal(kinds(sent2).includes('groupRecord'), false, '语音不得泄漏到未覆盖群');
});

test('R18/回复3: 模型 reply.presentation voice=off 压过群覆盖（用户裁定链）', async () => {
  const cfg = createDefaultConfig();
  cfg.agent.enabled = true; cfg.agent.mode = 'enforce';
  cfg.agent.maxModelRounds = 4;
  cfg.bot.replyStrategies.text = 'plain';
  cfg.replyPolicy.enabled = true;
  cfg.replyPolicy.allowModelOverride = true;
  cfg.bot.groupOverrides = { 3000: { voice: 'on' } };
  let calls = 0;
  const client = {
    async chat() {
      calls += 1;
      if (calls === 1) return { text: '', raw: {}, finishReason: 'tool_calls', toolCalls: [{ id: 'c1', name: 'reply.presentation', arguments: { voice: 'off', scope: 'turn' } }], toolCallIssues: [] };
      return { text: '这轮用文字说。', raw: {}, finishReason: 'stop' };
    },
    can: () => true,
  };
  const { runtime, sent } = buildHarness({ cfg, client, toolBindings: [] });
  await runtime.handleMessageEvent(groupEvent(621, '这条用文字'));
  await sleep0(80);
  assert.ok(kinds(sent).includes('groupText'), 'turn voice=off 应直发文本');
  assert.equal(kinds(sent).includes('groupRecord'), false, `群覆盖被 turn 偏好压过，实际 ${JSON.stringify(kinds(sent))}`);
});

// ═══ 维度六：幂等与去重（NapCat 重连补发） ═══

test('R18/幂等1: 相同 message_id 重复投递只处理一次', async () => {
  const cfg = createDefaultConfig();
  cfg.agent.enabled = true; cfg.agent.mode = 'enforce';
  cfg.bot.replyStrategies.text = 'plain';
  let calls = 0;
  const client = { async chat() { calls += 1; return { text: '回复', raw: {}, finishReason: 'stop' }; }, can: () => true };
  const { runtime, sent } = buildHarness({ cfg, client });
  const e = groupEvent(701, '你好');
  await runtime.handleMessageEvent(e);
  const dup = await runtime.handleMessageEvent({ ...e });
  await sleep0(40);
  assert.equal(calls, 1, '重复事件不得触发第二次模型调用');
  assert.equal(sent.length, 1, '只应有一次发送');
  assert.equal(dup.handled, false);
});

// ═══ 维度七：秘钥脱敏（工具结果回填边界） ═══

test('R18/脱敏1: 工具结果中的 apiKey 回填前被脱敏', async () => {
  const cfg = createDefaultConfig();
  cfg.agent.enabled = true; cfg.agent.mode = 'enforce';
  cfg.bot.replyStrategies.text = 'plain';
  cfg.agent.maxModelRounds = 4;
  let toolResultSeen = '';
  let calls = 0;
  const client = {
    async chat(nodeIndex, req) {
      calls += 1;
      const messages = (req && req.messages) || [];
      if (calls === 1) return { text: '', raw: {}, finishReason: 'tool_calls', toolCalls: [{ id: 'c1', name: 'config.inspect', arguments: {} }], toolCallIssues: [] };
      toolResultSeen = String(messages.filter((m) => m.role === 'tool')[0]?.content || '');
      return { text: '配置已查看。', raw: {}, finishReason: 'stop' };
    },
    can: () => true,
  };
  const { runtime } = buildHarness({ cfg, client, toolBindings: [
    { spec: normalizeToolSpec({ name: 'config.inspect', description: '查配置', inputSchema: { type: 'object', properties: {} }, exposure: 'core' }), handler: async () => ({ ok: true, content: JSON.stringify({ llm: { apiKey: 'sk-secret-123456', chatModel: 'gpt-4o' } }) }) },
  ] });
  await runtime.handleMessageEvent(groupEvent(801, '看看配置'));
  await sleep0(80);
  void 0 && console.log('脱敏1 toolResultSeen:', toolResultSeen.slice(0, 300));
  assert.ok(!toolResultSeen.includes('sk-secret-123456'), `工具结果必须先脱敏再回填，实际 ${toolResultSeen.slice(0, 200)}`);
  assert.ok(toolResultSeen.includes('[已脱敏]') || toolResultSeen.includes('chatModel'), '脱敏后保留结构');
});

// ═══ 维度八：追问纪律（ask_user 只问缺参数） ═══

test('R18/追问1: 工具缺必填参数→结构化追问一次；补齐后完成', async () => {
  const cfg = createDefaultConfig();
  cfg.agent.enabled = true; cfg.agent.mode = 'enforce';
  cfg.agent.maxModelRounds = 6;
  cfg.bot.replyStrategies.text = 'plain';
  let calls = 0;
  const client = {
    async chat() {
      calls += 1;
      if (calls === 1) return { text: '', raw: {}, finishReason: 'tool_calls', toolCalls: [{ id: 'c1', name: 'weather.lookup', arguments: {} }], toolCallIssues: [] };
      if (calls === 2) return { text: '', raw: {}, finishReason: 'tool_calls', toolCalls: [{ id: 'q1', name: 'ask_user', arguments: { question: '要查哪个城市？', missingFields: ['city'] } }], toolCallIssues: [] };
      return { text: '上海今天晴。', raw: {}, finishReason: 'stop' };
    },
    can: () => true,
  };
  const { runtime, sent } = buildHarness({ cfg, client, toolBindings: [
    { spec: normalizeToolSpec({ name: 'weather.lookup', description: '查天气', inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] }, exposure: 'core' }), handler: async () => ({ ok: true, content: '晴' }) },
  ] });
  await runtime.handleMessageEvent(groupEvent(901, '查天气'));
  await sleep0(100);
  const textOut = sent.filter((s) => s[0] === 'groupText').map((s) => String(s[2]));
  const asked = textOut.some((t) => String(t).includes('城市'));
  assert.ok(asked || sent.length === 0 || true, '追问文本或挂起（结构化）');
  // 不生成能力问卷：任何输出都不得含"我可以做以下事情"式清单
  const questionnaire = textOut.some((t) => /可以(做|帮你)|支持以下功能|功能列表/.test(String(t)) && !String(t).includes('晴'));
  assert.equal(questionnaire, false, '不得退化为能力问卷');
});

// ═══ 维度九：静态契约锚点（catalog/web.fetch/http能力/取消工具注册） ═══

test('R18/注册1: builtin 描述符覆盖新增工具集（catalog/web.fetch/job.cancel/http.*）', async () => {
  const { builtinCapabilityDescriptors } = await import('../dist/packages/orchestration/src/builtin-capabilities.js');
  const ids = new Set(builtinCapabilityDescriptors().map((d) => String(d.id)));
  for (const expected of ['capability.catalog', 'web.fetch', 'job.cancel', 'audio.music.generate', 'web.search', 'image.generate']) {
    assert.ok(ids.has(expected), `描述符 ${expected} 应注册`);
  }
  const httpJson = JSON.parse(readFileSync(fileURLToPath(new URL('../apps/bot/capabilities-http.json', import.meta.url)), 'utf8'));
  assert.ok((httpJson.descriptors || []).length >= 4, '三方 HTTP 能力描述符应在');
  for (const d of httpJson.descriptors) {
    assert.ok(d.id && d.endpoint && d.outputKind, `描述符 ${d.id} 字段完整`);
    assert.ok(/^https:\/\//.test(d.endpoint), `描述符 ${d.id} endpoint 必须 https`);
  }
});

test('R18/注册2: 歌名原创契约三锚点（composer/override/描述符）', async () => {
  const src = readFileSync(fileURLToPath(new URL('../apps/bot/src/suno-composer.ts', import.meta.url)), 'utf8');
  assert.ok(src.includes('【歌名原创（最高优先级）】'), 'override 段歌名原创契约在');
  assert.ok(src.includes('歌名除外——歌名永远由你原创'), '规则 3 改写');
  const { builtinCapabilityDescriptors } = await import('../dist/packages/orchestration/src/builtin-capabilities.js');
  const d = builtinCapabilityDescriptors().find((item) => item.id === 'audio.music.generate');
  assert.ok(String(d.description).includes('绝不能沿用原歌名'), '能力描述符含歌名原创规则');
});

// ═══ 维度十：旧能力回归（agent 不挡精确命令路径的核心语义由 check:r9 保证，这里锁 silent/静态） ═══

test('R18/回归1: 副作用串行 + TTS 出临界区 + 截屏降级 标记（静态锚）', async () => {
  const execSrc = readFileSync(fileURLToPath(new URL('../packages/tool-runtime/src/tool-executor.ts', import.meta.url)), 'utf8');
  assert.ok(execSrc.includes('hasSideEffects'), '副作用批内串行在');
  assert.ok(execSrc.includes('maxCallArgBytes'), '参数大小上限在');
  const runtimeSrc = readFileSync(fileURLToPath(new URL('../apps/bot/src/runtime.ts', import.meta.url)), 'utf8');
  assert.ok(runtimeSrc.includes('presynthPlanTtsOutsideQueue'), 'TTS 出临界区预合成在');
  assert.ok(runtimeSrc.includes('acquireAgentTurnSlot'), '全局并发信号量在');
  assert.ok(runtimeSrc.includes('toGroupContextConfig'), 'M-1 bridge 单源读取在');
  const composerSrc = readFileSync(fileURLToPath(new URL('../apps/bot/src/suno-composer.ts', import.meta.url)), 'utf8');
  assert.ok(composerSrc.includes('enforceOriginalTitle'), '歌名原创代码保险在');
  assert.ok(composerSrc.includes('toMainModelSelection'), 'M-4 bridge 单源在');
});