import test from 'node:test';
import assert from 'node:assert/strict';

import { RateLimiter, canvasRouteGuard, checkCanvasAccess, isCostlyCanvasRoute, isLocalClient, createCanvasService } from '../dist/packages/canvas-service/src/index.js';
import { normalizeConfig } from '../dist/packages/config/src/index.js';

/**
 * 画布前台没有登录态，生图/改图/反推每次调用都真金白银打到上游。
 * 不拦的话任何能访问端口的人都能消耗额度。
 */

const allow = () => true;
const deny = () => false;

function configWith(canvas) {
  return normalizeConfig({ canvas });
}

test('只有花钱的路由受访问控制约束', () => {
  assert.equal(isCostlyCanvasRoute('POST', '/images/generate'), true);
  assert.equal(isCostlyCanvasRoute('POST', '/images/edit'), true);
  assert.equal(isCostlyCanvasRoute('POST', '/interrogate'), true);
  // 读画廊、取资产、查任务状态不拦——否则前台刷新列表都会被限流打断
  assert.equal(isCostlyCanvasRoute('GET', '/gallery'), false);
  assert.equal(isCostlyCanvasRoute('GET', '/images/jobs/abc'), false);
  assert.equal(isCostlyCanvasRoute('GET', '/images/generate'), false);
});

test('本机判定认私有网段，且只看 x-client-ip', () => {
  assert.equal(isLocalClient({ 'x-client-ip': '127.0.0.1' }), true);
  assert.equal(isLocalClient({ 'x-client-ip': '::1' }), true);
  assert.equal(isLocalClient({ 'x-client-ip': '::ffff:192.168.1.9' }), true);
  assert.equal(isLocalClient({ 'x-client-ip': '10.1.2.3' }), true);
  assert.equal(isLocalClient({ 'x-client-ip': '172.16.0.1' }), true);
  assert.equal(isLocalClient({ 'x-client-ip': '172.32.0.1' }), false);
  assert.equal(isLocalClient({ 'x-client-ip': '8.8.8.8' }), false);
  // x-forwarded-for 客户端可以随便写，拿它做访问控制等于没做
  assert.equal(isLocalClient({ 'x-client-ip': '8.8.8.8', 'x-forwarded-for': '127.0.0.1' }), false);
});

test('public 模式放行任意来源', () => {
  const decision = checkCanvasAccess({
    config: configWith({ access: 'public', rateLimitPerMinute: 0 }),
    headers: { 'x-client-ip': '8.8.8.8' },
    isAuthorized: deny,
    limiter: new RateLimiter(),
  });
  assert.equal(decision.allowed, true);
});

test('local-only 模式挡外网、放本机', () => {
  const config = configWith({ access: 'local-only', rateLimitPerMinute: 0 });
  const outside = checkCanvasAccess({ config, headers: { 'x-client-ip': '8.8.8.8' }, isAuthorized: deny, limiter: new RateLimiter() });
  assert.equal(outside.allowed, false);
  assert.equal(outside.status, 403);
  assert.equal(outside.code, 'forbidden_origin');

  const inside = checkCanvasAccess({ config, headers: { 'x-client-ip': '192.168.1.5' }, isAuthorized: deny, limiter: new RateLimiter() });
  assert.equal(inside.allowed, true);

  // 管理员即使从外网也放行——他就是额度的主人
  const admin = checkCanvasAccess({ config, headers: { 'x-client-ip': '8.8.8.8' }, isAuthorized: allow, limiter: new RateLimiter() });
  assert.equal(admin.allowed, true);
});

test('admin 模式必须登录后台', () => {
  const config = configWith({ access: 'admin', rateLimitPerMinute: 0 });
  const anon = checkCanvasAccess({ config, headers: { 'x-client-ip': '127.0.0.1' }, isAuthorized: deny, limiter: new RateLimiter() });
  assert.equal(anon.allowed, false);
  assert.equal(anon.status, 401);

  const admin = checkCanvasAccess({ config, headers: {}, isAuthorized: allow, limiter: new RateLimiter() });
  assert.equal(admin.allowed, true);
});

test('画布整体关闭时直接 403', () => {
  const decision = checkCanvasAccess({
    config: configWith({ enabled: false }),
    headers: { 'x-client-ip': '127.0.0.1' },
    isAuthorized: deny,
    limiter: new RateLimiter(),
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, 'canvas_disabled');
});

test('限流按来源计数，管理员不受约束', () => {
  const config = configWith({ access: 'public', rateLimitPerMinute: 2 });
  const limiter = new RateLimiter();
  const call = (ip, authorized = deny) =>
    checkCanvasAccess({ config, headers: { 'x-client-ip': ip }, isAuthorized: authorized, limiter });

  assert.equal(call('1.1.1.1').allowed, true);
  assert.equal(call('1.1.1.1').allowed, true);
  const third = call('1.1.1.1');
  assert.equal(third.allowed, false);
  assert.equal(third.status, 429);

  // 另一个来源自己算自己的
  assert.equal(call('2.2.2.2').allowed, true);
  // 管理员不计数也不被拦
  assert.equal(call('1.1.1.1', allow).allowed, true);
});

test('限流窗口跨分钟后重置', () => {
  let now = 0;
  const limiter = new RateLimiter(() => now);
  assert.equal(limiter.take('a', 1), true);
  assert.equal(limiter.take('a', 1), false);
  now += 60_000;
  assert.equal(limiter.take('a', 1), true, '进入新的一分钟应重新放行');
});

test('limit <= 0 表示不限制', () => {
  const limiter = new RateLimiter();
  for (let i = 0; i < 100; i += 1) assert.equal(limiter.take('a', 0), true);
});

test('CanvasService 端到端：local-only 下外网生图被 403，读画廊仍放行', async () => {
  const service = createCanvasService({
    getConfig: () => configWith({ access: 'local-only', rateLimitPerMinute: 0, imageModel: 'gpt-image-2' }),
    generator: {
      generate: async () => { throw new Error('不该走到生成器'); },
      edit: async () => { throw new Error('不该走到生成器'); },
      interrogate: async () => ({ text: '' }),
    },
    isAuthorized: deny,
  });

  const blocked = await service.handle({
    method: 'POST', path: '/images/generate',
    headers: { 'x-client-ip': '203.0.113.9' },
    body: { prompt: '一只猫' },
  });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.error.code, 'forbidden_origin');

  const gallery = await service.handle({ method: 'GET', path: '/gallery', headers: { 'x-client-ip': '203.0.113.9' } });
  assert.equal(gallery.status, 200);
});

test('normalizeConfig 给出访问控制默认值并夹住非法值', () => {
  const fresh = normalizeConfig({});
  assert.equal(fresh.canvas.access, 'public');
  assert.equal(fresh.canvas.rateLimitPerMinute, 20);

  const weird = normalizeConfig({ canvas: { access: 'whatever', rateLimitPerMinute: -5 } });
  assert.equal(weird.canvas.access, 'public');
  assert.equal(weird.canvas.rateLimitPerMinute, 0);
});

/* ── 写路由也要设防（复查确认：原来只挡 POST） ────────────────── */

test('canvasRouteGuard: 读放行、写设防、只有花钱的路由计配额', () => {
  const g = (m, p) => canvasRouteGuard(m, p);

  // 读路由一律不拦——否则前台刷新列表就被限流打断
  assert.equal(g('GET', '/gallery').guarded, false);
  assert.equal(g('GET', '/assets/x/download').guarded, false);
  assert.equal(g('HEAD', '/project').guarded, false);
  assert.equal(g('OPTIONS', '/anything').guarded, false);

  // 花钱的三条：设防 + 计配额
  for (const p of ['/images/generate', '/images/edit', '/interrogate']) {
    assert.deepEqual(g('POST', p), { guarded: true, countsAgainstLimit: true }, p);
  }

  // 改状态但不花钱：设防，但不该占用生图配额
  assert.deepEqual(g('DELETE', '/gallery/abc'), { guarded: true, countsAgainstLimit: false });
  assert.deepEqual(g('PATCH', '/gallery/abc/favorite'), { guarded: true, countsAgainstLimit: false });
  assert.deepEqual(g('PUT', '/project'), { guarded: true, countsAgainstLimit: false });
  assert.deepEqual(g('DELETE', '/interrogations/abc'), { guarded: true, countsAgainstLimit: false });

  // bot 回写画廊有自己的鉴权，且不该被画布开关影响
  assert.equal(g('POST', '/bot/gallery').guarded, false);
});

test('画布关闭后，外网既不能生成也不能删除', async () => {
  const store = { deleted: [] };
  const service = createCanvasService({
    getConfig: () => normalizeConfig({ canvas: { enabled: false } }),
    generator: {
      generate: async () => { throw new Error('不该被调用'); },
      edit: async () => { throw new Error('不该被调用'); },
      interrogate: async () => { throw new Error('不该被调用'); },
    },
    isAuthorized: deny,
  });

  const gen = await service.handle({ method: 'POST', path: '/images/generate', headers: { 'x-client-ip': '203.0.113.9' }, body: { prompt: 'x' } });
  assert.equal(gen.status, 403);
  assert.equal(gen.body.error.code, 'canvas_disabled');

  const del = await service.handle({ method: 'DELETE', path: '/gallery/whatever', headers: { 'x-client-ip': '203.0.113.9' } });
  assert.equal(del.status, 403, '删除也必须被挡住——它会连带删磁盘资产');
  assert.equal(del.body.error.code, 'canvas_disabled');
  void store;
});

test('仅管理员模式下，匿名不能删画廊、不能改项目', async () => {
  const service = createCanvasService({
    getConfig: () => normalizeConfig({ canvas: { access: 'admin' } }),
    generator: { generate: async () => ({ images: [] }), edit: async () => ({ images: [] }), interrogate: async () => ({ text: '' }) },
    isAuthorized: deny,
  });

  const del = await service.handle({ method: 'DELETE', path: '/gallery/x', headers: { 'x-client-ip': '127.0.0.1' } });
  assert.equal(del.status, 401);

  const put = await service.handle({ method: 'PUT', path: '/project', headers: { 'x-client-ip': '127.0.0.1' }, body: { name: 'hacked' } });
  assert.equal(put.status, 401);

  // 读仍然放行（既定设计）
  const gallery = await service.handle({ method: 'GET', path: '/gallery', headers: { 'x-client-ip': '127.0.0.1' } });
  assert.equal(gallery.status, 200);
});

test('删记录不占生图配额', async () => {
  const service = createCanvasService({
    getConfig: () => normalizeConfig({ canvas: { access: 'public', rateLimitPerMinute: 2 } }),
    generator: { generate: async () => ({ images: [] }), edit: async () => ({ images: [] }), interrogate: async () => ({ text: '' }) },
    isAuthorized: deny,
  });
  const headers = { 'x-client-ip': '1.2.3.4' };
  // 连删 10 次都不该消耗配额
  for (let i = 0; i < 10; i += 1) {
    const r = await service.handle({ method: 'DELETE', path: `/gallery/x${i}`, headers });
    assert.notEqual(r.status, 429, '删除不该被生图配额挡住');
  }
});

test('PUT /project 只改名字时不会把快照抹掉', async () => {
  const service = createCanvasService({
    getConfig: () => normalizeConfig({}),
    generator: { generate: async () => ({ images: [] }), edit: async () => ({ images: [] }), interrogate: async () => ({ text: '' }) },
  });
  await service.handle({ method: 'PUT', path: '/project', body: { snapshot: { layers: [1, 2, 3] } } });
  const before = await service.handle({ method: 'GET', path: '/project' });
  assert.deepEqual(before.body.snapshot, { layers: [1, 2, 3] });

  await service.handle({ method: 'PUT', path: '/project', body: { name: '换个名字' } });
  const after = await service.handle({ method: 'GET', path: '/project' });
  assert.equal(after.body.name, '换个名字');
  assert.deepEqual(after.body.snapshot, { layers: [1, 2, 3] }, '只改名字不该清空整个画布内容');
});

test('超大项目快照被拒绝，不会常驻内存并反复落盘', async () => {
  const service = createCanvasService({
    getConfig: () => normalizeConfig({}),
    generator: { generate: async () => ({ images: [] }), edit: async () => ({ images: [] }), interrogate: async () => ({ text: '' }) },
  });
  const huge = { blob: 'x'.repeat(9 * 1024 * 1024) };
  const r = await service.handle({ method: 'PUT', path: '/project', body: { snapshot: huge } });
  assert.equal(r.status, 413);
  assert.equal(r.body.error.code, 'snapshot_too_large');

  const after = await service.handle({ method: 'GET', path: '/project' });
  assert.notEqual(after.body.snapshot?.blob?.length, huge.blob.length, '不该被存进去');
});
