// 站点配方（2026-11-19）：格式校验 / JSONPath 子集 / 结构校验 / 执行器安全边界
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  executeRecipe,
  extractEmbeddedJson,
  isPrivateHost as _isPrivateHost,
  extractValues,
  isPrivateHost,
  normalizeRecords,
  pickValue,
  planRequests,
  queryJsonPath,
  renderTemplate,
  validateRecipe,
  verifyDataset,
  recipeMatchesUrl,
} from '../dist/packages/site-recipe/src/index.js';

function baseRecipe(overrides = {}) {
  return {
    version: 1,
    id: 'qidian-rank',
    site: 'qidian.com',
    revision: 1,
    match: { host: ['www.qidian.com'], pathPrefix: ['/rank/'] },
    dataset: { columns: [{ name: 'title', type: 'string', required: true }, { name: 'ticket', type: 'number' }] },
    steps: [
      { type: 'http', method: 'GET', url: 'https://www.qidian.com/ajax/rank?type={type}&page={page}' },
      { type: 'extract', from: 'json', engine: 'json-api', path: '$.data.records[*]', map: { title: '$.bName', ticket: '$.monthTicket' } },
      { type: 'paginate', pageParam: 'page', from: 1, to: 3 },
    ],
    verify: { minRecords: 2, requiredFieldsNonEmpty: ['title'], uniqueBy: ['title'] },
    ...overrides,
  };
}

function fakeFetch(pages) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    const page = Number(new URL(url).searchParams.get('page') || 1);
    const body = pages(page);
    return { ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => JSON.stringify(body) };
  };
  impl.calls = calls;
  return impl;
}

test('validateRecipe：合法配方通过', () => {
  assert.deepEqual(validateRecipe(baseRecipe()), []);
});

test('validateRecipe：缺 host / 缺列 / 非法方法 都被拒', () => {
  const noHost = validateRecipe(baseRecipe({ match: { host: [] } }));
  assert.equal(noHost.some((e) => e.field === 'match.host'), true);

  const noColumns = validateRecipe(baseRecipe({ dataset: { columns: [] } }));
  assert.equal(noColumns.some((e) => e.field === 'dataset.columns'), true);

  const badMethod = validateRecipe(baseRecipe({
    steps: [
      { type: 'http', method: 'DELETE', url: 'https://www.qidian.com/x' },
      { type: 'extract', from: 'json', engine: 'json-api', path: '$.a', map: { x: '$.y' } },
    ],
  }));
  assert.equal(badMethod.some((e) => /只允许 GET\/HEAD\/POST/.test(e.message)), true);

  const postNoReadOnly = validateRecipe(baseRecipe({
    steps: [
      { type: 'http', method: 'POST', url: 'https://www.qidian.com/x' },
      { type: 'extract', from: 'json', engine: 'json-api', path: '$.a', map: { x: '$.y' } },
    ],
  }));
  assert.equal(postNoReadOnly.some((e) => /readOnly/.test(e.message)), true);
});

test('validateRecipe：缺 http 或 extract 步骤都算不完整', () => {
  const onlyExtract = validateRecipe(baseRecipe({ steps: [{ type: 'extract', from: 'json', engine: 'json-api', path: '$.a', map: { x: '$.y' } }] }));
  assert.equal(onlyExtract.some((e) => /缺少 http/.test(e.message)), true);
  const onlyHttp = validateRecipe(baseRecipe({ steps: [{ type: 'http', method: 'GET', url: 'https://www.qidian.com/x' }] }));
  assert.equal(onlyHttp.some((e) => /缺少 extract/.test(e.message)), true);
});

test('jsonpath：嵌套 / 数组展开 / 下标 / 顶层展开', () => {
  const data = { data: { records: [{ bName: 'A' }, { bName: 'B' }] } };
  assert.deepEqual(queryJsonPath(data, '$.data.records[*].bName'), ['A', 'B']);
  assert.deepEqual(queryJsonPath(data, '$.data.records[0].bName'), ['A']);
  assert.deepEqual(queryJsonPath([{ x: 1 }, { x: 2 }], '$[*].x'), [1, 2]);
  assert.deepEqual(queryJsonPath(data, '$.data.nope'), []);
  assert.deepEqual(queryJsonPath(data, '$.data.records[?(@.x)]'), [], '过滤器语法不支持，明确返回空而不是猜');
});

test('renderTemplate：缺参数返回 undefined（不猜）', () => {
  assert.equal(renderTemplate('https://a.test/x?p={page}', { page: 2 }), 'https://a.test/x?p=2');
  assert.equal(renderTemplate('https://a.test/x?p={page}', {}), undefined);
});

test('planRequests：分页展开 + maxPages 截断', () => {
  const urls = planRequests(baseRecipe(), { type: 'yuepiao' }, 2);
  assert.equal(Array.isArray(urls), true);
  assert.equal(urls.length, 2);
  assert.equal(urls[0], 'https://www.qidian.com/ajax/rank?type=yuepiao&page=1');
  assert.equal(urls[1], 'https://www.qidian.com/ajax/rank?type=yuepiao&page=2');
});

test('recipeMatchesUrl：host 与 pathPrefix 锁定', () => {
  const recipe = baseRecipe();
  assert.equal(recipeMatchesUrl(recipe, 'https://www.qidian.com/rank/yuepiao/'), true);
  assert.equal(recipeMatchesUrl(recipe, 'https://evil.com/rank/x'), false);
  assert.equal(recipeMatchesUrl(recipe, 'https://www.qidian.com/other/x'), false);
});

test('isPrivateHost：私网/环回/云元数据都算私网', () => {
  for (const host of ['localhost', '127.0.0.1', '10.1.2.3', '192.168.1.1', '169.254.169.254', '172.16.0.1', 'foo.local']) {
    assert.equal(isPrivateHost(host), true, host);
  }
  for (const host of ['www.qidian.com', '8.8.8.8', 'api.example.com']) {
    assert.equal(isPrivateHost(host), false, host);
  }
});

test('verifyDataset：0 条 / 必填字段空 60% / 唯一键重复 分别判失败', () => {
  const columns = [{ name: 'title', type: 'string', required: true }, { name: 'id', type: 'string' }];
  const empty = verifyDataset({ columns, records: [], meta: {} }, { minRecords: 2 }, columns);
  assert.equal(empty.ok, false);
  assert.match(empty.failures.join(), /记录数不足/);

  const sparse = verifyDataset({
    columns,
    records: [{ title: 'a' }, {}, {}, {}, { title: 'e' }],
    meta: {},
  }, { requiredFieldsNonEmpty: ['title'] }, columns);
  assert.equal(sparse.ok, false);
  assert.match(sparse.failures.join(), /非空率 40%/);

  const dup = verifyDataset({
    columns,
    records: [{ title: 'a' }, { title: 'a' }],
    meta: {},
  }, { uniqueBy: ['title'] }, columns);
  assert.equal(dup.ok, false);
  assert.match(dup.failures.join(), /唯一键 title 出现重复/);
});

test('normalizeRecords：按列类型转换，非法值丢弃', () => {
  const rows = [{ title: 'A', ticket: '1,234' }, { title: 'B', ticket: '不是数字' }];
  const out = normalizeRecords(rows, [{ name: 'title', type: 'string' }, { name: 'ticket', type: 'number' }]);
  assert.equal(out[0].ticket, 1234);
  assert.equal('ticket' in out[1], false);
});

test('extractValues：records 未写 [*] 时自动展开数组', () => {
  const body = JSON.stringify({ data: { records: [{ a: 1 }, { a: 2 }] } });
  assert.equal(extractValues(body, { engine: 'json-api', path: '$.data.records', from: 'json' }).length, 2);
  assert.equal(extractValues(body, { engine: 'json-api', path: '$.data.records[*]', from: 'json' }).length, 2);
  assert.deepEqual(extractValues('not json', { engine: 'json-api', path: '$.a', from: 'json' }), []);
});

test('pickValue：支持 $.x.y 与裸字段名', () => {
  const item = { bName: 'A', meta: { id: 7 } };
  assert.equal(pickValue(item, 'bName'), 'A');
  assert.equal(pickValue(item, '$.meta.id'), 7);
  assert.equal(pickValue(item, '$.nope'), undefined);
});

test('executor：正常抓取 → Dataset + 校验通过', async () => {
  // 每页返回不同的书名（真实站点就是这样翻页的），否则唯一键必然重复
  const fetchImpl = fakeFetch((page) => ({ data: { records: [{ bName: 'A' + page, monthTicket: 1 }, { bName: 'B' + page, monthTicket: 2 }] } }));
  const result = await executeRecipe(baseRecipe(), { fetchImpl, params: { type: 'yuepiao' }, minIntervalMs: 0 });
  assert.equal(result.ok, true, JSON.stringify(result.verify));
  assert.equal(result.dataset.records.length, 6, '3 页 × 每页 2 条');
  assert.equal(result.dataset.records[0].title, 'A1');
  assert.equal(result.dataset.meta.recipeVersion, 1);
});

test('executor：跨 host 的 URL 被拒绝（host 锁定）', async () => {
  const recipe = baseRecipe();
  recipe.steps[0].url = 'https://evil.com/ajax/rank?page={page}';
  const fetchImpl = fakeFetch(() => ({ data: { records: [] } }));
  const result = await executeRecipe(recipe, { fetchImpl, params: { type: 'x' }, minIntervalMs: 0 });
  assert.equal(result.ok, false);
  assert.match(String(result.error), /不在配方声明的站点范围内/);
  assert.equal(fetchImpl.calls.length, 0, '被拒绝时绝不能真的发请求');
});

test('executor：私网地址被拒绝', async () => {
  const recipe = baseRecipe({ match: { host: ['127.0.0.1'] } });
  recipe.steps[0].url = 'https://127.0.0.1/ajax/rank?page={page}';
  const fetchImpl = fakeFetch(() => ({ data: { records: [] } }));
  const result = await executeRecipe(recipe, { fetchImpl, minIntervalMs: 0 });
  assert.equal(result.ok, false);
  assert.match(String(result.error), /私网/);
  assert.equal(fetchImpl.calls.length, 0);
});

test('executor：3xx 跳转不跟（防跨 host 逃逸）', async () => {
  const fetchImpl = async () => ({ ok: false, status: 302, headers: { get: () => null }, text: async () => '' });
  const result = await executeRecipe(baseRecipe(), { fetchImpl, params: { type: 'x' }, minIntervalMs: 0, maxPages: 1 });
  assert.equal(result.ok, false);
  assert.match(String(result.error), /跳转/);
});

test('executor：401/403 明确回报需要登录', async () => {
  for (const status of [401, 403]) {
    const fetchImpl = async () => ({ ok: false, status, headers: { get: () => null }, text: async () => '' });
    const result = await executeRecipe(baseRecipe(), { fetchImpl, params: { type: 'x' }, minIntervalMs: 0, maxPages: 1 });
    assert.equal(result.ok, false);
    assert.match(String(result.error), /需要登录/);
  }
});

test('executor：速率限制真的生效（注入时钟，不真等）', async () => {
  let clock = 0;
  const waits = [];
  const fetchImpl = fakeFetch((page) => ({ data: { records: [{ bName: 'A' + page }, { bName: 'B' + page }] } }));
  const result = await executeRecipe(baseRecipe(), {
    fetchImpl,
    params: { type: 'x' },
    minIntervalMs: 2000,
    maxPages: 3,
    now: () => clock,
    sleep: async (ms) => { waits.push(ms); clock += ms; },
  });
  assert.equal(result.ok, true);
  assert.equal(waits.length >= 2, true, '抓 3 页至少应该等 2 次');
  assert.equal(waits.every((ms) => ms <= 2000), true);
});

test('executor：校验不通过时 ok=false 但仍返回 dataset（便于排查）', async () => {
  const fetchImpl = fakeFetch(() => ({ data: { records: [] } }));
  const result = await executeRecipe(baseRecipe(), { fetchImpl, params: { type: 'x' }, minIntervalMs: 0, maxPages: 1 });
  assert.equal(result.ok, false);
  assert.ok(result.dataset, '仍应返回 dataset 供排障');
  assert.match(result.verify.failures.join(), /记录数不足/);
});

test('embedded-json：从 <script type="application/json"> 挖出数据（起点 m 站形态）', () => {
  const payload = { pageContext: { pageProps: { pageData: { list: [{ bName: '书名A', bAuth: '作者A', bid: '101', cat: '玄幻', cnt: '120万', rec: '编辑推荐' }] } } } };
  const html = '<html><body><script type="application/json">' + JSON.stringify(payload) + '</script></body></html>';
  const values = extractValues(html, { engine: 'embedded-json', path: '$.pageContext.pageProps.pageData.list[*]', from: 'html' });
  assert.equal(values.length, 1);
  assert.equal(pickValue(values[0], '$.bName'), '书名A');
});

test('embedded-json：也支持 window.__INITIAL_STATE__（括号配平截取，不 eval）', () => {
  const html = '<script>window.__INITIAL_STATE__ = {"records":[{"bName":"X"}]};</script>';
  assert.deepEqual(extractEmbeddedJson(html), { records: [{ bName: 'X' }] });
});

test('embedded-json：挖不到时返回空数组（让 verify 判失败，不返回半成品）', () => {
  assert.deepEqual(extractValues('<html>no data</html>', { engine: 'embedded-json', path: '$.a[*]', from: 'html' }), []);
});

test('种子配方 qidian-sanjiang：validateRecipe 通过', () => {
  const raw = fs.readFileSync('plugins/site-recipes/qidian-sanjiang.json', 'utf8');
  const recipe = JSON.parse(raw.replace(/^\uFEFF/, ''));
  assert.deepEqual(validateRecipe(recipe), []);
  assert.equal(recipe.match.host[0], 'm.qidian.com');
  // 必须写明「为什么 list 接口榜单不做」——否则下一个人会以为漏了
  assert.ok((recipe._notes || []).some((note) => /csrfToken/.test(note)));
});

test('种子配方：用真实结构的夹具跑通执行器', async () => {
  const recipe = JSON.parse(fs.readFileSync('plugins/site-recipes/qidian-sanjiang.json', 'utf8').replace(/^\uFEFF/, ''));
  const payload = {
    pageContext: {
      pageProps: {
        pageData: {
          records: [
            { bName: '甲', bAuth: 'A', bid: '1', cat: '玄幻', cnt: '100万', rec: 'r1' },
            { bName: '乙', bAuth: 'B', bid: '2', cat: '都市', cnt: '90万', rec: 'r2' },
            { bName: '丙', bAuth: 'C', bid: '3', cat: '科幻', cnt: '80万', rec: 'r3' },
          ],
        },
      },
    },
  };
  const html = '<script type="application/json">' + JSON.stringify(payload) + '</script>';
  const fetchImpl = async () => ({ ok: true, status: 200, headers: { get: () => 'text/html' }, text: async () => html });
  const result = await executeRecipe(recipe, { fetchImpl, minIntervalMs: 0 });
  assert.equal(result.ok, true, JSON.stringify(result.verify));
  assert.equal(result.dataset.records.length, 3);
  assert.equal(result.dataset.records[0].name, '甲');
  assert.equal(result.dataset.records[0].bookId, '1');
  assert.equal(result.dataset.meta.source, 'qidian.com');
});


test('pickValue：$index 生成 1 基序号（榜单类必备）', () => {
  assert.equal(pickValue({ bName: 'A' }, '$index', 1), 1);
  assert.equal(pickValue({ bName: 'A' }, '$index', 7), 7);
  assert.equal(pickValue({ bName: 'A' }, '$index'), undefined, '没给序号时不该编一个');
});

test('种子配方：真实站点抓取结果包含 pos 序号且递增', async () => {
  // 用真实结构夹具（不是真网络，保证测试可离线跑）
  const recipe = JSON.parse(fs.readFileSync('plugins/site-recipes/qidian-sanjiang.json', 'utf8'));
  const payload = { pageContext: { pageProps: { pageData: { records: [
    { bName: '甲', bAuth: 'A', bid: '1', cat: '玄幻', cnt: '100万', rec: 'r1' },
    { bName: '乙', bAuth: 'B', bid: '2', cat: '都市', cnt: '90万', rec: 'r2' },
    { bName: '丙', bAuth: 'C', bid: '3', cat: '科幻', cnt: '80万', rec: 'r3' },
  ] } } } };
  const html = '<script type="application/json">' + JSON.stringify(payload) + '</script>';
  const fetchImpl = async () => ({ ok: true, status: 200, headers: { get: () => 'text/html' }, text: async () => html });
  const result = await executeRecipe(recipe, { fetchImpl, minIntervalMs: 0 });
  assert.equal(result.ok, true, JSON.stringify(result.verify));
  assert.deepEqual(result.dataset.records.map((row) => row.pos), [1, 2, 3]);
  assert.equal(result.dataset.records[0].name, '甲');
});


test('PUA 清洗：私用区字符替换成 □（番茄书名必需）', () => {
  const rows = [{ name: '\uE4C2怪\uE4C3异' }];
  const out = normalizeRecords(rows, [{ name: 'name', type: 'string' }]);
  assert.equal(out[0].name, '□怪□异');
});

test('种子配方 fanqie-rank：validateRecipe 通过，且注明 PUA 与 qimao 限制', () => {
  const recipe = JSON.parse(fs.readFileSync('plugins/site-recipes/fanqie-rank.json', 'utf8'));
  assert.deepEqual(validateRecipe(recipe), []);
  assert.equal(recipe.match.host[0], 'fanqienovel.com');
  assert.equal(recipe.steps[0].url, 'https://fanqienovel.com/rank/{seg1}_{seg2}');
  assert.equal(recipe.steps[1].path, '$.rank.book_list[*]');
  assert.ok(recipe._notes.some((note) => /__INITIAL_STATE__/.test(note)));
});

test('配方 README 必须写明 qimao 为什么阻塞（避免被当成遗漏）', () => {
  const readme = fs.readFileSync('plugins/site-recipes/README.md', 'utf8');
  assert.match(readme, /qimao/);
  assert.match(readme, /frame-ancestors/, '要写出真实的响应头问题');
  assert.match(readme, /HTTPParserError/);
  assert.match(readme, /_csrfToken/, '起点 list 接口的限制也要写');
  assert.match(readme, /默认全部不启用/);
});
