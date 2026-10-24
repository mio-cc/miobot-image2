import test from 'node:test';
import assert from 'node:assert/strict';

import { SessionStore } from '../dist/packages/core/src/index.js';
import { CanvasStore } from '../dist/packages/canvas-service/src/index.js';
import { NapcatAdapter } from '../dist/packages/napcat/src/index.js';
import { createAdminDeps } from '../dist/apps/admin/src/main.js';
import { normalizeConfig } from '../dist/packages/config/src/index.js';

/**
 * 「面板上改了、提示已热重载生效、可实际还是老样子，要重启才认」。
 *
 * 这一类问题的共同形状是：某个长生命周期对象在**构造那一刻**把配置值拷进了
 * private readonly 字段，之后再没人更新它。从代码上看不出问题——热重载确实
 * 发生了，只是这个对象没在听。
 */

test('会话上限改了立刻生效，不用重启 bot', () => {
  let rounds = 2;
  const sessions = new SessionStore({ maxRounds: () => rounds, maxChars: () => 100000 });
  for (let i = 0; i < 5; i += 1) sessions.append('g1', { role: 'user', content: `q${i}` }, { role: 'assistant', content: `a${i}` });
  assert.equal(sessions.get('g1').length, 4, '2 轮 = 4 条');

  rounds = 4;   // 用户在面板上把「对话轮数」调大并保存
  sessions.append('g1', { role: 'user', content: 'q5' }, { role: 'assistant', content: 'a5' });
  assert.equal(sessions.get('g1').length, 6,
    '新上限立刻起作用（旧上限下会被砍回 4）；已经裁掉的历史找不回来是应该的');
  sessions.append('g1', { role: 'user', content: 'q6' }, { role: 'assistant', content: 'a6' });
  assert.equal(sessions.get('g1').length, 8, '继续累积到新上限');

  rounds = 1;
  sessions.append('g1', { role: 'user', content: 'q7' }, { role: 'assistant', content: 'a7' });
  assert.equal(sessions.get('g1').length, 2, '调小同样立刻生效');

});

test('会话 TTL 改了立刻生效', () => {
  let now = 0;
  let ttlMinutes = 30;
  const sessions = new SessionStore({ ttlMs: () => ttlMinutes * 60_000, clock: () => now });
  sessions.append('g1', { role: 'user', content: 'q' }, { role: 'assistant', content: 'a' });

  now = 40 * 60_000;
  assert.equal(sessions.cleanup(), 1, '超过 30 分钟该被清掉');

  sessions.append('g2', { role: 'user', content: 'q' }, { role: 'assistant', content: 'a' });
  ttlMinutes = 120;              // 用户把 TTL 调大
  now += 40 * 60_000;
  assert.equal(sessions.cleanup(), 0, '调大后 40 分钟不该再被清');
});

test('传数字仍然按老语义工作（别的调用方没坏）', () => {
  const sessions = new SessionStore({ maxRounds: 1 });
  sessions.append('k', { role: 'user', content: 'a' }, { role: 'assistant', content: 'b' });
  sessions.append('k', { role: 'user', content: 'c' }, { role: 'assistant', content: 'd' });
  assert.equal(sessions.get('k').length, 2);
});

test('画布历史上限改了立刻生效', () => {
  let limit = 2;
  const store = new CanvasStore({ maxHistory: () => limit });
  assert.equal(store.historyCapacity(), 2);
  limit = 50;
  assert.equal(store.historyCapacity(), 50, '调大后不该还按 2 截断——超出的记录会直接没掉且不可恢复');
});

test('napcat 超时/重试改了不用重启 bot', () => {
  const adapter = new NapcatAdapter({
    wsUrl: 'ws://localhost:3001', token: 'tok',
    imageSendTimeoutMs: 60000, fileSendRetryCount: 1, autoReconnect: false,
    socketFactory: () => ({ on() {}, send() {}, close() {}, removeAllListeners() {} }),
  });
  const before = adapter.getConnectionSnapshot();

  const res = adapter.applyOptions({ imageSendTimeoutMs: 180000, fileSendRetryCount: 3, fileSendRetryDelayMs: 5000 });
  assert.equal(res.reconnectRequired, false, '只改超时不该触发重连，那会打断正在进行的发送');
  assert.equal(adapter.getConnectionSnapshot().wsUrl, before.wsUrl);
});

test('napcat 换地址或换 token 时报告需要重连', () => {
  const adapter = new NapcatAdapter({
    wsUrl: 'ws://localhost:3001', token: 'old', autoReconnect: false,
    socketFactory: () => ({ on() {}, send() {}, close() {}, removeAllListeners() {} }),
  });
  assert.equal(adapter.applyOptions({ wsUrl: 'ws://localhost:3001', token: 'old' }).reconnectRequired, false,
    '没变就不该重连');
  assert.equal(adapter.applyOptions({ wsUrl: 'ws://127.0.0.1:9001' }).reconnectRequired, true);
  assert.equal(adapter.getConnectionSnapshot().wsUrl, 'ws://127.0.0.1:9001', '字段要真的更新，下次连接才用新地址');
  assert.equal(adapter.applyOptions({ token: 'new' }).reconnectRequired, true);
});

test('只改 fileSendTimeoutMs 时 video 的回退链不能断', () => {
  const adapter = new NapcatAdapter({
    wsUrl: 'ws://x', autoReconnect: false,
    socketFactory: () => ({ on() {}, send() {}, close() {}, removeAllListeners() {} }),
  });
  adapter.applyOptions({ fileSendTimeoutMs: 600000 });
  // video 没显式配过，应当跟着 file 走
  assert.equal(adapter.applyOptions({}).reconnectRequired, false);
});

/* ── 测试生图 ─────────────────────────────────────────────── */

function stubFetch(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return handler(String(url), init); };
  return { calls, restore() { globalThis.fetch = original; } };
}

test('测试生图要带上面板配的超时，而不是 ModelClient 默认的 60 秒', async () => {
  const cfg = normalizeConfig({
    llm: {
      apiKeys: [{ name: 'n', baseUrl: 'https://api.example.com/v1', key: 'sk-k', enabled: true, models: [], modelsFetchedAt: '' }],
      imageModel: 'gpt-image-2', imageTimeoutMs: 300000,
    },
  });
  let sawSignal;
  const stub = stubFetch((_url, init) => {
    sawSignal = init?.signal;
    return new Response(JSON.stringify({ data: [{ b64_json: 'AAAA' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  try {
    const deps = createAdminDeps(() => cfg, () => ({ config: cfg }));
    const res = await deps.testImage({ prompt: 'x', nodeIndex: 0, keyRef: 0, model: 'gpt-image-2' });
    assert.equal(res.status, 200, res.body?.error);
    assert.ok(sawSignal, '应当带 AbortSignal（超时靠它实现）');
  } finally { stub.restore(); }
});

test('测试生图按 keyRef 定位节点，删了节点没保存也不会串到别家', async () => {
  const A = { name: 'A', baseUrl: 'https://a.example.com/v1', key: 'sk-A', enabled: true, models: [], modelsFetchedAt: '' };
  const B = { name: 'B', baseUrl: 'https://b.example.com/v1', key: 'sk-B', enabled: true, models: [], modelsFetchedAt: '' };
  const cfg = normalizeConfig({ llm: { apiKeys: [A, B], imageModel: 'gpt-image-2' } });
  const stub = stubFetch(() => new Response(JSON.stringify({ data: [{ b64_json: 'AAAA' }] }), { status: 200, headers: { 'content-type': 'application/json' } }));
  try {
    const deps = createAdminDeps(() => cfg, () => ({ config: cfg }));
    // 面板上删掉了 A（未保存），B 显示在第 0 行，但它的 keyRef 还是 1
    await deps.testImage({ prompt: 'x', nodeIndex: 0, keyRef: 1, model: 'gpt-image-2' });
    assert.match(stub.calls[0].url, /b\.example\.com/, '按实时下标会打到 A');
    assert.equal(stub.calls[0].init.headers.Authorization, 'Bearer sk-B');
  } finally { stub.restore(); }
});

/* ── 能力覆盖 ───────────────────────────────────────────────
   start.ts 以前把 getRegistry() 的**快照**回传给 createBotApp，
   而 createBotApp 一旦收到实例就退化成 `() => 该实例`，把它自己那条
   可热重载的分支整个绕过去。BotEngine 判断「这个模型支不支持生图/视频」
   用的就是这份注册表，于是用户加了能力覆盖、面板说热重载成功，
   bot 照旧回「当前模型不支持」。                                   */

test('能力覆盖改了立刻生效，不必重启 bot', async () => {
  const { createBotApp } = await import('../dist/apps/bot/src/app.js');
  let overrides = [];
  const getConfig = () => normalizeConfig({
    llm: {
      apiKeys: [{ name: 'n', baseUrl: 'https://api.example.com/v1', key: 'sk-k', enabled: true, models: [], modelsFetchedAt: '' }],
      imageModel: 'my-private-diffusion', imageEnabled: true,
      capabilityOverrides: overrides,
    },
  });
  const app = createBotApp({ getConfig });
  const can = () => app.registry().can('my-private-diffusion', 'image.generate');

  assert.equal(can(), false, '名字看不出门道的自建模型，一开始推断不出生图能力');
  overrides = [{ model: 'my-private-diffusion', operations: ['image.generate'] }];
  assert.equal(can(), true, '加了能力覆盖就该立刻认，而不是等重启');
});

test('传 registry 实例不再是「悄悄关掉热重载」的陷阱——也可以传解析器', async () => {
  const { createBotApp } = await import('../dist/apps/bot/src/app.js');
  const { createReloadableRegistry } = await import('../dist/packages/model/src/index.js');
  let overrides = [];
  const getConfig = () => normalizeConfig({
    llm: {
      apiKeys: [{ name: 'n', baseUrl: 'https://x/v1', key: 'k', enabled: true, models: [], modelsFetchedAt: '' }],
      capabilityOverrides: overrides,
    },
  });
  // 调用方复用自己那份可热重载的注册表
  const getRegistry = createReloadableRegistry(() => getConfig().llm.capabilityOverrides.map(o => ({ model: o.model, operations: o.operations })));
  const app = createBotApp({ getConfig, registry: getRegistry });

  assert.equal(app.registry().can('weird-model-x', 'video.generate'), false);
  overrides = [{ model: 'weird-model-x', operations: ['video.generate'] }];
  assert.equal(app.registry().can('weird-model-x', 'video.generate'), true, '传函数时热重载要保持有效');
});

test('session store T2.3: dump/restore 持久化往返（TTL 过滤与裁剪防御）', () => {
  const a = new SessionStore({ maxRounds: () => 4, maxChars: () => 100000 });
  a.append('private:1', { role: 'user', content: '你好' }, { role: 'assistant', content: '在的' });
  a.append('private:1', { role: 'user', content: '画猫' }, { role: 'assistant', content: '好' });
  const snapshot = a.dump();
  const b = new SessionStore({ maxRounds: () => 4, maxChars: () => 100000 });
  assert.equal(b.restore(snapshot), 1);
  assert.deepEqual(b.get('private:1'), a.get('private:1'));
  // 损坏数据防御：非对象/非数组/缺字段项全部跳过。
  assert.equal(b.restore(null), 0);
  assert.equal(b.restore({ bad: 'not-array', ok2: [{ role: 'user', content: 'x' }] }), 1);
  // TTL：过期会话不进 dump。
  let now = 1000;
  const c = new SessionStore({ ttlMs: () => 60_000, clock: () => now });
  c.append('s', { role: 'user', content: 'x' }, { role: 'assistant', content: 'y' });
  now += 61_000;
  assert.equal(Object.keys(c.dump()).length, 0);
});
