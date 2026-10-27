import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ToolExecutor,
  ToolRegistry,
  makeToolError,
  normalizeToolSpec,
} from '../dist/packages/tool-runtime/src/index.js';

function spec(name, extra = {}) {
  return normalizeToolSpec({
    name,
    title: name,
    description: name,
    inputSchema: { type: 'object', properties: { value: { type: 'string' } }, additionalProperties: true },
    riskLevel: 'low',
    outputKinds: ['text'],
    exposure: 'core',
    ...extra,
  });
}

function context() {
  return { turnId: 'turn-1', sessionKey: 'private:1', requestId: 'req-1' };
}

test('toolRegistry R9 BUG-6: default retry budget retries retryable read-only failures', async () => {
  const registry = new ToolRegistry();
  registry.register(spec('read.flaky'));
  const executor = new ToolExecutor({ registry, defaultMaxRetries: 2 });
  let attempts = 0;
  executor.registerHandler('read.flaky', async () => {
    attempts += 1;
    if (attempts < 2) {
      return {
        ok: false,
        error: makeToolError({ code: 'tool_execution_failed', message: 'temporary', retryable: true }),
      };
    }
    return { ok: true, content: 'ok' };
  });
  const result = await executor.execute({ id: 'c1', name: 'read.flaky', arguments: { value: 'x' } }, context());
  assert.equal(result.ok, true);
  assert.equal(attempts, 2);
  assert.equal(result.meta.attempts, 2);
});

test('toolRegistry R9 BUG-6: default timeout is enforced', async () => {
  const registry = new ToolRegistry();
  registry.register(spec('read.slow'));
  const executor = new ToolExecutor({ registry, defaultTimeoutMs: 25, defaultMaxRetries: 0 });
  executor.registerHandler('read.slow', async () => new Promise(() => {}));
  const result = await executor.execute({ id: 'c2', name: 'read.slow', arguments: { value: 'x' } }, context());
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'timeout');
  assert.equal(result.meta.attempts, 1);
});

test('toolRegistry R9 BUG-6: default max concurrency limits executeBatch', async () => {
  const registry = new ToolRegistry();
  registry.register(spec('read.a'));
  registry.register(spec('read.b'));
  const executor = new ToolExecutor({ registry, defaultMaxConcurrency: 1 });
  let active = 0;
  let maxActive = 0;
  const handler = async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 15));
    active -= 1;
    return { ok: true, content: 'ok' };
  };
  executor.registerHandler('read.a', handler);
  executor.registerHandler('read.b', handler);
  const results = await executor.executeBatch([
    { id: 'a1', name: 'read.a', arguments: { value: 'a' } },
    { id: 'b1', name: 'read.b', arguments: { value: 'b' } },
  ], context());
  assert.equal(results.every((item) => item.ok), true);
  assert.equal(maxActive, 1);
});
