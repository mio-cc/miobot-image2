import test from 'node:test';
import assert from 'node:assert/strict';

import { cleanBaseUrl, extractModelIds, createAdminApp } from '../dist/apps/admin/src/main.js';

test('cleanBaseUrl: 去掉端点后缀与尾斜杠', () => {
  assert.equal(cleanBaseUrl('https://api.x.com/v1/chat/completions'), 'https://api.x.com/v1');
  assert.equal(cleanBaseUrl('https://api.x.com/v1/'), 'https://api.x.com/v1');
  assert.equal(cleanBaseUrl('https://api.x.com/v1/models'), 'https://api.x.com/v1');
  assert.equal(cleanBaseUrl('  https://api.x.com/v1 ，'), 'https://api.x.com/v1');
});

test('extractModelIds: 兼容 data[].id / models[] / 字符串数组,去重排序', () => {
  assert.deepEqual(extractModelIds({ data: [{ id: 'gpt-4o' }, { id: 'gpt-3.5' }, { id: 'gpt-4o' }] }), ['gpt-3.5', 'gpt-4o']);
  assert.deepEqual(extractModelIds({ models: ['b', 'a', 'b'] }), ['a', 'b']);
  assert.deepEqual(extractModelIds(['y', 'x']), ['x', 'y']);
  assert.deepEqual(extractModelIds({ nope: true }), []);
});

test('createAdminApp: fetch-models 适配器已注入(缺 baseUrl -> 400,而非未配置 501)', async () => {
  const { service } = createAdminApp();
  const token = service.repository.getAuthSnapshot(false).token;
  const r = await service.handle({ method: 'POST', path: '/api/fetch-models', headers: { authorization: `Bearer ${token}` }, body: {} });
  assert.equal(r.status, 400); // 适配器自身的校验,证明 deps 已注入(未注入会是 501)
  assert.equal(r.body.success, false);
});

test('createAdminApp: templates/convert 适配器已注入(缺 rawPrompt -> 400)', async () => {
  const { service } = createAdminApp();
  const token = service.repository.getAuthSnapshot(false).token;
  const r = await service.handle({ method: 'POST', path: '/api/templates/convert', headers: { authorization: `Bearer ${token}` }, body: {} });
  assert.equal(r.status, 400);
});
