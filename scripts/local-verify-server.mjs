import http from 'node:http';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWebApi, derivePanelToken } from '../dist/packages/web-api/src/index.js';
import { getDefaultPrompts } from '../dist/packages/config/src/index.js';
import { createImageModule, renderPromptTemplate } from '../dist/packages/image/src/index.js';
import { createOpenAICompatibleAdapter } from '../dist/packages/llm/src/index.js';
import { NapcatAdapter } from '../dist/packages/napcat/src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const adminRoot = path.join(projectRoot, 'apps', 'panel', 'static', 'admin');
const canvasRoot = path.join(projectRoot, 'apps', 'panel', 'static', 'canvas');
const runtimeDir = process.env.MIOBOT_RUNTIME_DIR ? path.resolve(process.env.MIOBOT_RUNTIME_DIR) : path.join(projectRoot, '.runtime');
const configPath = process.env.MIOBOT_CONFIG_PATH ? path.resolve(process.env.MIOBOT_CONFIG_PATH) : path.join(runtimeDir, 'config.json');
const canvasStatePath = process.env.MIOBOT_CANVAS_STATE_PATH ? path.resolve(process.env.MIOBOT_CANVAS_STATE_PATH) : path.join(runtimeDir, 'canvas-state.json');
const canvasAssetDir = process.env.MIOBOT_CANVAS_ASSET_DIR ? path.resolve(process.env.MIOBOT_CANVAS_ASSET_DIR) : path.join(runtimeDir, 'canvas-assets');
const api = createWebApi({ initialConfig: await loadPersistedConfig() });
const port = Number(process.env.MIOBOT_PORT || process.env.MIOBOT_VERIFY_PORT || process.env.PORT || 3018);
const host = process.env.MIOBOT_HOST || process.env.HOST || 'localhost';
const persistedCanvasState = await loadPersistedCanvasState();

let gallery = Array.isArray(persistedCanvasState.gallery) ? persistedCanvasState.gallery : [];
let interrogations = initialInterrogationsFromState(persistedCanvasState);
let project = normalizePersistedProject(persistedCanvasState.project, interrogations);
const assets = restorePersistedAssets(persistedCanvasState, gallery, interrogations, project);
let canvasStateSaveTimer = null;
const imageJobs = new Map();
const interrogationJobs = new Map();
const systemLogs = [];
const canvasLogs = [];
let logSequence = 0;

const LOG_LEVEL_ORDER = { debug: 10, info: 20, warn: 30, error: 40 };
const DEFAULT_LOG_LIMIT = 300;

const sizePresets = [
  { id: 'square-1k', label: '1:1', width: 1024, height: 1024, description: 'Square composition' },
  { id: 'poster-portrait', label: '2:3', width: 1024, height: 1536, description: 'Classic portrait poster' },
  { id: 'portrait-2k', label: '3:4', width: 1152, height: 1536, description: 'Portrait photo and cover' },
  { id: 'wide-4k', label: '4:5', width: 1024, height: 1280, description: 'Social portrait crop' },
  { id: 'story-9-16', label: '9:16', width: 1152, height: 2048, description: 'Vertical screen and story image' },
  { id: 'video-16-9', label: '16:9', width: 2048, height: 1152, description: 'Video cover and presentation image' },
  { id: 'poster-landscape', label: '3:2', width: 1536, height: 1024, description: 'Classic landscape poster' },
  { id: 'square-2k', label: '4:3', width: 1536, height: 1152, description: 'Landscape photo and presentation' },
  { id: 'landscape-5-4', label: '5:4', width: 1280, height: 1024, description: 'Compact landscape crop' },
  { id: 'wide-2k', label: '21:9', width: 2688, height: 1152, description: 'Ultrawide cinematic composition' },
];
const stylePresets = [
  { id: 'none', label: 'None', prompt: '' },
  { id: 'photoreal', label: 'Photoreal', prompt: 'photorealistic, natural lighting, high detail, realistic materials' },
  { id: 'product', label: 'Product', prompt: 'premium product photography, clean studio lighting, sharp focus, commercial composition' },
  { id: 'illustration', label: 'Illustration', prompt: 'polished editorial illustration, clear shapes, rich but balanced colors, professional finish' },
  { id: 'poster', label: 'Poster', prompt: 'bold poster composition, strong focal point, refined typography space, cinematic color grading' },
  { id: 'avatar', label: 'Avatar', prompt: 'expressive avatar portrait, clean silhouette, high readability, distinctive character design' },
];

async function loadPersistedConfig() {
  try {
    const raw = await fs.readFile(configPath, 'utf8');
    return JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      console.warn(`[miobot] Failed to read persisted config from ${configPath}: ${error?.message || error}`);
    }
    return undefined;
  }
}

async function persistConfig(config) {
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');
}

async function persistSavedConfig(saved) {
  await persistConfig(saved.config);
  return saved;
}

function defaultCanvasProject(interrogationItems = []) {
  return {
    id: 'local-project',
    name: 'Miobot v2 Local Canvas',
    snapshot: null,
    history: [],
    interrogations: interrogationItems,
    updatedAt: new Date().toISOString(),
  };
}

function normalizePersistedProject(input, interrogationItems = []) {
  const base = defaultCanvasProject(interrogationItems);
  const project = input && typeof input === 'object' ? { ...base, ...input } : base;
  project.history = Array.isArray(project.history) ? project.history : [];
  project.interrogations = interrogationItems;
  project.updatedAt = project.updatedAt || new Date().toISOString();
  return project;
}

function collectAsset(asset, map) {
  if (!asset?.id) return;
  map.set(String(asset.id), asset);
}

function initialInterrogationsFromState(state = {}) {
  if (Array.isArray(state.interrogations)) return state.interrogations;
  if (Array.isArray(state.project?.interrogations)) return state.project.interrogations;
  return [];
}

function restorePersistedAssets(state, galleryItems = [], interrogationItems = [], projectState = {}) {
  const map = new Map();
  for (const asset of Array.isArray(state.assets) ? state.assets : []) collectAsset(asset, map);
  for (const item of galleryItems) collectAsset(item.asset, map);
  for (const item of interrogationItems) collectAsset(item.asset, map);
  for (const item of Array.isArray(projectState.interrogations) ? projectState.interrogations : []) collectAsset(item.asset, map);
  for (const record of Array.isArray(projectState.history) ? projectState.history : []) {
    for (const output of Array.isArray(record.outputs) ? record.outputs : []) collectAsset(output.asset, map);
  }
  return map;
}

async function loadPersistedCanvasState() {
  try {
    const raw = await fs.readFile(canvasStatePath, 'utf8');
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      console.warn(`[miobot] Failed to read canvas state from ${canvasStatePath}: ${error?.message || error}`);
    }
    return {};
  }
}

function canvasStatePayload() {
  project.interrogations = interrogations;
  return {
    version: 1,
    savedAt: new Date().toISOString(),
    project,
    gallery,
    interrogations,
    assets: Array.from(assets.values()),
  };
}

async function persistCanvasState() {
  if (canvasStateSaveTimer) {
    clearTimeout(canvasStateSaveTimer);
    canvasStateSaveTimer = null;
  }
  await fs.mkdir(path.dirname(canvasStatePath), { recursive: true });
  const tmpPath = `${canvasStatePath}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(canvasStatePayload(), null, 2), 'utf8');
  await fs.rename(tmpPath, canvasStatePath);
}

function queuePersistCanvasState() {
  if (canvasStateSaveTimer) clearTimeout(canvasStateSaveTimer);
  canvasStateSaveTimer = setTimeout(() => {
    canvasStateSaveTimer = null;
    persistCanvasState().catch((error) => {
      console.warn(`[miobot] Failed to persist canvas state to ${canvasStatePath}: ${error?.message || error}`);
    });
  }, 120);
  canvasStateSaveTimer.unref?.();
}

function publicAsset(asset) {
  if (!asset || typeof asset !== 'object') return asset;
  const out = { ...asset };
  if (out.id && (out.storagePath || String(out.url || '').startsWith('data:image/'))) {
    out.url = `/canvas-api/assets/${encodeURIComponent(out.id)}/download`;
  }
  delete out.storagePath;
  return out;
}

function publicGalleryItem(item) {
  return item ? { ...item, asset: publicAsset(item.asset) } : item;
}

function publicInterrogationItem(item) {
  return item ? { ...item, asset: publicAsset(item.asset) } : item;
}

function publicGenerationRecord(record) {
  if (!record || typeof record !== 'object') return record;
  return {
    ...record,
    outputs: Array.isArray(record.outputs)
      ? record.outputs.map((output) => ({ ...output, asset: publicAsset(output.asset) }))
      : [],
  };
}

function publicProjectState() {
  return {
    ...project,
    history: Array.isArray(project.history) ? project.history.map(publicGenerationRecord) : [],
    interrogations: interrogations.map(publicInterrogationItem),
  };
}

function currentConfig() { return api.repository.getConfig(); }
function currentSeed() { return currentConfig().panel.passwordSeed; }
function tokenFromHeader(headers = {}) { return String(headers.authorization || headers.Authorization || '').replace(/^Bearer\s+/i, '').trim(); }
function isAuthorized(headers = {}) { const token = tokenFromHeader(headers); const seed = currentSeed(); return token === seed || token === derivePanelToken(seed); }
function authBody(passwordSeedChanged = false) { const cfg = currentConfig(); return { token: cfg.panel.passwordSeed, tokenVersion: api.repository.tokenVersion, passwordSeedHash: api.repository.getAuthSnapshot(passwordSeedChanged).passwordSeedHash, passwordSeedChanged }; }

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization,content-type',
    'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    ...headers,
  });
  res.end(body);
}
function sendJson(res, status, body) { send(res, status, JSON.stringify(body, null, 2), { 'content-type': 'application/json; charset=utf-8' }); }
function sendHtml(res, html) { send(res, 200, html, { 'content-type': 'text/html; charset=utf-8' }); }

function redactForLog(value, depth = 0) {
  if (value === undefined || value === null) return value;
  if (depth > 5) return '[depth-limit]';
  if (typeof value === 'string') {
    if (value.startsWith('data:image/')) {
      const mime = value.match(/^data:([^;,]+)/i)?.[1] || 'image/*';
      return `[${mime} data-url, ${value.length} chars]`;
    }
    return value.length > 800 ? `${value.slice(0, 800)}…(${value.length} chars)` : value;
  }
  if (Array.isArray(value)) return value.map((item) => redactForLog(item, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (/token|secret|password|apikey|api_key|authorization|key$/i.test(key)) {
        out[key] = item ? '[redacted]' : item;
      } else {
        out[key] = redactForLog(item, depth + 1);
      }
    }
    return out;
  }
  return value;
}

function canvasLogOptions() {
  const cfg = currentConfig();
  const logs = cfg.canvas?.logs || {};
  return {
    enabled: logs.enabled !== false,
    level: String(logs.level || 'info').toLowerCase(),
    maxMemoryEntries: Math.max(100, Math.min(5000, Number(logs.maxMemoryEntries) || 1000)),
  };
}

function appendLog(target, level, scope, message, details) {
  const entry = {
    id: ++logSequence,
    timestamp: new Date().toISOString(),
    level,
    scope,
    message,
    details: redactForLog(details),
  };
  target.push(entry);
  const max = target === canvasLogs ? canvasLogOptions().maxMemoryEntries : 1000;
  if (target.length > max) target.splice(0, target.length - max);
  return entry;
}

function logSystem(level, scope, message, details) {
  return appendLog(systemLogs, level, scope, message, details);
}

function logCanvas(level, scope, message, details) {
  const options = canvasLogOptions();
  if (!options.enabled) return undefined;
  const min = LOG_LEVEL_ORDER[options.level] ?? LOG_LEVEL_ORDER.info;
  const current = LOG_LEVEL_ORDER[level] ?? LOG_LEVEL_ORDER.info;
  if (current < min) return undefined;
  return appendLog(canvasLogs, level, scope, message, details);
}

function readLogs(target, url, kind = 'system') {
  const level = String(url.searchParams.get('level') || 'all').toLowerCase();
  const search = String(url.searchParams.get('search') || '').trim().toLowerCase();
  const limit = Math.max(1, Math.min(1000, Number.parseInt(url.searchParams.get('limit') || String(DEFAULT_LOG_LIMIT), 10) || DEFAULT_LOG_LIMIT));
  const entries = target
    .filter((entry) => level === 'all' || entry.level === level)
    .filter((entry) => {
      if (!search) return true;
      return `${entry.timestamp} ${entry.level} ${entry.scope} ${entry.message} ${JSON.stringify(entry.details ?? '')}`.toLowerCase().includes(search);
    })
    .slice(-limit)
    .reverse();
  const options = kind === 'canvas' ? canvasLogOptions() : { maxMemoryEntries: 1000 };
  return {
    success: true,
    entries,
    stats: {
      total: target.length,
      filtered: entries.length,
      maxMemoryEntries: options.maxMemoryEntries,
      logFile: kind === 'canvas' ? 'memory://canvas' : 'memory://system',
    },
  };
}

function waitForNapcatOpen(adapter, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Napcat WebSocket 连接超时 (${timeoutMs}ms)`)), timeoutMs);
    const cleanup = () => clearTimeout(timer);
    adapter.on('open', (snapshot) => { cleanup(); resolve(snapshot); });
    adapter.on('error', (error) => { cleanup(); reject(error instanceof Error ? error : new Error(String(error))); });
    adapter.on('close', (event) => { cleanup(); reject(new Error(`Napcat WebSocket 已关闭: ${event?.code || ''} ${event?.reason || ''}`.trim())); });
    adapter.connect();
  });
}

async function testNapcatConnection() {
  const cfg = currentConfig();
  const wsUrl = String(cfg.napcat?.wsUrl || '').trim();
  if (!wsUrl) throw new Error('Napcat WebSocket 地址为空');
  const adapter = new NapcatAdapter({
    wsUrl,
    token: cfg.napcat?.token || '',
    actionTimeoutMs: cfg.napcat?.actionTimeoutMs || 15000,
    textSendTimeoutMs: cfg.napcat?.textSendTimeoutMs || 15000,
    imageSendTimeoutMs: cfg.napcat?.imageSendTimeoutMs || 120000,
    forwardSendTimeoutMs: cfg.napcat?.forwardSendTimeoutMs || 300000,
    getMessageTimeoutMs: cfg.napcat?.getMessageTimeoutMs || 10000,
    autoReconnect: false,
  });
  try {
    const snapshot = await waitForNapcatOpen(adapter, 8000);
    let loginInfo = undefined;
    try {
      const response = await adapter.callAction('get_login_info', {}, cfg.napcat?.actionTimeoutMs || 15000);
      loginInfo = response.data || response;
    } catch (error) {
      loginInfo = { warning: error?.message || String(error) };
    }
    return { snapshot, loginInfo };
  } finally {
    adapter.disconnect();
  }
}
async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return undefined;
  try { return JSON.parse(raw); } catch { return raw; }
}
function landing() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Miobot v2</title><style>
  body{margin:0;font-family:Inter,system-ui,'Microsoft YaHei',sans-serif;background:linear-gradient(135deg,#0f172a,#312e81);color:#e5e7eb}main{max-width:1100px;margin:0 auto;padding:64px 24px}.hero{padding:36px;border:1px solid rgba(255,255,255,.16);border-radius:28px;background:rgba(15,23,42,.72);box-shadow:0 24px 80px rgba(0,0,0,.35)}h1{font-size:44px;margin:0 0 12px}.cards{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px;margin-top:28px}.card{display:block;padding:24px;border:1px solid rgba(255,255,255,.14);border-radius:22px;background:rgba(255,255,255,.08);color:white;text-decoration:none}.card b{font-size:24px}.card p{color:#cbd5e1}.pill{display:inline-block;background:#22c55e22;border:1px solid #22c55e66;color:#bbf7d0;border-radius:999px;padding:6px 12px}.warn{margin-top:20px;color:#fde68a}@media(max-width:760px){.cards{grid-template-columns:1fr}h1{font-size:34px}}</style></head><body><main><section class="hero"><span class="pill">Miobot v2 local verify</span><h1>后台 + 画布验收入口</h1><p>已挂载真实构建后的后台前端和画布前端，API 由 v2 本地兼容层提供。默认登录密码：change-me-on-first-login。</p><div class="cards"><a class="card" href="/admin/"><b>后台管理</b><p>配置导入/导出、LLM、Bot、Free Mode、模板、Napcat、日志。</p></a><a class="card" href="/canvas/"><b>图像画布</b><p>画布、图库、文生图/改图模拟接口、本地项目状态。</p></a></div><p class="warn">说明：这是新项目目录下的本地验收服务；未修改旧项目文件。</p></section></main></body></html>`;
}
function mime(file) {
  const ext = path.extname(file).toLowerCase();
  return ext === '.html' ? 'text/html; charset=utf-8' : ext === '.js' ? 'text/javascript; charset=utf-8' : ext === '.css' ? 'text/css; charset=utf-8' : ext === '.svg' ? 'image/svg+xml' : ext === '.ico' ? 'image/x-icon' : ext === '.png' ? 'image/png' : ext === '.json' ? 'application/json; charset=utf-8' : 'application/octet-stream';
}
async function serveFile(res, root, requestPath, prefix, rewriteHtml = false) {
  let rel = decodeURIComponent(requestPath.slice(prefix.length)).replace(/^\/+/, '');
  if (!rel || rel.endsWith('/')) rel = path.join(rel, 'index.html');
  const file = path.resolve(root, rel);
  if (!file.startsWith(path.resolve(root))) return sendJson(res, 403, { error: 'Forbidden' });
  try {
    let data = await fs.readFile(file);
    if (rewriteHtml && path.basename(file) === 'index.html') {
      let html = data.toString('utf8')
        .replaceAll('href="/favicon.svg"', 'href="/canvas/favicon.svg"')
        .replaceAll('href="/favicon.ico"', 'href="/canvas/favicon.ico"')
        .replaceAll('src="/assets/', 'src="/canvas/assets/')
        .replaceAll('href="/assets/', 'href="/canvas/assets/');
      return send(res, 200, html, { 'content-type': 'text/html; charset=utf-8' });
    }
    return send(res, 200, data, { 'content-type': mime(file) });
  } catch {
    if (requestPath.startsWith(prefix)) {
      const index = path.join(root, 'index.html');
      if (fssync.existsSync(index)) return serveFile(res, root, `${prefix}/index.html`, prefix, rewriteHtml);
    }
    return sendJson(res, 404, { error: 'Not Found' });
  }
}

async function sendAssetResponse(res, asset) {
  if (asset?.storagePath) {
    const file = path.resolve(asset.storagePath);
    try {
      const data = await fs.readFile(file);
      return send(res, 200, data, {
        'content-type': asset.mimeType || mime(file),
        'cache-control': 'public, max-age=31536000, immutable',
        'content-disposition': `inline; filename="${String(asset.fileName || path.basename(file)).replace(/"/g, '').replace(/[^\x20-\x7E]/g, '_')}"`,
      });
    } catch {
      return sendJson(res, 404, { error: { code: 'not_found', message: 'Asset file not found' } });
    }
  }

  const parsed = parseDataUrl(asset?.url);
  if (parsed) {
    return send(res, 200, parsed.buffer, {
      'content-type': parsed.mimeType,
      'cache-control': 'public, max-age=31536000, immutable',
    });
  }

  if (asset?.url) return send(res, 302, '', { location: asset.url });
  return sendJson(res, 404, { error: { code: 'not_found', message: 'Asset not found' } });
}
function svgData(prompt, width = 1024, height = 1024) {
  const safe = String(prompt || 'Miobot v2').slice(0, 120).replace(/[<>&]/g, '');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs><linearGradient id="g" x1="0" x2="1" y1="0" y2="1"><stop stop-color="#6366f1"/><stop offset="1" stop-color="#06b6d4"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><circle cx="${width*0.75}" cy="${height*0.25}" r="${Math.min(width,height)*0.18}" fill="rgba(255,255,255,.22)"/><text x="50%" y="48%" text-anchor="middle" font-family="Arial, sans-serif" font-size="42" font-weight="700" fill="white">Miobot v2</text><text x="50%" y="56%" text-anchor="middle" font-family="Arial, sans-serif" font-size="24" fill="white">${safe}</text></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}
function presetSize(id) { const p = sizePresets.find(x => x.id === id) || sizePresets[0]; return { width: p.width, height: p.height, api: `${p.width}x${p.height}` }; }

function readImageDimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return undefined;

  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    return width > 0 && height > 0 ? { width, height } : undefined;
  }

  if (buffer[0] === 0xFF && buffer[1] === 0xD8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xFF) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1];
      if (marker === 0xD8 || marker === 0xD9) {
        offset += 2;
        continue;
      }
      const length = buffer.readUInt16BE(offset + 2);
      if (length < 2 || offset + 2 + length > buffer.length) break;
      const isStartOfFrame =
        (marker >= 0xC0 && marker <= 0xC3) ||
        (marker >= 0xC5 && marker <= 0xC7) ||
        (marker >= 0xC9 && marker <= 0xCB) ||
        (marker >= 0xCD && marker <= 0xCF);
      if (isStartOfFrame) {
        const height = buffer.readUInt16BE(offset + 5);
        const width = buffer.readUInt16BE(offset + 7);
        return width > 0 && height > 0 ? { width, height } : undefined;
      }
      offset += 2 + length;
    }
  }

  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buffer.toString('ascii', 12, 16);
    if (chunk === 'VP8X' && buffer.length >= 30) {
      const width = 1 + buffer.readUIntLE(24, 3);
      const height = 1 + buffer.readUIntLE(27, 3);
      return width > 0 && height > 0 ? { width, height } : undefined;
    }
    if (chunk === 'VP8 ' && buffer.length >= 30) {
      const width = buffer.readUInt16LE(26) & 0x3fff;
      const height = buffer.readUInt16LE(28) & 0x3fff;
      return width > 0 && height > 0 ? { width, height } : undefined;
    }
    if (chunk === 'VP8L' && buffer.length >= 25) {
      const b0 = buffer[21];
      const b1 = buffer[22];
      const b2 = buffer[23];
      const b3 = buffer[24];
      const width = 1 + (((b1 & 0x3f) << 8) | b0);
      const height = 1 + ((b3 << 6) | (b2 >> 2) | ((b1 & 0xc0) << 2));
      return width > 0 && height > 0 ? { width, height } : undefined;
    }
  }

  return undefined;
}

function imageDimensionsOrFallback(buffer, fallback) {
  return readImageDimensions(buffer) || { width: fallback.width, height: fallback.height };
}

function collectionQuery(url) {
  return {
    query: String(url.searchParams.get('query') || '').trim().toLowerCase(),
    favorite: ['1', 'true'].includes(String(url.searchParams.get('favorite') || '').toLowerCase()),
    status: ['done', 'failed'].includes(url.searchParams.get('status') || '') ? url.searchParams.get('status') : 'all',
    limit: Math.max(1, Math.min(240, Number.parseInt(url.searchParams.get('limit') || '120', 10) || 120)),
  };
}
function filterGalleryItems(items, url) {
  const q = collectionQuery(url);
  if (q.status === 'failed') return [];
  return items
    .filter(item => !q.favorite || item.favorite)
    .filter(item => !q.query || `${item.prompt} ${item.effectivePrompt} ${item.presetId} ${item.outputFormat}`.toLowerCase().includes(q.query))
    .slice(0, q.limit);
}
function filterInterrogationItems(items, url) {
  const q = collectionQuery(url);
  if (q.status === 'failed') return [];
  return items
    .filter(item => !q.favorite || item.favorite)
    .filter(item => !q.query || `${item.prompt} ${item.templatePrompt} ${item.fileName || ''}`.toLowerCase().includes(q.query))
    .slice(0, q.limit);
}
function updateGalleryFavorite(outputId, favorite) {
  let updated = false;
  gallery = gallery.map(item => {
    if (item.outputId !== outputId) return item;
    updated = true;
    return { ...item, favorite };
  });
  if (updated) queuePersistCanvasState();
  return updated;
}
function updateInterrogationFavorite(id, favorite) {
  let updated = false;
  interrogations = interrogations.map(item => {
    if (item.id !== id) return item;
    updated = true;
    return { ...item, favorite };
  });
  project.interrogations = interrogations;
  if (updated) queuePersistCanvasState();
  return updated;
}

function deleteGalleryItem(outputId) {
  const item = gallery.find(entry => entry.outputId === outputId);
  if (!item) return null;
  gallery = gallery.filter(entry => entry.outputId !== outputId);
  for (const record of project.history) {
    if (!Array.isArray(record.outputs)) continue;
    record.outputs = record.outputs.filter(output => output.id !== outputId);
  }
  if (item.asset?.id) assets.delete(item.asset.id);
  project.history = project.history.filter(record => Array.isArray(record.outputs) && record.outputs.length > 0);
  project.updatedAt = new Date().toISOString();
  queuePersistCanvasState();
  return item;
}

function deleteInterrogationItem(id) {
  const item = interrogations.find(entry => entry.id === id);
  if (!item) return null;
  interrogations = interrogations.filter(entry => entry.id !== id);
  if (item.asset?.id) assets.delete(item.asset.id);
  project.interrogations = interrogations;
  project.updatedAt = new Date().toISOString();
  queuePersistCanvasState();
  return item;
}

function managedCards() {
  return [
    ...gallery.map(item => ({
      kind: 'gallery',
      id: item.outputId,
      title: item.prompt,
      subtitle: `${item.size?.width || 0}x${item.size?.height || 0} · ${String(item.outputFormat || '').toUpperCase()}`,
      createdAt: item.createdAt,
      favorite: Boolean(item.favorite),
      status: item.status || 'succeeded',
      asset: publicAsset(item.asset),
    })),
    ...interrogations.map(item => ({
      kind: 'interrogation',
      id: item.id,
      title: item.templatePrompt || item.prompt,
      subtitle: item.fileName ? `模板库 · ${item.fileName}` : '模板库',
      createdAt: item.createdAt,
      favorite: Boolean(item.favorite),
      status: 'succeeded',
      asset: publicAsset(item.asset),
    })),
  ].sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')));
}

function publicJob(job) {
  if (!job) return undefined;
  const { timer, ...safe } = job;
  if (safe.record) safe.record = publicGenerationRecord(safe.record);
  if (safe.item) safe.item = publicInterrogationItem(safe.item);
  return safe;
}

function startBackgroundJob(map, job, runner, logScope) {
  map.set(job.id, job);
  job.timer = setInterval(() => {
    if (job.status !== 'running') return;
    job.progress = Math.min(92, Math.max(job.progress || 12, Math.round((job.progress || 12) + 3 + Math.random() * 6)));
    job.updatedAt = new Date().toISOString();
  }, 1400);
  job.timer.unref?.();

  queueMicrotask(async () => {
    const startedAt = Date.now();
    try {
      job.status = 'running';
      job.progress = Math.max(job.progress || 0, 12);
      job.updatedAt = new Date().toISOString();
      logCanvas('info', logScope, '后台任务开始', { jobId: job.id, mode: job.mode });
      const result = await runner();
      if (job.kind === 'interrogation') job.item = result;
      else job.record = result;
      job.status = 'succeeded';
      job.progress = 100;
      job.updatedAt = new Date().toISOString();
      logCanvas('info', logScope, '后台任务完成', { jobId: job.id, durationMs: Date.now() - startedAt });
    } catch (error) {
      job.status = 'failed';
      job.progress = 100;
      job.error = asErrorMessage(error);
      job.updatedAt = new Date().toISOString();
      logCanvas('error', logScope, '后台任务失败', { jobId: job.id, durationMs: Date.now() - startedAt, error: job.error });
    } finally {
      if (job.timer) clearInterval(job.timer);
      setTimeout(() => map.delete(job.id), 30 * 60 * 1000).unref?.();
    }
  });
  return publicJob(job);
}

function createImageJob(mode, body) {
  const now = new Date().toISOString();
  const job = {
    kind: 'image',
    id: `img_job_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
    mode,
    status: 'queued',
    progress: 5,
    createdAt: now,
    updatedAt: now,
  };
  return startBackgroundJob(imageJobs, job, () => runCanvasGeneration(mode, body), 'canvas.image');
}

function createInterrogationJob(image) {
  const now = new Date().toISOString();
  const job = {
    kind: 'interrogation',
    id: `int_job_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
    status: 'queued',
    progress: 5,
    createdAt: now,
    updatedAt: now,
  };
  return startBackgroundJob(interrogationJobs, job, () => runCanvasInterrogation(image), 'canvas.interrogate');
}

function asErrorMessage(error) {
  return error?.normalized?.message || error?.message || String(error);
}

function imageMimeFromDataUrl(dataUrl) {
  const match = String(dataUrl || '').match(/^data:([^;,]+)[;,]/i);
  return match?.[1] || 'image/png';
}

function mimeFromOutputFormat(format) {
  const normalized = String(format || '').toLowerCase();
  if (normalized === 'jpeg' || normalized === 'jpg') return 'image/jpeg';
  if (normalized === 'webp') return 'image/webp';
  return 'image/png';
}

function extensionFromMime(mimeType, outputFormat) {
  if (mimeType === 'image/jpeg') return 'jpg';
  if (mimeType === 'image/webp') return 'webp';
  if (mimeType === 'image/png') return 'png';
  const fallback = String(outputFormat || 'png').toLowerCase();
  return fallback === 'jpeg' ? 'jpg' : fallback;
}

function normalizeOutputFormat(value, fallback = 'png') {
  const format = String(value || fallback || 'png').toLowerCase();
  return ['png', 'jpeg', 'webp'].includes(format) ? format : 'png';
}

function normalizeQuality(value) {
  const quality = String(value || '').toLowerCase();
  return ['low', 'medium', 'high'].includes(quality) ? quality : undefined;
}

function resolveRequestSize(body = {}) {
  const presetId = String(body.sizePresetId || '').trim();
  const raw = body.size;
  const width = Number(raw?.width);
  const height = Number(raw?.height);
  const hasExplicitSize = Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0;
  if (presetId === 'auto') {
    const fallback = hasExplicitSize ? { width: Math.trunc(width), height: Math.trunc(height) } : presetSize('square-1k');
    return { ...fallback, api: 'auto', auto: true };
  }
  if (hasExplicitSize) {
    return { width: Math.trunc(width), height: Math.trunc(height), api: `${Math.trunc(width)}x${Math.trunc(height)}` };
  }
  return presetSize(body.sizePresetId || body.presetId);
}

function sizeFromResolution(value, fallback = presetSize('square-1k')) {
  const match = String(value || '').match(/^(\d{2,5})x(\d{2,5})$/i);
  if (!match) return fallback;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return { width, height, api: `${width}x${height}` };
}

function buildEffectivePrompt(rawPrompt, presetId) {
  const prompt = String(rawPrompt || '').trim();
  const style = stylePresets.find((item) => item.id === presetId);
  const stylePrompt = String(style?.prompt || '').trim();
  return [prompt, stylePrompt].filter(Boolean).join('\n');
}

function enabledNodeAt(index) {
  const cfg = currentConfig();
  const nodes = Array.isArray(cfg.llm?.apiKeys) ? cfg.llm.apiKeys : [];
  const indexed = nodes[Math.max(0, Math.min(nodes.length - 1, Number(index) || 0))];
  return indexed?.enabled === false ? nodes.find(node => node?.enabled !== false) : indexed;
}

function assertCanvasNode(index, capabilityLabel) {
  const node = enabledNodeAt(index);
  if (!node?.baseUrl) {
    throw new Error(`画布${capabilityLabel}没有可用的模型节点。请在后台「画布配置」里选择已启用且带基础地址的节点。`);
  }
  return node;
}

function assertCanvasVisionNode(index) {
  return assertCanvasNode(index, '反推');
}

function assertCanvasImageNode(index, capabilityLabel = '生图') {
  return assertCanvasNode(index, capabilityLabel);
}

function createNodeAdapter(node, timeoutMs) {
  return createOpenAICompatibleAdapter({
    node: {
      name: node.name,
      provider: node.provider,
      baseUrl: node.baseUrl,
      apiKey: node.apiKey ?? node.key,
      key: node.key,
      headers: node.headers,
    },
    timeoutMs,
    retryPolicy: { retries: 0, delayMs: 0 },
  });
}

async function runCanvasInterrogation(image) {
  if (!image?.dataUrl) throw new Error('缺少上传图片数据。');
  const startedAt = Date.now();
  logCanvas('info', 'canvas.interrogate', '开始图片反推', { fileName: image.fileName, hasImage: Boolean(image.dataUrl) });
  const cfg = currentConfig();
  const canvas = cfg.canvas || {};
  const firstNode = assertCanvasVisionNode(canvas.interrogateNodeIndex);
  const firstAdapter = createOpenAICompatibleAdapter({
    node: {
      name: firstNode.name,
      provider: firstNode.provider,
      baseUrl: firstNode.baseUrl,
      apiKey: firstNode.apiKey ?? firstNode.key,
      key: firstNode.key,
      headers: firstNode.headers,
    },
    timeoutMs: canvas.interrogateTimeoutMs || 300000,
    retryPolicy: { retries: 0, delayMs: 0 },
  });
  const module = createImageModule({
    llm: firstAdapter,
    imageModel: canvas.imageModel || cfg.llm?.imageModel || 'gpt-image-2',
    interrogateModel: canvas.interrogateModel || cfg.llm?.interrogateModel || cfg.llm?.chatModel || 'gpt-4o-mini',
    interrogatePromptTemplate: canvas.interrogatePromptTemplate || getDefaultPrompts().interrogatePromptTemplate,
    interrogateTimeoutMs: canvas.interrogateTimeoutMs || 300000,
  });
  const first = await module.interrogate({
    imageUrl: image.dataUrl,
    timeoutMs: canvas.interrogateTimeoutMs || 300000,
  });

  const templateNode = assertCanvasVisionNode(canvas.interrogateTemplateNodeIndex ?? canvas.interrogateNodeIndex);
  const templateAdapter = createOpenAICompatibleAdapter({
    node: {
      name: templateNode.name,
      provider: templateNode.provider,
      baseUrl: templateNode.baseUrl,
      apiKey: templateNode.apiKey ?? templateNode.key,
      key: templateNode.key,
      headers: templateNode.headers,
    },
    timeoutMs: canvas.interrogateTemplateTimeoutMs || canvas.interrogateTimeoutMs || 300000,
    retryPolicy: { retries: 0, delayMs: 0 },
  });
  const templatePrompt = renderPromptTemplate(
    canvas.interrogateTemplatePromptTemplate || getDefaultPrompts().interrogateTemplatePromptTemplate,
    { rawPrompt: first.text, prompt: first.text, input: first.text }
  ) || `请把下面的图像描述改写为包含 {{prompt}} 占位符的图像生成模板：\n${first.text}`;
  const second = await templateAdapter.createVision({
    model: canvas.interrogateTemplateModel || canvas.interrogateModel || cfg.llm?.chatModel || 'gpt-4o-mini',
    prompt: templatePrompt,
    imageUrls: [image.dataUrl],
    timeoutMs: canvas.interrogateTemplateTimeoutMs || canvas.interrogateTimeoutMs || 300000,
  });

  const now = new Date().toISOString();
  const id = `int_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
  const asset = await assetFromDataUrl(image.dataUrl, id, image.fileName || `${id}.png`, { width: 1024, height: 1024 }, 'png');
  assets.set(id, asset);
  const item = {
    id,
    prompt: String(first.text || '').trim(),
    templatePrompt: String(second.text || first.text || '').trim(),
    fileName: image.fileName,
    createdAt: now,
    favorite: false,
    asset,
  };
  interrogations = [item, ...interrogations].slice(0, 50);
  project.interrogations = interrogations;
  project.updatedAt = now;
  logCanvas('info', 'canvas.interrogate', '图片反推完成', { id, durationMs: Date.now() - startedAt, fileName: image.fileName });
  await persistCanvasState();
  return item;
}

function parseDataUrl(value) {
  const match = String(value || '').match(/^data:([^;,]+)(;base64)?,(.*)$/is);
  if (!match) return undefined;
  const mimeType = match[1] || 'image/png';
  const isBase64 = Boolean(match[2]);
  const raw = match[3] || '';
  return {
    mimeType,
    buffer: isBase64 ? Buffer.from(raw, 'base64') : Buffer.from(decodeURIComponent(raw), 'utf8'),
  };
}

async function writeAssetFile(assetId, mimeType, outputFormat, buffer) {
  const extension = extensionFromMime(mimeType, outputFormat);
  const fileName = `${assetId}.${extension}`;
  const storagePath = path.join(canvasAssetDir, fileName);
  await fs.mkdir(canvasAssetDir, { recursive: true });
  await fs.writeFile(storagePath, buffer);
  return { fileName, storagePath };
}

async function assetFromDataUrl(dataUrl, assetId, fileName, size, outputFormat = 'png') {
  const parsed = parseDataUrl(dataUrl);
  if (!parsed) {
    return {
      id: assetId,
      url: dataUrl,
      fileName: fileName || `${assetId}.${extensionFromMime(undefined, outputFormat)}`,
      mimeType: imageMimeFromDataUrl(dataUrl),
      width: size.width,
      height: size.height,
    };
  }
  const dimensions = imageDimensionsOrFallback(parsed.buffer, size);
  const stored = await writeAssetFile(assetId, parsed.mimeType, outputFormat, parsed.buffer);
  return {
    id: assetId,
    url: `/canvas-api/assets/${encodeURIComponent(assetId)}/download`,
    fileName: fileName || stored.fileName,
    mimeType: parsed.mimeType,
    width: dimensions.width,
    height: dimensions.height,
    storagePath: stored.storagePath,
  };
}

async function assetFromArtifact(artifact, assetId, size, outputFormat) {
  const mimeType = artifact.mimeType || mimeFromOutputFormat(outputFormat);
  const extension = extensionFromMime(mimeType, outputFormat);
  if (artifact.kind === 'base64') {
    const bytes = Buffer.from(artifact.data, 'base64');
    const dimensions = imageDimensionsOrFallback(bytes, size);
    const stored = await writeAssetFile(assetId, mimeType, outputFormat, bytes);
    return {
      id: assetId,
      url: `/canvas-api/assets/${encodeURIComponent(assetId)}/download`,
      fileName: stored.fileName,
      mimeType,
      width: dimensions.width,
      height: dimensions.height,
      storagePath: stored.storagePath,
    };
  }
  return {
    id: assetId,
    url: artifact.data,
    fileName: `${assetId}.${extension}`,
    mimeType,
    width: size.width,
    height: size.height,
  };
}

function normalizeBotGalleryArtifacts(input) {
  const source = Array.isArray(input?.artifacts)
    ? input.artifacts
    : Array.isArray(input?.images)
      ? input.images
      : [];
  return source
    .map((item, index) => {
      if (typeof item === 'string') {
        const text = item.trim();
        if (!text) return undefined;
        if (text.startsWith('base64://')) return { kind: 'base64', data: text.slice('base64://'.length), mimeType: 'image/png', index };
        if (/^data:image\//i.test(text)) return { kind: 'dataUrl', data: text, index };
        return { kind: 'url', data: text, index };
      }
      if (!item || typeof item !== 'object') return undefined;
      const data = String(item.data || item.url || '').trim();
      if (!data) return undefined;
      if (/^data:image\//i.test(data)) return { ...item, kind: 'dataUrl', data, index: Number.isFinite(Number(item.index)) ? Number(item.index) : index };
      const kind = item.kind === 'url' ? 'url' : item.kind === 'dataUrl' ? 'dataUrl' : 'base64';
      return {
        kind,
        data: kind === 'base64' && data.startsWith('base64://') ? data.slice('base64://'.length) : data,
        mimeType: item.mimeType,
        revisedPrompt: item.revisedPrompt,
        index: Number.isFinite(Number(item.index)) ? Number(item.index) : index,
      };
    })
    .filter(Boolean);
}

async function assetFromBotGalleryArtifact(artifact, assetId, size, outputFormat) {
  if (artifact.kind === 'dataUrl') {
    return assetFromDataUrl(artifact.data, assetId, undefined, size, outputFormat);
  }
  return assetFromArtifact(artifact, assetId, size, outputFormat);
}

function normalizeBotRecordQuality(value) {
  const quality = String(value || 'auto').toLowerCase();
  return ['auto', 'low', 'medium', 'high'].includes(quality) ? quality : 'auto';
}

function safeBotRecordId(value) {
  const cleaned = String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_.-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 96);
  return cleaned || `bot_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
}

async function addBotGalleryRecord(input = {}) {
  const artifacts = normalizeBotGalleryArtifacts(input);
  if (!artifacts.length) throw new Error('Bot image result is empty');

  const outputFormat = normalizeOutputFormat(input.outputFormat, 'png');
  const size = sizeFromResolution(input.sizeApiValue || input.size, presetSize('square-1k'));
  const mode = input.mode === 'edit' ? 'edit' : 'generate';
  const now = new Date().toISOString();
  const id = safeBotRecordId(input.taskId);
  const prompt = String(input.prompt || input.rawPrompt || '').trim() || '[Bot image]';
  const effectivePrompt = String(input.effectivePrompt || input.prompt || input.rawPrompt || '').trim() || prompt;

  const outputs = await Promise.all(artifacts.map(async (artifact, index) => {
    const assetId = `${id}_${index + 1}`;
    const asset = await assetFromBotGalleryArtifact(artifact, assetId, size, outputFormat);
    assets.set(assetId, asset);
    return { id: `out_${assetId}`, status: 'succeeded', favorite: false, asset };
  }));
  const firstAsset = outputs.find((output) => output.asset)?.asset;
  const recordSize = firstAsset
    ? { width: firstAsset.width || size.width, height: firstAsset.height || size.height }
    : { width: size.width, height: size.height };

  const record = {
    id,
    mode,
    prompt,
    effectivePrompt,
    presetId: 'bot',
    size: recordSize,
    quality: normalizeBotRecordQuality(input.quality),
    outputFormat,
    count: outputs.length,
    status: 'succeeded',
    referenceAssetIds: [],
    createdAt: now,
    outputs,
    source: 'bot',
    botContext: input.context && typeof input.context === 'object'
      ? {
          chatType: String(input.context.chatType || ''),
          groupId: String(input.context.groupId || ''),
          userId: String(input.context.userId || ''),
        }
      : undefined,
  };

  project.history = [record, ...project.history].slice(0, 50);
  project.updatedAt = now;
  gallery = galleryItemsForRecord(record).concat(gallery).slice(0, 500);
  logCanvas('info', 'canvas.bot', 'Bot image imported into gallery', {
    recordId: record.id,
    mode: record.mode,
    outputCount: outputs.length,
    command: String(input.command || ''),
  });
  await persistCanvasState();
  return record;
}

function galleryItemsForRecord(record) {
  return record.outputs
    .filter((output) => output.status === 'succeeded' && output.asset)
    .map((output) => ({
      outputId: output.id,
      generationId: record.id,
      mode: record.mode,
      prompt: record.prompt,
      effectivePrompt: record.effectivePrompt,
      presetId: record.presetId,
      size: record.size,
      quality: record.quality,
      outputFormat: record.outputFormat,
      status: output.status,
      favorite: false,
      createdAt: record.createdAt,
      asset: output.asset,
    }));
}

async function runCanvasGeneration(mode, body = {}) {
  const startedAt = Date.now();
  const cfg = currentConfig();
  const canvas = cfg.canvas || {};
  const isEdit = mode === 'edit';
  const rawPrompt = String(body.prompt || '').trim();
  if (!rawPrompt) throw new Error('请输入提示词。');

  const size = resolveRequestSize(body);
  const outputFormat = normalizeOutputFormat(body.outputFormat, canvas.defaultOutputFormat || 'png');
  const quality = normalizeQuality(body.quality || canvas.defaultQuality);
  const count = Math.max(1, Math.min(16, Math.trunc(Number(body.count || canvas.defaultCount || 1) || 1)));
  const prompt = buildEffectivePrompt(rawPrompt, body.presetId) || rawPrompt;
  const timeoutMs = canvas.imageTimeoutMs || cfg.llm?.imageTimeoutMs || 300000;
  const node = assertCanvasImageNode(isEdit ? canvas.editNodeIndex : canvas.imageNodeIndex, isEdit ? '改图' : '生图');
  const model = isEdit
    ? (canvas.editModel || cfg.llm?.editModel || canvas.imageModel || cfg.llm?.imageModel)
    : (canvas.imageModel || cfg.llm?.imageModel);
  if (!model) throw new Error(`画布${isEdit ? '改图' : '生图'}没有配置模型。请在后台「画布配置」选择模型。`);
  logCanvas('info', 'canvas.image', '开始图像任务', {
    mode: isEdit ? 'edit' : 'generate',
    model,
    node: node.name,
    promptChars: rawPrompt.length,
    size: size.api,
    count,
    quality: quality || 'auto',
    outputFormat,
  });

  const adapter = createNodeAdapter(node, timeoutMs);
  let result;
  if (isEdit) {
    const references = Array.isArray(body.referenceImages)
      ? body.referenceImages
      : body.referenceImage
        ? [body.referenceImage]
        : [];
    const images = references
      .map((image) => String(image?.dataUrl || image?.url || '').trim())
      .filter(Boolean);
    if (!images.length) throw new Error('改图缺少参考图。');
    const mask = String(body.maskImage?.dataUrl || body.maskImage?.url || '').trim() || undefined;
    result = await adapter.editImage({
      model,
      prompt,
      images,
      mask,
      size: size.api,
      quality,
      timeoutMs,
    });
  } else {
    result = await adapter.generateImages({
      model,
      prompt,
      size: size.api,
      count,
      quality,
      timeoutMs,
    });
  }

  if (!Array.isArray(result.images) || result.images.length === 0) {
    throw new Error('上游没有返回图片数据。');
  }

  const now = new Date().toISOString();
  const id = `gen_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
  const outputs = await Promise.all(result.images.map(async (artifact, index) => {
    const assetId = `${id}_${index + 1}`;
    const asset = await assetFromArtifact(artifact, assetId, size, outputFormat);
    assets.set(assetId, asset);
    return { id: `out_${assetId}`, status: 'succeeded', favorite: false, asset };
  }));
  const firstAsset = outputs.find((output) => output.asset)?.asset;
  const recordSize = size.auto && firstAsset
    ? { width: firstAsset.width, height: firstAsset.height }
    : { width: size.width, height: size.height };

  const record = {
    id,
    mode: isEdit ? 'edit' : 'generate',
    prompt: rawPrompt,
    effectivePrompt: result.images.find((item) => item.revisedPrompt)?.revisedPrompt || prompt,
    presetId: body.presetId || 'none',
    size: recordSize,
    quality: body.quality || canvas.defaultQuality || 'auto',
    outputFormat,
    count: outputs.length,
    status: 'succeeded',
    referenceAssetIds: [],
    createdAt: now,
    outputs,
  };
  project.history = [record, ...project.history].slice(0, 50);
  project.updatedAt = now;
  gallery = galleryItemsForRecord(record).concat(gallery).slice(0, 500);
  logCanvas('info', 'canvas.image', '图像任务完成', {
    recordId: record.id,
    mode: record.mode,
    outputCount: outputs.length,
    durationMs: Date.now() - startedAt,
  });
  await persistCanvasState();
  return record;
}

async function handleCompatApi(req, res, url) {
  const body = ['POST','PUT','PATCH'].includes(req.method || '') ? await readBody(req) : undefined;
  const p = url.pathname;
  if (req.method === 'POST' && p === '/api/login') {
    const password = typeof body === 'object' && body ? String(body.password || '') : '';
    if (password !== currentSeed()) return sendJson(res, 401, { error: '密码错误' });
    return sendJson(res, 200, { success: true, token: currentSeed(), auth: authBody(false), config: currentConfig(), revision: api.repository.revision });
  }
  if (!isAuthorized(req.headers)) return sendJson(res, 401, { error: 'Unauthorized' });
  if (req.method === 'GET' && p === '/api/config') return sendJson(res, 200, currentConfig());
  if (req.method === 'POST' && p === '/api/config') { const saved = await persistSavedConfig(api.repository.saveConfig(body)); logSystem('info', 'admin.config', '配置已保存', { changedPaths: saved.hotReload?.changedPaths, napcatReconnectRequired: saved.hotReload?.napcatReconnectRequired }); return sendJson(res, 200, { success: true, message: saved.message, config: saved.config, hotReload: saved.hotReload, auth: authBody(saved.hotReload.passwordSeedChanged), token: saved.config.panel.passwordSeed }); }
  if (req.method === 'POST' && p === '/api/config/import') { const saved = await persistSavedConfig(api.repository.importAndSave(body)); logSystem('info', 'admin.config', '配置已导入', { migrations: saved.importResult?.migrations, warnings: saved.importResult?.warnings }); return sendJson(res, 200, { success: true, message: saved.message, config: saved.config, importResult: saved.importResult, hotReload: saved.hotReload, auth: authBody(saved.hotReload.passwordSeedChanged), token: saved.config.panel.passwordSeed }); }
  if (req.method === 'GET' && p === '/api/config/export') return sendJson(res, 200, api.repository.exportConfig());
  if (req.method === 'GET' && p === '/api/default-prompts') return sendJson(res, 200, getDefaultPrompts());
  if (req.method === 'GET' && p === '/api/logs') return sendJson(res, 200, readLogs(systemLogs, url, 'system'));
  if (req.method === 'POST' && p === '/api/logs/clear') { systemLogs.length = 0; return sendJson(res, 200, readLogs(systemLogs, url, 'system')); }
  if (req.method === 'GET' && p === '/api/canvas/logs') return sendJson(res, 200, readLogs(canvasLogs, url, 'canvas'));
  if (req.method === 'POST' && p === '/api/canvas/logs/clear') { canvasLogs.length = 0; return sendJson(res, 200, readLogs(canvasLogs, url, 'canvas')); }
  if (req.method === 'GET' && p === '/api/canvas/cards') return sendJson(res, 200, { success: true, items: managedCards(), total: managedCards().length });
  const adminCardMatch = p.match(/^\/api\/canvas\/cards\/(gallery|interrogation)\/(.+)$/);
  if (req.method === 'DELETE' && adminCardMatch) {
    const kind = adminCardMatch[1];
    const id = decodeURIComponent(adminCardMatch[2]);
    const deleted = kind === 'gallery' ? deleteGalleryItem(id) : deleteInterrogationItem(id);
    if (!deleted) return sendJson(res, 404, { success: false, error: 'Card not found' });
    await persistCanvasState();
    logSystem('info', 'admin.canvas.cards', '卡片已删除', { kind, id });
    return sendJson(res, 200, { success: true, deleted: { kind, id }, items: managedCards(), total: managedCards().length });
  }
  if (req.method === 'POST' && p === '/api/test-napcat') {
    try {
      const result = await testNapcatConnection();
      logSystem('info', 'napcat.test', 'Napcat 长连接测试成功', { readyStateText: result.snapshot?.readyStateText, loginInfo: result.loginInfo });
      const login = result.loginInfo || {};
      const userId = login.user_id ?? login.userId ?? login.self_id ?? '';
      const nickname = login.nickname ?? login.nick ?? '';
      return sendJson(res, 200, {
        success: true,
        message: 'Napcat 长连接测试成功。',
        currentBot: {
          connected: true,
          verifyMode: false,
          readyStateText: result.snapshot?.readyStateText,
          selfQqId: userId ? String(userId) : result.snapshot?.selfQqId,
          nickname,
          loginInfo: result.loginInfo,
        },
      });
    } catch (error) {
      logSystem('error', 'napcat.test', 'Napcat 长连接测试失败', { error: error?.message || String(error) });
      return sendJson(res, 502, {
        success: false,
        message: error?.message || String(error),
        currentBot: { connected: false, verifyMode: false },
      });
    }
  }
  if (req.method === 'POST' && p === '/api/test-image') {
    const startedAt = Date.now();
    try {
      const cfg = currentConfig();
      const record = await runCanvasGeneration('generate', {
        prompt: body?.prompt || 'Miobot image API test',
        presetId: 'none',
        size: sizeFromResolution(body?.resolution),
        quality: cfg.canvas?.defaultQuality || 'auto',
        outputFormat: cfg.canvas?.defaultOutputFormat || 'png',
        count: 1,
      });
      const asset = publicAsset(record.outputs.find((output) => output.asset)?.asset);
      return sendJson(res, 200, {
        success: true,
        message: '生图接口真实调用成功。',
        durationMs: Date.now() - startedAt,
        model: cfg.canvas?.imageModel,
        resolution: `${record.size.width}x${record.size.height}`,
        recordId: record.id,
        asset,
      });
    } catch (error) {
      return sendJson(res, 502, { success: false, message: asErrorMessage(error) });
    }
  }
  if (req.method === 'POST' && p === '/api/templates/convert') { const cfg = currentConfig(); const raw = String(body?.rawPrompt || body?.sourcePrompt || '').trim(); const template = { id: `mb_${(cfg.bot.promptTemplates?.length || 0) + 1}`, title: raw.slice(0, 16) || 'AI模板', prompt: raw.includes('{{prompt}}') ? raw : `${raw || '模板'}\n\n主体内容：{{prompt}}` }; const saved = await persistSavedConfig(api.repository.saveConfig({ bot: { promptTemplates: [...cfg.bot.promptTemplates, template] } })); return sendJson(res, 200, { success: true, template, config: saved.config }); }
  if (req.method === 'POST' && p === '/api/templates/title') { const prompt = String(body?.templatePrompt || body?.prompt || '').trim(); return sendJson(res, 200, { success: true, title: (prompt.replace(/\{\{prompt\}\}/g, '').trim().slice(0, 16) || '模板') }); }
  return sendJson(res, 404, { error: 'Not Found' });
}
async function handleCanvasApi(req, res, url) {
  const body = ['POST','PUT','PATCH'].includes(req.method || '') ? await readBody(req) : undefined;
  const p = url.pathname.replace(/^\/canvas-api/, '') || '/';
  if (req.method === 'GET' && p === '/health') return sendJson(res, 200, { status: 'ok' });
  if (req.method === 'GET' && p === '/config') return sendJson(res, 200, { model: currentConfig().canvas.imageModel, models: [currentConfig().canvas.imageModel, currentConfig().canvas.editModel].filter(Boolean), sizePresets, stylePresets, qualities: ['auto','low','medium','high'], outputFormats: ['png','jpeg','webp'], counts: [1,2,4,8,16], defaults: { quality: currentConfig().canvas.defaultQuality, outputFormat: currentConfig().canvas.defaultOutputFormat, count: currentConfig().canvas.defaultCount, sizePresetId: currentConfig().canvas.defaultSizePresetId, stylePresetId: currentConfig().canvas.defaultStylePresetId } });
  if (req.method === 'GET' && p === '/auth/status') return sendJson(res, 200, { signedIn: false, source: 'local-verify', available: true });
  if (req.method === 'GET' && p === '/provider-config') return sendJson(res, 200, { sources: [{ id: 'local', label: 'Local verify provider', configured: true, available: true }], current: 'local', model: currentConfig().canvas.imageModel });
  if (req.method === 'PUT' && p === '/provider-config') return sendJson(res, 200, { ok: true, source: 'local' });
  if (req.method === 'GET' && p === '/storage/config') return sendJson(res, 200, { enabled: false });
  if (req.method === 'PUT' && p === '/storage/config') return sendJson(res, 200, { enabled: false });
  if (req.method === 'POST' && p === '/storage/config/test') return sendJson(res, 200, { ok: true, message: 'Local verify storage ok.' });
  if (req.method === 'GET' && p === '/project') return sendJson(res, 200, publicProjectState());
  if (req.method === 'PUT' && p === '/project') {
    project = { ...project, name: body?.name || project.name, snapshot: Object.hasOwn(body || {}, 'snapshot') ? body.snapshot : project.snapshot, interrogations, updatedAt: new Date().toISOString() };
    await persistCanvasState();
    return sendJson(res, 200, publicProjectState());
  }
  if (req.method === 'POST' && p === '/bot/gallery') {
    if (!isAuthorized(req.headers)) return sendJson(res, 401, { error: { code: 'unauthorized', message: 'Unauthorized' } });
    try {
      const record = await addBotGalleryRecord(body || {});
      return sendJson(res, 200, { ok: true, record: publicGenerationRecord(record) });
    } catch (error) {
      return sendJson(res, 400, {
        error: {
          code: 'bot_gallery_import_failed',
          message: asErrorMessage(error),
        },
      });
    }
  }
  if (req.method === 'GET' && p === '/gallery') return sendJson(res, 200, { items: filterGalleryItems(gallery, url).map(publicGalleryItem), total: gallery.length });
  if (req.method === 'PATCH' && p.startsWith('/gallery/') && p.endsWith('/favorite')) {
    const outputId = decodeURIComponent(p.slice('/gallery/'.length, -'/favorite'.length));
    const favorite = Boolean(body?.favorite);
    const updated = updateGalleryFavorite(outputId, favorite);
    if (updated) await persistCanvasState();
    return updated ? sendJson(res, 200, { ok: true, favorite }) : sendJson(res, 404, { error: { code: 'not_found', message: 'Gallery image record not found' } });
  }
  if (req.method === 'DELETE' && p.startsWith('/gallery/')) {
    const outputId = decodeURIComponent(p.slice('/gallery/'.length));
    const deleted = deleteGalleryItem(outputId);
    if (deleted) await persistCanvasState();
    return deleted ? sendJson(res, 200, { ok: true, deleted }) : sendJson(res, 404, { error: { code: 'not_found', message: 'Gallery image record not found' } });
  }
  if (req.method === 'GET' && p === '/interrogations') return sendJson(res, 200, { items: filterInterrogationItems(interrogations, url).map(publicInterrogationItem), total: interrogations.length });
  if (req.method === 'PATCH' && p.startsWith('/interrogations/') && p.endsWith('/favorite')) {
    const id = decodeURIComponent(p.slice('/interrogations/'.length, -'/favorite'.length));
    const favorite = Boolean(body?.favorite);
    const updated = updateInterrogationFavorite(id, favorite);
    if (updated) await persistCanvasState();
    return updated ? sendJson(res, 200, { ok: true, favorite }) : sendJson(res, 404, { error: { code: 'not_found', message: 'Interrogation record not found' } });
  }
  if (req.method === 'DELETE' && p.startsWith('/interrogations/')) {
    const id = decodeURIComponent(p.slice('/interrogations/'.length));
    const deleted = deleteInterrogationItem(id);
    if (deleted) await persistCanvasState();
    return deleted ? sendJson(res, 200, { ok: true, deleted }) : sendJson(res, 404, { error: { code: 'not_found', message: 'Interrogation record not found' } });
  }
  const imageJobMatch = p.match(/^\/images\/jobs\/([^/]+)$/);
  if (req.method === 'GET' && imageJobMatch) {
    const job = publicJob(imageJobs.get(decodeURIComponent(imageJobMatch[1])));
    return job ? sendJson(res, 200, { job }) : sendJson(res, 404, { error: { code: 'not_found', message: 'Image job not found' } });
  }
  const interrogationJobMatch = p.match(/^\/interrogate\/jobs\/([^/]+)$/);
  if (req.method === 'GET' && interrogationJobMatch) {
    const job = publicJob(interrogationJobs.get(decodeURIComponent(interrogationJobMatch[1])));
    return job ? sendJson(res, 200, { job }) : sendJson(res, 404, { error: { code: 'not_found', message: 'Interrogation job not found' } });
  }
  if (req.method === 'POST' && (p === '/images/generate' || p === '/images/edit')) {
    try {
      if (url.searchParams.get('async') === '1' || url.searchParams.get('async') === 'true') {
        const job = createImageJob(p.endsWith('/edit') ? 'edit' : 'generate', body || {});
        return sendJson(res, 202, { job });
      }
      const record = await runCanvasGeneration(p.endsWith('/edit') ? 'edit' : 'generate', body || {});
      return sendJson(res, 200, { record: publicGenerationRecord(record) });
    } catch (error) {
      return sendJson(res, 502, {
        error: {
          code: 'generation_failed',
          message: asErrorMessage(error),
        },
      });
    }
  }
  if (req.method === 'POST' && p === '/interrogate') {
    try {
      if (url.searchParams.get('async') === '1' || url.searchParams.get('async') === 'true') {
        const job = createInterrogationJob(body?.image);
        return sendJson(res, 202, { job });
      }
      const item = await runCanvasInterrogation(body?.image);
      return sendJson(res, 200, { item: publicInterrogationItem(item) });
    } catch (error) {
      return sendJson(res, 502, {
        error: {
          code: 'interrogate_failed',
          message: asErrorMessage(error),
        },
      });
    }
  }
  const assetMatch = p.match(/^\/assets\/([^/]+)\/(download|preview)$/);
  if (assetMatch) {
    const assetId = decodeURIComponent(assetMatch[1]);
    const asset = assets.get(assetId);
    if (!asset) return sendJson(res, 404, { error: { code: 'not_found', message: 'Asset not found' } });
    return sendAssetResponse(res, asset);
  }
  return sendJson(res, 404, { error: { code: 'not_found', message: 'Canvas API route not found' } });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return sendJson(res, 200, { ok: true });
    const url = new URL(req.url || '/', `http://${req.headers.host || `${host}:${port}`}`);
    if (url.pathname === '/favicon.ico') return serveFile(res, canvasRoot, '/canvas/favicon.ico', '/canvas/', false);
    if (url.pathname === '/') return send(res, 302, '', { location: '/canvas/' });
    if (url.pathname === '/admin') return send(res, 302, '', { location: '/admin/' });
    if (url.pathname.startsWith('/admin/')) return serveFile(res, adminRoot, url.pathname, '/admin/', false);
    if (url.pathname === '/canvas') return send(res, 302, '', { location: '/canvas/' });
    if (url.pathname.startsWith('/canvas/')) return serveFile(res, canvasRoot, url.pathname, '/canvas/', true);
    if (url.pathname.startsWith('/api/')) return handleCompatApi(req, res, url);
    if (url.pathname.startsWith('/canvas-api/')) return handleCanvasApi(req, res, url);
    return sendJson(res, 404, { error: 'Not Found' });
  } catch (error) {
    return sendJson(res, 500, { error: error?.message || String(error), stack: error?.stack });
  }
});

server.listen(port, host, () => {
  console.log(`Miobot v2 admin/canvas server listening on http://${host}:${port}/`);
  logSystem('info', 'server', 'Web 服务已启动', { host, port, configPath, canvasStatePath, canvasAssetDir });
  logCanvas('info', 'canvas.server', '画布接口已启动', { host, port, canvasStatePath, canvasAssetDir, galleryItems: gallery.length, templateItems: interrogations.length });
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
