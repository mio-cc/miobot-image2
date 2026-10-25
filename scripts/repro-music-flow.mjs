// E2E 复现线上「续话/歌单」问题并验证修复（napcat WS 模拟 + live 配置 + 真实 DeepSeek + Suno 拦截）。
// 场景：
//   1. 群B 关键词"大鱼今天都有什么歌" + planner 挂起 35s(clarificationTimeoutMs=30000) → 应回退旧链路且回复非罐头话
//   2. 60s 内追问"今天都生成了哪些歌"（延续）→ 应答出全局歌单（含他群预置歌曲）
//   3. @bot 点歌 → Suno 返回双 variant → 只发 1 首 + 第二首入库为分支
//   4. 另一个用户 @bot "回放一下远方的歌" → 跨用户回放预置歌曲
//   5. "@bot 给我刚才那首歌的第二版" → audio.music.variant 发分支音频
//   6. 裸 @bot → 罐头话 → 立即补充 → 延续判断应触发并处理
//   7. 对单版预置歌要"第二版" → needs_input"只保留了一个版本"
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';

import { NapcatAdapter } from '../dist/packages/napcat/src/index.js';
import { normalizeConfig } from '../dist/packages/config/src/index.js';
import { createModelClient } from '../dist/packages/model/src/index.js';
import { createBotApp } from '../dist/apps/bot/src/app.js';
import { createBotMessageRuntime } from '../dist/apps/bot/src/main.js';
import { TriggerIntentChecker } from '../dist/apps/bot/src/trigger-intent.js';
import { OrchestrationEnforcer } from '../dist/apps/bot/src/orchestration-enforce.js';
import { SunoSongHistoryStore } from '../dist/apps/bot/src/suno-song-history.js';
import { createWebSearchService } from '../dist/packages/search/src/index.js';

const T0 = Date.now();
function ts() { return '[' + ((Date.now() - T0) / 1000).toFixed(1).padStart(6) + 's]'; }
function log(msg) { console.log(ts() + ' ' + msg); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
const results = [];
function check(name, ok, detail) { results.push({ name, ok, detail }); log((ok ? '✅ ' : '❌ ') + name + (detail ? ' — ' + detail : '')); }

// ── 配置：live 导出 + 复现覆盖 ──
const exported = JSON.parse(fs.readFileSync('C:/Users/Administrator/Downloads/miobot-config-2026-10-25T10-31-58-310Z.json', 'utf8'));
const cfg = normalizeConfig(exported);
cfg.bot.tts.enabled = false;
cfg.orchestration.planner.clarificationTimeoutMs = 30000; // 复现线上 30s 规划超时
cfg.bot.keywordTrigger.enabled = true;

// ── 历史预置：他群（群999）他用户（888）的一首单版歌（v1 旧格式，无 globalSeq，验证迁移）──
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repro-music-'));
const historyPath = path.join(dataDir, 'suno-song-history.json');
fs.writeFileSync(historyPath, JSON.stringify({ version: 1, records: [{
  id: 'song_seed_remote_1', seq: 1, scopeKey: 'group:999:888', chatType: 'group', chatId: '999', userQq: '888',
  createdAt: new Date(Date.now() - 3600e3).toISOString(), requestText: '来首远方的歌', taskId: 'task-seed-remote',
  title: '远方的歌', audioUrl: 'https://example.com/remote-song.mp3', duration: 60,
}] }), 'utf8');
const sunoHistory = new SunoSongHistoryStore({ filePath: historyPath, maxRecords: () => 100 });

// ── fetch 打点：Suno 全拦截（双 variant），DeepSeek 支持按预算挂起（确定性复现 planner 失败）──
const realFetch = globalThis.fetch;
let hangBudget = 0; // 场景1：planner 全链 = FC + maxRepairAttempts+1 次 JSON = 4 次调用，全部挂起 → 必然 planner_failed
let sunoCreateCount = 0;
const fakeTasks = new Map();
globalThis.fetch = async (url, init = {}) => {
  const u = String(url instanceof Request ? url.url : url);
  if (u.includes('sunoapi.org')) {
    if (u.includes('/generate') && (init.method || 'GET') === 'POST' && !u.includes('record-info')) {
      sunoCreateCount += 1;
      const taskId = `fake-task-${sunoCreateCount}`;
      fakeTasks.set(taskId, true);
      log(`HTTP [SUNO拦截] create → ${taskId}`);
      await sleep(200);
      return new Response(JSON.stringify({ code: 200, data: { taskId } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('record-info')) {
      const taskId = decodeURIComponent(u.split('taskId=')[1] || '');
      await sleep(300);
      const body = { code: 200, data: { taskId, status: 'SUCCESS', response: { sunoData: [
        { audio_url: `https://example.com/fake-${taskId}-A.mp3`, title: '测试歌', lyrics: '[Verse] la la la', duration: 30 },
        { audio_url: `https://example.com/fake-${taskId}-B.mp3`, title: '测试歌', lyrics: '[Verse] la la la', duration: 30 },
      ] } } };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  }
  if (false && u.includes('api.deepseek.com') && (init.method || 'GET') === 'POST' && typeof init.body === 'string' && init.body.length > 5000) {
    // 保留挂起机制备查（planner 有 FC→JSON 恢复链，字符数启发式无法确定性命中，已改用无效模型名方案）
    hangBudget -= 1;
    log(`HTTP [模拟挂起35s] POST deepseek chars=${init.body.length}（剩余预算 ${hangBudget}）`);
    await sleep(35000);
    return new Response(JSON.stringify({ error: 'simulated_blackhole' }), { status: 500 });
  }
  const started = Date.now();
  const res = await realFetch(url, init);
  if (u.includes('deepseek')) log(`HTTP POST deepseek (${init.body?.length || 0}B) → ${res.status} ${Date.now() - started}ms`);
  return res;
};

// ── 模型客户端 ──
const client = createModelClient({
  nodes: () => cfg.llm.apiKeys.map((n) => ({ name: n.name, baseUrl: n.baseUrl, apiKey: n.key, headers: n.headers, models: n.models, enabled: n.enabled, concurrency: n.concurrency })),
});
const logger = {
  info: (...a) => log('[INFO] ' + a.map((x) => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')),
  warn: (...a) => log('[WARN] ' + a.map((x) => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')),
  error: () => {},
  debug: () => {},
};

// ── napcat 模拟器 ──
const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
await once(wss, 'listening');
const simPort = wss.address().port;
const actions = [];
let peer = null;
let nextMessageId = 5000;
wss.on('connection', (socket) => {
  peer = socket;
  socket.on('message', (raw) => {
    let action; try { action = JSON.parse(String(raw)); } catch { return; }
    actions.push(action);
    socket.send(JSON.stringify({ echo: action.echo, self_id: 3557339810, status: 'ok', retcode: 0, data: { message_id: nextMessageId++ } }));
  });
});
cfg.napcat.wsUrl = 'ws://127.0.0.1:' + simPort;
const adapter = new NapcatAdapter({ wsUrl: cfg.napcat.wsUrl, token: 'sim', actionTimeoutMs: 60000, textSendTimeoutMs: 180000, imageSendTimeoutMs: 300000, fileSendTimeoutMs: 300000, forwardSendTimeoutMs: 600000, getMessageTimeoutMs: 60000, autoReconnect: false });
await new Promise((r) => { const off = adapter.on('open', () => { off(); r(); }); adapter.connect(); });

const GROUP_A = 1098867961; // 出歌的群
const GROUP_B = 709088381;  // 出问题的群
const OWNER = 2238639363;
const OTHER = 777;
const BOT = 3557339810;
const recordSends = () => actions.filter((a) => a.action === 'send_group_msg' && (a.params?.message || []).some((s) => s.type === 'record'));
const groupTexts = () => actions.filter((a) => (a.action === 'send_group_msg' || a.action === 'send_group_forward_msg') && a.params?.group_id).map((a) => JSON.stringify(a.params));
const sendGroup = (text, { group = GROUP_A, uid = OWNER, withAt = false } = {}) => {
  log(`用户${uid}@群${group} 发信 ${withAt ? '[@bot] ' : '[无@] '}${text}`);
  peer.send(JSON.stringify({
    self_id: BOT, post_type: 'message', message_type: 'group', group_id: group, user_id: uid,
    message_id: nextMessageId++, time: Math.floor(Date.now() / 1000),
    raw_message: (withAt ? `[CQ:at,qq=${BOT}] ` : '') + text,
    message: withAt ? [{ type: 'at', data: { qq: String(BOT) } }, { type: 'text', data: { text: ' ' + text } }] : [{ type: 'text', data: { text } }],
    sender: { user_id: uid, nickname: '用户' + uid, card: '用户' + uid },
  }));
};
const CANNED = '我在。直接说需求就行';

// ── 装配 ──
const searchService = createWebSearchService({ getConfig: () => cfg, logger });
const app = createBotApp({ getConfig: () => cfg, client, search: searchService, log: logger });
const oldChainTexts = [];
const rawAppHandle = app.handle.bind(app);
app.handle = async (input) => { oldChainTexts.push(String(input.text || '')); return rawAppHandle(input); };
const rawExplicit = app.engine.handleExplicit.bind(app.engine);
app.engine.handleExplicit = async (kind, input, opts) => { oldChainTexts.push(String(input?.text || '')); return rawExplicit(kind, input, opts); };
const enforcer = new OrchestrationEnforcer({
  getConfig: () => cfg, app, client, logger, sunoHistory,
  trace: (t) => { if (t.stage === 'plan' && /生成执行计划/.test(t.summary)) log('[trace] ' + t.summary + ' ' + JSON.stringify(t.data?.steps || []).slice(0, 200)); },
});
const enforcerCalls = [];
const rawEnforcerHandle = enforcer.handle.bind(enforcer);
enforcer.handle = async (input) => { enforcerCalls.push(String(input.text || '')); return rawEnforcerHandle(input); };
const runtime = createBotMessageRuntime({
  app, reply: adapter, getConfig: () => cfg,
  selfId: () => String(BOT), botName: 'Mio', logger,
  reportProblem: async () => true,
  triggerIntentChecker: new TriggerIntentChecker({ getConfig: () => cfg, client }),
  enforceOrchestration: (input) => enforcer.handle(input),
});
runtime.attach(adapter);

async function waitForText(matcher, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  const startCount = actions.length;
  while (Date.now() < deadline) {
    const hit = groupTexts().some((t) => matcher(t));
    if (hit) return true;
    await sleep(300);
  }
  void startCount;
  throw new Error('timeout: ' + label);
}

try {
  // ═══ 场景 1：群B 关键词 → enforce 必败（planner 模型名无效，快速确定性失败）→ 回退旧链路 ═══
  // 线上故障形态是"规划超时→回退"（run-3 已实证 planner_failed→回退链路完整）；
  // 这里用确定性失败复现同一回退链路，验证回退后 commandText 不丢、不回罐头话。
  const realPlannerModel = cfg.orchestration.planner.model;
  cfg.orchestration.planner.model = 'definitely-missing-model-xyz';
  cfg.orchestration.roles.planner.fallbackModel = 'definitely-missing-model-xyz'; // 主备都断，planner 必败
  sendGroup('大鱼今天都有什么歌', { group: GROUP_B });
  await waitForText((t) => t.includes(GROUP_B), 180000, '群B 收到任何回复');
  cfg.orchestration.planner.model = realPlannerModel; // 恢复，后续场景走真实 planner
  cfg.orchestration.roles.planner.fallbackModel = realPlannerModel;
  await sleep(500);
  const bTexts = actions.filter((a) => a.params?.group_id === GROUP_B).map((a) => JSON.stringify(a.params?.message || a.params?.messages || ''));
  const gotCanned = bTexts.some((t) => t.includes(CANNED));
  const oldChainGotText = oldChainTexts.some((t) => t.includes('大鱼今天都有什么歌'));
  check('场景1 关键词消息回退旧链路收到原文', oldChainGotText, `oldChainTexts=${JSON.stringify(oldChainTexts).slice(0, 200)}`);
  check('场景1 未回罐头话', !gotCanned, gotCanned ? '仍回了罐头话' : '回复为正常 chat 内容');

  // ═══ 场景 2：60s 内追问（延续）→ 全局歌单 ═══
  sendGroup('今天都生成了哪些歌', { group: GROUP_B });
  try {
    await waitForText((t) => t.includes('远方的歌'), 180000, '回复含预置的他群歌曲');
    const listText = actions.filter((a) => a.params?.group_id === GROUP_B).map((a) => JSON.stringify(a.params?.message || a.params?.messages || '')).join('');
    check('场景2 延续后答出全局歌单（含他群歌曲）', true);
    check('场景2 列表无来源群/生成者标注', !listText.includes('group:999') && !listText.includes('888'), '');
  } catch (error) {
    check('场景2 延续后答出全局歌单', false, String(error.message || error));
  }

  // ═══ 场景 3：@bot 点歌 → 双 variant → 只发 1 首 + 分支入库 ═══
  sendGroup('给我唱首歌吧', { group: GROUP_A, withAt: true });
  try {
    await waitForText((t) => t.includes('fake-task-1-A') || t.includes('fake-task-1'), 240000, 'Suno 歌曲交付');
    await sleep(500);
    const records = recordSends().filter((a) => JSON.stringify(a.params?.message || '').includes('fake-task-1'));
    check('场景3 只发送 1 条语音', records.length === 1, `record 发送 ${records.length} 条`);
    const all = sunoHistory.listGlobal(50);
    const taskRecords = all.filter((r) => r.taskId === 'fake-task-1');
    const branch = taskRecords.find((r) => r.variantIndex === 2);
    check('场景3 主版+分支都入库', taskRecords.length === 2 && branch?.variantOf, `task 记录 ${taskRecords.length} 条，branch=${Boolean(branch)}`);
  } catch (error) {
    check('场景3 点歌流程', false, String(error.message || error).slice(0, 160));
  }

  // ═══ 场景 4：另一个用户跨用户回放预置歌曲 ═══
  sendGroup('回放一下远方的歌', { group: GROUP_A, uid: OTHER, withAt: true });
  try {
    await waitForText((t) => t.includes('remote-song.mp3'), 180000, '跨用户回放发送预置歌');
    check('场景4 他人回放成功', true);
  } catch (error) {
    check('场景4 他人回放', false, String(error.message || error).slice(0, 160));
  }

  // ═══ 场景 5：取另一版（若 planner 追问澄清，补充歌名后重试——复用追问合并链路）═══
  sendGroup('给我刚才那首歌的第二版', { group: GROUP_A, withAt: true });
  try {
    await waitForText((t) => t.includes('fake-task-1-B'), 150000, 'B 版音频发送（首次）');
    check('场景5 audio.music.variant 发送 B 版', true);
  } catch {
    log('场景5 首次未命中，可能 planner 追问澄清——补充歌名重试');
    sendGroup('就是「测试歌」，要它的第二版', { group: GROUP_A, withAt: true });
    try {
      await waitForText((t) => t.includes('fake-task-1-B'), 150000, 'B 版音频发送（澄清后重试）');
      check('场景5 audio.music.variant 发送 B 版（澄清合并后）', true);
    } catch (error) {
      check('场景5 取另一版', false, String(error.message || error).slice(0, 160));
    }
  }

  // ═══ 场景 6：裸 @bot → 罐头话 → 立即补充 → 延续处理（换用户避免场景5追问会话干扰）═══
  sendGroup('', { group: GROUP_A, uid: OTHER, withAt: true });
  try {
    await waitForText((t) => t.includes(CANNED), 60000, '罐头话');
    const deadline = Date.now() + 120000;
    sendGroup('今天几号', { group: GROUP_A, uid: OTHER });
    const deadline2 = Date.now() + 120000;
    let handled = false;
    while (Date.now() < deadline2) {
      if (enforcerCalls.some((t) => t.includes('今天几号')) || oldChainTexts.some((t) => t.includes('今天几号'))) { handled = true; break; }
      await sleep(300);
    }
    check('场景6 罐头话后补充消息进入延续处理', handled, `enforcer=${JSON.stringify(enforcerCalls.slice(-2))}`);
    void deadline;
  } catch (error) {
    check('场景6 裸@延续', false, String(error.message || error).slice(0, 160));
  }

  // ═══ 场景 7：单版预置歌要第二版 → needs_input 提示 ═══
  sendGroup('远方的歌的第二版', { group: GROUP_A, withAt: true });
  try {
    await waitForText((t) => t.includes('只保留了一个版本'), 180000, '单版提示');
    check('场景7 单版歌提示无另一版', true);
  } catch (error) {
    check('场景7 单版歌提示', false, String(error.message || error).slice(0, 160));
  }
} finally {
  adapter.disconnect();
  for (const c of wss.clients) c.terminate();
  await new Promise((r) => wss.close(r));
}

log('\n════ 复现结果汇总 ════');
let pass = 0;
for (const r of results) { log(`${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`); if (r.ok) pass += 1; }
log(`共 ${results.length} 项，通过 ${pass}，失败 ${results.length - pass}`);
fs.rmSync(dataDir, { recursive: true, force: true });
process.exit(pass === results.length ? 0 : 1);
