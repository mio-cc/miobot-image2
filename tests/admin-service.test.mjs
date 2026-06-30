import test from 'node:test';
import assert from 'node:assert/strict';

import { createAdminService } from '../dist/packages/admin-service/src/index.js';

function authedHeaders(service) {
  return { authorization: `Bearer ${service.repository.getAuthSnapshot(false).token}` };
}

test('login: 错误密码 401，正确密码 200 带 token', async () => {
  const service = createAdminService();
  const bad = await service.handle({ method: 'POST', path: '/api/login', body: { password: 'wrong' } });
  assert.equal(bad.status, 401);
  const ok = await service.handle({ method: 'POST', path: '/api/login', body: { password: 'change-me-on-first-login' } });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.auth.token);
});

test('auth: 无 token 访问 /api/config 401，有 token 200', async () => {
  const service = createAdminService();
  const noAuth = await service.handle({ method: 'GET', path: '/api/config' });
  assert.equal(noAuth.status, 401);
  const withAuth = await service.handle({ method: 'GET', path: '/api/config', headers: authedHeaders(service) });
  assert.equal(withAuth.status, 200);
  assert.ok(withAuth.body.config);
});

test('default-prompts: 返回内置提示词', async () => {
  const service = createAdminService();
  const r = await service.handle({ method: 'GET', path: '/api/default-prompts', headers: authedHeaders(service) });
  assert.equal(r.status, 200);
  assert.ok(r.body.prompts.enhancePromptTemplate);
});

test('logs: 追加→按 level 过滤→清空', async () => {
  const service = createAdminService();
  service.logs.system.append({ timestamp: '2026-05-27T00:00:01.000Z', level: 'info', scope: 'bot', message: 'a' });
  service.logs.system.append({ timestamp: '2026-05-27T00:00:02.000Z', level: 'error', scope: 'bot', message: 'boom' });
  const all = await service.handle({ method: 'GET', path: '/api/logs', headers: authedHeaders(service) });
  assert.equal(all.body.total, 2);
  const errs = await service.handle({ method: 'GET', path: '/api/logs?level=error', headers: authedHeaders(service) });
  assert.equal(errs.body.total, 1);
  assert.equal(errs.body.items[0].message, 'boom');
  const cleared = await service.handle({ method: 'POST', path: '/api/logs/clear', headers: authedHeaders(service) });
  assert.equal(cleared.body.total, 0);
});

test('canvas logs: 独立通道', async () => {
  const service = createAdminService();
  service.logs.canvas.append({ timestamp: '2026-05-27T00:00:01.000Z', level: 'info', scope: 'canvas', message: 'c' });
  const r = await service.handle({ method: 'GET', path: '/api/canvas/logs', headers: authedHeaders(service) });
  assert.equal(r.body.total, 1);
  const sys = await service.handle({ method: 'GET', path: '/api/logs', headers: authedHeaders(service) });
  assert.equal(sys.body.total, 0); // 系统通道不受影响
});

test('templates/title: 去除 {{prompt}} 并截断', async () => {
  const service = createAdminService();
  const r = await service.handle({ method: 'POST', path: '/api/templates/title', headers: authedHeaders(service), body: { templatePrompt: '赛博朋克城市 {{prompt}} 霓虹灯下的雨夜街道远景超长描述超出十六字' } });
  assert.equal(r.status, 200);
  assert.ok(r.body.title.length <= 16);
  assert.equal(r.body.title.includes('{{prompt}}'), false);
});

test('注入集成: 未配置 fetch-models → 501；注入后 → passthrough', async () => {
  const off = createAdminService();
  const r1 = await off.handle({ method: 'POST', path: '/api/fetch-models', headers: authedHeaders(off), body: {} });
  assert.equal(r1.status, 501);

  const on = createAdminService({ deps: { fetchModels: async () => ({ status: 200, body: { success: true, models: ['gpt-4o'] } }) } });
  const r2 = await on.handle({ method: 'POST', path: '/api/fetch-models', headers: authedHeaders(on), body: { baseUrl: 'https://a/v1' } });
  assert.equal(r2.status, 200);
  assert.deepEqual(r2.body.models, ['gpt-4o']);
});

test('注入集成: dep 抛错 → 502', async () => {
  const service = createAdminService({ deps: { testImage: async () => { throw new Error('上游超时'); } } });
  const r = await service.handle({ method: 'POST', path: '/api/test-image', headers: authedHeaders(service), body: {} });
  assert.equal(r.status, 502);
  assert.equal(r.body.success, false);
});

test('codex: 未配置 → 200 + enabled:false(避免浏览器控制台噪音)；注入后委派(带 method/path)', async () => {
  const off = createAdminService();
  const r1 = await off.handle({ method: 'GET', path: '/api/codex/status', headers: authedHeaders(off) });
  assert.equal(r1.status, 200);
  assert.equal(r1.body.enabled, false);
  assert.equal(r1.body.notConfigured, true);

  const on = createAdminService({ deps: { codex: { handle: (method, path) => ({ status: 200, body: { success: true, method, path } }) } } });
  const r2 = await on.handle({ method: 'GET', path: '/api/codex/status', headers: authedHeaders(on) });
  assert.equal(r2.status, 200);
  assert.equal(r2.body.path, '/api/codex/status');
});

test('config 导出委派给 web-api', async () => {
  const service = createAdminService();
  const r = await service.handle({ method: 'GET', path: '/api/config/export', headers: authedHeaders(service) });
  assert.equal(r.status, 200);
  assert.ok(r.body.export.config);
});
