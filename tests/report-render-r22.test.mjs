import test from 'node:test';
import assert from 'node:assert/strict';

const { renderReport } = await import('../dist/apps/bot/src/report-render.js');
const { builtinCapabilityDescriptors } = await import('../dist/packages/orchestration/src/builtin-capabilities.js');
const { defaultFeatureSettings } = await import('../dist/packages/shared/src/features.js');

const makeRows = (count) => Array.from({ length: count }, (_, index) => ({
  rank: index + 1,
  name: `热门话题 ${String(index + 1).padStart(2, '0')}`,
  category: ['科技', '生活', '娱乐', '财经'][index % 4],
  heat: 100000 - index * 937,
  trend: index % 3 === 0 ? '-1.0%' : '+2.0%',
}));

test('R23 report.render paginates data and renders chart blocks', async () => {
  const htmls = [];
  const renderer = {
    renderCode: async (artifact) => {
      htmls.push(String(artifact.html || ''));
      return { path: `/tmp/report-${htmls.length}.png`, name: `report-${htmls.length}.png`, mime: 'image/png', width: 1080, height: 1200, size: 100 };
    },
  };
  const result = await renderReport({
    title: '本周榜单 <script>alert(1)</script>',
    rows: makeRows(80),
    pageSize: 30,
    columns: [
      { key: 'rank', label: '排名', width: 64, align: 'right' },
      { key: 'name', label: '话题', weight: 2 },
      { key: 'category', label: '分类', width: 90 },
      { key: 'heat', label: '热度', width: 120, align: 'right' },
      { key: 'trend', label: '趋势', width: 90, align: 'right' },
    ],
    blocks: [
      { kind: 'chart', title: '热度 TOP 10', chart: { type: 'horizontal-bar', x: 'name', y: 'heat', topN: 10 } },
      { kind: 'table', title: '完整榜单' },
    ],
  }, {
    browserRenderer: renderer,
    outputDir: '/tmp',
    uploadFile: async (file) => `https://example.test/${file.split('/').pop()}`,
  });
  assert.equal(result.pages, 4);
  assert.equal(result.images.length, 4);
  assert.equal(htmls.length, 4);
  assert.match(htmls[0], /<svg/);
  assert.doesNotMatch(htmls[0], /<script>alert/);
  assert.match(htmls[1], /趋势/);
  assert.match(htmls[1], /热门话题 30/);
  assert.match(htmls[3], /热门话题 80/);
});

test('R23 report.render supports line, pie and scatter chart specs', async () => {
  const htmls = [];
  const renderer = {
    renderCode: async (artifact) => {
      htmls.push(String(artifact.html || ''));
      return { path: `/tmp/chart-${htmls.length}.png`, name: `chart-${htmls.length}.png`, mime: 'image/png', width: 1080, height: 1200, size: 100 };
    },
  };
  const rows = makeRows(12);
  const result = await renderReport({
    title: '图表类型验证',
    rows,
    blocks: [
      { kind: 'chart', chart: { type: 'line', x: 'name', y: 'heat' } },
      { kind: 'chart', chart: { type: 'pie', x: 'category', y: 'heat' } },
      { kind: 'chart', chart: { type: 'scatter', x: 'rank', y: 'heat' } },
    ],
  }, { browserRenderer: renderer, outputDir: '/tmp', uploadFile: async (file) => file });
  assert.equal(result.pages, 3);
  assert.equal(htmls.length, 3);
  assert.ok(htmls.every((html) => html.includes('<svg')));
});

test('R23 report.render rejects more than eight pages', async () => {
  const renderer = { renderCode: async () => ({ path: '/tmp/x.png', name: 'x.png', mime: 'image/png', width: 1080, height: 1200, size: 1 }) };
  await assert.rejects(() => renderReport({ title: 'too many', rows: makeRows(300), pageSize: 30, blocks: [{ kind: 'table' }] }, { browserRenderer: renderer, outputDir: '/tmp' }), /超过当前上限/);
});

test('R23 report.render is exposed as a model capability', () => {
  const descriptor = builtinCapabilityDescriptors().find((item) => item.id === 'report.render');
  assert.ok(descriptor);
  assert.equal(descriptor.effect, 'generate');
  assert.deepEqual(descriptor.outputKinds, ['image']);
  assert.equal(defaultFeatureSettings()['report.render']?.enabled, true);
});

test('R23 report.render splits 200 rows across stable pages', async () => {
  const htmls = [];
  const renderer = { renderCode: async (artifact) => { htmls.push(String(artifact.html || '')); return { path: `/tmp/report-${htmls.length}.png`, name: 'report.png', mime: 'image/png', width: 1080, height: 1604, size: 100 }; } };
  const result = await renderReport({ title: '200 行', rows: makeRows(200), pageSize: 30, blocks: [{ kind: 'table' }] }, { browserRenderer: renderer, outputDir: '/tmp' });
  assert.equal(result.pages, 7);
  assert.equal(result.images.length, 7);
  assert.match(htmls.at(-1), /热门话题 200/);
});
