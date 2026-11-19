// XHR 记录（2026-11-19）：urlTemplate 抽象 + 结构骨架 + 脱敏 + 证据包
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  describeShape,
  formatProbeEvidence,
  normalizeNetworkEvents,
  redactSensitive,
  responseShapeOf,
  shouldRecordResource,
  urlTemplateOf,
} from '../dist/packages/browser-render/src/index.js';

test('urlTemplate：数字路径段与 query 值都抽象成占位符', () => {
  assert.equal(
    urlTemplateOf('https://www.qidian.com/rank/12345?type=yuepiao&page=2'),
    'https://www.qidian.com/rank/{param}?type={type}&page={page}',
  );
});

test('urlTemplate：同一站点不同 id 得到同一模板（配方可复用的前提）', () => {
  const a = urlTemplateOf('https://api.example.com/books/1001/chapters?page=1');
  const b = urlTemplateOf('https://api.example.com/books/2002/chapters?page=3');
  assert.equal(a, b);
  assert.equal(a, 'https://api.example.com/books/{param}/chapters?page={page}');
});

test('urlTemplate：uuid / 日期 / 长 hex / 前缀+数字 都能识别', () => {
  assert.match(urlTemplateOf('https://x.test/item/550e8400-e29b-41d4-a716-446655440000'), /\{param\}$/);
  assert.match(urlTemplateOf('https://x.test/archive/2026-11-19/list'), /\{param\}\/list$/);
  assert.match(urlTemplateOf('https://x.test/blob/deadbeefdeadbeefdeadbeef'), /\{param\}$/);
  assert.match(urlTemplateOf('https://x.test/rank_2026'), /\{param\}$/);
});

test('urlTemplate：非 URL 输入不抛错，原样返回', () => {
  assert.equal(urlTemplateOf('not a url'), 'not a url');
  assert.equal(urlTemplateOf(''), '');
});

test('responseShape：只保留类型/数组长度/对象键，不含任何真实值', () => {
  const shape = responseShapeOf({ code: 0, data: { records: [{ bName: '秘密书名' }], total: 3 } });
  assert.equal(shape.type, 'object');
  assert.deepEqual(shape.keys, ['code', 'data']);
  const text = JSON.stringify(shape);
  assert.equal(text.includes('秘密书名'), false, 'shape 里绝不能出现真实值');
  assert.equal(text.includes('records'), false, '嵌套键不该出现在顶层 shape');
  assert.deepEqual(responseShapeOf([1, 2, 3]), { type: 'array', length: 3 });
  assert.deepEqual(responseShapeOf(null), { type: 'null' });
  assert.deepEqual(responseShapeOf('x'), { type: 'string' });
});

test('redactSensitive：Bearer / 邮箱 / 手机号 / 长 hex 都打码', () => {
  const input = 'Authorization: Bearer abcdefghijklmnop user@test.com 13812345678 key=deadbeefdeadbeefdeadbeefdeadbeef';
  const out = redactSensitive(input);
  assert.equal(out.includes('abcdefghijklmnop'), false);
  assert.equal(out.includes('user@test.com'), false);
  assert.equal(out.includes('13812345678'), false);
  assert.equal(out.includes('deadbeefdeadbeefdeadbeefdeadbeef'), false);
});

test('shouldRecordResource：只记 xhr/fetch', () => {
  for (const type of ['xhr', 'fetch', 'XHR', 'Fetch']) assert.equal(shouldRecordResource(type), true, type);
  for (const type of ['document', 'script', 'stylesheet', 'image', 'font', 'media']) assert.equal(shouldRecordResource(type), false, type);
});

test('normalizeNetworkEvents：默认只记同源 + 过滤非 xhr + 按模板去重', () => {
  const events = normalizeNetworkEvents({
    pageUrl: 'https://www.qidian.com/rank/yuepiao/',
    events: [
      { url: 'https://www.qidian.com/ajax/rank?type=yuepiao&page=1', method: 'GET', resourceType: 'xhr', status: 200, contentType: 'application/json; charset=utf-8', bodyText: '{"code":0,"data":{"records":[1,2]}}' },
      { url: 'https://www.qidian.com/ajax/rank?type=yuepiao&page=2', method: 'GET', resourceType: 'xhr', status: 200 },
      { url: 'https://ads.other.com/track', method: 'GET', resourceType: 'xhr', status: 200 },
      { url: 'https://www.qidian.com/static/app.js', method: 'GET', resourceType: 'script', status: 200 },
      { url: 'https://www.qidian.com/img/a.png', method: 'GET', resourceType: 'image', status: 200 },
    ],
    parseBody: (text) => JSON.parse(text),
  });
  assert.equal(events.length, 1, '同模板去重 + 跨域过滤 + 非 xhr 过滤');
  assert.equal(events[0].urlTemplate, 'https://www.qidian.com/ajax/rank?type={type}&page={page}');
  assert.equal(events[0].contentType, 'application/json', 'content-type 只保留 MIME');
  assert.deepEqual(events[0].shape.keys, ['code', 'data']);
  assert.equal(events[0].sample, undefined, '默认不记响应体');
});

test('normalizeNetworkEvents：includeResponseBody=true 才出 sample，且已截断脱敏', () => {
  const events = normalizeNetworkEvents({
    pageUrl: 'https://a.test/x',
    options: { includeResponseBody: true, maxBodyBytes: 40 },
    events: [{ url: 'https://a.test/api/list?p=1', method: 'GET', resourceType: 'fetch', bodyText: 'user@test.com ' + 'x'.repeat(100) }],
  });
  assert.ok(events[0].sample);
  assert.equal(events[0].sample.includes('user@test.com'), false);
  assert.equal(events[0].sample.length <= 40, true);
});

test('normalizeNetworkEvents：maxEvents 生效；data:/blob: 不记录', () => {
  // 用不同路径（不同模板），这样才能验证 maxEvents 截断；同一接口不同页会被模板去重。
  const many = Array.from({ length: 10 }, (_, i) => ({ url: 'https://a.test/api/item' + i + '/detail', method: 'GET', resourceType: 'xhr' }));
  many.push({ url: 'data:application/json,{}', method: 'GET', resourceType: 'xhr' });
  const events = normalizeNetworkEvents({ pageUrl: 'https://a.test/', options: { maxEvents: 3 }, events: many });
  assert.equal(events.length, 3);
  assert.equal(events.some((event) => event.url.startsWith('data:')), false);
});

test('formatProbeEvidence：结构固定，含页面类型/嵌入式状态/候选接口', () => {
  const text = formatProbeEvidence({
    url: 'https://www.qidian.com/rank/yuepiao/',
    title: '月票榜',
    pageKind: 'spa',
    embeddedStateKeys: [],
    network: [{
      method: 'GET',
      url: 'https://www.qidian.com/ajax/rank?type=yuepiao&page=1',
      urlTemplate: 'https://www.qidian.com/ajax/rank?type={type}&page={page}',
      status: 200,
      contentType: 'application/json',
      shape: { type: 'object', keys: ['code', 'data'] },
    }],
  });
  assert.match(text, /【站点探测证据】/);
  assert.match(text, /页面类型：SPA/);
  assert.match(text, /嵌入式状态：未命中/);
  assert.match(text, /1\) GET https:\/\/www\.qidian\.com\/ajax\/rank\?type=\{type\}&page=\{page\}/);
  assert.match(text, /shape: \{code, data\}/);
});

test('formatProbeEvidence：超长时截断并说明', () => {
  const network = Array.from({ length: 200 }, (_, i) => ({
    method: 'GET',
    url: 'https://a.test/api/' + i,
    urlTemplate: 'https://a.test/api/{param}',
    shape: { type: 'object', keys: ['a', 'b', 'c'] },
  }));
  const text = formatProbeEvidence({ url: 'https://a.test/', network, maxChars: 800 });
  assert.equal(text.length <= 800 + 60, true);
  assert.match(text, /已截断/);
});

test('describeShape：一行描述嵌套结构', () => {
  assert.equal(describeShape({ code: 0, data: { records: [], total: 3 } }), '{code:number, data:{records:array[0], total:number}}');
  assert.equal(describeShape([1, 2]), 'array[2]');
});
test('screenshotUrl 默认不记录网络（recordNetwork 缺省 = 关闭，零行为变化）', async () => {
  const { DEFAULT_RECORD_NETWORK_OPTIONS } = await import('../dist/packages/browser-render/src/index.js');
  assert.equal(DEFAULT_RECORD_NETWORK_OPTIONS.includeResponseBody, false);
  assert.equal(DEFAULT_RECORD_NETWORK_OPTIONS.sameOriginOnly, true);
  assert.equal(DEFAULT_RECORD_NETWORK_OPTIONS.maxEvents, 200);
  const src = fs.readFileSync('packages/browser-render/src/index.ts', 'utf8');
  // 必须是显式 === true 才挂监听，不能用 truthy 判断（避免配置里传字符串 'false' 也开启）
  assert.match(src, /const recordNetwork = input\.recordNetwork === true;/);
  // 绝不读取请求头（防 Authorization / Cookie 泄漏）
  assert.doesNotMatch(src, /request\.headers\(\)/);
});
