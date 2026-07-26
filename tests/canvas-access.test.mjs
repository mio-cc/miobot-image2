import test from 'node:test';
import assert from 'node:assert/strict';

import { RateLimiter, checkCanvasAccess, isCostlyCanvasRoute, isLocalClient, createCanvasService } from '../dist/packages/canvas-service/src/index.js';
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
