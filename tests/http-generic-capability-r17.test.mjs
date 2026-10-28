import test from 'node:test';
import assert from 'node:assert/strict';

const { HttpCapabilityRegistry } = await import('../dist/apps/bot/src/capability-http-generic.js');
const { assertSafePublicUrl } = await import('../dist/packages/browser-render/src/index.js');

const CFG = () => ({ capabilitiesHttp: {}, browserRender: { allowPrivateHosts: false } });

test('R17/http-generic: descriptor → ToolSpec generation with param schema', () => {
  const registry = new HttpCapabilityRegistry({ getConfig: CFG, assertSafeUrl: assertSafePublicUrl });
  registry.load([{
    id: 'http.hotnews', name: '今日热榜聚合', description: '聚合热搜。',
    category: '信息', endpoint: 'https://api.example.test/hotlist/all',
    outputKind: 'text',
    params: [
      { name: 'source', type: 'string', description: '平台', enumValues: ['baidu', 'weibo'] },
      { name: 'num', type: 'number', description: '条数', default: 10 },
      { name: 'city', type: 'string', description: '城市', required: true },
    ],
  }]);
  const cap = registry.toCapabilityDescriptor('http.hotnews');
  assert.ok(cap, '描述符应生成');
  const schema = cap.inputSchema;
  assert.deepEqual(schema.required, ['city'], 'required 数组应正确生成');
  assert.ok(schema.properties.source.enum.length === 2, 'enum 应保留');
  assert.equal(schema.properties.num.default, 10, 'default 应保留');
  // 未注册 id 不应成页
  assert.equal(registry.toCapabilityDescriptor('http.nope'), undefined);
});

test('R17/http-generic: 12.1 分类纪律——text 抽取与 image 直链分离', async () => {
  const originalFetch = globalThis.fetch;
  test.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = (async () => ({
    ok: true, status: 200,
    text: async () => JSON.stringify({ code: 200, data: { list: [{ title: '热搜1', hot: '123万' }, { title: '热搜2', hot: '45万' }] } }),
  }));
  const registry = new HttpCapabilityRegistry({ getConfig: CFG, assertSafeUrl: assertSafePublicUrl });
  registry.load([{
    id: 'http.hotnews', name: '热榜', description: 'd', category: '信息',
    endpoint: 'https://api.example.test/hot', outputKind: 'text',
  }]);
  const res = await registry.execute('http.hotnews', {});
  assert.equal(res.outputs[0].kind, 'text');
  assert.ok(String(res.outputs[0].text).includes('热搜1'), 'JSON 应展平为文本');
  assert.ok(!String(res.outputs[0].text).startsWith('['), '不应把原始 JSON 数组当 URL 文本');

  // image 直链 → image 输出（不把 URL 当文本发）
  globalThis.fetch = (async () => ({
    ok: true, status: 200,
    text: async () => JSON.stringify({ data: { url: 'https://img.example.test/wallpaper.png' } }),
  }));
  registry.load([{
    id: 'http.bing', name: '壁纸', description: 'd', category: '信息',
    endpoint: 'https://api.example.test/bing', outputKind: 'image', imageUrlJsonPath: 'data.url',
  }]);
  const img = await registry.execute('http.bing', {});
  assert.equal(img.outputs[0].kind, 'image', '图片直链必须走 image 输出');
  assert.equal(img.outputs[0].url, 'https://img.example.test/wallpaper.png');
});

test('R17/http-generic: SSRF gate + fallback endpoint + degraded note', async () => {
  const originalFetch = globalThis.fetch;
  test.after(() => { globalThis.fetch = originalFetch; });
  const registry = new HttpCapabilityRegistry({ getConfig: () => ({ capabilitiesHttp: {}, browserRender: { allowPrivateHosts: false } }), assertSafeUrl: assertSafePublicUrl });
  registry.load([{ id: 'http.x', name: 'x', description: 'd', category: '信息', endpoint: 'http://127.0.0.1:9/x', outputKind: 'text' }]);
  await assert.rejects(() => registry.execute('http.x', {}));

  // 主站挂 → fallback 生效
  let calls = 0;
  const registry2 = new HttpCapabilityRegistry({
    getConfig: () => ({ capabilitiesHttp: { 'http.y': { fallbackEndpoint: 'https://backup.example.test/y' } }, browserRender: { allowPrivateHosts: false } }),
    assertSafeUrl: assertSafePublicUrl,
  });
  registry2.load([{ id: 'http.y', name: 'y', description: 'd', category: '信息', endpoint: 'https://primary.example.test/y', outputKind: 'text' }]);
  globalThis.fetch = (async (url) => {
    calls += 1;
    if (String(url).includes('primary')) throw new Error('connect timeout');
    return { ok: true, status: 200, text: async () => 'backup content' };
  });
  const res = await registry2.execute('http.y', {});
  assert.equal(calls, 2, '主站失败后应打备源');
  assert.ok(String(res.outputs[0].text).includes('backup content'));

  // 双挂 → degraded 提示（模型自主换路）
  globalThis.fetch = (async () => { throw new Error('all down'); });
  const res2 = await registry2.execute('http.y', {});
  assert.ok(res2.degraded === true, '双挂应标 degraded');
  assert.ok(String(res2.outputs[0].text).includes('不可用'), '应给模型可读的降级说明');
});

test('R17/http-generic: SSRF gate blocks private/loopback hosts', async () => {
  const registry = new HttpCapabilityRegistry({ getConfig: () => ({ capabilitiesHttp: {}, browserRender: { allowPrivateHosts: false } }), assertSafeUrl: assertSafePublicUrl });
  registry.load([{ id: 'http.s', name: 's', description: 'd', category: '信息', endpoint: 'http://localhost:9999/secret', outputKind: 'text' }]);
  await assert.rejects(() => registry.execute('http.s', {}));
});