import test from 'node:test';
import assert from 'node:assert/strict';
import { SearchCapabilityHandler } from '../dist/apps/bot/src/capability-basic.js';

function invocation(queries, args = {}) {
  return {
    request: { text: 'default', chat: { type: 'group', groupId: '3000' }, user: { qq: '1001' }, attachments: [], metadata: {} },
    plan: { planId: 'p1', requestId: 'r1', goal: 'search', steps: [], source: 'model' },
    step: { id: 's1', capability: 'web.search', args: { queries, ...args } },
    dependencyResults: {},
  };
}

test('web.search batch: independent queries run concurrently and return labeled results', async () => {
  const calls = [];
  const app = {
    engine: { handleExplicit: async () => ({ text: 'unused' }) },
    search: {
      async search({ query, signal }) {
        assert.ok(signal === undefined || signal instanceof AbortSignal);
        calls.push(query);
        await new Promise((resolve) => setTimeout(resolve, query === 'B' ? 10 : 1));
        return { provider: 'deepseek', query, results: [], cached: false, durationMs: 1 };
      },
      formatContext(response) { return '结果：' + response.query; },
    },
  };
  const handler = new SearchCapabilityHandler(app);
  const started = Date.now();
  const result = await handler.execute(invocation(['A', 'B', 'C', 'A']));
  const elapsed = Date.now() - started;
  assert.equal(result.status, 'success');
  assert.deepEqual(calls, ['A', 'B', 'C']);
  const text = result.outputs[0]?.text || '';
  assert.match(text, /【A】/);
  assert.match(text, /【B】/);
  assert.match(text, /【C】/);
  assert.ok(elapsed < 100, `batch should be concurrent, elapsed=${elapsed}`);
  assert.equal(result.outputs[0]?.meta?.batch, true);
});

test('web.search batch: caps total result text instead of flooding context', async () => {
  const app = {
    engine: { handleExplicit: async () => ({ text: 'unused' }) },
    search: {
      async search({ query }) { return { provider: 'deepseek', query, results: [], cached: false, durationMs: 1 }; },
      formatContext() { return 'x'.repeat(5000); },
    },
  };
  const handler = new SearchCapabilityHandler(app);
  const result = await handler.execute(invocation(['A', 'B', 'C']));
  const text = result.outputs[0]?.text || '';
  assert.ok(text.length <= 12_050, `text length=${text.length}`);
  assert.match(text, /批量搜索内容已截断/);
});
