// 「不回复」事故两 bug 回归（napcat WS 模拟）：
//   Bug A：关键词/延续触发的 chat 决策必须带 commandText——否则 enforce 失败回退旧链路时
//          用户原文丢失，被判空@回罐头话"我在。直接说需求就行…"。
//   Bug B：empty-mention 罐头回复必须登记延续状态——否则用户紧跟着的补充消息直接被忽略。
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';

import { NapcatAdapter } from '../dist/packages/napcat/src/index.js';
import { createBotMessageRuntime } from '../dist/apps/bot/src/main.js';
import { createDefaultConfig } from '../dist/packages/config/src/index.js';

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function waitUntil(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(20);
  }
  throw new Error('timeout waiting for ' + label);
}

async function createSim() {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(wss, 'listening');
  const port = wss.address().port;
  const actions = [];
  let peer = null;
  let nextMessageId = 8000;
  wss.on('connection', (socket) => {
    peer = socket;
    socket.on('message', (raw) => {
      let action; try { action = JSON.parse(String(raw)); } catch { return; }
      actions.push(action);
      socket.send(JSON.stringify({ echo: action.echo, self_id: 10000, status: 'ok', retcode: 0, data: { message_id: nextMessageId++ } }));
    });
  });
  const adapter = new NapcatAdapter({ wsUrl: 'ws://127.0.0.1:' + port, token: 'sim', actionTimeoutMs: 3000, textSendTimeoutMs: 3000, forwardSendTimeoutMs: 3000, autoReconnect: false });
  const opened = new Promise((r) => { const off = adapter.on('open', () => { off(); r(); }); });
  adapter.connect();
  await opened;
  return {
    adapter, actions,
    get peer() { return peer; },
    sendEvent(event) { peer.send(JSON.stringify({ self_id: 10000, ...event })); },
    sends() { return actions.filter((a) => String(a.action).startsWith('send_group')); },
    sentTexts() {
      return this.sends().map((a) => (a.params?.message || []).map((s) => s?.data?.text || '').join('')).join('\n');
    },
    async close() { adapter.disconnect(); for (const c of wss.clients) c.terminate(); await new Promise((r) => wss.close(r)); },
  };
}

function makeCfg() {
  const cfg = createDefaultConfig();
  cfg.agent.enabled = false; cfg.agent.mode = 'off'; // 旧引擎/命令路径测试（新聊天语义由 agent-r9-fixes.test.mjs 覆盖）
  cfg.bot.botQqId = '10000';
  cfg.llm.chatEnabled = true;
  cfg.bot.replyStrategies.text = 'plain';
  cfg.bot.keywordTrigger = { enabled: true, words: ['大鱼'], contextMessages: 5, windowMs: 10000, intentModel: '', intentNodeIndex: 0 };
  // 延续判断免检（本文件只测链路，不测模型判断力）
  cfg.bot.autoContinue = { enabled: true, windowMs: 60000, maxRounds: 3, cooldownMs: 5000, requireModelCheck: false };
  return cfg;
}

function makeRuntime(sim, { enforceResult, engineTexts }) {
  return createBotMessageRuntime({
    app: {
      // 旧链路入口：记录收到的文本并给出可发送的 chat 回复
      handle: async (input) => { engineTexts.push(String(input.text || '')); return { kind: 'chat', handled: true, text: '好的，已收到：' + String(input.text || '').slice(0, 20), decision: { kind: 'chat', params: {} } }; },
      engine: { async handleExplicit(kind, input) { engineTexts.push(String(input.text || '')); return { kind: 'chat', handled: true, text: '好的，已收到：' + String(input.text || '').slice(0, 20), decision: { kind: 'chat', params: {} } }; } },
      sessions: { clear() {}, get: () => [], append() {} },
      registry: () => ({}), client: {},
    },
    reply: sim.adapter,
    getConfig: () => makeCfg(),
    selfId: () => '10000', botName: 'Mio',
    reportProblem: async () => true,
    triggerIntentChecker: {
      checkKeywordIntent: async () => true, // 关键词意图恒通过（复现线上 hasIntent=true）
      checkContinueIntent: async () => true, // 延续意图恒通过（链路测试，不测模型判断力）
    },
    // 模拟线上：enforce planner 超时失败 → 回退旧链路
    enforceOrchestration: async () => enforceResult,
  });
}

async function establish(sim) {
  sim.sendEvent({ post_type: 'message', message_type: 'group', group_id: 100, user_id: 2, message_id: sim.actions.length + 1, raw_message: '[CQ:at,qq=10000] 给我讲讲黑洞', message: [{ type: 'at', data: { qq: '10000' } }, { type: 'text', data: { text: ' 给我讲讲黑洞' } }], sender: { user_id: 2, nickname: '小明' } });
  await waitUntil(() => sim.sends().length > 0, 5000, '首轮回复');
  await sleep(250);
}

test('Bug A-关键词: enforce 失败回退旧链路后，关键词消息原文进入旧链路（不再回罐头话）', async () => {
  const sim = await createSim();
  const engineTexts = [];
  const runtime = makeRuntime(sim, { enforceResult: { handled: false, reason: 'planner_failed' }, engineTexts });
  runtime.attach(sim.adapter);
  try {
    await establish(sim);
    const before = engineTexts.length;
    sim.sendEvent({ post_type: 'message', message_type: 'group', group_id: 100, user_id: 2, message_id: 90, raw_message: '大鱼今天都有什么歌', message: [{ type: 'text', data: { text: '大鱼今天都有什么歌' } }], sender: { user_id: 2, nickname: '小明' } });
    await waitUntil(() => engineTexts.length > before, 5000, '旧链路被调用');
    assert.ok(engineTexts.slice(before).some((t) => t.includes('大鱼今天都有什么歌')), `旧链路应收到关键词消息原文，实际: ${JSON.stringify(engineTexts.slice(before))}`);
    const sent = sim.sentTexts();
    assert.ok(!sent.includes('我在。直接说需求就行'), `不应回罐头话，实际发送: ${sent}`);
  } finally { await sim.close(); }
});

test('Bug A-延续: enforce 失败回退旧链路后，延续消息原文进入旧链路', async () => {
  const sim = await createSim();
  const engineTexts = [];
  const runtime = makeRuntime(sim, { enforceResult: { handled: false, reason: 'planner_failed' }, engineTexts });
  runtime.attach(sim.adapter);
  try {
    await establish(sim);
    const before = engineTexts.length;
    sim.sendEvent({ post_type: 'message', message_type: 'group', group_id: 100, user_id: 2, message_id: 91, raw_message: '按原本词重新做', message: [{ type: 'text', data: { text: '按原本词重新做' } }], sender: { user_id: 2, nickname: '小明' } });
    await waitUntil(() => engineTexts.length > before, 5000, '旧链路被调用');
    assert.ok(engineTexts.slice(before).some((t) => t.includes('按原本词重新做')), `旧链路应收到延续消息原文，实际: ${JSON.stringify(engineTexts.slice(before))}`);
  } finally { await sim.close(); }
});

test('Bug B: 罐头回复登记延续状态，紧跟着的补充消息可进入延续处理', async () => {
  const sim = await createSim();
  const engineTexts = [];
  const runtime = makeRuntime(sim, { enforceResult: { handled: true, result: null }, engineTexts });
  runtime.attach(sim.adapter);
  try {
    // 裸 @bot（无文本）→ 罐头话
    sim.sendEvent({ post_type: 'message', message_type: 'group', group_id: 100, user_id: 2, message_id: 92, raw_message: '[CQ:at,qq=10000]', message: [{ type: 'at', data: { qq: '10000' } }], sender: { user_id: 2, nickname: '小明' } });
    await waitUntil(() => sim.sentTexts().includes('我在。直接说需求就行'), 5000, '罐头话回复');
    // 紧跟着补充消息（无@）：延续状态已登记 → 进延续 → 旧链路
    sim.sendEvent({ post_type: 'message', message_type: 'group', group_id: 100, user_id: 2, message_id: 93, raw_message: '今天都生成了哪些歌', message: [{ type: 'text', data: { text: '今天都生成了哪些歌' } }], sender: { user_id: 2, nickname: '小明' } });
    await waitUntil(() => engineTexts.some((t) => t.includes('今天都生成了哪些歌')), 5000, '补充消息进旧链路');
    assert.ok(engineTexts.some((t) => t.includes('今天都生成了哪些歌')), '延续状态登记后补充消息应被处理');
  } finally { await sim.close(); }
});
