/**
 * 网文数据通（novel-platform.mjs）—— 起点 / 番茄 / 七猫 三平台榜单与书籍数据能力插件
 *
 * 安装：放到 <数据目录>/capabilities/novel-platform.mjs，bot 启动自动加载，
 *       能力中心出现「网文数据通」卡片；能力注册表 / 测试卡 / 编排全部自动可用。
 * 配置：<数据目录>/capabilities/novel-platform.config.json（首次运行自动生成默认值）
 *       缓存时长等可在对话里让模型用 action:"config" 修改，也可直接编辑该文件。
 * 落盘：每天首次成功拉取的榜单/书籍数据快照写到 <数据目录>/capabilities/novel-data/，
 *       action:"compare" 基于快照做跨天对比（排名升降、数据变化），这是本能力核心卖点。
 *
 * 数据通道（全部实测可用，2026-10-31）：
 *   起点  m.qidian.com   榜单需两步 CSRF（页面拿 _csrfToken → JSON 接口）；榜单支持
 *                        分类过滤(catId) 与历史月份(月票榜 yearmonth)；书籍详情 SSR 内嵌
 *                        全量指标（月票/推荐票/收藏/粉丝值/打赏/荣誉/最近章节）。
 *   番茄  fanqienovel.com SSR 内嵌 __INITIAL_STATE__；榜单=4主榜+38分类榜；
 *                        书籍详情含在读人数/总章节数/章节目录ID。搜索无公开 HTTP 通道，
 *                        返回引导文本（web.search 兜底或提供 bookId）。
 *   七猫  www.qimao.com  响应头畸形（行尾多 CR + chunked），Node fetch 会拒收——插件内置
 *                        宽容 TLS 客户端；榜单 SSR __NUXT__；搜索走同源 JSON 接口；
 *                        分类数据走书库浏览页（男频0/女频1 × 分类ID × 排序翻页）。
 *
 * 防风控纪律（复刻指纹工程设计模式）：UA 按平台家族从真实份额加权池启动时选定、全程一致；
 * 头集宁少勿假；请求间最小间隔+抖动；起点 token 生命周期缓存、失效自动重刷重试一次；
 * 全部只读公开数据，不碰登录态与正文。
 */

import tls from 'node:tls';
import fs from 'node:fs';
import path from 'node:path';

/* ════════════════ 常量与映射 ════════════════ */

const MAX_OUTPUT_CHARS = 8000;

// 平台家族 UA 池（2026 年真实份额近似，启动时加权选定，进程内全程一致）
const UA_POOLS = {
  ios: [
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1', 0.45],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Mobile/15E148 Safari/604.1', 0.30],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1', 0.25],
  ],
  desktop: [
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36', 0.40],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36', 0.30],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36', 0.30],
  ],
};
function pickWeighted(pairs) {
  const total = pairs.reduce((a, [, w]) => a + w, 0);
  let r = Math.random() * total;
  for (const [v, w] of pairs) { r -= w; if (r <= 0) return v; }
  return pairs[0][0];
}

// 平台别名归一化（宽容：中/英/缩写/全称都能接）
const PLATFORM_ALIASES = {
  qidian: ['qidian', 'qd', '起点', '起点中文网', '起点读书', 'qdwx'],
  fanqie: ['fanqie', 'fq', '番茄', '番茄小说', '番茄小说网', 'fanqienovel'],
  qimao: ['qimao', 'qm', '七猫', '七猫小说', '七猫中文网', 'qimaomao'],
};
function normalizePlatform(v) {
  const s = String(v || '').trim().toLowerCase();
  if (!s) return '';
  for (const [key, aliases] of Object.entries(PLATFORM_ALIASES)) {
    if (aliases.some((a) => s === a || s.includes(a))) return key;
  }
  return '';
}

function normalizeGender(v) {
  const s = String(v || '').trim().toLowerCase();
  if (!s) return '';
  if (['male', '男', '男频', 'boy', '男生', 'm'].includes(s) || s.includes('男')) return 'male';
  if (['female', '女', '女频', 'girl', '女生', 'f'].includes(s) || s.includes('女')) return 'female';
  return '';
}

// 起点榜单映射（11 榜，全部实测）
const QIDIAN_RANKS = {
  yuepiao: { title: '月票榜', api: 'yuepiao', aliases: ['yuepiao', '月票', '月票榜', '本月月票'] },
  hotsales: { title: '畅销榜', api: 'hotsales', aliases: ['hotsales', '畅销', '畅销榜', '热销', '热销榜', '销量'] },
  readindex: { title: '阅读榜', api: 'readIndex', aliases: ['readindex', '阅读', '阅读榜', '阅读指数', '追读', '追读榜'] },
  newfans: { title: '书友榜', api: 'newfans', aliases: ['newfans', '书友', '书友榜', '新粉'] },
  rec: { title: '推荐榜', api: 'rec', aliases: ['rec', '推荐', '推荐榜', '推荐票'] },
  update: { title: '更新榜', api: 'update', aliases: ['update', '更新', '更新榜', '日更'] },
  sign: { title: '签约榜', api: 'sign', aliases: ['sign', '签约', '签约榜'], gender: 'male' },
  newbook: { title: '新书榜', api: 'newbook', aliases: ['newbook', '新书', '新书榜'], gender: 'male' },
  newauthor: { title: '新人榜', api: 'newauthor', aliases: ['newauthor', '新人', '新人榜', '新作者'], gender: 'male' },
  collect: { title: '收藏榜', api: 'collect', aliases: ['collect', '收藏', '收藏榜'], gender: 'female' },
  free: { title: '免费榜', api: 'free', aliases: ['free', '免费', '免费榜'], gender: 'female' },
};
function normalizeQidianRank(v) {
  const s = String(v || '').trim().toLowerCase();
  if (!s) return 'yuepiao';
  for (const [key, meta] of Object.entries(QIDIAN_RANKS)) {
    if (meta.aliases.some((a) => s === a || s.includes(a) || a.includes(s))) return key;
  }
  return '';
}

// 起点一级分类 catId（与 m 站 filters 实测一致；男/女频通用）
const QIDIAN_CATS = {
  玄幻: 21, 奇幻: 1, 武侠: 2, 仙侠: 22, 都市: 4, 现实: 15, 军事: 6, 历史: 5,
  游戏: 7, 体育: 8, 科幻: 9, 悬疑灵异: 10, 诸天无限: 20109, 轻小说: 12,
};
function normalizeQidianCat(v) {
  const s = String(v || '').trim();
  if (!s || s === '全部' || s === '全站') return -1;
  if (/^\d+$/.test(s)) return Number(s);
  if (QIDIAN_CATS[s]) return QIDIAN_CATS[s];
  for (const [name, id] of Object.entries(QIDIAN_CATS)) {
    if (s.includes(name) || name.includes(s)) return id;
  }
  return null; // 无法识别
}

// 番茄榜单（seg1: 1=男 0=女；seg2: 2=阅读 1=新书；分类榜追加 _<catId>）
const FANQIE_RANKS = {
  read: { title: '阅读榜', seg: 2, aliases: ['read', '阅读', '阅读榜', '人气', '人气榜', '追读', '在读'] },
  new: { title: '新书榜', seg: 1, aliases: ['new', '新书', '新书榜'] },
};
function normalizeFanqieRank(v) {
  const s = String(v || '').trim().toLowerCase();
  if (!s) return 'read';
  for (const [key, meta] of Object.entries(FANQIE_RANKS)) {
    if (meta.aliases.some((a) => s === a || s.includes(a) || a.includes(s))) return key;
  }
  return '';
}

// 七猫榜单（boy/girl × hot/new/over）
const QIMAO_RANKS = {
  hot: { title: '热门榜', path: 'hot', aliases: ['hot', '热门', '热门榜', '点击', '点击榜'] },
  new: { title: '新书榜', path: 'new', aliases: ['new', '新书', '新书榜'] },
  over: { title: '完本榜', path: 'over', aliases: ['over', '完本', '完本榜', '完结', '完结榜'] },
};
function normalizeQimaoRank(v) {
  const s = String(v || '').trim().toLowerCase();
  if (!s) return 'hot';
  for (const [key, meta] of Object.entries(QIMAO_RANKS)) {
    if (meta.aliases.some((a) => s === a || s.includes(a) || a.includes(s))) return key;
  }
  return '';
}

// "上月"/"10月"/"2026-10" → YYYYMM；仅起点月票榜支持
function normalizeYearMonth(v) {
  if (v === undefined || v === null || v === '') return '';
  const s = String(v).trim();
  const now = new Date();
  if (/^(上月|上个月|lastmonth)$/i.test(s)) {
    const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
  }
  let m = s.match(/^(\d{4})[-/年]?(\d{1,2})月?$/);
  if (m) return `${m[1]}${String(Number(m[2])).padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})月$/);
  if (m) {
    const month = Number(m[1]);
    const year = month > now.getMonth() + 1 ? now.getFullYear() - 1 : now.getFullYear();
    return `${year}${String(month).padStart(2, '0')}`;
  }
  m = s.match(/^(\d{6})$/);
  if (m) return m[1];
  return '';
}

function normalizeDays(v) {
  if (v === undefined || v === null || v === '') return 7;
  if (/^\d+$/.test(String(v))) return Math.min(90, Math.max(1, Number(v)));
  const s = String(v);
  const map = [['昨天', 1], ['一周', 7], ['上周', 7], ['上周同期', 7], ['半月', 15], ['半个月', 15], ['一月', 30], ['一个月', 30], ['上月', 30]];
  for (const [k, n] of map) if (s.includes(k)) return n;
  const m = s.match(/(\d+)\s*天/);
  if (m) return Math.min(90, Math.max(1, Number(m[1])));
  return 7;
}

/* ════════════════ 运行时状态 ════════════════ */

const UA = {
  qidian: pickWeighted(UA_POOLS.ios),
  fanqie: pickWeighted(UA_POOLS.desktop),
  qimao: pickWeighted(UA_POOLS.desktop),
};

const state = {
  cache: new Map(),            // key -> { at, payload }
  qidianSession: { token: '', cookie: '', at: 0 },
  fanqieCats: { list: null, at: 0 },   // [{id,name,gender}]
  fanqieBookMeta: new Map(),   // bookId -> { name, author, desc, at }（番茄书名/作者被字体反爬，用详情页 JSON-LD 明文还原）
  qimaoCats: { byChannel: null, at: 0 }, // {male:[{id,name,children}], female:[...]}
  lastRequestAt: { qidian: 0, fanqie: 0, qimao: 0 },
  pluginCtx: null,
};

const DEFAULT_CONFIG = {
  cacheHours: 12,
  snapshotRetentionDays: 90,
  minRequestIntervalMs: 350,
  disabledPlatforms: [],
};
let pluginConfig = { ...DEFAULT_CONFIG };
let configPath = '';

function loadConfigFile(dataDir) {
  configPath = path.join(dataDir, 'capabilities', 'novel-platform.config.json');
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    pluginConfig = { ...DEFAULT_CONFIG, ...raw };
  } catch {
    pluginConfig = { ...DEFAULT_CONFIG };
    saveConfigFile();
  }
}
function saveConfigFile() {
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(pluginConfig, null, 2), 'utf8');
  } catch { /* 写失败不阻塞，仅本次内存生效 */ }
}

const log = (level, msg, extra) => state.pluginCtx?.logger?.[level]?.(msg, extra);

function isPlatformEnabled(p) {
  return !Array.isArray(pluginConfig.disabledPlatforms) || !pluginConfig.disabledPlatforms.includes(p);
}

/* ════════════════ HTTP 基础设施 ════════════════ */

async function pace(platform) {
  const min = Math.max(0, Number(pluginConfig.minRequestIntervalMs) || 0);
  const wait = state.lastRequestAt[platform] + min + Math.random() * 400 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  state.lastRequestAt[platform] = Date.now();
}

async function fetchText(url, platform, headers = {}, timeoutMs = 15000) {
  await pace(platform);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        'user-agent': UA[platform] || UA_POOLS.desktop[0][0],
        'accept': 'text/html,application/json,*/*',
        'accept-language': 'zh-CN,zh;q=0.9',
        ...headers,
      },
      signal: ctrl.signal,
    });
    const text = await res.text();
    return { status: res.status, text, getSetCookie: () => (res.headers.getSetCookie ? res.headers.getSetCookie() : []) };
  } finally {
    clearTimeout(timer);
  }
}

/** 宽容 HTTP/1.1 GET：七猫服务器响应头行尾多 CR 且偶发 chunked，Node 严格解析会拒收。 */
export function lenientGet(url, headers = {}, timeoutMs = 15000) {
  const u = new URL(url);
  const reqText = [
    `GET ${u.pathname + u.search} HTTP/1.1`,
    ...Object.entries({ host: u.host, 'accept-encoding': 'identity', connection: 'close', ...headers }).map(([k, v]) => `${k}: ${v}`),
    '', '',
  ].join('\r\n');
  return new Promise((resolve, reject) => {
    let status = 0;
    let respHeaders = {};
    let headerDone = false;
    let headRest = Buffer.alloc(0);
    const chunks = [];
    const finish = () => {
      let bodyBuf = Buffer.concat([headRest, ...chunks]);
      if (/chunked/i.test(String(respHeaders['transfer-encoding'] || ''))) {
        const out = [];
        let pos = 0;
        for (;;) {
          const lineEnd = bodyBuf.indexOf('\r\n', pos);
          if (lineEnd === -1) break;
          const size = parseInt(bodyBuf.subarray(pos, lineEnd).toString('utf8').trim().split(';')[0], 16);
          if (!Number.isFinite(size) || size <= 0) break;
          out.push(bodyBuf.subarray(lineEnd + 2, lineEnd + 2 + size));
          pos = lineEnd + 2 + size + 2;
        }
        bodyBuf = Buffer.concat(out);
      }
      resolve({ status, headers: respHeaders, text: bodyBuf.toString('utf8') });
    };
    const socket = tls.connect({ host: u.hostname, servername: u.hostname, port: 443, rejectUnauthorized: true }, () => socket.write(reqText));
    socket.setTimeout(timeoutMs, () => { socket.destroy(); reject(new Error('请求超时')); });
    socket.on('data', (d) => {
      if (headerDone) { chunks.push(d); return; }
      headRest = Buffer.concat([headRest, d]);
      let sep = -1, sepLen = 0;
      const i1 = headRest.indexOf('\r\r\n\r\r\n');
      const i2 = headRest.indexOf('\r\n\r\n');
      if (i1 !== -1 && (i2 === -1 || i1 <= i2)) { sep = i1; sepLen = 6; }
      else if (i2 !== -1) { sep = i2; sepLen = 4; }
      if (sep === -1) return;
      const lines = headRest.subarray(0, sep).toString('utf8').replace(/\r\r\n/g, '\r\n').split(/\r\n|\n/).filter(Boolean);
      const sm = (lines[0] || '').match(/HTTP\/[\d.]+ (\d{3})/);
      status = sm ? Number(sm[1]) : 0;
      for (const line of lines.slice(1)) {
        const idx = line.indexOf(':');
        if (idx > 0) respHeaders[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
      }
      headRest = headRest.subarray(sep + sepLen);
      headerDone = true;
    });
    socket.on('end', () => { headerDone ? finish() : reject(new Error('连接提前断开')); });
    socket.on('error', (e) => reject(new Error(String(e.message || e))));
  });
}

/* ════════════════ 页面内嵌数据提取 ════════════════ */

/** 提取 <script type="application/json">（起点 vike SSR） */
function extractJsonScript(html) {
  const m = html.match(/<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

/** 提取并求值 window.__INITIAL_STATE__ / window.__NUXT__ 表达式（站点自身 payload，非用户输入） */
function extractJsState(html, marker) {
  const i = html.indexOf(marker);
  if (i === -1) return null;
  let seg = html.slice(i + marker.length);
  const stop = seg.search(/;\s*<\/script>/);
  if (stop !== -1) seg = seg.slice(0, stop);
  try {
    return new Function('"use strict"; return (' + seg + ')')();
  } catch {
    // 退路：清洗裸 undefined 字面量后按平衡花括号截取再试
    const s = html.indexOf('{', i);
    let depth = 0, end = s;
    for (let k = s; k < html.length; k++) {
      const ch = html[k];
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) { end = k + 1; break; } }
      else if (ch === '"') { k++; while (k < html.length && html[k] !== '"') { if (html[k] === '\\') k++; k++; } }
    }
    try { return JSON.parse(html.slice(s, end).replace(/([:,\[]\s*)undefined(\s*[,}\]])/g, '$1null$2')); } catch { return null; }
  }
}

/** 从书籍详情/搜索页 URL 片段宽容解析 bookId（支持传完整链接） */
function extractBookId(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  const m = s.match(/(?:\/page\/|\/shuku\/|\/book\/)(\d+)/);
  if (m) return m[1];
  const pure = s.match(/^(\d{5,})$/);
  return pure ? pure[1] : '';
}

/* ════════════════ 快照落盘（对比分析的数据底座） ════════════════ */

function snapshotDir() {
  return path.join(state.pluginCtx?.dataDir || '.', 'capabilities', 'novel-data', 'snapshots');
}
function todayStr(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return d.toISOString().slice(0, 10);
}
async function saveSnapshot(platform, kind, key, data) {
  try {
    const dir = path.join(snapshotDir(), platform);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${kind}_${key}_${todayStr()}.json`);
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, JSON.stringify({ date: todayStr(), kind, key, platform, capturedAt: new Date().toISOString(), data }, null, 1), 'utf8');
      log('info', '榜单快照已落盘', { platform, key });
    }
    cleanupSnapshots();
  } catch (e) { log('warn', '快照写入失败', { error: String(e?.message || e) }); }
}
function cleanupSnapshots() {
  try {
    const retention = Math.max(7, Number(pluginConfig.snapshotRetentionDays) || 90);
    const cutoff = todayStr(-retention);
    for (const platform of fs.readdirSync(snapshotDir())) {
      const dir = path.join(snapshotDir(), platform);
      for (const f of fs.readdirSync(dir)) {
        const m = f.match(/(\d{4}-\d{2}-\d{2})\.json$/);
        if (m && m[1] < cutoff) fs.unlinkSync(path.join(dir, f));
      }
    }
  } catch { /* 目录不存在等，忽略 */ }
}
/** 找距离 targetDays 天前最近的快照（±3 天容差），返回 {date, data} 或 null */
function loadSnapshotNear(platform, kind, key, targetDays) {
  try {
    const dir = path.join(snapshotDir(), platform);
    const target = todayStr(-targetDays);
    const files = fs.readdirSync(dir)
      .map((f) => { const m = f.match(new RegExp(`^${kind}_${key}_(\\d{4}-\\d{2}-\\d{2})\\.json$`)); return m ? m[1] : null; })
      .filter(Boolean)
      .sort();
    if (!files.length) return null;
    // 目标日 ±3 天内最近的；没有则返回早于等于目标的最近一份；再没有则返回最早一份
    const inWindow = files.filter((d) => Math.abs(new Date(d) - new Date(target)) <= 3 * 86400000);
    if (inWindow.length) return { date: inWindow[inWindow.length - 1], data: readSnap(path.join(dir, `${kind}_${key}_${inWindow[inWindow.length - 1]}.json`)) };
    const before = files.filter((d) => d <= target);
    if (before.length) return { date: before[before.length - 1], data: readSnap(path.join(dir, `${kind}_${key}_${before[before.length - 1]}.json`)) };
    return { date: files[0], data: readSnap(path.join(dir, `${kind}_${key}_${files[0]}.json`)), note: '历史不足，已用最早快照' };
  } catch { return null; }
}
function readSnap(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')).data; } catch { return null; }
}

/* ════════════════ 起点适配器 ════════════════ */

async function qidianSession(forceRefresh = false) {
  const s = state.qidianSession;
  const ttl = 25 * 60 * 1000;
  if (!forceRefresh && s.token && Date.now() - s.at < ttl) return s;
  const res = await fetchText('https://m.qidian.com/rank/yuepiao/', 'qidian', { accept: 'text/html' });
  if (res.status !== 200) throw new Error(`起点页面 ${res.status}`);
  const cookie = res.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const token = (res.getSetCookie().find((c) => c.startsWith('_csrfToken=')) || '').split(';')[0].split('=')[1] || '';
  if (!token || !cookie) throw new Error('起点令牌获取失败');
  Object.assign(s, { token, cookie, at: Date.now() });
  return s;
}

async function qidianListApi(rankKey, gender, pageNum, extra = {}) {
  const meta = QIDIAN_RANKS[rankKey];
  const params = new URLSearchParams({ gender, pageNum: String(pageNum), ...extra });
  for (let attempt = 0; attempt < 2; attempt++) {
    const s = await qidianSession(attempt > 0);
    const url = `https://m.qidian.com/webcommon/rank/${meta.api}list?${params}&_csrfToken=${encodeURIComponent(s.token)}`;
    const res = await fetchText(url, 'qidian', {
      'accept': 'application/json',
      'referer': `https://m.qidian.com/rank/${meta.api}/`,
      'x-requested-with': 'XMLHttpRequest',
      'cookie': s.cookie,
    });
    let json = null;
    try { json = JSON.parse(res.text); } catch { /* 非 JSON */ }
    if (json?.code === 1403) { state.qidianSession = { token: '', cookie: '', at: 0 }; continue; }
    if (json?.code !== 0) throw new Error(`起点接口 code=${json?.code ?? res.status} ${json?.msg || ''}`);
    return json.data || {};
  }
  throw new Error('起点令牌两次刷新仍失败');
}

/** 起点榜单：records 归一化。category/month/pages 全部宽容处理。 */
async function qidianRank(args) {
  const rankKey = normalizeQidianRank(args.rank);
  if (!rankKey) {
    return { error: `未识别的起点榜单「${args.rank}」。可用榜单：${Object.values(QIDIAN_RANKS).map((r) => r.title).join('、')}（可直接传中文名或 yuepiao 等英文 id）。` };
  }
  const meta = QIDIAN_RANKS[rankKey];
  const gender = args.gender ? normalizeGender(args.gender) : (meta.gender || 'male');
  if (!gender) return { error: `未识别频道「${args.gender}」，请传 男/女（male/female）。注意：${meta.title}仅提供${meta.gender === 'male' ? '男频' : '女频'}数据。` };
  const pages = Math.min(3, Math.max(1, Math.trunc(Number(args.pages) || 1)));

  const extra = {};
  if (args.category !== undefined && args.category !== null && String(args.category).trim() !== '') {
    const cat = normalizeQidianCat(args.category);
    if (cat === null) return { error: `未识别起点分类「${args.category}」。可用分类：${Object.keys(QIDIAN_CATS).join('、')}（或直接传分类数字 ID）。` };
    if (cat !== -1) extra.catId = String(cat);
  }
  if (rankKey === 'yuepiao') {
    const ym = normalizeYearMonth(args.month);
    if (ym) extra.yearmonth = ym;
  }

  const records = [];
  for (let p = 1; p <= pages; p++) {
    const data = await qidianListApi(rankKey, gender, p, extra);
    const list = Array.isArray(data.records) ? data.records : [];
    records.push(...list.map((r, i) => ({
      pos: r.rankNum ?? (p - 1) * 20 + i + 1,
      name: r.bName || '未知',
      author: r.bAuth || '',
      category: [r.cat, r.subCat].filter(Boolean).join('/'),
      metric: r.rankCnt || r.cnt || '',
      metricLabel: '票数/字数',
      desc: String(r.desc || '').replace(/\s+/g, '').slice(0, 60),
      bookId: String(r.bid || ''),
    })));
    if (data.isLast) break;
  }
  const label = `${meta.title}${extra.catId ? `·${args.category}` : ''}${extra.yearmonth ? `·${extra.yearmonth.slice(0, 4)}-${extra.yearmonth.slice(4)}月` : ''}`;
  return {
    platform: 'qidian', kind: 'rank', key: `${rankKey}_${gender}${extra.catId ? '_cat' + extra.catId : ''}${extra.yearmonth ? '_' + extra.yearmonth : ''}`,
    header: `起点${label}·${gender === 'male' ? '男频' : '女频'}`,
    records,
    stats: buildStats(records),
    notes: extra.yearmonth ? '（历史月份数据为起点官方存档）' : '',
  };
}

/** 起点搜索（SSR 内嵌） */
async function qidianSearch(keyword) {
  const res = await fetchText(`https://m.qidian.com/search?kw=${encodeURIComponent(keyword)}`, 'qidian', { accept: 'text/html' });
  if (res.status !== 200) throw new Error(`起点搜索页 ${res.status}`);
  const st = extractJsonScript(res.text);
  const records = st?.pageContext?.pageProps?.pageData?.records || findKeyDeep(st, 'records') || [];
  return {
    platform: 'qidian', kind: 'search', key: `search_${keyword}`,
    header: `起点搜索「${keyword}」`,
    records: (Array.isArray(records) ? records : []).slice(0, 15).map((r) => ({
      name: r.bName || '',
      author: r.bAuth || '',
      category: [r.cat, r.subCat].filter(Boolean).join('/'),
      metric: `${r.favoriteCnt || '-'}收藏 / ${r.recomendCnt || '-'}推荐`,
      metricLabel: '收藏/推荐',
      desc: String(r.desc || '').replace(/\s+/g, '').slice(0, 60),
      bookId: String(r.bid || ''),
      state: r.state || (r.signStatus || ''),
      words: r.cnt || '',
    })),
    stats: '',
  };
}

/** 起点书籍详情（SSR 全量指标：月票/推荐票/收藏/粉丝/打赏/荣誉） */
async function qidianBook(bookId) {
  const res = await fetchText(`https://m.qidian.com/book/${bookId}/`, 'qidian', { accept: 'text/html' });
  if (res.status !== 200) throw new Error(`起点详情页 ${res.status}`);
  const st = extractJsonScript(res.text);
  const pd = st?.pageContext?.pageProps?.pageData || findKeyDeep(st, 'bookInfo') || {};
  const bi = pd.bookInfo || {};
  const lines = [];
  lines.push(`《${bi.bookName || bi.bName || '未知'}》 ${bi.authorName || ''}｜${[bi.chanName, bi.subCateName].filter(Boolean).join('/')}`);
  lines.push(`状态：${bi.actionStatus || bi.bookStatus || '-'}｜签约：${bi.signStatus || '-'}｜字数：${fmtWan(bi.wordsCnt)}｜更新：${bi.updTime || '-'}${bi.updChapterName ? `（${bi.updChapterName}）` : ''}`);
  const tags = (bi.bookLabels || []).map((t) => t.tag).filter(Boolean);
  if (tags.length) lines.push(`标签：${tags.join('、')}`);
  lines.push('');
  lines.push(`收藏 ${fmtWan(bi.collect)}｜总推荐 ${fmtWan(bi.recomAll)}｜周推荐 ${fmtWan(bi.recomWeek)}`);
  const mt = pd.monthTicketInfo || {};
  if (mt.monthCnt !== undefined) lines.push(`本月月票 ${mt.monthCnt}（月票榜第 ${mt.rank} 名，距上名 ${mt.disForward} 票 / 领先下名 ${mt.disBackward} 票）`);
  const rt = pd.recTicketInfo || {};
  if (rt.weekCnt !== undefined) lines.push(`本周推荐票 ${rt.weekCnt}（第 ${rt.rank} 名）`);
  const fans = pd.fansInfo || {};
  if (fans.fansTotal) lines.push(`总粉丝值 ${fans.fansTotal}${Array.isArray(fans.fansRank) && fans.fansRank[0] ? `｜粉丝榜第一：${fans.fansRank[0].userName}（${fans.fansRank[0].levelName}）` : ''}`);
  const rw = pd.rewardInfo || {};
  if (rw.todayCnt !== undefined) lines.push(`打赏：今日 ${rw.todayCnt} 次 / 本周 ${rw.weekCnt} 次`);
  const au = pd.authorInfo || {};
  if (au.authorName) lines.push(`作者：${au.authorName}（${au.rank || au.authorLevel || '-'}，写作 ${au.writeDays || au.days || '-'} 天）`);
  const honors = (pd.bookHonorList || []).slice(0, 3).map((h) => h.desc || h.honorDesc).filter(Boolean);
  if (honors.length) lines.push(`近期荣誉：${honors.join('；')}`);
  const chapters = (pd.recentChapters || []).slice(0, 3).map((c) => `${c.cN}（${c.uT}，${c.cnt}字）`);
  if (chapters.length) { lines.push(''); lines.push(`最近章节：\n  ${chapters.join('\n  ')}`); }
  if (bi.desc) lines.push('', `简介：${String(bi.desc).replace(/<br\s*\/?>/gi, ' ').replace(/\s+/g, '').slice(0, 160)}…`);
  const text = lines.join('\n');
  return {
    platform: 'qidian', kind: 'book', key: `book_${bookId}`,
    header: `起点书籍档案`, records: [], stats: '',
    text, snapshotData: { name: bi.bookName, collect: bi.collect, recomAll: bi.recomAll, monthTicket: mt.monthCnt, monthTicketRank: mt.rank, wordsCnt: bi.wordsCnt, actionStatus: bi.actionStatus, updChapterName: bi.updChapterName },
  };
}

/* ════════════════ 番茄适配器 ════════════════ */

/** 番茄字体反爬：正文书名/作者/简介是 PUA 私有区字符（约半数字符，字体动态生成无法离线解表）。
 *  实测可靠通道：书籍详情页 JSON-LD 与 <title> 是明文——用 bookId 逐本补查还原（结果缓存）。 */
function cleanPua(s) {
  return String(s || '').replace(/[\uE000-\uF8FF]/g, '□');
}
function parseFanqieTitle(headline) {
  const seg = String(headline || '').split('_')[0].trim();
  return seg.replace(/(完整版)?在线免费阅读$/, '').replace(/最新章节$/, '').trim();
}
async function fanqieBookMeta(bookId) {
  const ttl = Math.max(1, Number(pluginConfig.cacheHours) || 12) * 3600 * 1000;
  const hit = state.fanqieBookMeta.get(String(bookId));
  if (hit && Date.now() - hit.at < ttl) return hit;
  try {
    const res = await fetchText(`https://fanqienovel.com/page/${bookId}`, 'fanqie', { accept: 'text/html' });
    if (res.status !== 200) throw new Error(String(res.status));
    const html = res.text;
    let name = '', author = '', desc = '';
    const ld = html.match(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/);
    if (ld) {
      try {
        const j = JSON.parse(ld[1]);
        name = parseFanqieTitle(j.headline || j.name || '');
        const au = Array.isArray(j.author) ? j.author[0]?.name : j.author?.name;
        author = String(au || '');
        desc = String(j.description || '');
      } catch { /* JSON-LD 解析失败走 title 兜底 */ }
    }
    if (!name) name = parseFanqieTitle((html.match(/<title>([^<]*)<\/title>/) || [])[1]);
    if (!desc) desc = (html.match(/<meta name="description" content="([^"]*)"/) || [])[1] || '';
    if (!name) throw new Error('no_title');
    const meta = { name, author, desc, at: Date.now() };
    state.fanqieBookMeta.set(String(bookId), meta);
    return meta;
  } catch {
    return null; // 补查失败不阻塞，调用方降级为 □
  }
}

async function fanqieCategoryList() {
  const ttl = 24 * 3600 * 1000;
  if (state.fanqieCats.list && Date.now() - state.fanqieCats.at < ttl) return state.fanqieCats.list;
  const res = await fetchText('https://fanqienovel.com/rank', 'fanqie', { accept: 'text/html' });
  if (res.status !== 200) throw new Error(`番茄榜单页 ${res.status}`);
  const st = extractJsState(res.text, 'window.__INITIAL_STATE__=');
  const map = st?.rank?.rankCategoryTypeList || {};
  const list = [];
  for (const [gender, cats] of Object.entries(map)) {
    for (const c of Array.isArray(cats) ? cats : []) list.push({ id: String(c.id), name: String(c.name || ''), gender });
  }
  state.fanqieCats = { list, at: Date.now() };
  return list;
}

async function fanqieRankPage(seg1, seg2, catId) {
  const url = `https://fanqienovel.com/rank/${seg1}_${seg2}${catId ? `_${catId}` : ''}`;
  const res = await fetchText(url, 'fanqie', { accept: 'text/html' });
  if (res.status !== 200) throw new Error(`番茄榜单页 ${res.status}`);
  const st = extractJsState(res.text, 'window.__INITIAL_STATE__=');
  const list = st?.rank?.book_list || [];
  return list;
}

/** 番茄榜单：4 主榜 + 分类榜（分类名动态解析） */
async function fanqieRank(args) {
  const rankKey = normalizeFanqieRank(args.rank);
  if (!rankKey) return { error: `未识别的番茄榜单「${args.rank}」。番茄榜单：阅读榜（人气/在读）、新书榜。` };
  const gender = args.gender ? normalizeGender(args.gender) : 'male';
  if (!gender) return { error: `未识别频道「${args.gender}」，请传 男/女（male/female）。` };
  const seg1 = gender === 'male' ? 1 : 0;
  const meta = FANQIE_RANKS[rankKey];

  let catId = '';
  let catName = '';
  if (args.category !== undefined && args.category !== null && String(args.category).trim() !== '' && String(args.category).trim() !== '全部') {
    const cats = await fanqieCategoryList();
    const want = String(args.category).trim();
    const hit = cats.find((c) => c.name === want)
      || cats.find((c) => c.name.includes(want) || want.includes(c.name));
    if (!hit) {
      const pool = cats.filter((c) => c.gender === (gender === 'male' ? 'male' : 'female')).map((c) => c.name);
      return { error: `番茄未找到分类「${args.category}」。${gender === 'male' ? '男频' : '女频'}可用分类：${pool.join('、')}。` };
    }
    catId = hit.id; catName = hit.name;
  }
  const list = await fanqieRankPage(seg1, meta.seg, catId);
  const records = [];
  for (const [i, b] of list.entries()) {
    const bookMeta = await fanqieBookMeta(b.bookId);
    records.push({
      pos: i + 1,
      name: bookMeta?.name || cleanPua(b.bookName) || '',
      author: bookMeta?.author || cleanPua(b.author || ''),
      category: b.category || (Array.isArray(b.categoryV2) ? b.categoryV2.map((c) => c?.Name).filter(Boolean)[0] : '') || '',
      metric: b.readCount && b.readCount !== '0' ? `在读${fmtWan2(b.readCount)}` : (b.wordNumber ? `字数${fmtWan2(b.wordNumber)}` : ''),
      metricLabel: '在读/字数',
      desc: cleanPua(String(bookMeta?.desc || b.abstract || '')).replace(/^番茄小说提供.*?精彩小说尽在番茄小说网。/, '').replace(/\s+/g, '').slice(0, 60),
      bookId: String(b.bookId || ''),
      extra: b.lastChapterTitle ? `最新:${cleanPua(b.lastChapterTitle).slice(0, 18)}` : (b.rankPosDiff !== undefined && b.rankPosDiff !== null && Number(b.rankPosDiff) !== 0 ? `排位${b.rankPosDiff > 0 ? '↑' : '↓'}${Math.abs(b.rankPosDiff)}` : ''),
    });
  }
  const puaNote = records.some((r) => r.name.includes('□')) ? '（书名中□为番茄字体反爬缺字，用 bookId 可查详情还原真实书名）' : '';
  return {
    platform: 'fanqie', kind: 'rank', key: `${rankKey}_${seg1}${catId ? '_cat' + catId : ''}`,
    header: `番茄${meta.title}${catName ? `·${catName}` : ''}·${gender === 'male' ? '男频' : '女频'}`,
    records, stats: buildStats(records),
    notes: records.length ? puaNote : '该榜单本次没有返回数据（可能分类下暂无上榜书）。',
  };
}

/** 番茄书籍详情（指标取自 SSR state；书名/作者/简介用 JSON-LD 明文还原） */
async function fanqieBook(bookId) {
  const res = await fetchText(`https://fanqienovel.com/page/${bookId}`, 'fanqie', { accept: 'text/html' });
  if (res.status !== 200) throw new Error(`番茄详情页 ${res.status}`);
  const html = res.text;
  const st = extractJsState(html, 'window.__INITIAL_STATE__=');
  const pg = st?.page || {};
  if (!pg.bookId && !pg.bookName) throw new Error('番茄详情解析失败（页面结构变化或书不存在）');
  const bookMeta = await fanqieBookMeta(bookId);
  const tags = Array.isArray(pg.categoryV2) ? pg.categoryV2.map((c) => c?.Name).filter(Boolean) : [];
  const lines = [];
  lines.push(`《${bookMeta?.name || cleanPua(pg.bookName)}》 ${bookMeta?.author || cleanPua(pg.author || '')}｜${tags[0] || cleanPua(pg.category || '') || '未知分类'}`);
  lines.push(`状态：${pg.creationStatus === 0 ? '完结' : '连载中'}｜字数：${fmtWan2(pg.wordNumber)}｜在读：${fmtWan2(pg.readCount)}｜总章节：${pg.chapterTotal ?? '-'}`);
  lines.push(`最新章节：${cleanPua(pg.lastChapterTitle || '-')}`);
  if (tags.length) lines.push(`标签：${tags.slice(0, 8).map(cleanPua).join('、')}`);
  const desc = bookMeta?.desc || cleanPua(pg.abstract || '');
  if (desc) lines.push('', `简介：${String(desc).replace(/\s+/g, '').slice(0, 160)}…`);
  return {
    platform: 'fanqie', kind: 'book', key: `book_${bookId}`,
    header: '番茄书籍档案', records: [], stats: '', text: lines.join('\n'),
    snapshotData: { name: bookMeta?.name || cleanPua(pg.bookName), readCount: pg.readCount, wordNumber: pg.wordNumber, chapterTotal: pg.chapterTotal, lastChapterTitle: cleanPua(pg.lastChapterTitle || ''), creationStatus: pg.creationStatus },
  };
}

/* ════════════════ 七猫适配器 ════════════════ */

async function qimaoGet(url, headers = {}) {
  const res = await lenientGet(url, { 'user-agent': UA.qimao, 'accept-language': 'zh-CN,zh;q=0.9', ...headers });
  if (res.status !== 200) throw new Error(`七猫接口 ${res.status}`);
  return res;
}
function unpackNuxt(html) {
  return extractJsState(html, 'window.__NUXT__=');
}

async function qimaoRank(args) {
  const rankKey = normalizeQimaoRank(args.rank);
  if (!rankKey) return { error: `未识别的七猫榜单「${args.rank}」。七猫榜单：热门榜、新书榜、完本榜。` };
  const gender = args.gender ? normalizeGender(args.gender) : 'male';
  if (!gender) return { error: `未识别频道「${args.gender}」，请传 男/女（male/female）。` };
  const meta = QIMAO_RANKS[rankKey];
  const seg = gender === 'male' ? 'boy' : 'girl';
  const res = await qimaoGet(`https://www.qimao.com/paihang/${seg}/${meta.path}/date`);
  const st = unpackNuxt(res.text);
  // 榜单书单在 fetch.* 的 listData
  let list = [];
  for (const v of Object.values(st?.fetch || {})) {
    if (v && typeof v === 'object' && Array.isArray(v.listData)) { list = v.listData; break; }
  }
  if (!list.length) list = findKeyDeep(st, 'listData') || [];
  const records = list.map((b, i) => ({
    pos: i + 1,
    name: b.title || '',
    author: b.author || '',
    category: [b.category1_name, b.category2_name].filter(Boolean).join('/'),
    metric: b.words_num || '',
    metricLabel: '字数',
    desc: String(b.intro || '').replace(/\s+/g, '').slice(0, 60),
    bookId: String(b.book_id || ''),
    extra: b.is_over === '1' ? '完结' : '连载',
  }));
  return {
    platform: 'qimao', kind: 'rank', key: `${rankKey}_${seg}`,
    header: `七猫${meta.title}·${gender === 'male' ? '男频' : '女频'}`,
    records, stats: buildStats(records), notes: '',
  };
}

async function qimaoSearch(keyword) {
  const res = await qimaoGet(`https://www.qimao.com/qimaoapi/api/search/result?keyword=${encodeURIComponent(keyword)}&page=1&page_size=15`, {
    'accept': 'application/json',
    'referer': 'https://www.qimao.com/search/index/',
  });
  let j = null;
  try { j = JSON.parse(res.text); } catch { throw new Error('七猫搜索返回非 JSON'); }
  const list = j?.data?.search_list || [];
  return {
    platform: 'qimao', kind: 'search', key: `search_${keyword}`,
    header: `七猫搜索「${keyword}」（共 ${j?.data?.page_data?.count ?? list.length} 条）`,
    records: list.slice(0, 15).map((b) => ({
      name: b.title || '',
      author: b.author || '',
      category: [b.category1_name, b.category2_name].filter(Boolean).join('/'),
      metric: b.words_num || '',
      metricLabel: '字数',
      desc: String(b.intro || '').replace(/\s+/g, '').slice(0, 60),
      bookId: String(b.book_id || ''),
      extra: b.is_over === '1' ? '完结' : '连载',
    })),
    stats: '',
  };
}

async function qimaoBook(bookId) {
  const res = await qimaoGet(`https://www.qimao.com/shuku/${bookId}/`, { accept: 'text/html' });
  const st = unpackNuxt(res.text);
  let bd = null, ad = null;
  for (const v of Object.values(st?.fetch || {})) {
    if (v && typeof v === 'object' && v.dataaaa?.bookDetail) { bd = v.dataaaa.bookDetail; ad = v.dataaaa.authorDetail || {}; break; }
    if (v && typeof v === 'object' && v.bookDetail) { bd = v.bookDetail; ad = v.authorDetail || {}; break; }
  }
  if (!bd) {
    const found = findKeyDeep(st, 'bookDetail');
    bd = found?.bookDetail || found; ad = found?.authorDetail || ad;
  }
  if (!bd?.title && !bd?.book_id) throw new Error('七猫详情解析失败（页面结构变化或书不存在）');
  const lines = [];
  lines.push(`《${bd.title || ''}》 ${bd.author || ''}｜${[bd.category1_name, bd.category2_name].filter(Boolean).join('/')}`);
  lines.push(`状态：${bd.is_over === '1' ? '完结' : '连载中'}｜字数：${bd.words_num ? bd.words_num + '万字' : '-'}｜最新章节：${bd.latest_chapter_title || '-'}`);
  if (ad?.author_name) lines.push(`作者：${ad.author_name}（等级 ${ad.author_level || '-'}，累计 ${ad.total_words || '-'} 万字 / ${ad.total_days || '-'} 天，作品 ${ad.book_count ?? '-'} 部）`);
  if (bd.intro) lines.push('', `简介：${String(bd.intro).replace(/\s+/g, '').slice(0, 160)}…`);
  return {
    platform: 'qimao', kind: 'book', key: `book_${bookId}`,
    header: '七猫书籍档案', records: [], stats: '', text: lines.join('\n'),
    snapshotData: { name: bd.title, words: bd.words_num, latest_chapter_title: bd.latest_chapter_title, is_over: bd.is_over },
  };
}

/** 七猫分类数据：书库浏览页（channel 0=男 1=女；order: click=点击/热门 update_time=更新） */
async function qimaoCats() {
  const ttl = 24 * 3600 * 1000;
  if (state.qimaoCats.byChannel && Date.now() - state.qimaoCats.at < ttl) return state.qimaoCats.byChannel;
  const byChannel = {};
  for (const ch of ['0', '1']) {
    const res = await qimaoGet(`https://www.qimao.com/shuku/${ch}-a-a-a-a-a-a-click-1/`, { accept: 'text/html' });
    const st = unpackNuxt(res.text);
    let cats = [];
    for (const v of Object.values(st?.fetch || {})) {
      if (v && typeof v === 'object' && Array.isArray(v.categoryList)) { cats = v.categoryList; break; }
    }
    byChannel[ch] = cats;
  }
  state.qimaoCats = { byChannel, at: Date.now() };
  return byChannel;
}

async function qimaoCategoryRank(args) {
  const gender = args.gender ? normalizeGender(args.gender) : '';
  const order = /更新|update/i.test(String(args.rank || args.order || '')) ? 'update_time' : 'click';
  const byChannel = await qimaoCats();
  const want = String(args.category || '').trim();
  let channel = gender === 'male' ? '0' : gender === 'female' ? '1' : '';
  let catId = '', catName = '', subId = 'a';
  const trees = channel ? [[channel, byChannel[channel]]] : Object.entries(byChannel);
  for (const [ch, cats] of trees) {
    for (const c of cats || []) {
      if (c.name === want) { channel = ch; catId = c.id; catName = c.name; break; }
      for (const sub of c.children || []) {
        if (sub.name === want || sub.name.includes(want) || want.includes(sub.name)) {
          channel = ch; catId = c.id; subId = sub.id; catName = sub.name; break;
        }
      }
      if (catId) break;
    }
    if (catId) break;
  }
  if (!catId) {
    const pool = [...(byChannel['0'] || []), ...(byChannel['1'] || [])].map((c) => c.name);
    return { error: `七猫未找到分类「${args.category}」。可用一级分类：${pool.join('、')}（也支持其子分类，如"总裁豪门"）。` };
  }
  const pages = Math.min(3, Math.max(1, Math.trunc(Number(args.pages) || 1)));
  const records = [];
  for (let p = 1; p <= pages; p++) {
    // 书库 URL 为 9 段：channel-cat1-cat2-words-is_vip-is_over-?)-order-page（a=不限）
    const res = await qimaoGet(`https://www.qimao.com/shuku/${channel}-${catId}-${subId}-a-a-a-a-${order}-${p}/`, { accept: 'text/html' });
    const st = unpackNuxt(res.text);
    let list = [];
    for (const v of Object.values(st?.fetch || {})) {
      for (const [k, val] of Object.entries(v && typeof v === 'object' ? v : {})) {
        if (k === 'categoryFormData' || k === 'categoryList') continue;
        if (Array.isArray(val) && val.length && val[0] && (val[0].book_id || val[0].title)) { list = val; break; }
      }
      if (list.length) break;
    }
    if (!list.length) break;
    records.push(...list.map((b, i) => ({
      pos: (p - 1) * list.length + i + 1,
      name: b.title || '',
      author: b.author || '',
      category: [b.category1_name, b.category2_name].filter(Boolean).join('/'),
      metric: b.words_num || '',
      metricLabel: '字数',
      desc: String(b.intro || '').replace(/\s+/g, '').slice(0, 60),
      bookId: String(b.book_id || ''),
      extra: b.is_over === '1' ? '完结' : '连载',
    })));
  }
  return {
    platform: 'qimao', kind: 'rank', key: `cat_${channel}_${catId}_${subId}_${order}`,
    header: `七猫分类榜·${catName}·按${order === 'click' ? '热门' : '更新'}·${channel === '0' ? '男频' : '女频'}`,
    records, stats: buildStats(records), notes: '',
  };
}

/* ════════════════ 对比引擎（核心卖点） ════════════════ */

async function runCompare(args) {
  const days = normalizeDays(args.days);
  // 书籍对比：有 bookId/bookName 即走书
  const bookId = extractBookId(args.bookId);
  const platform = normalizePlatform(args.platform);
  if (bookId && platform) {
    const r = await executeInner({ action: 'book', platform, bookId, bookName: args.bookName });
    if (r.error) return r;
    const cur = r.result;
    const snap = loadSnapshotNear(platform, 'book', cur.key, days);
    return { text: formatBookCompare(platform, bookId, cur, snap, days) };
  }
  // 榜单对比
  if (!platform) return { error: '对比需要指定平台（起点/番茄/七猫）。' };
  const rankArgs = { ...args, action: 'rank' };
  const r = await executeInner(rankArgs);
  if (r.error) return r;
  const cur = r.result;
  if (!cur?.records?.length) return { error: '对比失败：当前榜单没有拿到数据。' };
  const snap = loadSnapshotNear(platform, 'rank', cur.key, days);
  return { text: formatRankCompare(cur, snap, days) };
}

function formatRankCompare(cur, snap, days) {
  const lines = [];
  lines.push(`【${cur.header} 对比：今天 vs ${days} 天前】`);
  if (!snap || !Array.isArray(snap.records) || !snap.records.length) {
    lines.push(`暂无 ${days} 天前的快照。快照库从部署起每日自动积累，之后对比会越来越准。`);
    lines.push('');
    lines.push(...renderRankRecords(cur).split('\n'));
    return clip(lines.join('\n'));
  }
  lines.push(`（对比基准快照：${snap.date}${snap.note ? '，' + snap.note : ''}）`);
  lines.push('');
  lines.push(renderRankDiff(cur, snap.data));
  lines.push('');
  lines.push(`—— 今日完整榜单 ——`);
  lines.push(renderRankRecords(cur));
  if (cur.stats) lines.push('', cur.stats);
  return clip(lines.join('\n'));
}

function renderRankDiff(cur, oldData) {
  const oldMap = new Map((oldData.records || []).map((r) => [String(r.name), r]));
  const curMap = new Map((cur.records || []).map((r) => [String(r.name), r]));
  const lines = [];
  for (const r of cur.records || []) {
    const prev = oldMap.get(String(r.name));
    if (!prev) { lines.push(`🆕 第${r.pos}名《${r.name}》新上榜`); continue; }
    const diff = Number(prev.pos) - Number(r.pos);
    const arrow = diff > 0 ? `↑${diff}` : diff < 0 ? `↓${-diff}` : '-';
    const metricNote = (prev.metric && r.metric && prev.metric !== r.metric) ? `，${prev.metric}→${r.metric}` : '';
    lines.push(`${arrow.padStart(2, ' ')} 第${r.pos}名《${r.name}》（原第${prev.pos}名${metricNote}）`);
  }
  const dropped = (oldData.records || []).filter((r) => !curMap.has(String(r.name))).map((r) => `《${r.name}》(原第${r.pos}名)`);
  if (dropped.length) lines.push(`⬇ 跌出当前榜单：${dropped.join('、')}`);
  return lines.join('\n');
}

function formatBookCompare(platform, bookId, cur, snap, days) {
  const lines = [];
  lines.push(`【${cur.text.split('\n')[0]} 对比：今天 vs ${days} 天前】`);
  if (!snap || !snap.snapshotData) {
    lines.push(`暂无 ${days} 天前的该书快照。快照库从部署起每日自动积累，之后对比会越来越准。`);
    lines.push('');
    lines.push(cur.text);
    return clip(lines.join('\n'));
  }
  const s = snap.snapshotData;
  lines.push(`（对比基准快照：${snap.date}${snap.note ? '，' + snap.note : ''}）`);
  for (const [label, now, old] of [
    ['收藏', cur.snapshotData?.collect, s.collect],
    ['总推荐', cur.snapshotData?.recomAll, s.recomAll],
    ['本月月票', cur.snapshotData?.monthTicket, s.monthTicket],
    ['月票排名', cur.snapshotData?.monthTicketRank, s.monthTicketRank],
    ['在读人数', cur.snapshotData?.readCount, s.readCount],
    ['字数', cur.snapshotData?.wordsCnt ?? cur.snapshotData?.wordNumber ?? cur.snapshotData?.words, s.wordsCnt ?? s.wordNumber ?? s.words],
  ]) {
    if (now === undefined || old === undefined || now === null || old === null) continue;
    const n = Number(now), o = Number(old);
    if (!Number.isFinite(n) || !Number.isFinite(o)) continue;
    const d = n - o;
    lines.push(`${label}：${fmtNum(o)} → ${fmtNum(n)}（${d >= 0 ? '+' : ''}${fmtNum(d)}）`);
  }
  if (cur.snapshotData?.updChapterName && s.updChapterName && cur.snapshotData.updChapterName !== s.updChapterName) {
    lines.push(`最新章节：${s.updChapterName} → ${cur.snapshotData.updChapterName}`);
  } else if (cur.snapshotData?.lastChapterTitle && s.lastChapterTitle && cur.snapshotData.lastChapterTitle !== s.lastChapterTitle) {
    lines.push(`最新章节：${s.lastChapterTitle} → ${cur.snapshotData.lastChapterTitle}`);
  }
  lines.push('');
  lines.push(cur.text);
  return clip(lines.join('\n'));
}

/* ════════════════ 工具函数 ════════════════ */

function findKeyDeep(obj, key, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 6) return null;
  if (Array.isArray(obj)) {
    for (const item of obj) { const r = findKeyDeep(item, key, depth + 1); if (r) return r; }
    return null;
  }
  if (obj[key] !== undefined) return obj[key];
  for (const v of Object.values(obj)) { const r = findKeyDeep(v, key, depth + 1); if (r) return r; }
  return null;
}
function fmtWan(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return '-';
  return num >= 10000 ? `${(num / 10000).toFixed(2)}万` : String(num);
}
function fmtWan2(v) {
  const s = String(v ?? '');
  if (/万/.test(s)) return s;
  const num = Number(s);
  if (!Number.isFinite(num)) return s || '-';
  return num >= 10000 ? `${(num / 10000).toFixed(1)}万` : s;
}
function fmtNum(v) {
  const num = Number(v);
  if (!Number.isFinite(num)) return String(v);
  return num >= 10000 ? `${(num / 10000).toFixed(2)}万` : String(num);
}
function buildStats(records) {
  if (!Array.isArray(records) || !records.length) return '';
  const catCount = {};
  for (const r of records) {
    const cat = String(r.category || '未知').split('/')[0] || '未知';
    catCount[cat] = (catCount[cat] || 0) + 1;
  }
  const cats = Object.entries(catCount).sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c}×${n}`);
  return `分类分布：${cats.join('、')}`;
}
function clip(text) {
  return text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n[内容截断]` : text;
}
function renderRankRecords(result) {
  return (result.records || []).map((r) => {
    const head = `${String(r.pos).padStart(2, ' ')}. 《${r.name}》${r.author ? ' ' + r.author : ''}｜${r.category || '-'}｜${r.metric ? r.metric : ''}${r.extra ? '｜' + r.extra : ''}${r.desc ? '｜' + r.desc + '…' : ''}`;
    return head;
  }).join('\n');
}

/* ════════════════ 执行入口（action 路由） ════════════════ */

async function executeInner(args) {
  const action = String(args.action || 'rank').trim().toLowerCase();
  if (action === 'config') return handleConfig(args);
  if (action === 'compare') return runCompare(args);

  const platform = normalizePlatform(args.platform);
  if (!platform) {
    return { error: `未识别平台「${args.platform || '(空)'}」。本能力支持：起点(qidian)、番茄(fanqie)、七猫(qimao)。` };
  }
  if (!isPlatformEnabled(platform)) return { error: `平台「${platform}」已在插件配置中停用。` };

  // 内容缓存（rank/search/book；时长 cacheHours，默认 12 小时）
  const cacheKey = `novel:${action}:${platform}:${JSON.stringify([args.rank || '', args.gender || '', args.category || '', args.month || '', args.pages || 1, args.keyword || '', args.bookId || '', args.bookName || ''])}`;
  const ttlH = Math.max(0, Number(pluginConfig.cacheHours) || 0);
  const cached = state.cache.get(cacheKey);
  if (cached && Date.now() - cached.at < ttlH * 3600000) {
    log('info', '网文数据通缓存命中', { action, platform });
    return cached.payload;
  }

  const out = await runAction(action, platform, args);
  if (!out.error && ttlH > 0) {
    state.cache.set(cacheKey, { at: Date.now(), payload: out });
    if (state.cache.size > 200) {
      const firstKey = state.cache.keys().next().value;
      state.cache.delete(firstKey);
    }
  }
  return out;
}

async function runAction(action, platform, args) {
  try {
    if (action === 'rank') {
      let result;
      if (platform === 'qidian') result = await qidianRank(args);
      else if (platform === 'fanqie') result = await fanqieRank(args);
      else {
        // 七猫：给了分类就走分类书库，否则走排行榜
        const wantsCat = args.category !== undefined && String(args.category).trim() !== '' && String(args.category).trim() !== '全部';
        result = wantsCat ? await qimaoCategoryRank(args) : await qimaoRank(args);
      }
      if (result.error) return result;
      if (result.kind === 'rank' && result.records?.length) await saveSnapshot(platform, 'rank', result.key, { header: result.header, records: result.records, stats: result.stats });
      return formatRankResult(result);
    }
    if (action === 'search') {
      const keyword = String(args.keyword || args.kw || args.bookName || '').trim();
      if (!keyword) return { error: '搜索需要 keyword 参数（书名/作者/主角名）。' };
      let result;
      if (platform === 'qidian') result = await qidianSearch(keyword);
      else if (platform === 'qimao') result = await qimaoSearch(keyword);
      else {
        return { error: '番茄没有公开的书名搜索 HTTP 通道。替代方案：① 用 web.search 搜"site:fanqienovel.com 关键词"拿到 fanqienovel.com/page/<bookId> 链接，再用本能力 action:"book" platform:"fanqie" 查该书详情；② 让用户提供番茄 App 分享的书籍链接或 ID。' };
      }
      if (result.error) return result;
      const text = [
        result.header,
        ...result.records.map((r) => `《${r.name}》 ${r.author}｜${r.category || '-'}｜${r.state || r.extra || ''}｜${r.metric}${r.bookId ? `｜ID:${r.bookId}` : ''}${r.desc ? '｜' + r.desc + '…' : ''}`),
        '',
        '提示：把上面感兴趣的书的 ID 传入 action:"book" 可查完整档案（收藏/月票/粉丝值等）。',
      ].join('\n');
      return { text: clip(text), result };
    }
    if (action === 'book') {
      const bookId = extractBookId(args.bookId || args.book_id || '');
      const bookName = String(args.bookName || args.book_name || args.keyword || '').trim();
      let finalId = bookId;
      let searchNote = '';
      if (!finalId && bookName && platform !== 'fanqie') {
        const sr = await executeInner({ action: 'search', platform, keyword: bookName });
        if (sr.error) return sr;
        const top = sr.result?.records?.[0];
        if (!top?.bookId) return { error: `没有搜到「${bookName}」的匹配结果，可换个书名关键词再试。` };
        finalId = top.bookId;
        searchNote = `（已按书名自动匹配：《${top.name}》/${top.author}；如不是这本书，请提供精确书名或书籍链接）`;
      }
      if (!finalId) {
        if (platform === 'fanqie') return { error: '番茄查书需要 bookId（fanqienovel.com/page/<数字> 里的数字）。可以先 web.search"site:fanqienovel.com 书名"拿到链接，或让用户提供番茄分享链接。' };
        return { error: '查书需要 bookId 或 bookName 参数（可传书籍详情页链接，会自动提取 ID）。' };
      }
      let result;
      if (platform === 'qidian') result = await qidianBook(finalId);
      else if (platform === 'fanqie') result = await fanqieBook(finalId);
      else result = await qimaoBook(finalId);
      if (result.error) return result;
      if (result.snapshotData) await saveSnapshot(platform, 'book', result.key, result.snapshotData);
      return { text: clip(result.text + (searchNote ? `\n${searchNote}` : '')), result };
    }
    return { error: `未知 action「${action}」。可用：rank（榜单）、search（搜书）、book（书籍详情）、compare（跨天对比）、config（查看/修改插件配置）。` };
  } catch (error) {
    const msg = String(error?.message || error);
    return { error: `${platformName(platform)}数据获取失败：${msg}。可稍后重试；若持续失败可能是站点结构变化或风控升级。`, retryable: true };
  }
}

function platformName(p) { return { qidian: '起点', fanqie: '番茄', qimao: '七猫' }[p] || p; }

function formatRankResult(result) {
  const text = [
    `【${result.header}】共 ${result.records.length} 本（${new Date().toLocaleString('zh-CN', { hour12: false })}）${result.notes || ''}`,
    renderRankRecords(result),
    ...(result.stats ? ['', '—— 本地统计 ——', result.stats] : []),
  ].join('\n');
  return { text: clip(text), result };
}

function handleConfig(args) {
  const op = String(args.op || args.mode || (args.cacheHours !== undefined || args.snapshotRetentionDays !== undefined || args.disabledPlatforms !== undefined ? 'set' : 'get')).toLowerCase();
  if (op === 'get' || op === 'show') {
    return { text: `【网文数据通 · 当前配置】（配置文件：capabilities/novel-platform.config.json）\n缓存时长：${pluginConfig.cacheHours} 小时（默认 12）\n快照保留：${pluginConfig.snapshotRetentionDays} 天\n请求间隔：${pluginConfig.minRequestIntervalMs} ms（防风控节流）\n已停用平台：${(pluginConfig.disabledPlatforms || []).join('、') || '无'}\n\n可修改项：cacheHours（缓存小时数）、snapshotRetentionDays（快照保留天数）、minRequestIntervalMs（请求最小间隔）、disabledPlatforms（停用平台数组）。回复时说"把缓存改成 X 小时"即可修改。` };
  }
  // set
  const changed = [];
  if (args.cacheHours !== undefined) {
    const v = Math.min(168, Math.max(0, Number(args.cacheHours)));
    if (Number.isFinite(v)) { pluginConfig.cacheHours = v; changed.push(`缓存时长 → ${v} 小时`); }
  }
  if (args.snapshotRetentionDays !== undefined) {
    const v = Math.min(365, Math.max(7, Number(args.snapshotRetentionDays)));
    if (Number.isFinite(v)) { pluginConfig.snapshotRetentionDays = v; changed.push(`快照保留 → ${v} 天`); }
  }
  if (args.minRequestIntervalMs !== undefined) {
    const v = Math.min(5000, Math.max(0, Number(args.minRequestIntervalMs)));
    if (Number.isFinite(v)) { pluginConfig.minRequestIntervalMs = v; changed.push(`请求间隔 → ${v} ms`); }
  }
  if (args.disabledPlatforms !== undefined) {
    const list = Array.isArray(args.disabledPlatforms) ? args.disabledPlatforms : String(args.disabledPlatforms).split(/[,，、\s]+/);
    const normalized = [...new Set(list.map(normalizePlatform).filter(Boolean))];
    pluginConfig.disabledPlatforms = normalized;
    changed.push(`停用平台 → ${normalized.join('、') || '无（全部启用)'}`);
  }
  saveConfigFile();
  return { text: `【网文数据通 · 配置已保存】\n${changed.length ? changed.join('\n') : '没有可识别的配置项，未做修改。'}\n\n当前：缓存 ${pluginConfig.cacheHours} 小时｜快照保留 ${pluginConfig.snapshotRetentionDays} 天｜请求间隔 ${pluginConfig.minRequestIntervalMs} ms｜停用：${(pluginConfig.disabledPlatforms || []).join('、') || '无'}` };
}

/* ════════════════ 插件注册 ════════════════ */

export default function createNovelPlatformPlugin(ctx) {
  state.pluginCtx = ctx;
  loadConfigFile(ctx.dataDir);
  log('info', '网文数据通插件已初始化', { cacheHours: pluginConfig.cacheHours, ua: UA });

  const descriptor = {
    id: 'novel.platform',
    name: '网文数据通（起点/番茄/七猫）',
    version: '1.0.0',
    description: [
      '拉取起点中文网、番茄小说、七猫小说的榜单与书籍数据，并支持跨天对比分析（核心能力）。四大 action：',
      '① rank 榜单：platform 必传；起点支持月票/畅销/阅读(追读)/书友/推荐/更新/签约/新书/新人/收藏/免费 11 榜，且支持 category 分类过滤（如"仙侠"）和 month 历史月份（仅月票榜，如"上月"）；番茄支持阅读榜(人气/在读)/新书榜+38个分类；七猫支持热门/新书/完本榜；七猫传 category 时返回该分类的热门/更新书库榜。gender 传 男/女。pages 1-3（每页约20本）。',
      '② search 搜书：keyword 传书名/作者/主角名，返回书名/作者/收藏/推荐/ID；番茄不支持 search（会返回替代方案）。',
      '③ book 书籍档案：bookId（可直接传书籍详情页链接，自动提取 ID）或 bookName（自动搜索匹配）。起点返回收藏/总推荐/月票及月票榜排名/推荐票/粉丝值/打赏/荣誉/最近章节；番茄返回在读人数/字数/总章节；七猫返回字数/作者数据。',
      '④ compare 对比：今天 vs N 天前（days 参数，默认 7）。不带 bookId 时对比当前榜单（排名升降/新上榜/跌出/指标变化），带 bookId 时对比单本书的数据变化（收藏/月票/在读增量）。对比基于每日自动落盘的快照，刚部署时历史不足会如实说明。',
      '⑤ config 配置：查看或修改插件配置（缓存时长 cacheHours 默认12小时、快照保留天数等）。用户说"把缓存改成6小时"时调用本 action。',
      '用户提到排行榜/榜单/网文/小说推荐/某本书数据/数据变化/涨没涨时使用。参数尽量用用户原话传回（中文别名可识别）；结果基于真实拉取数据回答并做分析，不要凭记忆编造。',
    ].join('\n'),
    provider: 'plugin-novel',
    mode: 'sync',
    riskLevel: 'low',
    mergeable: true,
    outputKinds: ['text'],
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'rank=榜单 | search=搜书 | book=书籍详情 | compare=跨天对比 | config=查看/修改配置' },
        platform: { type: 'string', description: '起点/番茄/七猫（中文、拼音、英文均可）' },
        rank: { type: 'string', description: '榜单名，用用户原话即可：如 月票榜/畅销榜/阅读榜/追读/推荐榜/新书榜/完本榜/热门榜；番茄可传分类名做分类榜' },
        gender: { type: 'string', description: '男/女（男频/女频）' },
        category: { type: 'string', description: '分类名，如 仙侠/都市/玄幻/总裁豪门；起点、番茄、七猫榜单均支持' },
        month: { type: 'string', description: '仅起点月票榜：历史月份，如 上月/2026-10/10月' },
        pages: { type: 'number', description: '榜单页数（可选，默认1，最多3）' },
        keyword: { type: 'string', description: 'search 用：书名/作者/主角名' },
        bookId: { type: 'string', description: 'book/compare 用：书籍ID或详情页链接' },
        bookName: { type: 'string', description: 'book 用：书名（无 ID 时自动搜索匹配）' },
        days: { type: 'number', description: 'compare 用：对比几天前，默认 7' },
        op: { type: 'string', description: 'config 用：get=查看 | set=修改' },
        cacheHours: { type: 'number', description: 'config 用：缓存时长（小时）' },
        snapshotRetentionDays: { type: 'number', description: 'config 用：快照保留天数' },
        disabledPlatforms: { type: 'string', description: 'config 用：要停用的平台（逗号分隔，传空启用全部）' },
      },
      additionalProperties: true,
    },
  };

  const handler = {
    async execute(invocation) {
      const started = Date.now();
      const args = invocation?.step?.args || {};
      const out = await executeInner(args);
      // 两类失败：retryable=true 是网络/站点故障（status=failed，可重试）；
      // 其余是参数纠正或使用引导（status=success + 文本，保证模型能看到并自行调整参数重试）。
      const isFailure = out.retryable === true;
      return {
        jobId: invocation?.step?.id || 'novel-platform',
        status: isFailure ? 'failed' : 'success',
        outputs: [{ kind: 'text', text: out.error || out.text, priority: 10, mergeable: true }],
        ...(isFailure ? { error: out.error, retryable: true } : {}),
        durationMs: Date.now() - started,
      };
    },
  };

  return { descriptor, handler };
}
