// 全流程模拟：极端输入 + 多步协作 + 已知 bug 回归（napcat WS 模拟，确定性）。
// 与 angle-simulation（边界/并发/分流）互补，本文件聚焦：
//   撤回多步（文本/语音 uncertain/合并转发/超窗）、歌词能力、局部编辑定位失败文案、
//   窗口分区纯函数、戳一戳、上下文合并注入。
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';

import { NapcatAdapter } from '../dist/packages/napcat/src/index.js';
import { createBotMessageRuntime } from '../dist/apps/bot/src/main.js';
import { createDefaultConfig } from '../dist/packages/config/src/index.js';
import { createSentMessageTracker, createTrackingReplyClient, partitionRecallEntries, sentChatKey } from '../dist/apps/bot/src/sent-messages.js';
import { OwnerRecallCapabilityHandler } from '../dist/apps/bot/src/capability-owner.js';
import { SunoLyricsCapabilityHandler, SunoReplaceSectionCapabilityHandler } from '../dist/apps/bot/src/capability-suno-library.js';
import { SunoSongHistoryStore } from '../dist/apps/bot/src/suno-song-history.js';

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function waitUntil(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(20);
  }
  throw new Error('timeout waiting for ' + label);
}

// ═══ 纯函数：撤回窗口分区 ═══

test('撤回分区: 超窗跳过、合并转发跳过、其余进 targets', () => {
  const now = Date.now();
  const entries = [
    { id: 1, at: now - 10e3, kind: 'text' },
    { id: 2, at: now - 3 * 60e3, kind: 'record' },
    { id: 3, at: now - 30e3, kind: 'forward' },
    { id: 4, at: now - 5e3, kind: 'text' },
  ];
  const { targets, forward, expired } = partitionRecallEntries(entries, now);
  assert.deepEqual(targets.map((e) => e.id), [1, 4]);
  assert.deepEqual(forward.map((e) => e.id), [3]);
  assert.equal(expired, 1);
});

test('撤回登记: uncertain 发送（retcode 1200 高发形态）也登记且带类型', async () => {
  const tracker = createSentMessageTracker();
  const mock = {
    async sendGroupRecord() { return { success: false, uncertain: true, messageId: 555 }; },
    async sendGroupNestedForward() { return { success: true, messageId: 666 }; },
    async sendGroupText() { return { success: true, messageId: 777 }; },
  };
  const client = createTrackingReplyClient(mock, tracker);
  await client.sendGroupRecord(100, 'file://x.mp3');
  await client.sendGroupNestedForward(100, []);
  await client.sendGroupText(100, 'hi');
  const entries = tracker.takeDetailed(sentChatKey('group', 100), 10).slice().reverse();
  assert.deepEqual(entries.map((e) => [e.id, e.kind]), [[555, 'record'], [666, 'forward'], [777, 'text']]);
});

// ═══ handler 级：歌词能力 + 局部编辑定位失败文案 ═══

function sunoInvocation(args) {
  return {
    request: { chat: { type: 'group', groupId: '7', userId: '77' }, user: { qq: '77', role: 'user' }, text: 'x', attachments: [], receivedAt: new Date().toISOString() },
    plan: { planId: 'p' },
    step: { id: 's1', capability: 'audio.music.lyrics', args },
    dependencyResults: {},
  };
}

function tempHistoryStore(records = []) {
  const store = new SunoSongHistoryStore({ filePath: ':memory-none', maxRecords: () => 100 });
  for (const r of records) {
    store.add({ chatType: r.chatType, groupId: r.groupId, userQq: r.userQq, requestText: r.requestText, taskId: r.taskId, title: r.title, lyrics: r.lyrics, audioUrl: r.audioUrl, variantIndex: r.variantIndex });
  }
  return store;
}

test('歌词能力: 有歌词 → 输出歌词文本；无歌词 → 明说没有保存', async () => {
  const store = tempHistoryStore([]);
  const withLyrics = store.add({ chatType: 'group', groupId: 1, userQq: '2', requestText: '有词的歌', taskId: 't1', audioId: 'aud-t1', title: '有词的歌', lyrics: '[Verse] 天黑请闭眼', audioUrl: 'https://example.com/a.mp3', variantIndex: 1 });
  store.add({ chatType: 'group', groupId: 1, userQq: '2', requestText: '没词的歌', taskId: 't2', audioId: 'aud-t2', title: '没词的歌', audioUrl: 'https://example.com/b.mp3', variantIndex: 1 });
  const handler = new SunoLyricsCapabilityHandler(store);

  const ok = await handler.execute(sunoInvocation({ recordId: withLyrics.id }));
  assert.equal(ok.status, 'success');
  assert.match(String(ok.outputs[0].text), /天黑请闭眼/);
  assert.match(String(ok.outputs[0].text), /有词的歌/);

  const none = await handler.execute(sunoInvocation({ title: '没词的歌' }));
  assert.equal(none.status, 'needs_input');
  assert.match(String(none.outputs[0].text), /没有保存歌词/);

  const missing = await handler.execute(sunoInvocation({ title: '不存在的歌' }));
  assert.equal(missing.status, 'needs_input');
  assert.match(String(missing.outputs[0].text), /有词的歌/, '找不到歌时应附全局历史列表供选择');
});

test('局部编辑: 找不到歌 → 全局历史；定位失败 → 自然语言文案（自动定位提示）', async () => {
  const store = tempHistoryStore([]);
  store.add({ chatType: 'group', groupId: 1, userQq: '2', requestText: '远方的歌', taskId: 'seed', audioId: 'aud-seed', title: '远方的歌', audioUrl: 'https://example.com/r.mp3', variantIndex: 1 });
  const handler = new SunoReplaceSectionCapabilityHandler({
    getConfig: () => ({ orchestration: { suno: { enabled: true } } }),
    store,
    client: { async chat() { throw new Error('timestamped lyrics unavailable'); } }, // inferSection 失败
  });
  // 用户自然语言要改词，没给秒数 → 不再要求手输秒数，而是提示会自动定位
  const result = await handler.execute(sunoInvocation({ title: '远方的歌', change: '把第二段副歌换成生日主题' }));
  assert.equal(result.status, 'needs_input');
  assert.match(String(result.outputs[0].text), /远方的歌/);
  assert.ok(result.diagnostics.missingInformation.some((s) => s.includes('自动定位')), `文案应含自动定位提示：${JSON.stringify(result.diagnostics.missingInformation)}`);

  const notFound = await handler.execute(sunoInvocation({ title: '不存在的歌', change: 'x' }));
  assert.equal(notFound.status, 'needs_input');
  assert.match(String(notFound.outputs[0].text), /还没有生成过歌曲|远方的歌/);
});

// ═══ runtime 级：撤回多步（文本→撤回；语音 uncertain→撤回）═══

async function createSim() {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(wss, 'listening');
  const port = wss.address().port;
  const actions = [];
  let peer = null;
  let mid = 1;
  wss.on('connection', (socket) => {
    peer = socket;
    socket.on('message', (raw) => {
      let action; try { action = JSON.parse(String(raw)); } catch { return; }
      actions.push(action);
      socket.send(JSON.stringify({ echo: action.echo, self_id: 10000, status: 'ok', retcode: 0, data: { message_id: mid++ } }));
    });
  });
  const adapter = new NapcatAdapter({ wsUrl: 'ws://127.0.0.1:' + port, token: 'sim', actionTimeoutMs: 3000, textSendTimeoutMs: 3000, forwardSendTimeoutMs: 3000, autoReconnect: false });
  await new Promise((r) => { const off = adapter.on('open', () => { off(); r(); }); adapter.connect(); });
  return {
    adapter, actions,
    get peer() { return peer; },
    sendEvent(event) { peer.send(JSON.stringify({ self_id: 10000, ...event })); },
    async close() { adapter.disconnect(); for (const c of wss.clients) c.terminate(); await new Promise((r) => wss.close(r)); },
  };
}

function makeRuntime(sim, { ownerQQs = ['2'], deletedIds } = {}) {
  const owner = { ownerQQs: () => ownerQQs, handle: async () => null };
  const cfg = createDefaultConfig();
  cfg.agent.enabled = false; cfg.agent.mode = 'off'; // 旧引擎/命令路径测试（新聊天语义由 agent-r9-fixes.test.mjs 覆盖）
  cfg.bot.botQqId = '10000';
  cfg.bot.ownerQQs = ownerQQs;
  cfg.llm.chatEnabled = true;
  cfg.bot.replyStrategies.text = 'plain';
  return createBotMessageRuntime({
    app: { handle: async () => ({ kind: 'chat', handled: true, text: '收到啦', decision: { kind: 'chat', params: {} } }), engine: { async handleExplicit() { return null; } }, sessions: { clear() {}, get: () => [], append() {} }, registry: () => ({}), client: {} },
    reply: sim.adapter,
    getConfig: () => cfg,
    selfId: () => '10000', botName: 'Mio', owner,
    deleteMessage: async (id) => { deletedIds?.push(id); return true; },
    reportProblem: async () => true,
  });
}

test('撤回多步: bot 发文本 → owner /撤回 1 → 对应 message_id 被删除且收到汇总', async () => {
  const sim = await createSim();
  const deletedIds = [];
  const runtime = makeRuntime(sim, { deletedIds });
  runtime.attach(sim.adapter);
  try {
    sim.sendEvent({ post_type: 'message', message_type: 'group', group_id: 100, user_id: 2, message_id: 1, raw_message: '[CQ:at,qq=10000] 讲个笑话', message: [{ type: 'at', data: { qq: '10000' } }, { type: 'text', data: { text: ' 讲个笑话' } }], sender: { user_id: 2, nickname: 'o' } });
    await waitUntil(() => sim.actions.some((a) => a.action === 'send_group_msg'), 5000, 'bot 回复');
    const sentId = sim.actions.find((a) => a.action === 'send_group_msg')?.echo;
    void sentId;
    const repliesBefore = sim.actions.filter((a) => a.action === 'send_group_msg').length;
    sim.sendEvent({ post_type: 'message', message_type: 'group', group_id: 100, user_id: 2, message_id: 2, raw_message: '[CQ:at,qq=10000] /撤回 1', message: [{ type: 'at', data: { qq: '10000' } }, { type: 'text', data: { text: ' /撤回 1' } }], sender: { user_id: 2, nickname: 'o' } });
    await waitUntil(() => sim.actions.filter((a) => a.action === 'send_group_msg').length > repliesBefore, 5000, '撤回结果回复');
    assert.equal(deletedIds.length, 1, `应删除 1 条，实际 ${JSON.stringify(deletedIds)}`);
    const recallReply = sim.actions.filter((a) => a.action === 'send_group_msg').at(-1);
    const recallText = (recallReply?.params?.message || []).map((s) => s?.data?.text || '').join('');
    assert.match(recallText, /已撤回 1 条消息/);
  } finally { await sim.close(); }
});

test('撤回多步: 语音 uncertain 登记后可撤回（线上语音撤不回的根因回归）', async () => {
  // handler 级：模拟 sendGroupRecord 返回 uncertain（NapCat retcode 1200 常态），登记后 owner 撤回应命中该 id
  const tracker = createSentMessageTracker();
  const mock = { async sendGroupRecord() { return { success: false, uncertain: true, messageId: 555 }; } };
  await createTrackingReplyClient(mock, tracker).sendGroupRecord(100, 'file://voice.mp3');
  const deleted = [];
  const handler = new OwnerRecallCapabilityHandler({ tracker, deleteMessage: async (id) => { deleted.push(id); return true; } });
  const result = await handler.execute({
    request: { chat: { type: 'group', groupId: '100' }, user: { qq: '2', role: 'owner' }, text: '/ch', attachments: [], receivedAt: new Date().toISOString() },
    plan: { planId: 'p' },
    step: { id: 's', capability: 'owner.recall', args: { count: 1 } },
    dependencyResults: {},
  });
  assert.deepEqual(deleted, [555], 'uncertain 语音的 message id 应已登记并可撤');
  assert.match(String(result.outputs[0].text), /已撤回 1 条消息/);
});

// ═══ 图片可见性：引用图片、pending 纯图答案、最近图片并入 ═══

test('图片可见性: 用户回复(引用)一条图片消息并 @bot → 模型输入带上引用图片', async () => {
  const sim = await createSim();
  const engineInputs = [];
  const storedMessages = {
    500: { post_type: 'message', message_type: 'group', group_id: 100, user_id: 9, message_id: 500, raw_message: '[CQ:image,file=abc.jpg,url=https://example.com/cat.jpg]', message: [{ type: 'image', data: { file: 'abc.jpg', url: 'https://example.com/cat.jpg' } }], sender: { user_id: 9, nickname: '发图人' } },
  };
  const runtime = createBotMessageRuntime({
    app: { handle: async (input) => { engineInputs.push(input); return { kind: 'chat', handled: true, text: '看到了', decision: { kind: 'chat', params: {} } }; }, engine: { async handleExplicit() { return null; } }, sessions: { clear() {}, get: () => [], append() {} }, registry: () => ({}), client: {} },
    reply: sim.adapter,
    getConfig: () => { const c = createDefaultConfig(); c.agent.enabled = false; c.agent.mode = 'off'; c.bot.botQqId = '10000'; c.llm.chatEnabled = true; c.bot.replyStrategies.text = 'plain'; return c; },
    selfId: () => '10000', botName: 'Mio',
    prepareInputImages: async (images) => images.map((u) => /^(https?:|data:)/.test(String(u)) ? u : 'https://test.local/' + String(u).replace(/^local:/, '')),
    fetchReferencedMessage: async (replyId) => storedMessages[String(replyId)] || null,
    reportProblem: async () => true,
  });
  runtime.attach(sim.adapter);
  try {
    sim.sendEvent({ post_type: 'message', message_type: 'group', group_id: 100, user_id: 2, message_id: 501, raw_message: '[CQ:reply,id=500][CQ:at,qq=10000] 看看这张图', message: [{ type: 'reply', data: { id: '500' } }, { type: 'at', data: { qq: '10000' } }, { type: 'text', data: { text: ' 看看这张图' } }], sender: { user_id: 2, nickname: 'u' } });
    await waitUntil(() => engineInputs.length > 0, 5000, '旧链路被调用');
    const input = engineInputs[0];
    assert.ok((input.images || []).some((u) => String(u).includes('abc.jpg')), `引用图片应进入模型输入: ${JSON.stringify(input.images)}`);
  } finally { await sim.close(); }
});

test('图片可见性: 追问等待中用户只发一张图（无@无文字）→ 作为澄清答案进入处理并带图', async () => {
  const sim = await createSim();
  const engineInputs = [];
  let enforceInput;
  const runtime = createBotMessageRuntime({
    app: { handle: async (input) => { engineInputs.push(input); return { kind: 'chat', handled: true, text: 'ok', decision: { kind: 'chat', params: {} } }; }, engine: { async handleExplicit() { return null; } }, sessions: { clear() {}, get: () => [], append() {} }, registry: () => ({}), client: {} },
    reply: sim.adapter,
    getConfig: () => { const c = createDefaultConfig(); c.agent.enabled = false; c.agent.mode = 'off'; c.bot.botQqId = '10000'; c.llm.chatEnabled = true; c.bot.replyStrategies.text = 'plain'; return c; },
    selfId: () => '10000', botName: 'Mio',
    prepareInputImages: async (images) => images.map((u) => /^(https?:|data:)/.test(String(u)) ? u : 'https://test.local/' + String(u).replace(/^local:/, '')),
    hasPendingClarification: ({ userId }) => userId === 3, // 该用户有等待回答的追问
    enforceOrchestration: async (input) => { enforceInput = input; return { handled: false, reason: 'planner_failed' }; },
    reportProblem: async () => true,
  });
  runtime.attach(sim.adapter);
  try {
    // 纯图消息，无 @ 无文字——追问等待中应作为澄清答案处理，而不是被忽略
    sim.sendEvent({ post_type: 'message', message_type: 'group', group_id: 100, user_id: 3, message_id: 600, raw_message: '[CQ:image,file=ans.jpg,url=https://example.com/answer.jpg]', message: [{ type: 'image', data: { file: 'ans.jpg', url: 'https://example.com/answer.jpg' } }], sender: { user_id: 3, nickname: 'u3' } });
    await waitUntil(() => engineInputs.length > 0 || enforceInput, 5000, '澄清答案被处理');
    // 本测试未启用 orchestration → 走旧链路（行为等价：图片都到达了模型输入）
    const seen = enforceInput || engineInputs[0];
    assert.ok(seen, '澄清答案应被处理');
    assert.ok((seen.images || []).some((u) => String(u).includes('ans.jpg')), `澄清答案图片应带给模型: ${JSON.stringify((enforceInput || engineInputs[0]).images)}`);
  } finally { await sim.close(); }
});

test('图片可见性: 先发图(被忽略) → 再 @bot 提问(无图) → 最近图片自动并入', async () => {
  const sim = await createSim();
  const engineInputs = [];
  const runtime = createBotMessageRuntime({
    app: { handle: async (input) => { engineInputs.push(input); return { kind: 'chat', handled: true, text: '看到了', decision: { kind: 'chat', params: {} } }; }, engine: { async handleExplicit() { return null; } }, sessions: { clear() {}, get: () => [], append() {} }, registry: () => ({}), client: {} },
    reply: sim.adapter,
    getConfig: () => { const c = createDefaultConfig(); c.agent.enabled = false; c.agent.mode = 'off'; c.bot.botQqId = '10000'; c.llm.chatEnabled = true; c.bot.replyStrategies.text = 'plain'; return c; },
    selfId: () => '10000', botName: 'Mio',
    prepareInputImages: async (images) => images.map((u) => /^(https?:|data:)/.test(String(u)) ? u : 'https://test.local/' + String(u).replace(/^local:/, '')),
    reportProblem: async () => true,
  });
  runtime.attach(sim.adapter);
  try {
    // 先发图（无触发 → 忽略，但图片进最近记忆）
    sim.sendEvent({ post_type: 'message', message_type: 'group', group_id: 100, user_id: 2, message_id: 700, raw_message: '[CQ:image,file=recent.jpg,url=https://example.com/recent.jpg]', message: [{ type: 'image', data: { file: 'recent.jpg', url: 'https://example.com/recent.jpg' } }], sender: { user_id: 2, nickname: 'u' } });
    await sleep(300);
    // 再 @bot 提问（无图）→ 最近图片并入模型输入
    sim.sendEvent({ post_type: 'message', message_type: 'group', group_id: 100, user_id: 2, message_id: 701, raw_message: '[CQ:at,qq=10000] 这是什么', message: [{ type: 'at', data: { qq: '10000' } }, { type: 'text', data: { text: ' 这是什么' } }], sender: { user_id: 2, nickname: 'u' } });
    await waitUntil(() => engineInputs.length > 0, 5000, '提问被处理');
    assert.ok((engineInputs[0].images || []).some((u) => String(u).includes('recent.jpg')), `最近图片应并入模型输入: ${JSON.stringify(engineInputs[0].images)}`);
  } finally { await sim.close(); }
});
