import test from 'node:test';
import assert from 'node:assert/strict';

import { ToolRegistry } from '../dist/packages/tool-runtime/src/tool-registry.js';
import { ToolExecutor } from '../dist/packages/tool-runtime/src/tool-executor.js';

test('R15/C-3: mixed side-effect batch is fully serial to preserve dependency order', async () => {
  const registry = new ToolRegistry();
  const executor = new ToolExecutor({ registry, defaultMaxConcurrency: 4 });
  const order = [];
  let sideActive = 0;
  let sideMax = 0;
  let readMax = 0;
  let readActive = 0;
  registry.register({
    name: 'write.one',
    description: 'write one',
    inputSchema: { type: 'object', properties: {}, additionalProperties: true },
    sideEffects: ['modifies_state'],
  });
  executor.registerHandler('write.one', async () => {
    sideActive += 1;
    sideMax = Math.max(sideMax, sideActive);
    order.push('w');
    await new Promise((r) => setTimeout(r, 40));
    sideActive -= 1;
    return { ok: true, outputs: [{ kind: 'text', text: 'done' }] };
  });
  const readHandler = async (label) => {
    readActive += 1;
    readMax = Math.max(readMax, readActive);
    order.push('r');
    await new Promise((r) => setTimeout(r, 40));
    readActive -= 1;
    return { ok: true, outputs: [{ kind: 'text', text: label }] };
  };
  registry.register({ name: 'read.alpha', description: 'a', inputSchema: { type: 'object', properties: {}, additionalProperties: true } });
  registry.register({ name: 'read.beta', description: 'b', inputSchema: { type: 'object', properties: {}, additionalProperties: true } });
  executor.registerHandler('read.alpha', () => readHandler('a'));
  executor.registerHandler('read.beta', () => readHandler('b'));
  const calls = [
    { id: 'c1', name: 'write.one', arguments: {} },
    { id: 'c2', name: 'read.alpha', arguments: {} },
    { id: 'c3', name: 'write.one', arguments: { item: 'second' } },
    { id: 'c4', name: 'read.beta', arguments: {} },
  ];
  const results = await executor.executeBatch(calls, {});
  assert.equal(results.length, 4);
  assert.ok(results.every((r) => r?.ok !== false), '全部执行成功');
  assert.equal(sideMax, 1, `副作用工具必须串行（最大并发 ${sideMax}）`);
  assert.equal(readMax, 1, `混合批次必须顺序执行（只读最大并发 ${readMax}）`);
  assert.deepEqual(order, ['w', 'r', 'w', 'r'], `结果必须按原始调用顺序执行: ${order}`);
});

test('R15/C-3: idempotent (payload) side-effect tools still serialize', async () => {
  const registry = new ToolRegistry();
  const executor = new ToolExecutor({ registry, defaultMaxConcurrency: 4 });
  let concurrent = 0;
  let maxConcurrent = 0;
  registry.register({
    name: 'write.idem',
    description: 'idempotent write',
    inputSchema: { type: 'object', properties: {}, additionalProperties: true },
    sideEffects: ['modifies_state'],
    idempotency: 'payload',
  });
  executor.registerHandler('write.idem', async () => {
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await new Promise((r) => setTimeout(r, 40));
    concurrent -= 1;
    return { ok: true, outputs: [{ kind: 'text', text: 'x' }] };
  });
  const calls = [1, 2, 3].map((i) => ({ id: `c${i}`, name: 'write.idem', arguments: { n: i } }));
  const results = await executor.executeBatch(calls, {});
  assert.ok(results.every((r) => r?.ok !== false));
  assert.equal(maxConcurrent, 1, `幂等副作用工具也必须串行（实际最大并发 ${maxConcurrent}）`);
});

test('R15/C-3: pure read-only batch still honors maxConcurrency pool', async () => {
  const registry = new ToolRegistry();
  const executor = new ToolExecutor({ registry, defaultMaxConcurrency: 2 });
  let active = 0;
  let max = 0;
  for (const name of ['a', 'b', 'c']) {
    registry.register({ name: `read.${name}`, description: name, inputSchema: { type: 'object', properties: {}, additionalProperties: true } });
    executor.registerHandler(`read.${name}`, async () => {
      active += 1;
      max = Math.max(max, active);
      await new Promise((r) => setTimeout(r, 30));
      active -= 1;
      return { ok: true, outputs: [{ kind: 'text', text: name }] };
    });
  }
  const calls = ['a', 'b', 'c'].map((n) => ({ id: `c-${n}`, name: `read.${n}`, arguments: {} }));
  const results = await executor.executeBatch(calls, {});
  assert.equal(results.length, 3);
  assert.ok(max <= 2, `只读池并发不超过 maxConcurrency=2（实际 ${max}）`);
});