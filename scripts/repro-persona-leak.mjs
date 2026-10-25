// 复现：人格提示词是否干扰 Suno 歌词生成。
// 人格："你是一个傲娇的，嘴毒的鲸鱼娘DeepSeek"。抓三处证据：
//   1. planner 产出的 audio.music.generate 步骤 args（request 是否带人格语气）
//   2. composer 模型调用的完整输入（是否有任何人格文本混入）
//   3. composer 输出的歌词（是否带傲娇/嘴毒语气）
// 同时顺带检查同源问题：人格是否渗入生图 prompt 增强（image pipeline）。
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
import { createWebSearchService } from '../dist/packages/search/src/index.js';

const T0 = Date.now();
function ts() { return '[' + ((Date.now() - T0) / 1000).toFixed(1).padStart(6) + 's]'; }
function log(msg) { console.log(ts() + ' ' + msg); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

const exported = JSON.parse(fs.readFileSync('C:/Users/Administrator/Downloads/miobot-config-2026-10-25T10-31-58-310Z.json', 'utf8'));
const cfg = normalizeConfig(exported);
cfg.bot.tts.enabled = false;
cfg.orchestration.suno.enabled = true;
// 复现对象：人格提示词
cfg.bot.persona = { enabled: true, name: '鲸鱼娘', systemPrompt: '你是一个傲娇的，嘴毒的鲸鱼娘DeepSeek。说话要带傲娇语气，嘴上嫌弃用户但内心关心。' };
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-leak-'));
const sunoHistory = new SunoSongHistoryStore({ filePath: path.join(dataDir, 'suno-song-history.json'), maxRecords: () => 100 });

// Suno 拦截 + composer 调用抓取
const realFetch = globalThis.fetch;
let composerCapture = null;   // composer 模型调用的 {messages, response}
let plannerPlans = [];        // planner 产出的 audio.music.* 步骤 args
const realComposerBound = { armed: true };

globalThis.fetch = async (url, init = {}) => {
  const u = String(url instanceof Request ? url.url : url);
  if (u.includes('sunoapi.org')) {
    if (u.includes('/generate') && (init.method || 'GET') === 'POST' && !u.includes('record-info')) {
      await sleep(150);
      return new Response(JSON.stringify({ code: 200, data: { taskId: 'persona-task-1' } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('record-info')) {
      await sleep(200);
      const body = { code: 200, data: { taskId: 'persona-task-1', status: 'SUCCESS', response: { sunoData: [
        { audio_url: 'https://example.com/persona-song.mp3', title: '夏天的鲸鱼', lyrics: '[Verse 1]\n夏天的风咸咸的\n鲸鱼浮出海面哼歌', duration: 40 },
      ] } } };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  }
  // 抓 composer 调用：deepseek + body 含 musicBrief/composer 特征
  if (u.includes('api.deepseek.com') && (init.method || 'GET') === 'POST' && typeof init.body === 'string' && init.body.includes('musicBrief')) {
    let parsed = {};
    try { parsed = JSON.parse(init.body); } catch {}
    const started = Date.now();
    const res = await realFetch(url, init);
    const resBody = await res.clone().text().catch(() => '');
    composerCapture = {
      messages: parsed.messages || [],
      response: (() => { try { return JSON.parse(resBody)?.choices?.[0]?.message?.content || ''; } catch { return ''; } })(),
      ms: Date.now() - started,
    };
    return res;
  }
  const res = await realFetch(url, init);
  return res;
};

const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
await once(wss, 'listening');
let peer = null;
let nextMessageId = 1;
wss.on('connection', (socket) => {
  peer = socket;
  socket.on('message', (raw) => {
    let action; try { action = JSON.parse(String(raw)); } catch { return; }
    socket.send(JSON.stringify({ echo: action.echo, self_id: 3557339810, status: 'ok', retcode: 0, data: { message_id: nextMessageId++ } }));
    if (String(action.action).startsWith('send_')) {
      outgoingReplies += 1;
      const text = JSON.stringify(action.params || {}).slice(0, 260);
      outgoingTexts.push(text);
    }
  });
});
let outgoingReplies = 0;
const outgoingTexts = [];
cfg.napcat.wsUrl = 'ws://127.0.0.1:' + wss.address().port;
const adapter = new NapcatAdapter({ wsUrl: cfg.napcat.wsUrl, token: 'sim', actionTimeoutMs: 60000, textSendTimeoutMs: 180000, imageSendTimeoutMs: 300000, fileSendTimeoutMs: 300000, forwardSendTimeoutMs: 600000, getMessageTimeoutMs: 60000, autoReconnect: false });
await new Promise((r) => { const off = adapter.on('open', () => { off(); r(); }); adapter.connect(); });

const sendGroup = (text, { withAt = true } = {}) => {
  log(`发信 ${withAt ? '[@bot] ' : ''}${text}`);
  peer.send(JSON.stringify({
    self_id: 3557339810, post_type: 'message', message_type: 'group', group_id: 1098867961, user_id: 2238639363,
    message_id: nextMessageId++, time: Math.floor(Date.now() / 1000),
    raw_message: (withAt ? '[CQ:at,qq=3557339810] ' : '') + text,
    message: withAt ? [{ type: 'at', data: { qq: '3557339810' } }, { type: 'text', data: { text: ' ' + text } }] : [{ type: 'text', data: { text } }],
    sender: { user_id: 2238639363, nickname: 'owner', card: 'owner' },
  }));
};

const client = createModelClient({
  nodes: () => cfg.llm.apiKeys.map((n) => ({ name: n.name, baseUrl: n.baseUrl, apiKey: n.key, headers: n.headers, models: n.models, enabled: n.enabled, concurrency: n.concurrency })),
});
const logger = { info: () => {}, warn: (...a) => console.log('[W]', ...a), error: () => {}, debug: () => {} };
const searchService = createWebSearchService({ getConfig: () => cfg, logger });
const app = createBotApp({ getConfig: () => cfg, client, search: searchService, log: logger });
const enforcer = new OrchestrationEnforcer({
  getConfig: () => cfg, app, client, logger, sunoHistory,
  trace: (t) => {
    if (t.stage === 'plan' && /生成执行计划/.test(t.summary)) {
      const steps = (t.data?.steps || []).map((s) => s.capability).join(',');
      log('[plan] ' + steps);
      plannerPlans.push(t.data?.steps || []);
    }
  },
});
const runtime = createBotMessageRuntime({
  app, reply: adapter, getConfig: () => cfg,
  selfId: () => '3557339810', botName: 'Mio', logger,
  reportProblem: async (p) => { log('[PROBLEM] ' + p.kind + ' ' + String(p.error || p.message || '').slice(0, 120)); return true; },
  triggerIntentChecker: new TriggerIntentChecker({ getConfig: () => cfg, client }),
  enforceOrchestration: (input) => enforcer.handle(input),
});
runtime.attach(adapter);

let handledCount = 0;
  const waitHandled2 = async (timeoutMs = 240000) => {
    // 等聊天回复出站（send_group_msg 动作计数）
    const before = outgoingReplies;
    const deadline = Date.now() + timeoutMs;
    while (outgoingReplies <= before && Date.now() < deadline) await sleep(300);
    await sleep(400);
  };
  const waitHandled = async (timeoutMs = 240000) => {
  // 等到 Suno 交付（handler 完成）
  await waitFor(() => composerCapture && composerCapture.response, timeoutMs, 'composer 完成');
};
function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  const inner = async () => { while (!predicate() && Date.now() < deadline) await sleep(300); };
  return inner();
}

try {
  sendGroup('你好呀，今天心情怎么样');
  await waitHandled2(240000);
  sendGroup('你会写歌词吗？写一段看看');
  await waitHandled2(240000);
  sendGroup('写一首关于鲸鱼的短歌词');
  await waitHandled2(240000);
  sendGroup('再写一首傲娇风格的');
  await waitHandled2(240000);
  sendGroup('给我唱一首关于夏天的歌');
  await waitHandled(240000);
  await sleep(1000);
} finally {
  adapter.disconnect();
  for (const c of wss.clients) c.terminate();
}

// ── 分析 ──
console.log('\n════ 证据 1：planner 产出的音乐步骤 args ════');
console.log(JSON.stringify(plannerPlans).slice(0, 600) || '(未捕获)');

console.log('\n════ 证据 2：composer 模型调用输入 ════');
if (composerCapture) {
  for (const m of composerCapture.messages || []) {
    console.log(`--- role=${m.role} ---`);
    console.log(String(m.content).slice(0, 500));
  }
} else console.log('(未抓到 composer 调用)');

console.log('\n════ 证据 3：composer 输出的歌词 ════');
console.log(composerCapture?.response?.slice(0, 1200) || '(无)');

const personaMarkers = ['傲娇', '嘴毒', '鲸鱼', '哼', '笨蛋', '才不是', '别误会'];
const haystack = JSON.stringify({ plans: plannerPlans, composer: composerCapture }) || '';
const hits = personaMarkers.filter((k) => haystack.includes(k));
console.log('\n════ 结论 ════');
console.log('人格标记命中：', hits.length ? hits.join(', ') : '无');
console.log('聊天出站文案（人格活性验证）：', JSON.stringify(outgoingTexts.slice(0, 4)));
process.exit(0);
