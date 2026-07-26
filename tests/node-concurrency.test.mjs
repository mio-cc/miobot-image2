import test from 'node:test';
import assert from 'node:assert/strict';

import { NodeConcurrencyGate, createModelClient } from '../dist/packages/model/src/index.js';
import { createCapabilityRegistry } from '../dist/packages/model/src/capability/registry.js';
import { CHAT_PROFILE } from '../dist/packages/model/src/capability/profiles.js';
import { normalizeConfig, importConfig } from '../dist/packages/config/src/index.js';

/**
 * 并发限制按节点。上游的额度是跟着 key 发的，
 * 同一个 key 上开 8 个对话和开 8 个生图对上游是一回事。
 */

/** 反复放行，直到所有调用 settle——每释放一批就会有新的补位，轮数不能写死。 */
async function drain(release, calls) {
  let settled = false;
  const done = Promise.all(calls).then(() => { settled = true; });
  for (let i = 0; i < 200 && !settled; i += 1) {
    while (release.length) release.shift()();
    await new Promise((r) => setTimeout(r, 5));
  }
  await done;
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

test('limit <= 0 不进队列，全部立即放行', async () => {
  const gate = new NodeConcurrencyGate();
  let peak = 0;
  let running = 0;
  const gates = Array.from({ length: 8 }, () => deferred());
  const tasks = gates.map((g, i) => gate.run(0, 0, async () => {
    running += 1; peak = Math.max(peak, running);
    await g.promise;
    running -= 1;
    return i;
  }));
  assert.equal(peak, 8, '不限制时应全部同时在飞');
  gates.forEach((g) => g.resolve());
  assert.deepEqual(await Promise.all(tasks), [0, 1, 2, 3, 4, 5, 6, 7]);
});

test('限制为 2 时最多两个在飞，其余排队', async () => {
  const gate = new NodeConcurrencyGate();
  let running = 0;
  let peak = 0;
  const gates = Array.from({ length: 5 }, () => deferred());
  const order = [];

  const tasks = gates.map((g, i) => gate.run(0, 2, async () => {
    running += 1; peak = Math.max(peak, running);
    order.push(i);
    await g.promise;
    running -= 1;
  }));

  await new Promise((r) => setImmediate(r));
  assert.equal(peak, 2, '同时在飞不能超过 2');
  assert.deepEqual(order, [0, 1], '先到的两个先跑');

  gates[0].resolve();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(order, [0, 1, 2], '释放一个才放下一个');

  gates.forEach((g) => g.resolve());
  await Promise.all(tasks);
  assert.equal(peak, 2);
  assert.deepEqual(order, [0, 1, 2, 3, 4]);
});

test('槽位是移交而不是先减后加——否则唤醒的微任务间隙会超额', async () => {
  const gate = new NodeConcurrencyGate();
  let running = 0;
  let peak = 0;
  const gates = Array.from({ length: 6 }, () => deferred());
  const tasks = gates.map((g) => gate.run(0, 1, async () => {
    running += 1; peak = Math.max(peak, running);
    await g.promise;
    running -= 1;
  }));

  // 逐个释放：每次释放后立刻有人补位，任何时刻都不能出现 2 个在飞。
  for (const g of gates) {
    g.resolve();
    await new Promise((r) => setImmediate(r));
    assert.ok(peak <= 1, `峰值 ${peak} 超过了限制 1`);
  }
  await Promise.all(tasks);
  assert.equal(peak, 1);
});

test('不同节点各算各的', async () => {
  const gate = new NodeConcurrencyGate();
  let running = 0;
  let peak = 0;
  const gates = [deferred(), deferred()];
  const tasks = gates.map((g, i) => gate.run(i, 1, async () => {
    running += 1; peak = Math.max(peak, running);
    await g.promise;
    running -= 1;
  }));
  await new Promise((r) => setImmediate(r));
  assert.equal(peak, 2, '两个节点各占一个槽，互不排队');
  gates.forEach((g) => g.resolve());
  await Promise.all(tasks);
});

test('任务抛错也要释放槽位，不能把队列卡死', async () => {
  const gate = new NodeConcurrencyGate();
  await assert.rejects(() => gate.run(0, 1, async () => { throw new Error('boom'); }), /boom/);
  // 上一个失败后队列必须还能继续跑
  assert.equal(await gate.run(0, 1, async () => 'ok'), 'ok');
  assert.deepEqual(gate.snapshot(), [], '全部结束后不该残留状态');
});

test('上限被调小时在飞数量自然收敛', async () => {
  const gate = new NodeConcurrencyGate();
  const gates = Array.from({ length: 4 }, () => deferred());
  let running = 0;
  const peaks = [];
  // 前两个按 limit=2 进入
  const first = gates.slice(0, 2).map((g) => gate.run(0, 2, async () => {
    running += 1; peaks.push(running); await g.promise; running -= 1;
  }));
  await new Promise((r) => setImmediate(r));
  assert.equal(running, 2);

  // 后两个按已经调小的 limit=1 排队
  const rest = gates.slice(2).map((g) => gate.run(0, 1, async () => {
    running += 1; peaks.push(running); await g.promise; running -= 1;
  }));
  await new Promise((r) => setImmediate(r));
  assert.equal(running, 2, '新的还进不来');

  gates[0].resolve();
  await new Promise((r) => setImmediate(r));
  assert.equal(running, 1, '降到 1 之前不放新的进来');

  gates.forEach((g) => g.resolve());
  await Promise.all([...first, ...rest]);
});

/** 端到端：ModelClient 真的会按节点排队。 */
test('ModelClient 按节点并发上限排队', async () => {
  let running = 0;
  let peak = 0;
  const release = [];
  const client = createModelClient({
    nodes: [{ baseUrl: 'https://a.example/v1', apiKey: 'k', dialect: 'openai', concurrency: 2 }],
    registry: createCapabilityRegistry({ fallback: CHAT_PROFILE }),
    transport: async () => {
      running += 1; peak = Math.max(peak, running);
      await new Promise((r) => release.push(r));
      running -= 1;
      return { status: 200, data: { choices: [{ message: { content: 'hi' } }] } };
    },
  });

  const calls = Array.from({ length: 5 }, () => client.chat(0, { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'x' }] }));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(peak, 2, '节点上限 2，同时在飞不能更多');

  // 一直放行到全部跑完：每释放一批就会有新的补位，轮数不能写死。
  await drain(release, calls);
  assert.equal(peak, 2, '整个过程峰值都不该超过 2');
});

test('getNodeConcurrency 优先于节点表快照——后台改完要立刻生效', async () => {
  let limit = 1;
  let running = 0;
  let peak = 0;
  const release = [];
  const client = createModelClient({
    nodes: [{ baseUrl: 'https://a.example/v1', apiKey: 'k', dialect: 'openai', concurrency: 8 }],
    registry: createCapabilityRegistry({ fallback: CHAT_PROFILE }),
    getNodeConcurrency: () => limit,
    transport: async () => {
      running += 1; peak = Math.max(peak, running);
      await new Promise((r) => release.push(r));
      running -= 1;
      return { status: 200, data: { choices: [{ message: { content: 'hi' } }] } };
    },
  });

  // 4 个调用：1 个在飞、3 个排队，放宽到 3 之后剩下的应当能一起跑
  const calls = Array.from({ length: 4 }, () => client.chat(0, { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'x' }] }));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(peak, 1, '实时值 1 应当压过节点表里的 8');

  limit = 3; // 中途放宽：已经排在队里的请求也要跟着放开，不能等下一批新请求
  await drain(release, calls);
  assert.equal(peak, 3, '放宽后排队中的请求应当立刻按新上限并行');
});

/* ── 配置迁移 ─────────────────────────────────────────────── */

test('节点默认不限制并发', () => {
  const cfg = normalizeConfig({});
  assert.equal(cfg.llm.apiKeys[0].concurrency, 0);
});

test('并发值被夹到合法区间', () => {
  const cfg = normalizeConfig({ llm: { apiKeys: [
    { name: 'a', baseUrl: 'https://a/v1', concurrency: -5 },
    { name: 'b', baseUrl: 'https://b/v1', concurrency: 9999 },
    { name: 'c', baseUrl: 'https://c/v1', concurrency: '3' },
  ] } });
  assert.equal(cfg.llm.apiKeys[0].concurrency, 0);
  assert.equal(cfg.llm.apiKeys[1].concurrency, 256);
  assert.equal(cfg.llm.apiKeys[2].concurrency, 3);
});

test('旧的「节点+模型」限制折叠到节点上，取该节点最大的一条', () => {
  const result = importConfig({
    llm: {
      apiKeys: [
        { name: 'n0', baseUrl: 'https://a/v1' },
        { name: 'n1', baseUrl: 'https://b/v1' },
      ],
      modelLimits: [
        { nodeIndex: 0, model: 'gpt-4o-mini', enabled: true, concurrency: 2 },
        { nodeIndex: 0, model: 'gpt-image-2', enabled: true, concurrency: 5 },
        { nodeIndex: 1, model: 'deepseek-chat', enabled: true, concurrency: 1 },
      ],
    },
  });
  assert.equal(result.config.llm.apiKeys[0].concurrency, 5, '节点 0 取 max(2,5)');
  assert.equal(result.config.llm.apiKeys[1].concurrency, 1);
  assert.equal(result.config.llm.modelLimits, undefined, '旧字段应当被移除');
  assert.ok(result.migrations.some((m) => m.id === 'llm.modelLimits-to-apiKeys.concurrency'), '应当登记迁移');
});

test('被停用或为 0 的旧限制不参与折叠', () => {
  const result = importConfig({
    llm: {
      apiKeys: [{ name: 'n0', baseUrl: 'https://a/v1' }],
      modelLimits: [
        { nodeIndex: 0, model: 'a', enabled: false, concurrency: 9 },
        { nodeIndex: 0, model: 'b', enabled: true, concurrency: 0 },
      ],
    },
  });
  assert.equal(result.config.llm.apiKeys[0].concurrency, 0);
});

/* ── 节点表热重载（复查确认：原来是装配时刻的快照） ────────────── */

test('nodes 传函数时每次现读——换 key / 改 baseUrl 立刻生效', async () => {
  let nodes = [{ baseUrl: 'https://old.example/v1', apiKey: 'old-key', dialect: 'openai' }];
  const seen = [];
  const client = createModelClient({
    nodes: () => nodes,
    registry: createCapabilityRegistry({ fallback: CHAT_PROFILE }),
    transport: async (req) => {
      seen.push({ url: req.url, auth: req.headers?.Authorization });
      return { status: 200, data: { choices: [{ message: { content: 'ok' } }] } };
    },
  });

  await client.chat(0, { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'x' }] });
  assert.match(seen[0].url, /old\.example/);
  assert.equal(seen[0].auth, 'Bearer old-key');

  // 模拟面板保存后配置热重载
  nodes = [{ baseUrl: 'https://new.example/v1', apiKey: 'new-key', dialect: 'openai' }];

  await client.chat(0, { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'x' }] });
  assert.match(seen[1].url, /new\.example/, '改了 baseUrl 必须立刻生效，不能等重启');
  assert.equal(seen[1].auth, 'Bearer new-key', '换了 key 必须立刻生效');
});

test('全新部署场景：装配时节点是空的，填好后立刻可用', async () => {
  // 默认配置的 baseUrl 和 key 都是空串——这正是快照写法的致命场景
  let nodes = [{ baseUrl: '', apiKey: '', dialect: 'openai' }];
  let lastUrl = '';
  const client = createModelClient({
    nodes: () => nodes,
    registry: createCapabilityRegistry({ fallback: CHAT_PROFILE }),
    transport: async (req) => {
      lastUrl = req.url;
      return { status: 200, data: { choices: [{ message: { content: 'ok' } }] } };
    },
  });

  nodes = [{ baseUrl: 'https://filled.example/v1', apiKey: 'k', dialect: 'openai' }];
  await client.chat(0, { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'x' }] });
  assert.match(lastUrl, /filled\.example/, '运维填完节点保存后应当立刻能用');
});

test('新增节点后可以直接路由过去，不必重启', async () => {
  let nodes = [{ baseUrl: 'https://a.example/v1', apiKey: 'ka', dialect: 'openai' }];
  let lastUrl = '';
  const client = createModelClient({
    nodes: () => nodes,
    registry: createCapabilityRegistry({ fallback: CHAT_PROFILE }),
    transport: async (req) => { lastUrl = req.url; return { status: 200, data: { choices: [{ message: { content: 'ok' } }] } }; },
  });

  nodes = [...nodes, { baseUrl: 'https://b.example/v1', apiKey: 'kb', dialect: 'openai' }];
  await client.chat(1, { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'x' }] });
  assert.match(lastUrl, /b\.example/, '新节点的下标必须立刻可用，否则会静默回落到节点 0');
});

test('createReloadableRegistry: 覆盖变了才重建，没变就复用', async () => {
  const { createReloadableRegistry } = await import('../dist/packages/model/src/index.js');
  let overrides = [{ model: 'my-relay', operations: ['chat'] }];
  const getRegistry = createReloadableRegistry(() => overrides);

  const first = getRegistry();
  assert.equal(getRegistry(), first, '内容没变应当复用同一实例');
  assert.equal(first.can('my-relay', 'chat'), true);
  assert.equal(first.can('my-relay', 'image.generate'), false);

  overrides = [{ model: 'my-relay', operations: ['chat', 'image.generate'] }];
  const second = getRegistry();
  assert.notEqual(second, first, '覆盖改了应当重建');
  assert.equal(second.can('my-relay', 'image.generate'), true, '能力覆盖的改动要即时生效');
});
