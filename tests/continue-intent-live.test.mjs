// 延续（autoContinue）判断 live 测试：
//   L1 直判 —— 真实模型跑 TriggerIntentChecker.checkContinueIntent 的模糊/极端用例集，
//              对照「生产现状(maxTokens=50)」与「修正 token 预算(50→400)」两种口径，
//              区分「模型判断错」与「token 截断导致 JSON 没输出被 fail-closed 误杀」。
//   L2 E2E —— 模拟 napcat WebSocket + QQ 群用户发信，走完整 runtime 链路：
//              真实模型延续判断（正向/负向/生产现状）+ 窗口过期/轮数上限/冷却/用户与群隔离/
//              @bot 优先/私聊不延续/模型输出不可解析/模型异常/requireModelCheck=false/关键词触发落回延续。
// 依赖 .runtime/config.json 里的 DeepSeek 节点（deepseek-flash）；节点不可用时 live 用例自动跳过，
// 链路（scripted）用例不依赖网络照常运行。报告落盘 .runtime/live-continue-intent-report.json。
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import { NapcatAdapter } from '../dist/packages/napcat/src/index.js';
import { createBotMessageRuntime } from '../dist/apps/bot/src/main.js';
import { createDefaultConfig } from '../dist/packages/config/src/index.js';
import { TriggerIntentChecker } from '../dist/apps/bot/src/trigger-intent.js';
import { createModelClient } from '../dist/packages/model/src/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPORT_PATH = path.join(ROOT, '.runtime', 'live-continue-intent-report.json');
const MODEL = 'deepseek-flash';

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function waitUntil(predicate, timeoutMs = 6000, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(20);
  }
  throw new Error('timeout waiting for ' + label);
}

// ════════ live 节点探测（.runtime/config.json 的 DeepSeek 节点） ════════

function loadLiveNode() {
  try {
    const live = JSON.parse(fs.readFileSync(path.join(ROOT, '.runtime', 'config.json'), 'utf8'));
    const nodes = Array.isArray(live.llm?.apiKeys) ? live.llm.apiKeys : [];
    return nodes.find((n) => /deepseek/i.test(String(n.baseUrl || '')) && (n.models || []).includes(MODEL)) || null;
  } catch { return null; }
}

let liveProbePromise;
function liveAvailable() {
  if (!liveProbePromise) {
    liveProbePromise = (async () => {
      const node = loadLiveNode();
      if (!node) return null;
      try {
        const ctl = new AbortController();
        setTimeout(() => ctl.abort(), 8000);
        const res = await fetch(String(node.baseUrl).replace(/\/+$/, '') + '/chat/completions', {
          method: 'POST', signal: ctl.signal,
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + node.key },
          body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'ok' }], max_tokens: 8 }),
        });
        return res.ok ? node : null;
      } catch { return null; }
    })();
  }
  return liveProbePromise;
}

// ════════ 配置与 client ════════

function makeCfg(node) {
  const cfg = createDefaultConfig();
  cfg.agent.enabled = false; cfg.agent.mode = 'off'; // 旧引擎/命令路径测试（新聊天语义由 agent-r9-fixes.test.mjs 覆盖）
  cfg.bot.botQqId = '10000';
  cfg.bot.ownerQQs = ['1'];
  cfg.llm.chatEnabled = true;
  cfg.bot.replyStrategies.text = 'plain';
  // R15/#8：模板/超时来自默认配置；这里只覆盖行为开关，不整体替换对象。
  cfg.bot.autoContinue = { ...cfg.bot.autoContinue, enabled: true, windowMs: 60000, maxRounds: 3, cooldownMs: 5000, requireModelCheck: true };
  if (node) {
    cfg.llm.apiKeys = [{ name: node.name, baseUrl: node.baseUrl, key: node.key, enabled: true, models: node.models, modelsFetchedAt: '', concurrency: 0 }];
    cfg.llm.chatNodeIndex = 0;
    cfg.llm.chatModel = MODEL;
  }
  return cfg;
}

function makeClient(node) {
  return createModelClient({
    nodes: () => [{ name: node.name, baseUrl: node.baseUrl, apiKey: node.key, models: node.models, enabled: true, concurrency: 0 }],
  });
}

// 生产 checker 曾硬编码 maxTokens:50，推理模型思维链会把它耗尽 → JSON 截断 → fail-closed 误杀
// （已修复为 400，见 trigger-intent.ts）。这里包一层记录实际 maxTokens 并按需抬到 budget，
// prompt/temperature/timeout/解析逻辑保持生产原样，用来单独测「模型判断力」。
function withTokenBudget(client, budget) {
  return {
    chat: async (nodeIndex, req) => {
      lastObservedMaxTokens = req.maxTokens;
      return client.chat(nodeIndex, req.maxTokens === 50 ? { ...req, maxTokens: budget } : req);
    },
  };
}
let lastObservedMaxTokens;

// ════════ L1 用例集：模糊意图 + 极端角度 ════════

const S1 = '已为你生成了一张赛博朋克风格的猫咪图片～还需要调整吗？';
const S2 = '《三体》的作者是刘慈欣，黑暗森林是第二部。还有什么想问的吗？';
const S3 = '原神里零命最强主C目前普遍认为是那维莱特，但具体要看阵容搭配～';
const LONG_MIXED = '这图整体来说还挺不错的，不过我感觉光线有点暗了，你能不能重新调一下，另外@张三 你也来看看这张图，大家觉得怎么样，我个人是觉得色调偏冷了点，当然这只是我的一家之言，每个人审美不一样嘛，反正我个人更喜欢暖色调的，不知道大家怎么看，欢迎讨论哈，另外说一句这猫的姿势还挺妖娆的，跟真的一样，细节很到位，就是背景有点抢戏了，主体不够突出，建议下次构图的时候注意一下主次关系，谢谢啦';

// exp: true=应延续(用户在跟bot说话) / false=不应延续(在跟群里说话) / 'O'=人类判断本身分裂，仅观察不计分
const CASES = [
  // ── 场景1：bot 刚生成了图片 ──
  { s: S1, tag: '图片', t: '再粉嫩一点', exp: true, note: '无主语的调整指令，默认承接bot' },
  { s: S1, tag: '图片', t: '把背景改成蓝色', exp: true, note: '明确调整指令' },
  { s: S1, tag: '图片', t: '？', exp: true, note: '极端短：回应bot「还需要调整吗」' },
  { s: S1, tag: '图片', t: '嗯嗯就是这个感觉，不用改了', exp: true, note: '确认+收尾' },
  { s: S1, tag: '图片', t: '那换成狗吧', exp: true, note: '话题内切换主体' },
  { s: S1, tag: '图片', t: '这猫画得还不如我家的猫好笑', exp: true, note: '吐槽bot作品，仍是对bot说' },
  { s: S1, tag: '图片', t: '兄弟们晚上吃鸡吗', exp: false, note: '对群里喊话' },
  { s: S1, tag: '图片', t: '有人知道明天考试范围吗', exp: false, note: '问群友' },
  { s: S1, tag: '图片', t: '@张三 昨天那个链接发我下', exp: false, note: '明确@别人' },
  { s: S1, tag: '图片', t: '哈哈哈哈笑死我了', exp: false, note: '对别人发的梗的反应' },
  { s: S1, tag: '图片', t: '刚吃完饭回来', exp: false, note: '群闲聊报备' },
  { s: S1, tag: '图片', t: '😅😅😅', exp: 'O', note: '极端：纯表情，对象不明' },
  { s: S1, tag: '图片', t: '666', exp: 'O', note: '网络用语，可能夸bot的图' },
  // ── 场景2：bot 刚回答了读书问题 ──
  { s: S2, tag: '读书', t: '那第三部叫什么', exp: true, note: '同话题追问' },
  { s: S2, tag: '读书', t: '谢谢你，讲得很清楚', exp: true, note: '对bot致谢' },
  { s: S2, tag: '读书', t: '帮我把它翻译成英文：今晚吃火锅', exp: true, note: '换任务但方向是bot' },
  { s: S2, tag: '读书', t: '谁看过这本书举个手', exp: false, note: '对群里做调查' },
  { s: S2, tag: '读书', t: '我也超喜欢这本书', exp: 'O', note: '话题延续但对象可能换人' },
  { s: S2, tag: '读书', t: '她刚才说什么了', exp: 'O', note: '「她」指代不明（bot/群友）' },
  // ── 场景3：bot 刚回答了游戏问题 ──
  { s: S3, tag: '游戏', t: '那他的专武叫什么', exp: true, note: '同话题追问' },
  { s: S3, tag: '游戏', t: '那满命呢', exp: 'O', note: '极端省略，人类大概率判延续但很模糊' },
  { s: S3, tag: '游戏', t: '主播今天几点开播', exp: false, note: '对群里别的主播说' },
  { s: S3, tag: '游戏', t: '网管这把怎么又输了', exp: false, note: '对一起打游戏的群友抱怨' },
  { s: S1, tag: '图片', t: '不要了谢谢', exp: true, note: '结束对话，仍是对bot说' },
  { s: S1, tag: '图片', t: '还在吗', exp: 'O', note: '极端短，找bot确认' },
  { s: S1, tag: '图片', t: LONG_MIXED, exp: 'O', note: '极端：半对bot半对群的长混排' },
  { s: S3, tag: '游戏', t: '你说呢', exp: 'O', note: '反问bot观点，也可能是群内反问' },
];

function scored(cases) { return cases.filter((c) => c.exp === true || c.exp === false); }

const report = { generatedAt: new Date().toISOString(), model: MODEL, layer1: {}, layer2: [] };
function note2(name, detail) { report.layer2.push({ name, ...detail }); }

// ════════ L1：直判（真实模型） ════════

test('L1-生产现状: checker 原样跑全部用例，统计 JSON 截断/误杀', async (t) => {
  const node = await liveAvailable();
  if (!node) return t.skip('DeepSeek live 节点不可用');
  const cfg = makeCfg(node);
  const client = makeClient(node);
  const traces = [];
  const observedTokens = [];
  const wrapped = { chat: async (ni, req) => { observedTokens.push(req.maxTokens); return client.chat(ni, req); } };
  const checker = new TriggerIntentChecker({ getConfig: () => cfg, client: wrapped, trace: (x) => traces.push(x) });
  const results = [];
  for (const c of CASES) {
    const t0 = Date.now();
    try {
      const verdict = await checker.checkContinueIntent({ userText: c.t, userName: '小明', botLastReply: c.s });
      results.push({ ...c, verdict, ms: Date.now() - t0 });
    } catch (error) {
      results.push({ ...c, verdict: null, error: String(error?.message || error), ms: Date.now() - t0 });
    }
  }
  assert.equal(traces.length, results.length, '每次判断应有对应 trace');
  results.forEach((r, i) => { r.parsed = traces[i]?.data?.parsed; });
  // fail-closed 语义：解析不出 JSON 一律按 false 处理（延续被打断）。
  for (const r of results) {
    if (r.parsed === 'unparseable') {
      assert.equal(r.verdict, false, `用例「${r.t.slice(0, 20)}」解析失败应 fail-closed 为 false`);
    }
  }
  const sc = scored(results);
  const trunc = results.filter((r) => r.parsed === 'unparseable');
  const correct = sc.filter((r) => r.verdict === r.exp).length;
  const observed = observedTokens.length ? observedTokens[0] : lastObservedMaxTokens;
  report.layer1.asIs = {
    maxTokens: observed, results,
    stats: { scored: sc.length, correct, accuracy: correct / sc.length, unparseable: trunc.length, unparseableAll: results.length },
  };
  console.log(`── L1 生产现状(checker 原样, maxTokens=${observed}) ──`);
  console.log(`计分 ${sc.length} 例，判对 ${correct}（${(correct / sc.length * 100).toFixed(0)}%）；JSON 未输出被截断 ${trunc.length}/${results.length} 例（全部 fail-closed 成 false）`);
});

test('L1-判断力: 修正 token 预算(50→400)后，模型对模糊/极端用例的真实判断力', async (t) => {
  const node = await liveAvailable();
  if (!node) return t.skip('DeepSeek live 节点不可用');
  const cfg = makeCfg(node);
  const checker = new TriggerIntentChecker({ getConfig: () => cfg, client: withTokenBudget(makeClient(node), 400) });
  const queue = [...CASES];
  const results = [];
  const worker = async () => {
    for (;;) {
      const c = queue.shift();
      if (!c) return;
      const t0 = Date.now();
      try {
        const verdict = await checker.checkContinueIntent({ userText: c.t, userName: '小明', botLastReply: c.s });
        results.push({ ...c, verdict, ms: Date.now() - t0 });
      } catch (error) {
        results.push({ ...c, verdict: null, error: String(error?.message || error), ms: Date.now() - t0 });
      }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  const sc = scored(results).filter((r) => typeof r.verdict === 'boolean');
  const pos = sc.filter((r) => r.exp === true);
  const neg = sc.filter((r) => r.exp === false);
  const correct = sc.filter((r) => r.verdict === r.exp);
  const posOk = pos.filter((r) => r.verdict === true).length;
  const negOk = neg.filter((r) => r.verdict === false).length;
  const mismatches = sc.filter((r) => r.verdict !== r.exp).map((r) => `「${r.t.slice(0, 18)}」期望${r.exp}实判${r.verdict}`);
  report.layer1.patched = {
    maxTokens: 400, results,
    stats: {
      scored: sc.length, correct: correct.length, accuracy: correct.length / sc.length,
      positive: `${posOk}/${pos.length}`, negative: `${negOk}/${neg.length}`,
      observation: results.filter((r) => r.exp === 'O').map((r) => ({ t: r.t.slice(0, 24), verdict: r.verdict })),
    },
  };
  console.log('── L1 判断力(修正 maxTokens=400) ──');
  console.log(`计分 ${sc.length} 例，判对 ${correct.length}（${(correct.length / sc.length * 100).toFixed(0)}%）｜应延续命中 ${posOk}/${pos.length}，不应延续命中 ${negOk}/${neg.length}`);
  for (const r of results.filter((r) => r.exp === 'O')) console.log(`  [观察] ${r.t.slice(0, 22)} → ${r.verdict}`);
  assert.ok(correct.length / sc.length >= 0.7, `判断准确率 ${(correct.length / sc.length * 100).toFixed(0)}% 低于 70% 阈值；误判：${mismatches.join('；')}`);
});

// ════════ L2：napcat E2E ════════

async function createSim() {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(wss, 'listening');
  const port = wss.address().port;
  const actions = [];
  let peer = null;
  let nextMessageId = 3000;
  let evtId = 1;
  wss.on('connection', (socket) => {
    peer = socket;
    socket.on('message', (raw) => {
      let action;
      try { action = JSON.parse(String(raw)); } catch { return; }
      actions.push(action);
      socket.send(JSON.stringify({ echo: action.echo, self_id: 10000, status: 'ok', retcode: 0, data: { message_id: nextMessageId++ } }));
    });
  });
  const adapter = new NapcatAdapter({ wsUrl: 'ws://127.0.0.1:' + port, token: 'sim', actionTimeoutMs: 3000, textSendTimeoutMs: 3000, forwardSendTimeoutMs: 3000, autoReconnect: false });
  const opened = new Promise((r) => { const off = adapter.on('open', () => { off(); r(); }); });
  adapter.connect();
  await opened;
  return {
    adapter, actions, nextId: () => evtId++,
    get peer() { return peer; },
    sendEvent(event) { peer.send(JSON.stringify({ self_id: 10000, ...event })); },
    async close() { adapter.disconnect(); for (const c of wss.clients) c.terminate(); await new Promise((r) => wss.close(r)); },
  };
}

function scriptedChecker({ keywordVerdict = false, contVerdict = true } = {}) {
  const calls = { keyword: [], cont: [] };
  return {
    calls,
    async checkKeywordIntent(input) { calls.keyword.push(input); return keywordVerdict; },
    async checkContinueIntent(input) { calls.cont.push(input); return contVerdict; },
  };
}

// 建立「bot 刚回复过该用户」的延续状态，并提供发后续消息的快捷方法。
async function setupE2E({ cfg, checker, groupId = 100, userId = 2 }) {
  const sim = await createSim();
  let replyCount = 0;
  const app = {
    handle: async () => {
      replyCount += 1;
      return { kind: 'chat', handled: true, text: replyCount === 1 ? S1 : '已经按你的要求调整好啦～', decision: { kind: 'chat', params: {} } };
    },
    engine: { async handleExplicit() { return null; } },
    sessions: { clear() {}, get: () => [], append() {} },
    registry: () => ({}), client: {},
  };
  const runtime = createBotMessageRuntime({
    app, reply: sim.adapter, getConfig: () => cfg,
    selfId: () => '10000', botName: 'Mio', reportProblem: async () => true,
    triggerIntentChecker: checker,
  });
  runtime.attach(sim.adapter);
  const sends = () => sim.actions.filter((a) => a.action === 'send_group_msg').length;
  const establish = async (text = '给我讲讲黑洞是什么', uid = userId) => {
    sim.sendEvent({ post_type: 'message', message_type: 'group', group_id: groupId, user_id: uid, message_id: sim.nextId(), raw_message: '[CQ:at,qq=10000] ' + text, message: [{ type: 'at', data: { qq: '10000' } }, { type: 'text', data: { text: ' ' + text } }] });
    await waitUntil(() => sends() > 0, 6000, '首轮回复');
    // 延续状态在回复发送完成后才写入，等它落稳再发后续消息，避免竞态。
    await sleep(250);
  };
  const followUp = (text, { uid = userId, group = groupId, withAt = false } = {}) => {
    sim.sendEvent({
      post_type: 'message', message_type: 'group', group_id: group, user_id: uid, message_id: sim.nextId(),
      raw_message: (withAt ? '[CQ:at,qq=10000] ' : '') + text,
      message: withAt
        ? [{ type: 'at', data: { qq: '10000' } }, { type: 'text', data: { text: ' ' + text } }]
        : [{ type: 'text', data: { text } }],
    });
  };
  return { sim, sends, establish, followUp };
}

// ── 真实模型 E2E ──

test('L2E-真实现状: 模糊正向消息走完整 napcat 链路（checker 原样）', async (t) => {
  const node = await liveAvailable();
  if (!node) return t.skip('DeepSeek live 节点不可用');
  const cfg = makeCfg(node);
  const traces = [];
  const checker = new TriggerIntentChecker({ getConfig: () => cfg, client: makeClient(node), trace: (x) => traces.push(x) });
  const e2e = await setupE2E({ cfg, checker });
  try {
    await e2e.establish();
    e2e.followUp('再粉嫩一点');
    await waitUntil(() => traces.some((x) => x.data?.type === 'continue_intent'), 12000, '延续判断完成');
    const parsed = traces.find((x) => x.data?.type === 'continue_intent')?.data?.parsed;
    const target = parsed === 'true' ? 2 : 1;
    await waitUntil(() => e2e.sends() === target, 4000, `回复数=${target}`);
    note2('真实现状-模糊正向', { parsed, sends: e2e.sends(), truncated: parsed === 'unparseable' });
    // 链路一致性：判 true 才第二条回复，判 false/unparseable 保持沉默——与模型裁定一致即通过。
    assert.ok(e2e.sends() === target, `解析=${parsed} 时应发送 ${target} 条，实际 ${e2e.sends()}`);
  } finally { await e2e.sim.close(); }
});

test('L2E-真实正向: 修正 token 预算后「把背景改成蓝色」应被判定延续并回复', async (t) => {
  const node = await liveAvailable();
  if (!node) return t.skip('DeepSeek live 节点不可用');
  const cfg = makeCfg(node);
  const traces = [];
  const checker = new TriggerIntentChecker({ getConfig: () => cfg, client: withTokenBudget(makeClient(node), 400), trace: (x) => traces.push(x) });
  const e2e = await setupE2E({ cfg, checker });
  try {
    await e2e.establish();
    e2e.followUp('把背景改成蓝色');
    await waitUntil(() => e2e.sends() === 2, 15000, '延续回复');
    const parsed = traces.find((x) => x.data?.type === 'continue_intent')?.data?.parsed;
    const contCalls = traces.filter((x) => x.data?.type === 'continue_intent');
    assert.equal(contCalls.length, 1, '延续判断应恰好调用一次');
    assert.equal(parsed, 'true', `模型应判延续，实际解析=${parsed}`);
    note2('真实正向-调整指令', { parsed, sends: e2e.sends() });
  } finally { await e2e.sim.close(); }
});

test('L2E-真实负向: 「兄弟们晚上吃鸡吗」应判不延续且bot保持沉默', async (t) => {
  const node = await liveAvailable();
  if (!node) return t.skip('DeepSeek live 节点不可用');
  const cfg = makeCfg(node);
  const traces = [];
  const checker = new TriggerIntentChecker({ getConfig: () => cfg, client: withTokenBudget(makeClient(node), 400), trace: (x) => traces.push(x) });
  const e2e = await setupE2E({ cfg, checker });
  try {
    await e2e.establish();
    e2e.followUp('兄弟们晚上吃鸡吗');
    await waitUntil(() => traces.some((x) => x.data?.type === 'continue_intent'), 12000, '延续判断完成');
    await sleep(600);
    const parsed = traces.find((x) => x.data?.type === 'continue_intent')?.data?.parsed;
    note2('真实负向-群内喊话', { parsed, sends: e2e.sends() });
    assert.equal(parsed, 'false', `模型应判不延续，实际解析=${parsed}`);
    assert.equal(e2e.sends(), 1, '判不延续时 bot 不应再发消息');
  } finally { await e2e.sim.close(); }
});

// ── 链路机制（scripted checker，不依赖网络） ──

test('L2E-窗口过期: 超过 windowMs(10s) 后消息不再触发延续判断', async () => {
  const cfg = makeCfg(null);
  cfg.bot.autoContinue.windowMs = 10000; // runtime 下限即 10s
  const checker = scriptedChecker({ contVerdict: true });
  const e2e = await setupE2E({ cfg, checker });
  try {
    await e2e.establish();
    await sleep(10500);
    e2e.followUp('再粉嫩一点');
    await sleep(500);
    note2('窗口过期', { checkCalls: checker.calls.cont.length, sends: e2e.sends() });
    assert.equal(checker.calls.cont.length, 0, '窗口过期后不应调用延续判断');
    assert.equal(e2e.sends(), 1, '窗口过期后 bot 不应回复');
  } finally { await e2e.sim.close(); }
});

test('L2E-轮数上限: maxRounds=1，第二次延续请求被拒且不再调模型', async () => {
  const cfg = makeCfg(null);
  cfg.bot.autoContinue.maxRounds = 1;
  const checker = scriptedChecker({ contVerdict: true });
  const e2e = await setupE2E({ cfg, checker });
  try {
    await e2e.establish();
    e2e.followUp('再粉嫩一点'); // 第 1 轮延续
    await waitUntil(() => e2e.sends() === 2, 4000, '第 1 轮延续回复');
    await sleep(250);
    e2e.followUp('再粉嫩一点'); // 轮数已满
    await sleep(500);
    note2('轮数上限', { checkCalls: checker.calls.cont.length, sends: e2e.sends() });
    assert.equal(checker.calls.cont.length, 1, '轮数满后不应再调用延续判断');
    assert.equal(e2e.sends(), 2, '轮数满后不应有第三条回复');
  } finally { await e2e.sim.close(); }
});

test('L2E-冷却: cooldown(5s) 内的第二条消息被静默跳过，冷却过后恢复', async () => {
  const cfg = makeCfg(null);
  // R15/#8：模板/超时来自默认配置；这里只覆盖行为开关，不整体替换对象。
  cfg.bot.autoContinue = { ...cfg.bot.autoContinue, enabled: true, windowMs: 60000, maxRounds: 3, cooldownMs: 5000, requireModelCheck: true };
  const checker = scriptedChecker({ contVerdict: true });
  const e2e = await setupE2E({ cfg, checker });
  try {
    await e2e.establish();
    e2e.followUp('再粉嫩一点'); // 触发延续 → 冷却开始
    await waitUntil(() => e2e.sends() === 2, 4000, '第 1 轮延续回复');
    await sleep(250);
    e2e.followUp('再粉嫩一点'); // 冷却期内 → 应被跳过且不调模型
    await sleep(500);
    assert.equal(checker.calls.cont.length, 1, '冷却期内不应调用延续判断');
    assert.equal(e2e.sends(), 2, '冷却期内不应回复');
    await sleep(5200);
    e2e.followUp('再粉嫩一点'); // 冷却结束 → 恢复
    await waitUntil(() => e2e.sends() === 3, 4000, '冷却结束后的延续回复');
    note2('冷却', { checkCalls: checker.calls.cont.length, sends: e2e.sends() });
    assert.equal(checker.calls.cont.length, 2, '冷却结束后恢复判断');
  } finally { await e2e.sim.close(); }
});

test('L2E-用户隔离: bot 回复过A，B 的消息不触发延续', async () => {
  const cfg = makeCfg(null);
  const checker = scriptedChecker({ contVerdict: true });
  const e2e = await setupE2E({ cfg, checker });
  try {
    await e2e.establish('给我讲讲黑洞是什么', 2);
    e2e.followUp('再粉嫩一点', { uid: 7 });
    await sleep(500);
    note2('用户隔离', { checkCalls: checker.calls.cont.length, sends: e2e.sends() });
    assert.equal(checker.calls.cont.length, 0, '其他用户的消息不应触发A的延续判断');
    assert.equal(e2e.sends(), 1, 'bot 不应回复其他用户');
  } finally { await e2e.sim.close(); }
});

test('L2E-群隔离: 同一用户在另一个群发消息不触发延续', async () => {
  const cfg = makeCfg(null);
  const checker = scriptedChecker({ contVerdict: true });
  const e2e = await setupE2E({ cfg, checker });
  try {
    await e2e.establish();
    e2e.followUp('再粉嫩一点', { group: 200 });
    await sleep(500);
    note2('群隔离', { checkCalls: checker.calls.cont.length, sends: e2e.sends() });
    assert.equal(checker.calls.cont.length, 0, '另一个群的消息不应触发本群延续判断');
    assert.equal(e2e.sends(), 1, 'bot 不应跨群回复');
  } finally { await e2e.sim.close(); }
});

test('L2E-@bot优先: 后续消息带@bot走 mention 触发，不进延续分支', async () => {
  const cfg = makeCfg(null);
  const checker = scriptedChecker({ contVerdict: true });
  const e2e = await setupE2E({ cfg, checker });
  try {
    await e2e.establish();
    e2e.followUp('再给我讲个好听的段子', { withAt: true });
    await waitUntil(() => e2e.sends() === 2, 4000, 'mention 触发回复');
    note2('@bot优先', { checkCalls: checker.calls.cont.length, sends: e2e.sends() });
    assert.equal(checker.calls.cont.length, 0, '@bot 消息不应走延续判断');
    assert.equal(e2e.sends(), 2, 'mention 触发应正常回复');
  } finally { await e2e.sim.close(); }
});

test('L2E-私聊不延续: 同一用户私聊消息直接进chat，不触发延续判断', async () => {
  const cfg = makeCfg(null);
  const checker = scriptedChecker({ contVerdict: true });
  const e2e = await setupE2E({ cfg, checker });
  try {
    await e2e.establish();
    e2e.sim.sendEvent({ post_type: 'message', message_type: 'private', user_id: 2, message_id: e2e.sim.nextId(), raw_message: '私聊里继续聊', message: [{ type: 'text', data: { text: '私聊里继续聊' } }] });
    await waitUntil(() => e2e.sim.actions.some((a) => a.action === 'send_private_msg'), 4000, '私聊回复');
    note2('私聊不延续', { checkCalls: checker.calls.cont.length, privateReply: true });
    assert.equal(checker.calls.cont.length, 0, '私聊消息不应走延续判断');
    assert.ok(e2e.sim.actions.some((a) => a.action === 'send_private_msg'), '私聊消息应正常回复');
  } finally { await e2e.sim.close(); }
});

test('L2E-输出不可解析: 模型回废话无JSON → fail-closed 不延续', async () => {
  const cfg = makeCfg(null);
  const client = { chat: async () => ({ text: '嗯我觉得用户应该还是在跟机器人说话的吧，毕竟他刚问完' }) };
  const checker = new TriggerIntentChecker({ getConfig: () => cfg, client });
  const e2e = await setupE2E({ cfg, checker });
  try {
    await e2e.establish();
    e2e.followUp('再粉嫩一点');
    await sleep(800);
    note2('输出不可解析', { sends: e2e.sends() });
    assert.equal(e2e.sends(), 1, '模型输出不可解析时应 fail-closed 不延续');
  } finally { await e2e.sim.close(); }
});

test('L2E-模型异常: chat 调用抛错 → 不延续，不崩', async () => {
  const cfg = makeCfg(null);
  const client = { chat: async () => { throw new Error('model down'); } };
  const checker = new TriggerIntentChecker({ getConfig: () => cfg, client });
  const e2e = await setupE2E({ cfg, checker });
  try {
    await e2e.establish();
    e2e.followUp('再粉嫩一点');
    await sleep(800);
    note2('模型异常', { sends: e2e.sends() });
    assert.equal(e2e.sends(), 1, '模型异常时应静默不延续');
  } finally { await e2e.sim.close(); }
});

test('L2E-免检模式: requireModelCheck=false 时不调模型直接延续', async () => {
  const cfg = makeCfg(null);
  cfg.bot.autoContinue.requireModelCheck = false;
  const clientCalls = [];
  const client = { chat: async (ni, req) => { clientCalls.push(req); throw new Error('不应调用模型'); } };
  const checker = new TriggerIntentChecker({ getConfig: () => cfg, client });
  const e2e = await setupE2E({ cfg, checker });
  try {
    await e2e.establish();
    e2e.followUp('再粉嫩一点');
    await waitUntil(() => e2e.sends() === 2, 4000, '免检延续回复');
    note2('免检模式', { clientCalls: clientCalls.length, sends: e2e.sends() });
    assert.equal(clientCalls.length, 0, 'requireModelCheck=false 不应调用模型');
    assert.equal(e2e.sends(), 2, '免检模式下窗口内应直接延续');
  } finally { await e2e.sim.close(); }
});

test('L2E-关键词落回延续: 触发词命中但意图判否 → 仍可走延续', async () => {
  const cfg = makeCfg(null);
  cfg.bot.keywordTrigger = { enabled: true, words: ['小喵'], contextMessages: 5, windowMs: 10000, intentModel: '', intentNodeIndex: 0 };
  const checker = scriptedChecker({ keywordVerdict: false, contVerdict: true });
  const e2e = await setupE2E({ cfg, checker });
  try {
    await e2e.establish();
    e2e.followUp('小喵帮我翻译一下晚安');
    await waitUntil(() => e2e.sends() === 2, 4000, '延续回复');
    note2('关键词落回延续', { kwCalls: checker.calls.keyword.length, contCalls: checker.calls.cont.length, sends: e2e.sends() });
    assert.equal(checker.calls.keyword.length, 1, '触发词命中应调用关键词意图判断');
    assert.equal(checker.calls.cont.length, 1, '关键词判否后应落回延续判断');
    assert.equal(e2e.sends(), 2, '延续通过后应回复');
  } finally { await e2e.sim.close(); }
});

// ════════ 汇总报告 ════════

test('汇总: 落盘报告并打印结论', () => {
  report.summary = {
    asIs: report.layer1.asIs?.stats || null,
    patched: report.layer1.patched?.stats || null,
    layer2: report.layer2,
  };
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log('════ 延续判断 live 测试汇总 ════');
  if (report.layer1.asIs) {
    const s = report.layer1.asIs.stats;
    console.log(`生产现状(checker原样, maxTokens=${report.layer1.asIs.maxTokens}): 计分${s.scored}判对${s.correct}(${(s.accuracy * 100).toFixed(0)}%)，JSON截断${s.unparseable}/${s.unparseableAll}`);
  } else console.log('生产现状: live 节点不可用，未测');
  if (report.layer1.patched) {
    const s = report.layer1.patched.stats;
    console.log(`判断力(修正口径): 计分${s.scored}判对${s.correct}(${(s.accuracy * 100).toFixed(0)}%)｜应延续${s.positive}｜不应延续${s.negative}`);
  } else console.log('判断力: live 节点不可用，未测');
  console.log(`E2E 链路: ${report.layer2.map((x) => `${x.name}=${JSON.stringify({ ...x, name: undefined })}`).join('；') || '无'}`);
  console.log(`报告已写入: ${REPORT_PATH}`);
});
