import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeConfig } from '../dist/packages/config/src/index.js';
import { createWebSearchService } from '../dist/packages/search/src/index.js';
import { createModelBackedDeps } from '../dist/apps/bot/src/deps.js';

function config(overrides = {}) {
  const cfg = normalizeConfig({});
  Object.assign(cfg.search, {
    enabled: true,
    provider: 'deepseek',
    apiUrl: 'https://api.deepseek.com',
    apiKey: 'search-key',
    autoMode: 'auto',
    maxResults: 5,
    needContent: true,
    fetchContent: false,
    fetchProvider: 'none',
    qps: 20,
    retryCount: 0,
    timeoutMs: 3000,
    ...overrides,
  });
  return cfg;
}

test('web search: deepseek request shape, auth, and result parsing', async () => {
  const calls = [];
  const service = createWebSearchService({
    getConfig: () => config({ fetchContent: false }),
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({
        results: [{
          rerank_score: 2.4,
          title: 'DeepSeek V4 model released',
          url: 'https://example.com/deepseek-v4',
          snippet: 'snippet',
          summary: 'summary',
          content: 'full content',
          site_name: 'Example News',
          date: '2026-06-01T00:00:00+00:00',
          authority: 3,
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const response = await service.search({ query: 'DeepSeek V4', count: 5, oriQuestion: 'V4 发布了吗' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.deepseek.com/v1/tools/search');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer search-key');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.query, 'DeepSeek V4');
  assert.equal(body.count, 5);
  assert.equal(body.need_content, true);
  assert.equal(body.ori_question, 'V4 发布了吗');
  assert.equal(response.results.length, 1);
  assert.equal(response.results[0].rerankScore, 2.4);
  assert.equal(response.results[0].authority, 3);
  assert.equal(response.results[0].content, 'full content');
});

test('web search: deepseek fetch fills missing page content', async () => {
  const calls = [];
  const cfg = config({ fetchContent: true, fetchProvider: 'deepseek', needContent: false });
  const service = createWebSearchService({
    getConfig: () => cfg,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (String(url).endsWith('/v1/tools/search')) {
        return new Response(JSON.stringify({ results: [{ title: 'A', url: 'https://example.com/a', summary: 'short' }] }), { status: 200 });
      }
      if (String(url).endsWith('/v1/tools/fetch')) {
        return new Response(JSON.stringify({ title: 'A', content: '# Full page\nmore details' }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    },
  });
  const response = await service.search({ query: 'test' });
  assert.equal(calls.length, 2);
  assert.match(response.results[0].content, /more details/);
});

test('web search: auto mode heuristic and explicit force', () => {
  const cfg = config();
  const service = createWebSearchService({ getConfig: () => cfg, fetchImpl: async () => new Response('{}') });
  assert.equal(service.shouldSearch('今天有什么新闻'), true);
  assert.equal(service.shouldSearch('你好'), false);
  assert.equal(service.shouldSearch('你正在分析用户上传的文件\n内容'), false);
  assert.equal(service.shouldSearch('你好', true), true);
  cfg.search.autoMode = 'off';
  assert.equal(service.shouldSearch('最新新闻'), false);
  assert.equal(service.shouldSearch('最新新闻', true), true);
});

test('web search: formatted context marks results as untrusted and keeps source links', async () => {
  const service = createWebSearchService({
    getConfig: () => config({ fetchContent: false }),
    fetchImpl: async () => new Response(JSON.stringify({ results: [{ title: 'Title', url: 'https://example.com/a', snippet: 'Snippet', rerank_score: 1.8 }] }), { status: 200 }),
  });
  const response = await service.search({ query: 'q' });
  const context = service.formatContext(response);
  assert.match(context, /不可信/);
  assert.match(context, /https:\/\/example\.com\/a/);
  assert.match(context, /Markdown/);
});


test('web search: model deps injects search context before chat', async () => {
  let captured = null;
  const client = {
    can: () => false,
    chat: async (_nodeIndex, req) => { captured = req; return { text: 'answer' }; },
  };
  const search = {
    shouldSearch: () => true,
    search: async () => ({ provider: 'deepseek', query: '最新新闻', results: [], cached: false, durationMs: 1 }),
    formatContext: () => 'SEARCH_CONTEXT_MARKER',
  };
  const deps = createModelBackedDeps({
    client,
    getRouting: () => ({ chatNodeIndex: 0, imageNodeIndex: 0, editNodeIndex: 0, interrogateNodeIndex: 0, videoNodeIndex: 0, freeModeNodeIndex: 0, chatModel: 'm', imageModel: 'i', editModel: 'e', interrogateModel: 'v', videoModel: 'x', freeModeModel: 'f' }),
    search,
  });
  const result = await deps.chat({ model: 'm', text: '最新新闻', sessionId: undefined });
  assert.equal(result.text, 'answer');
  assert.ok(captured.messages.some((message) => String(message.content).includes('SEARCH_CONTEXT_MARKER')));
});
