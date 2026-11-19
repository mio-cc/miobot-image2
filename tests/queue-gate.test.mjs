// 键控并发闸的不变量（2026-11-19）：
//   running 恒等于「已发出去但还没释放的名额数」；
//   释放时名额直接转交队首（不先减再加），避免微任务窗口超额放行；
//   排队超时必须把自己从队列摘掉，否则会占着位子不放。
import test from 'node:test';
import assert from 'node:assert/strict';
import { KeyedConcurrencyGate, QueueGateTimeoutError } from '../dist/apps/bot/src/queue-gate.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('limit 内直接放行，超出后按 FIFO 排队', async () => {
  const gate = new KeyedConcurrencyGate('t');
  const order = [];
  const r1 = await gate.acquire('k', 1);
  assert.deepEqual(gate.peek('k'), { key: 'k', running: 1, queued: 0, limit: 1 });

  const p2 = gate.acquire('k', 1).then((release) => { order.push('b'); return release; });
  const p3 = gate.acquire('k', 1).then((release) => { order.push('c'); return release; });
  await sleep(5);
  assert.deepEqual(gate.peek('k'), { key: 'k', running: 1, queued: 2, limit: 1 });

  r1();
  const r2 = await p2;
  assert.deepEqual(order, ['b'], '先排队的先拿到名额');
  assert.deepEqual(gate.peek('k'), { key: 'k', running: 1, queued: 1, limit: 1 });
  r2();
  const r3 = await p3;
  assert.deepEqual(order, ['b', 'c']);
  r3();
  assert.equal(gate.snapshot().length, 0, '全部释放后键应被回收');
});

test('不同键互不阻塞（跨群/跨能力隔离的基础）', async () => {
  const gate = new KeyedConcurrencyGate('t');
  const r1 = await gate.acquire('group:1', 1);
  const r2 = await gate.acquire('group:2', 1); // 不同键不应排队
  assert.equal(gate.peek('group:1').running, 1);
  assert.equal(gate.peek('group:2').running, 1);
  r1(); r2();
});

test('limit<=0 表示不限流，但仍然计数', async () => {
  const gate = new KeyedConcurrencyGate('t');
  const releases = [];
  for (let i = 0; i < 5; i += 1) releases.push(await gate.acquire('k', 0));
  assert.deepEqual(gate.peek('k'), { key: 'k', running: 5, queued: 0, limit: 0 });
  for (const release of releases) release();
  assert.equal(gate.snapshot().length, 0);
});

test('排队超时会从队列摘掉并抛 queue_timeout', async () => {
  const gate = new KeyedConcurrencyGate('t');
  const r1 = await gate.acquire('k', 1);
  await assert.rejects(
    () => gate.acquire('k', 1, { timeoutMs: 20 }),
    (error) => error instanceof QueueGateTimeoutError && error.code === 'queue_timeout',
  );
  assert.deepEqual(gate.peek('k'), { key: 'k', running: 1, queued: 0, limit: 1 }, '超时的排队项必须被摘掉');
  r1();
  assert.equal(gate.snapshot().length, 0);
});

test('超时的排队项不会在名额释放时被误唤醒', async () => {
  const gate = new KeyedConcurrencyGate('t');
  let leaked = 0;
  const r1 = await gate.acquire('k', 1);
  const timedOut = gate.acquire('k', 1, { timeoutMs: 15 }).then(() => { leaked += 1; }, () => undefined);
  await timedOut;
  r1();
  await sleep(20);
  assert.equal(leaked, 0, '超时后即使原持有者释放也不能再被放行');
  assert.equal(gate.snapshot().length, 0);
});

test('释放是幂等的：重复调用不会把 running 算成负数', async () => {
  const gate = new KeyedConcurrencyGate('t');
  const release = await gate.acquire('k', 2);
  release();
  release();
  release();
  assert.equal(gate.peek('k').running, 0);
  const again = await gate.acquire('k', 2);
  assert.equal(gate.peek('k').running, 1);
  again();
});

test('排队期间取消的项被跳过，名额继续给下一个', async () => {
  const gate = new KeyedConcurrencyGate('t');
  const r1 = await gate.acquire('k', 1);
  let cancelled = true;
  let grantedAfterCancel = false;
  const pCancelled = gate.acquire('k', 1, { isCancelled: () => cancelled }).catch(() => undefined);
  const pNext = gate.acquire('k', 1).then((release) => { grantedAfterCancel = true; return release; });
  r1();
  const rNext = await pNext;
  assert.equal(grantedAfterCancel, true, '被取消的排队项不应占住名额');
  await pCancelled;
  rNext();
});

test('并发抢占下 running 从不超过上限（40 个请求 / 上限 3）', async () => {
  const gate = new KeyedConcurrencyGate('t');
  let active = 0;
  let peak = 0;
  await Promise.all(Array.from({ length: 40 }, () => (async () => {
    const release = await gate.acquire('k', 3);
    active += 1;
    peak = Math.max(peak, active);
    await sleep(1);
    active -= 1;
    release();
  })()));
  assert.equal(peak <= 3, true, '峰值并发必须 ≤ 上限，实际 ' + peak);
  assert.equal(gate.snapshot().length, 0, '跑完必须回收干净');
});