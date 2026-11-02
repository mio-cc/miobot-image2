import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 后端三项优化的测试（本轮：静态缓存 immutable / logs 分页 / registry ETag）。
 * ② logs 分页走 AdminService 单元级（内存日志，边界 0/1/超总长/非法参数 + 筛选 total 口径）。
 * ③ ETag 走 web-api 单元级（304 命中/未命中/命中后再取全量）+ applyAdminResponse 单元级（生产装配层透传）。
 * ①①③ E2E：拉起 local-verify-server-v2（生产装配路径）断言静态缓存头与 ETag 全链路。
 */
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 隔离：别让真实 .runtime/bot-logs.jsonl 混进 /api/logs 断言（同 admin-service.test.mjs）。
process.env.MIOBOT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'miobot-cache-round-'));

const { createAdminService } = await import('../dist/packages/admin-service/src/index.js');
const { createWebApi } = await import('../dist/packages/web-api/src/index.js');
const { applyAdminResponse } = await import('../dist/apps/admin/src/main.js');

function authedHeaders(service) {
  return { authorization: `Bearer ${service.repository.getAuthSnapshot(false).token}` };
}

/** 造 n 条时间递增的日志（i=1 最老，i=n 最新）。秒数超过 59 会自动进位到分钟。 */
function seedLogs(store, n, level = 'info', message = 'entry') {
  for (let i = 1; i <= n; i++) {
    store.append({
      timestamp: new Date(Date.UTC(2026, 10, 2, 0, 0, i)).toISOString(),
      level,
      scope: 'test',
      message: `${message}-${i}`,
    });
  }
}

/* ───────────────────── ② /api/logs 分页 + total 口径 ───────────────────── */

test('logs 分页边界：limit=0/1/超总长，offset=0/1/超总长', async () => {
  const service = createAdminService();
  seedLogs(service.logs.system, 5);
  const h = authedHeaders(service);

  // limit=0：空页但 total 仍是全量命中数
  const zero = await service.handle({ method: 'GET', path: '/api/logs?limit=0', headers: h });
  assert.equal(zero.body.items.length, 0);
  assert.equal(zero.body.total, 5);
  assert.equal(zero.body.grandTotal, 5);
  assert.equal(zero.body.limit, 0);

  // limit=1：最新一条（末尾分页，offset=0 是最新一页）
  const latest = await service.handle({ method: 'GET', path: '/api/logs?limit=1', headers: h });
  assert.deepEqual(latest.body.items.map((i) => i.message), ['entry-5']);
  assert.equal(latest.body.total, 5);

  // offset=1：往前翻一页
  const prev = await service.handle({ method: 'GET', path: '/api/logs?limit=1&offset=1', headers: h });
  assert.deepEqual(prev.body.items.map((i) => i.message), ['entry-4']);

  // offset 恰好等于总长：越界空页
  const edge = await service.handle({ method: 'GET', path: '/api/logs?limit=1&offset=5', headers: h });
  assert.equal(edge.body.items.length, 0);
  assert.equal(edge.body.total, 5);

  // offset 超总长：clamp 后仍空页，不报错
  const over = await service.handle({ method: 'GET', path: '/api/logs?limit=1&offset=999', headers: h });
  assert.equal(over.body.items.length, 0);

  // limit 超总长：返回全部
  const all = await service.handle({ method: 'GET', path: '/api/logs?limit=99999', headers: h });
  assert.equal(all.body.items.length, 5);
  assert.equal(all.body.limit, 10000); // clamp 到上限
});

test('logs 非法参数：非数字忽略、负数 clamp 0、超大 clamp 上限', async () => {
  const service = createAdminService();
  seedLogs(service.logs.system, 5);
  const h = authedHeaders(service);

  // 非数字 → 忽略，limit 用默认页 300（此处总量不足一页，取全部）
  const nan = await service.handle({ method: 'GET', path: '/api/logs?limit=abc&offset=xyz', headers: h });
  assert.equal(nan.body.items.length, 5);
  assert.equal(nan.body.limit, 300);
  assert.equal(nan.body.offset, 0);

  // 负数 → clamp 0：limit=0 空页、offset=0 不位移
  const neg = await service.handle({ method: 'GET', path: '/api/logs?limit=-7&offset=-3', headers: h });
  assert.equal(neg.body.items.length, 0);
  assert.equal(neg.body.limit, 0);
  assert.equal(neg.body.offset, 0);

  // 超大 offset → clamp 1_000_000
  const big = await service.handle({ method: 'GET', path: '/api/logs?limit=1&offset=2000000', headers: h });
  assert.equal(big.body.offset, 1000000);
  assert.equal(big.body.items.length, 0);
});

test('logs 筛选 + total：total=筛选命中数（不随分页缩水）、grandTotal=全量', async () => {
  const service = createAdminService();
  service.logs.system.append({ timestamp: '2026-11-02T00:00:01.000Z', level: 'info', scope: 'bot', message: 'ok-1' });
  service.logs.system.append({ timestamp: '2026-11-02T00:00:02.000Z', level: 'error', scope: 'bot', message: 'boom-1' });
  service.logs.system.append({ timestamp: '2026-11-02T00:00:03.000Z', level: 'info', scope: 'bot', message: 'ok-2' });
  service.logs.system.append({ timestamp: '2026-11-02T00:00:04.000Z', level: 'error', scope: 'bot', message: 'boom-2' });
  const h = authedHeaders(service);

  // level 筛选：total=2（命中数），grandTotal=4（全量），items 只含 error
  const errs = await service.handle({ method: 'GET', path: '/api/logs?level=error', headers: h });
  assert.equal(errs.body.total, 2);
  assert.equal(errs.body.grandTotal, 4);
  assert.deepEqual(errs.body.items.map((i) => i.message), ['boom-1', 'boom-2']);

  // 分页后 total 不缩水：limit=1 只给最新 1 条 error，但 total 仍是命中数 2
  const paged = await service.handle({ method: 'GET', path: '/api/logs?level=error&limit=1', headers: h });
  assert.deepEqual(paged.body.items.map((i) => i.message), ['boom-2']);
  assert.equal(paged.body.total, 2);

  // contains 筛选同理
  const contains = await service.handle({ method: 'GET', path: '/api/logs?contains=boom', headers: h });
  assert.equal(contains.body.total, 2);
  assert.equal(contains.body.grandTotal, 4);

  // canvas 通道同口径
  service.logs.canvas.append({ timestamp: '2026-11-02T00:00:01.000Z', level: 'warn', scope: 'canvas', message: 'w-1' });
  service.logs.canvas.append({ timestamp: '2026-11-02T00:00:02.000Z', level: 'warn', scope: 'canvas', message: 'w-2' });
  service.logs.canvas.append({ timestamp: '2026-11-02T00:00:03.000Z', level: 'info', scope: 'canvas', message: 'i-1' });
  const canvas = await service.handle({ method: 'GET', path: '/api/canvas/logs?level=warn&limit=1', headers: h });
  assert.equal(canvas.body.total, 2);
  assert.equal(canvas.body.grandTotal, 3);
  assert.deepEqual(canvas.body.items.map((i) => i.message), ['w-2']);
});

test('logs 默认页 300 + OverviewPage 兼容（limit=60 语义不变）', async () => {
  const service = createAdminService();
  seedLogs(service.logs.system, 305);
  const h = authedHeaders(service);

  // 不带 limit：默认 300 条，取最新一页（最老的 entry-1 被翻页掉）
  const def = await service.handle({ method: 'GET', path: '/api/logs', headers: h });
  assert.equal(def.body.items.length, 300);
  assert.equal(def.body.total, 305);
  assert.equal(def.body.items[0].message, 'entry-6');
  assert.equal(def.body.items[299].message, 'entry-305');

  // OverviewPage 的调用方式：limit=60 → 最新 60 条；total 现在是真实全量（比旧的"取回条数"更准）
  const overview = await service.handle({ method: 'GET', path: '/api/logs?limit=60', headers: h });
  assert.equal(overview.body.items.length, 60);
  assert.equal(overview.body.items[0].message, 'entry-246');
  assert.equal(overview.body.items[59].message, 'entry-305');
  assert.equal(overview.body.total, 305);
});

test('logs 清空后：total/grandTotal 归零', async () => {
  const service = createAdminService();
  seedLogs(service.logs.system, 3);
  const h = authedHeaders(service);
  const cleared = await service.handle({ method: 'POST', path: '/api/logs/clear', headers: h });
  assert.equal(cleared.body.total, 0);
  assert.equal(cleared.body.grandTotal, 0);
  assert.equal(cleared.body.items.length, 0);
});

/* ───────────────────── ③ registry ETag/304（web-api 单元） ───────────────────── */

test('ETag：首次 200 带 etag；If-None-Match 命中 304 空体；未命中 200 全量', async () => {
  const api = createWebApi();
  const login = await api.handle({ method: 'POST', path: '/api/login', body: { password: 'change-me-on-first-login' } });
  const auth = { authorization: 'Bearer ' + login.body.auth.token };

  const first = await api.handle({ method: 'GET', path: '/api/orchestration/capabilities', headers: auth });
  assert.equal(first.status, 200);
  assert.match(String(first.headers?.etag), /^"cap-[0-9a-f]{16}"$/);
  assert.equal(first.headers?.['cache-control'], 'no-cache');
  assert.ok(first.body.capabilities.length > 0);

  // 命中：同 etag → 304，body 为空
  const hit = await api.handle({
    method: 'GET', path: '/api/orchestration/capabilities',
    headers: { ...auth, 'if-none-match': String(first.headers.etag) },
  });
  assert.equal(hit.status, 304);
  assert.equal(hit.body, undefined);
  assert.equal(hit.headers?.etag, first.headers.etag);

  // If-None-Match 带多个候选值（逗号分隔）也应命中
  const multi = await api.handle({
    method: 'GET', path: '/api/orchestration/capabilities',
    headers: { ...auth, 'if-none-match': `"cap-nope", ${first.headers.etag}` },
  });
  assert.equal(multi.status, 304);

  // 未命中：错误 etag → 200 全量
  const miss = await api.handle({
    method: 'GET', path: '/api/orchestration/capabilities',
    headers: { ...auth, 'if-none-match': '"cap-stale-0000000000"' },
  });
  assert.equal(miss.status, 200);
  assert.ok(miss.body.capabilities.length > 0);

  // 304 之后不带 If-None-Match 再取：仍能拿到完整数据（前端复用缓存的前提）
  const again = await api.handle({ method: 'GET', path: '/api/orchestration/capabilities', headers: auth });
  assert.equal(again.status, 200);
  assert.deepEqual(again.body, first.body);
  assert.equal(again.headers?.etag, first.headers.etag);
});

test('applyAdminResponse：headers 透传 + 304 空体（生产装配层不吞 ETag）', () => {
  const makeRes = () => {
    const headers = {};
    const chunks = [];
    return {
      statusCode: 0,
      headers,
      chunks,
      setHeader(k, v) { headers[String(k).toLowerCase()] = v; },
      end(chunk) { chunks.push(String(chunk ?? '')); },
    };
  };

  const r304 = makeRes();
  applyAdminResponse(r304, { status: 304, body: undefined, headers: { etag: '"cap-x"', 'cache-control': 'no-cache' } });
  assert.equal(r304.statusCode, 304);
  assert.equal(r304.headers.etag, '"cap-x"');
  assert.equal(r304.headers['cache-control'], 'no-cache');
  assert.equal(r304.chunks.join(''), ''); // 304 必须空体

  const r200 = makeRes();
  applyAdminResponse(r200, { status: 200, body: { success: true, hello: 1 } });
  assert.equal(r200.statusCode, 200);
  assert.equal(r200.headers['content-type'], 'application/json; charset=utf-8');
  assert.deepEqual(JSON.parse(r200.chunks.join('')), { success: true, hello: 1 });

  // 带 headers 的 200：ETag 透传且不影响 JSON body
  const r200h = makeRes();
  applyAdminResponse(r200h, { status: 200, body: { success: true }, headers: { etag: '"cap-y"' } });
  assert.equal(r200h.headers.etag, '"cap-y"');
  assert.equal(JSON.parse(r200h.chunks.join('')).success, true);
});

/* ───────── ①③ E2E：local-verify-server-v2（生产装配路径）静态头 + ETag 全链路 ───────── */

async function getFreePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('E2E(v2 启动器)：指纹产物 immutable / index.html no-cache / ETag 304 全链路', async (t) => {
  const runtime = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'miobot-v2-cache-e2e-'));
  const port = await getFreePort();
  const stderrRef = { value: '' };
  const child = spawn(process.execPath, ['scripts/local-verify-server-v2.mjs'], {
    cwd: projectRoot,
    env: { ...process.env, MIOBOT_RUNTIME_DIR: runtime, MIOBOT_PORT: String(port), MIOBOT_HOST: '127.0.0.1' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.on('data', (chunk) => { stderrRef.value += chunk.toString(); });
  t.after(async () => {
    child.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 250));
    await fs.promises.rm(runtime, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${port}`;
  // 等启动完成
  const deadline = Date.now() + 20000;
  for (;;) {
    try {
      const probe = await fetch(`${base}/admin/`);
      if (probe.ok) break;
    } catch { /* booting */ }
    if (Date.now() > deadline) throw new Error(`v2 server did not start: ${stderrRef.value.slice(-800)}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  // ① index.html（入口）：必须 no-cache，否则发布后锁死旧版本
  const html = await fetch(`${base}/admin/`);
  assert.equal(html.status, 200);
  assert.match(String(html.headers.get('cache-control')), /no-cache/);
  assert.match(await html.text(), /<div id="app">/);

  // ① 指纹产物（vite: name-[hash].ext）：immutable 一年
  const assetName = fs.readdirSync(path.join(projectRoot, 'apps', 'panel', 'static', 'admin', 'assets'))
    .find((name) => /^index-[A-Za-z0-9_-]{8,}\.(js|css)$/.test(name));
  assert.ok(assetName, '构建产物里应存在带指纹的 index chunk');
  const asset = await fetch(`${base}/admin/assets/${assetName}`);
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get('cache-control'), 'public, max-age=31536000, immutable');

  // ③ ETag 全链路（经 admin-service → web-api → applyAdminResponse 透传）
  const login = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'change-me-on-first-login' }),
  });
  assert.equal(login.status, 200);
  const token = (await login.json()).auth.token;

  const first = await fetch(`${base}/api/orchestration/capabilities`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(first.status, 200);
  const etag = first.headers.get('etag');
  assert.match(String(etag), /^"cap-[0-9a-f]{16}"$/);
  const firstBody = await first.json();
  assert.ok(firstBody.capabilities.length > 0);

  const hit = await fetch(`${base}/api/orchestration/capabilities`, {
    headers: { authorization: `Bearer ${token}`, 'if-none-match': String(etag) },
  });
  assert.equal(hit.status, 304);
  assert.equal(await hit.text(), ''); // 304 空体
  assert.equal(hit.headers.get('etag'), etag);

  // 304 后不带条件再取：数据完整（前端复用缓存后仍可拿到全量）
  const again = await fetch(`${base}/api/orchestration/capabilities`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(again.status, 200);
  assert.deepEqual(await again.json(), firstBody);
});
