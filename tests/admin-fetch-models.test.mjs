import test from 'node:test';
import assert from 'node:assert/strict';

import { createAdminDeps, cleanBaseUrl, extractModelIds } from '../dist/apps/admin/src/main.js';
import { normalizeConfig } from '../dist/packages/config/src/index.js';

/**
 * 「获取模型」按钮。
 *
 * 面板上密钥是打码显示的，所以对已保存的节点它发的是空 key + nodeIndex，
 * 指望后端自己去存量配置里取真值。后端以前不认 nodeIndex，
 * 于是请求不带 Authorization 头发出去，上游一律 401——
 * 表现就是「已经配好的节点，一点获取模型就失败」。
 */

function configWith(nodes) {
  return normalizeConfig({ llm: { apiKeys: nodes } });
}

/** 换掉全局 fetch，记录它到底带没带 Authorization。 */
function stubFetch(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), headers: (init && init.headers) || {} });
    return handler(String(url), init);
  };
  return { calls, restore() { globalThis.fetch = original; } };
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const NODE = { name: '中转', baseUrl: 'https://api.example.com/v1', key: 'sk-real-stored-key', enabled: true, models: [], modelsFetchedAt: '' };

test('已保存的节点：面板发空 key + nodeIndex，后端要用存量真 key', async () => {
  const cfg = configWith([NODE]);
  const stub = stubFetch(() => jsonResponse(200, { data: [{ id: 'gpt-4o-mini' }, { id: 'gpt-image-2' }] }));
  try {
    const deps = createAdminDeps(() => cfg, () => ({ config: cfg }));
    const res = await deps.fetchModels({ baseUrl: NODE.baseUrl, key: '', nodeIndex: 0 });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body.models, ['gpt-4o-mini', 'gpt-image-2']);
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].url, 'https://api.example.com/v1/models');
    assert.equal(stub.calls[0].headers.Authorization, 'Bearer sk-real-stored-key',
      '空 key + nodeIndex 时必须回填存量密钥，否则上游 401');
  } finally { stub.restore(); }
});

test('打码值等同于「没改过」，同样回填存量真 key', async () => {
  const cfg = configWith([NODE]);
  const stub = stubFetch(() => jsonResponse(200, { data: [] }));
  try {
    const deps = createAdminDeps(() => cfg, () => ({ config: cfg }));
    // 面板另一处可能把打码值原样发回来，不能当成用户新填的密钥用
    await deps.fetchModels({ baseUrl: NODE.baseUrl, key: 'sk-••••••••key', nodeIndex: 0 });
    assert.equal(stub.calls[0].headers.Authorization, 'Bearer sk-real-stored-key');
  } finally { stub.restore(); }
});

test('用户刚敲进去的新 key 优先于存量', async () => {
  const cfg = configWith([NODE]);
  const stub = stubFetch(() => jsonResponse(200, { data: [] }));
  try {
    const deps = createAdminDeps(() => cfg, () => ({ config: cfg }));
    await deps.fetchModels({ baseUrl: NODE.baseUrl, key: 'sk-brand-new', nodeIndex: 0 });
    assert.equal(stub.calls[0].headers.Authorization, 'Bearer sk-brand-new');
  } finally { stub.restore(); }
});

test('新建节点还没保存时 nodeIndex 越界，不能崩也不能串到别的节点', async () => {
  const cfg = configWith([NODE]);
  const stub = stubFetch(() => jsonResponse(200, { data: [] }));
  try {
    const deps = createAdminDeps(() => cfg, () => ({ config: cfg }));
    const res = await deps.fetchModels({ baseUrl: 'https://new.example.com/v1', key: 'sk-typed-in', nodeIndex: 99 });
    assert.equal(res.status, 200);
    assert.equal(stub.calls[0].headers.Authorization, 'Bearer sk-typed-in');
    assert.equal(stub.calls[0].url, 'https://new.example.com/v1/models');
  } finally { stub.restore(); }
});

test('baseUrl 没填时用存量节点的地址', async () => {
  const cfg = configWith([NODE]);
  const stub = stubFetch(() => jsonResponse(200, { data: [] }));
  try {
    const deps = createAdminDeps(() => cfg, () => ({ config: cfg }));
    const res = await deps.fetchModels({ nodeIndex: 0 });
    assert.equal(res.status, 200);
    assert.equal(stub.calls[0].url, 'https://api.example.com/v1/models');
  } finally { stub.restore(); }
});

test('上游的错误原因要带到界面上，不能只剩一个状态码', async () => {
  const cfg = configWith([NODE]);
  const stub = stubFetch(() => jsonResponse(403, { code: 'INSUFFICIENT_BALANCE', message: 'Insufficient account balance' }));
  try {
    const deps = createAdminDeps(() => cfg, () => ({ config: cfg }));
    const res = await deps.fetchModels({ nodeIndex: 0 });
    assert.equal(res.status, 502);
    assert.match(res.body.error, /403/);
    assert.match(res.body.error, /Insufficient account balance/,
      '只报 HTTP 403 的话用户完全不知道是余额问题');
  } finally { stub.restore(); }
});

test('上游返回 HTML 错误页时剥标签并截断，不把整页糊上去', async () => {
  const cfg = configWith([NODE]);
  const html = `<html><body><h1>502 Bad Gateway</h1><p>${'x'.repeat(2000)}</p></body></html>`;
  const stub = stubFetch(() => new Response(html, { status: 502, headers: { 'content-type': 'text/html' } }));
  try {
    const deps = createAdminDeps(() => cfg, () => ({ config: cfg }));
    const res = await deps.fetchModels({ nodeIndex: 0 });
    assert.match(res.body.error, /502 Bad Gateway/);
    assert.ok(!res.body.error.includes('<h1>'), 'HTML 标签要剥掉');
    assert.ok(res.body.error.length < 420, `错误文案 ${res.body.error.length} 字，太长了`);
  } finally { stub.restore(); }
});

test('节点确实没有密钥时，401 要说清楚是缺密钥', async () => {
  const cfg = configWith([{ ...NODE, key: '' }]);
  const stub = stubFetch(() => jsonResponse(401, { message: 'API key is required' }));
  try {
    const deps = createAdminDeps(() => cfg, () => ({ config: cfg }));
    const res = await deps.fetchModels({ nodeIndex: 0 });
    assert.match(res.body.error, /该节点还没有密钥/);
    assert.equal(stub.calls[0].headers.Authorization, undefined, '没有密钥就不该带空的 Authorization 头');
  } finally { stub.restore(); }
});

test('各种写法的 Base URL 都要拼成同一个 /models', () => {
  for (const raw of [
    'https://api.example.com/v1',
    'https://api.example.com/v1/',
    'https://api.example.com/v1/models',
    'https://api.example.com/v1/chat/completions',
    '  https://api.example.com/v1 ,',
  ]) assert.equal(`${cleanBaseUrl(raw)}/models`, 'https://api.example.com/v1/models', `Base URL 写成「${raw}」时拼错了`);
});

test('/models 的几种常见响应形状都要认', () => {
  assert.deepEqual(extractModelIds({ data: [{ id: 'b' }, { id: 'a' }] }), ['a', 'b']);
  assert.deepEqual(extractModelIds({ object: 'list', data: [{ id: 'a', permission: [] }] }), ['a']);
  assert.deepEqual(extractModelIds({ models: ['a', 'b', 'a'] }), ['a', 'b'], '要去重');
  assert.deepEqual(extractModelIds(['a', 'b']), ['a', 'b']);
  assert.deepEqual(extractModelIds({ data: [{ name: 'a' }] }), ['a'], '有的中转用 name 不用 id');
  assert.deepEqual(extractModelIds(null), []);
});

/* ── 未保存的删除导致下标漂移 ────────────────────────────────
   打码时 secrets.ts 会给每个节点写 keyRef（当时的下标），它挂在节点对象上、
   随 splice 一起走。面板要发 keyRef 而不是实时下标，否则「删了一个节点还没保存」
   期间，后端按下标取到的是别的节点的密钥。                        */

test('删掉前面的节点还没保存时，仍要取到本节点自己的密钥', async () => {
  const A = { name: 'A', baseUrl: 'https://a.example.com/v1', key: 'sk-key-A', enabled: true, models: [], modelsFetchedAt: '' };
  const B = { name: 'B', baseUrl: 'https://b.example.com/v1', key: 'sk-key-B', enabled: true, models: [], modelsFetchedAt: '' };
  const cfg = configWith([A, B]);   // 磁盘上还是 [A, B]
  const stub = stubFetch(() => jsonResponse(200, { data: [{ id: 'm' }] }));
  try {
    const deps = createAdminDeps(() => cfg, () => ({ config: cfg }));
    // 用户在面板上删掉了 A（只是本地 splice），B 现在显示在第 0 行；
    // 但 B 的 keyRef 仍然是 1，因为它跟着节点对象走。
    await deps.fetchModels({ baseUrl: B.baseUrl, key: '', keyRef: 1, nodeIndex: 0 });
    assert.equal(stub.calls[0].headers.Authorization, 'Bearer sk-key-B',
      '按实时下标会取到 A 的密钥——轻则 401，重则把 A 账号的模型列表写进 B');
    assert.equal(stub.calls[0].url, 'https://b.example.com/v1/models');
  } finally { stub.restore(); }
});

test('没有 keyRef 的旧面板仍能按 nodeIndex 工作', async () => {
  const cfg = configWith([NODE]);
  const stub = stubFetch(() => jsonResponse(200, { data: [{ id: 'm' }] }));
  try {
    const deps = createAdminDeps(() => cfg, () => ({ config: cfg }));
    await deps.fetchModels({ baseUrl: NODE.baseUrl, key: '', nodeIndex: 0 });
    assert.equal(stub.calls[0].headers.Authorization, 'Bearer sk-real-stored-key');
  } finally { stub.restore(); }
});

test('网关多包一层信封时也要认出模型', () => {
  // new-api / one-api 一类：{ code, msg, data: { object: 'list', data: [...] } }
  assert.deepEqual(extractModelIds({ code: 0, msg: 'ok', data: { object: 'list', data: [{ id: 'gpt-4o' }] } }), ['gpt-4o']);
  assert.deepEqual(extractModelIds({ result: { models: ['a', 'b'] } }), ['a', 'b']);
  assert.deepEqual(extractModelIds({ data: { items: [{ model: 'x' }] } }), ['x'], '有的用 model 字段');
  assert.deepEqual(extractModelIds({ code: 0, data: [] }), [], '真的空就是空');
});

test('解析不出模型时不能装成功——面板会照着清空已有列表', async () => {
  const cfg = configWith([NODE]);
  const stub = stubFetch(() => jsonResponse(200, { weird: { shape: 'nobody knows' } }));
  try {
    const deps = createAdminDeps(() => cfg, () => ({ config: cfg }));
    const res = await deps.fetchModels({ nodeIndex: 0 });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.models, []);
    assert.match(res.body.warning || '', /没能从响应里解析出任何模型/,
      '要给面板一个信号，否则用户看到的是「点了一下模型全没了」');
  } finally { stub.restore(); }
});

test('尾部带斜杠的 Base URL 也要跟落盘时清洗成同一个值', () => {
  // adapters 的 cleanBaseUrl 与 config 的 cleanupApiBaseUrl 必须一致，
  // 否则「探测通过的地址」和「实际存下来的地址」是两个东西。
  for (const raw of ['https://api.example.com/v1/models/', 'https://api.example.com/v1/chat/completions/'])
    assert.equal(cleanBaseUrl(raw), 'https://api.example.com/v1', `「${raw}」清洗结果不对`);
});
