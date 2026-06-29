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
  isAuthorized: (headers) => adminService.repository.isAuthorized(authHeader(headers)),
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
  const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method || '') ? await readBody(req) : undefined;
  const result = await adminService.handle({
    method: req.method || 'GET',
    path: url.pathname + url.search,
    headers: req.headers,
    body,
  });
  applyAdminResponse(res, result);
}

async function handleCanvas(req, res, url) {
  const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method || '') ? await readBody(req) : undefined;
  const result = await canvasService.handle({
    method: req.method || 'GET',
    path: url.pathname + url.search,
    headers: req.headers,
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

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') : undefined));
    req.on('error', () => resolve(undefined));
  });
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
