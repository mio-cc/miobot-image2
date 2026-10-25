// 全流程计时报告（真实模型 + napcat 模拟）：
//   跑三类典型消息（@bot chat / 延续追问 / 关键词触发），收集 runtime 的
//   「消息处理耗时」阶段日志，输出每步骤耗时表；
//   同时验证节点延迟被动采集（node-latency.json）落盘。
// 用法：node scripts/sim-timing-report.mjs（依赖 C:/Users/Administrator/Downloads 的 live 配置导出 + DeepSeek 节点）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
import { NodeLatencyRecorder, wrapClientWithLatency } from '../dist/apps/bot/src/node-latency.js';
import { createWebSearchService } from '../dist/packages/search/src/index.js';

const T0 = Date.now();
function ts() { return '[' + ((Date.now() - T0) / 1000).toFixed(1).padStart(6) + 's]'; }
function log(msg) { console.log(ts() + ' ' + msg); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

const exported = JSON.parse(fs.readFileSync('C:/Users/Administrator/Downloads/miobot-config-2026-10-25T10-31-58-310Z.json', 'utf8'));
const cfg = normalizeConfig(exported);
cfg.bot.tts.enabled = false;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'timing-report-'));

// ── napcat 模拟器 ──
const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
await once(wss, 'listening');
let peer = null;
let nextMessageId = 1;
wss.on('connection', (socket) => {
  peer = socket;
  socket.on('message', (raw) => {
    let action; try { action = JSON.parse(String(raw)); } catch { return; }
    socket.send(JSON.stringify({ echo: action.echo, self_id: 3557339810, status: 'ok', retcode: 0, data: { message_id: nextMessageId++ } }));
  });
});
cfg.napcat.wsUrl = 'ws://127.0.0.1:' + wss.address().port;
const adapter = new NapcatAdapter({ wsUrl: cfg.napcat.wsUrl, token: 'sim', actionTimeoutMs: 60000, textSendTimeoutMs: 180000, imageSendTimeoutMs: 300000, fileSendTimeoutMs: 300000, forwardSendTimeoutMs: 600000, getMessageTimeoutMs: 60000, autoReconnect: false });
await new Promise((r) => { const off = adapter.on('open', () => { off(); r(); }); adapter.connect(); });

const GROUP = 1098867961;
const OWNER = 2238639363;
const BOT = 3557339810;
const sendGroup = (text, { withAt = false } = {}) => {
  log(`发信 ${withAt ? '[@bot] ' : '[无@] '}${text}`);
  peer.send(JSON.stringify({
    self_id: BOT, post_type: 'message', message_type: 'group', group_id: GROUP, user_id: OWNER,
    message_id: nextMessageId++, time: Math.floor(Date.now() / 1000),
    raw_message: (withAt ? `[CQ:at,qq=${BOT}] ` : '') + text,
    message: withAt ? [{ type: 'at', data: { qq: String(BOT) } }, { type: 'text', data: { text: ' ' + text } }] : [{ type: 'text', data: { text } }],
    sender: { user_id: OWNER, nickname: 'owner', card: 'owner' },
  }));
};

// ── 装配（含节点延迟被动采集 + 计时日志收集）──
const timingLogs = [];
let handledCount = 0;
const client = createModelClient({
  nodes: () => cfg.llm.apiKeys.map((n) => ({ name: n.name, baseUrl: n.baseUrl, apiKey: n.key, headers: n.headers, models: n.models, enabled: n.enabled, concurrency: n.concurrency })),
});
const latencyPath = path.join(dataDir, 'node-latency.json');
const latencyRecorder = new NodeLatencyRecorder({ filePath: latencyPath });
wrapClientWithLatency(client, latencyRecorder, (i) => cfg.llm.apiKeys?.[i]?.name);
const baseInfo = (...a) => console.log('[I]', ...a);
const logger = {
  info: (...a) => {
    const line = a.map((x) => typeof x === 'string' ? x : JSON.stringify(x)).join(' ');
    if (/消息处理总耗时/.test(line)) handledCount += 1;
    if (/消息处理耗时|上下文组装/.test(line)) timingLogs.push(line);
    baseInfo(line);
  },
  warn: () => {}, error: () => {}, debug: () => {},
};
const searchService = createWebSearchService({ getConfig: () => cfg, logger });
const app = createBotApp({ getConfig: () => cfg, client, search: searchService, log: logger });
const enforcer = new OrchestrationEnforcer({
  getConfig: () => cfg, app, client, logger,
  sunoHistory: new SunoSongHistoryStore({ filePath: path.join(dataDir, 'suno-song-history.json'), maxRecords: () => 100 }),
});
const runtime = createBotMessageRuntime({
  app, reply: adapter, getConfig: () => cfg,
  selfId: () => String(BOT), botName: 'Mio', logger,
  reportProblem: async () => true,
  triggerIntentChecker: new TriggerIntentChecker({ getConfig: () => cfg, client }),
  enforceOrchestration: (input) => enforcer.handle(input),
});
runtime.attach(adapter);

const waitHandled = async (timeoutMs = 240000) => {
  const before = handledCount;
  const deadline = Date.now() + timeoutMs;
  while (handledCount <= before && Date.now() < deadline) await sleep(300);
  if (handledCount <= before) throw new Error('处理超时');
};

try {
  log('── 场景 1：@bot chat（enforce 全链路）──');
  sendGroup('用一句话介绍你自己', { withAt: true });
  await waitHandled();

  log('── 场景 2：延续追问（窗口内无@补充）──');
  await sleep(2000);
  sendGroup('再补充一句你的特点');
  await waitHandled();

  log('── 场景 3：关键词触发 ──');
  await sleep(2000);
  sendGroup('大鱼今天天气怎么样');
  await waitHandled();

  await sleep(1500); // 等延迟采集落盘
} finally {
  adapter.disconnect();
  for (const c of wss.clients) c.terminate();
  await new Promise((r) => wss.close(r));
}

// ── 汇总输出 ──
const report = [];
report.push('════ 全流程计时报告 ════');
report.push('');
const stageAgg = {};
for (const line of timingLogs) {
  const m = line.match(/"stages":\s*(\{[^}]*\})/);
  if (m) {
    try {
      const stages = JSON.parse(m[1]);
      for (const [k, v] of Object.entries(stages)) {
        (stageAgg[k] = stageAgg[k] || []).push(v);
      }
    } catch { /* ignore */ }
  }
}
report.push('各阶段耗时（ms）：');
report.push('  阶段          样本  平均    最大');
for (const [k, list] of Object.entries(stageAgg)) {
  const avg = Math.round(list.reduce((s, v) => s + v, 0) / list.length);
  report.push(`  ${k.padEnd(12)}  ${String(list.length).padStart(3)}   ${String(avg).padStart(5)}  ${String(Math.max(...list)).padStart(5)}`);
}
report.push('');
report.push('每条消息明细：');
for (const line of timingLogs) {
  const m = line.match(/"outcome":\s*"([^"]+)".*"totalMs":\s*(\d+)/);
  if (m) report.push(`  ${m[1].padEnd(12)} total=${m[2]}ms  stages=${line.match(/"stages":\s*(\{[^}]*\})/)?.[1] || '{}'}`);
}
report.push('');
let latencyOk = false;
try {
  const latency = JSON.parse(fs.readFileSync(latencyPath, 'utf8'));
  report.push('节点延迟被动采集（node-latency.json）：');
  for (const [idx, stat] of Object.entries(latency.nodes || {})) {
    report.push(`  节点${idx} ${stat.name || ''}: 调用 ${stat.count} 次（失败 ${stat.failCount}），均值 ${stat.avgMs}ms，最近 ${stat.lastMs}ms`);
  }
  latencyOk = Object.keys(latency.nodes || {}).length > 0;
  report.push(`节点延迟被动采集${latencyOk ? '已生效' : '未生效'}`);
} catch (error) {
  report.push(`节点延迟被动采集未落盘: ${String(error?.message || error)}`);
}
const text = report.join('\n');
console.log('\n' + text);
fs.mkdirSync('.runtime', { recursive: true });
fs.writeFileSync('.runtime/timing-report.txt', text, 'utf8');
log('报告已写入 .runtime/timing-report.txt');
const ok = timingLogs.some((l) => /消息处理耗时/.test(l)) && latencyOk;
process.exit(ok ? 0 : 1);
