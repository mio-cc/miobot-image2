#!/usr/bin/env node
/**
 * Miobot v2 web/admin/canvas launcher —— 取代 local-verify-server.mjs 的 3231 行单体。
 * 装配 apps/admin(admin-service + web-api + 配置热重载) + apps/canvas(canvas-service + ModelClient)，
 * 跨域注入 canvasCards(admin 卡片页读画布画廊/反推) + isAuthorized(/bot/gallery 鉴权)，
 * 挂载静态前端(/admin/、/canvas/)，路由分发 /api/* → admin-service、/canvas-api/* → canvas-service。
 *
 * 环境变量(与单体兼容)：
 *   MIOBOT_PORT / MIOBOT_HOST          监听地址(默认 localhost:3018)
 *   MIOBOT_CONFIG_PATH                 配置文件(默认 .runtime/config.json)
 *   MIOBOT_CANVAS_STATE_PATH           画布状态(默认 .runtime/canvas-state.json)
 *   MIOBOT_CANVAS_ASSET_DIR            画布资产目录(默认 .runtime/canvas-assets)
 *   MIOBOT_SYSTEM_LOG_PATH             系统日志(默认 .runtime/logs/system.ndjson)
 *   MIOBOT_CANVAS_LOG_PATH             画布日志(默认 .runtime/logs/canvas.ndjson)
 *   MIOBOT_RUNTIME_DIR                 运行时根(覆盖以上默认)
 */
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createAdminApp, applyAdminResponse } from '../dist/apps/admin/src/main.js';
import { createCanvasApp } from '../dist/apps/canvas/src/main.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const adminRoot = path.join(projectRoot, 'apps', 'panel', 'static', 'admin');
const canvasRoot = path.join(projectRoot, 'apps', 'panel', 'static', 'canvas');
const runtimeDir = process.env.MIOBOT_RUNTIME_DIR ? path.resolve(process.env.MIOBOT_RUNTIME_DIR) : path.join(projectRoot, '.runtime');
const configPath = process.env.MIOBOT_CONFIG_PATH ? path.resolve(process.env.MIOBOT_CONFIG_PATH) : path.join(runtimeDir, 'config.json');
const canvasStatePath = process.env.MIOBOT_CANVAS_STATE_PATH ? path.resolve(process.env.MIOBOT_CANVAS_STATE_PATH) : path.join(runtimeDir, 'canvas-state.json');
const canvasAssetDir = process.env.MIOBOT_CANVAS_ASSET_DIR ? path.resolve(process.env.MIOBOT_CANVAS_ASSET_DIR) : path.join(runtimeDir, 'canvas-assets');
const logDir = process.env.MIOBOT_LOG_DIR ? path.resolve(process.env.MIOBOT_LOG_DIR) : path.join(runtimeDir, 'logs');
const systemLogPath = process.env.MIOBOT_SYSTEM_LOG_PATH ? path.resolve(process.env.MIOBOT_SYSTEM_LOG_PATH) : path.join(logDir, 'system.ndjson');
const canvasLogPath = process.env.MIOBOT_CANVAS_LOG_PATH ? path.resolve(process.env.MIOBOT_CANVAS_LOG_PATH) : path.join(logDir, 'canvas.ndjson');
const port = Number(process.env.MIOBOT_PORT || process.env.MIOBOT_VERIFY_PORT || process.env.PORT || 3018);
const host = process.env.MIOBOT_HOST || process.env.HOST || 'localhost';

// —— 两阶段装配(打破 admin↔canvas 循环依赖) ——
// admin 的 canvasCards 闭包在【请求时】才读 canvas store(此时 canvas 已装配)，
// canvas 的 isAuthorized 闭包在【请求时】才读 admin 仓储(此时 admin 已装配)。
// 两者都靠延迟闭包而非事后改 private readonly 字段(adminService.deps / canvasService.isAuthorized 均为 readonly)。

let canvasStoreRef = null; // canvas 装配后赋值，供 admin canvasCards 闭包延迟解析。

// ① 装配 admin(配置仓储 + admin-service + 真实外部适配器 + 日志 + 热重载回存)。
//    canvasCards 闭包合并画廊+反推为卡片视图，对齐单体 managedCards。
const adminApp = createAdminApp({
  configFilePath: configPath,
  systemLogFile: systemLogPath,
  canvasLogFile: canvasLogPath,
  canvasCards: {
    list() {
      const store = canvasStoreRef;
      if (!store) return [];
      const gallery = store.gallery();
      const interrogations = store.interrogations();
      return [
        ...gallery.map((item) => ({
          kind: 'gallery',
          id: item.id,
          title: item.prompt,
          subtitle: `${item.size?.width || 0}x${item.size?.height || 0} · ${String(item.outputFormat || '').toUpperCase()}`,
          createdAt: item.createdAt,
          favorite: Boolean(item.favorite),
          status: item.status || 'succeeded',
          asset: publicCanvasAsset(item.asset),
        })),
        ...interrogations.map((item) => ({
          kind: 'interrogation',
          id: item.id,
          title: item.templatePrompt || item.prompt,
          subtitle: item.fileName ? `模板库 · ${item.fileName}` : '模板库',
          createdAt: item.createdAt,
          favorite: Boolean(item.favorite),
          status: 'succeeded',
          asset: publicCanvasAsset(item.asset),
        })),
      ].sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')));
    },
    delete(kind, id) {
      const store = canvasStoreRef;
      if (!store) return false;
      return kind === 'gallery' ? store.deleteGalleryItem(id) : store.deleteInterrogationItem(id);
    },
  },
});
const adminService = adminApp.service;

// ② 装配 canvas(ModelClient → canvas-service + 文件资产 + 状态落盘)。
//    getConfig/isAuthorized 前向引用读 admin 仓储(热重载后生效)，与 admin 共享同一份配置。
const canvasApp = createCanvasApp({
  getConfig: () => adminService.repository.getConfig(),
  stateFilePath: canvasStatePath,
  assetDir: canvasAssetDir,
  // 画布可以来自两种凭据：bot 回写画廊时带 Authorization 头；
  // 浏览器访问画布前台时只有登录后台时种下的 Cookie。
  isAuthorized: (headers) => {
    const bearer = authHeader(headers);
    if (bearer && adminService.repository.isAuthorized(bearer)) return true;
    const fromCookie = cookieToken(headers);
    return Boolean(fromCookie) && adminService.repository.isAuthorized(`Bearer ${fromCookie}`);
  },
});
const canvasService = canvasApp.service;

// ③ 把 canvas store 绑定到 admin 的 canvasCards 闭包(此后 /api/canvas/cards 可读)。
canvasStoreRef = canvasService.getStore();

// —— HTTP 层(对齐单体 send/sendJson/serveFile/mime，但路由走 service.handle) ——

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return sendJson(res, 200, { ok: true });
  let url;
  try {
    url = new URL(req.url || '/', `http://${req.headers.host || `${host}:${port}`}`);
  } catch {
    return sendJson(res, 400, { error: 'Bad Request' });
  }
  const pathname = url.pathname;
  try {
    if (pathname === '/favicon.ico') return serveFile(res, canvasRoot, '/canvas/favicon.ico', '/canvas/', false);
    if (pathname === '/') return send(res, 302, '', { location: '/canvas/' });
    if (pathname === '/admin') return send(res, 302, '', { location: '/admin/' });
    if (pathname.startsWith('/admin/')) return serveFile(res, adminRoot, pathname, '/admin/', false);
    if (pathname === '/canvas') return send(res, 302, '', { location: '/canvas/' });
    if (pathname.startsWith('/canvas/')) return serveFile(res, canvasRoot, pathname, '/canvas/', true);
    if (pathname.startsWith('/api/')) return handleAdmin(req, res, url);
    if (pathname.startsWith('/canvas-api/')) return handleCanvas(req, res, url);
    return sendJson(res, 404, { error: 'Not Found' });
  } catch (error) {
    return sendJson(res, 500, { error: error?.message || String(error), stack: error?.stack });
  }
});

async function handleAdmin(req, res, url) {
  const parsed = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method || '') ? await readBody(req) : { value: undefined };
  if (bodyErrorResponse(res, parsed)) return;
  const body = parsed.value;
  const result = await adminService.handle({
    method: req.method || 'GET',
    path: url.pathname + url.search,
    headers: req.headers,
    body,
  });

  // 登录成功时顺带把会话令牌写进 Cookie。
  // 画布前台是个纯静态页，没有登录入口、也从不发 Authorization 头，
  // 所以「仅管理员」这个访问模式原本等于把画布彻底废掉——页面照常打开、
  // 参数照常能调，一点生成就永远失败，用户还看不出为什么。
  // 有了这个 Cookie，先在 /admin/ 登录过的人回到 /canvas/ 就能正常用。
  // HttpOnly：JS 读不到，降低 XSS 顺手偷走令牌的风险。
  // SameSite=Lax：跨站请求不会带上它，画布是同源访问，不受影响。
  if (url.pathname === '/api/login' && result.status === 200 && result.body?.auth?.token) {
    const parts = [
      `${PANEL_SESSION_COOKIE}=${encodeURIComponent(result.body.auth.token)}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${30 * 24 * 3600}`,
    ];
    res.setHeader('Set-Cookie', parts.join('; '));
  }

  applyAdminResponse(res, result);
}

const PANEL_SESSION_COOKIE = 'miobot_panel';

/** 从 Cookie 头里取面板令牌。画布没有地方放 Authorization 头，只能走 Cookie。 */
function cookieToken(headers) {
  const raw = headers?.cookie;
  if (!raw) return undefined;
  for (const piece of String(raw).split(';')) {
    const at = piece.indexOf('=');
    if (at < 0) continue;
    if (piece.slice(0, at).trim() !== PANEL_SESSION_COOKIE) continue;
    try { return decodeURIComponent(piece.slice(at + 1).trim()); } catch { return piece.slice(at + 1).trim(); }
  }
  return undefined;
}

async function handleCanvas(req, res, url) {
  const parsed = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method || '') ? await readBody(req) : { value: undefined };
  if (bodyErrorResponse(res, parsed)) return;
  const body = parsed.value;
  const result = await canvasService.handle({
    method: req.method || 'GET',
    path: url.pathname + url.search,
    // x-client-ip 由这里覆写成 socket 的真实来源地址。
    // 不能用客户端送来的 x-forwarded-for——那个头谁都能写，
    // 拿它做「仅本机可用」的判定等于没做。
    headers: { ...req.headers, 'x-client-ip': req.socket?.remoteAddress || '' },
    body,
  });
  if (result.binary) {
    send(res, result.status, Buffer.from(result.binary.base64, 'base64'), {
      'content-type': result.binary.contentType,
      'cache-control': 'public, max-age=31536000, immutable',
    });
    return;
  }
  sendJson(res, result.status, result.body);
}

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

function mime(file) {
  const ext = path.extname(file).toLowerCase();
  return ext === '.html' ? 'text/html; charset=utf-8' : ext === '.js' ? 'text/javascript; charset=utf-8' : ext === '.css' ? 'text/css; charset=utf-8' : ext === '.svg' ? 'image/svg+xml' : ext === '.ico' ? 'image/x-icon' : ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : ext === '.json' ? 'application/json; charset=utf-8' : 'application/octet-stream';
}

async function serveFile(res, root, requestPath, prefix, rewriteHtml = false) {
  let rel = decodeURIComponent(requestPath.slice(prefix.length)).replace(/^\/+/, '');
  if (!rel || rel.endsWith('/')) rel = path.join(rel, 'index.html');
  const file = path.resolve(root, rel);
  if (!file.startsWith(path.resolve(root))) return sendJson(res, 403, { error: 'Forbidden' });
  try {
    const data = await fs.readFile(file);
    if (rewriteHtml && path.basename(file) === 'index.html') {
      const html = data.toString('utf8')
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

// 画布改图会把参考图以 base64 塞进请求体，正常也有十几 MB，所以上限不能定太小；
// 但必须有上限，否则一个不断发数据的连接就能把内存吃光。
const MAX_REQUEST_BODY_BYTES = 32 * 1024 * 1024;

/**
 * 读请求体。返回 { value } 或 { error }。
 *
 * 两个坑：
 * 1. JSON.parse 原来直接写在 'end' 监听器里，请求体不是合法 JSON 时抛出的异常
 *    没有任何人接——在事件回调里抛就是未捕获异常，整个进程当场退出。
 *    随便发一段 `{` 就能把服务打挂。
 * 2. 没有体积上限，一直发数据就能把内存撑爆。
 */
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (result) => { if (!done) { done = true; resolve(result); } };

    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_REQUEST_BODY_BYTES) {
        finish({ error: 'too_large' });
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return finish({ value: undefined });
      try {
        finish({ value: JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') });
      } catch {
        finish({ error: 'invalid_json' });
      }
    });
    req.on('error', () => finish({ error: 'stream_error' }));
  });
}

/** 把 readBody 的结果转成响应；没问题时返回 undefined。 */
function bodyErrorResponse(res, parsed) {
  if (!parsed || !parsed.error) return false;
  if (parsed.error === 'too_large') {
    sendJson(res, 413, { success: false, error: `请求体超过上限 ${MAX_REQUEST_BODY_BYTES / 1024 / 1024}MB。` });
    return true;
  }
  if (parsed.error === 'invalid_json') {
    sendJson(res, 400, { success: false, error: '请求体不是合法 JSON。' });
    return true;
  }
  sendJson(res, 400, { success: false, error: '读取请求体失败。' });
  return true;
}

function authHeader(headers) {
  if (!headers) return undefined;
  return headers.authorization || headers.Authorization;
}

/** canvas 卡片视图用的 asset 投影(对齐单体 publicAsset：data URL/存储资产改写为下载链接)。 */
function publicCanvasAsset(asset) {
  if (!asset || typeof asset !== 'object') return asset;
  const out = { ...asset };
  if (out.id && String(out.url || '').startsWith('data:image/')) {
    out.url = `/canvas-api/assets/${encodeURIComponent(out.id)}/download`;
  }
  return out;
}

server.listen(port, host, () => {
  console.log(`Miobot v2 launcher listening on http://${host}:${port}/ (admin+canvas via service packages)`);
  console.log(`  config: ${configPath}`);
  console.log(`  canvas state: ${canvasStatePath}`);
  console.log(`  canvas assets: ${canvasAssetDir}`);
});

function shutdown() { server.close(() => process.exit(0)); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
