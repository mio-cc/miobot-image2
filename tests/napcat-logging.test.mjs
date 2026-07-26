import test from 'node:test';
import assert from 'node:assert/strict';

import { summarizeLogValue } from '../dist/packages/napcat/src/index.js';

/**
 * 日志里不能出现整段 base64。
 * 一张普通图片就是 1.33MB 的一行日志，几张图能把 5MB 轮转窗口冲干净，
 * 真正需要的诊断信息全被挤掉。
 */

test('data URL 被摘要成类型 + 大小', () => {
  const big = `data:image/png;base64,${'A'.repeat(2 * 1024 * 1024)}`;
  const out = summarizeLogValue(big);
  assert.match(out, /^<image\/png base64 约 \d+KB>$/);
  assert.ok(out.length < 60);
});

test('base64:// 引用同样被摘要', () => {
  const out = summarizeLogValue(`base64://${'B'.repeat(900000)}`);
  assert.match(out, /^<base64 约 \d+KB>$/);
});

test('普通长文本截断并标出总长', () => {
  const out = summarizeLogValue('x'.repeat(5000));
  assert.ok(out.startsWith('x'.repeat(256)));
  assert.match(out, /共 5000 字符/);
});

test('短字符串原样保留（诊断信息不能被削掉）', () => {
  assert.equal(summarizeLogValue('send_group_msg'), 'send_group_msg');
  assert.equal(summarizeLogValue(''), '');
});

test('嵌套结构逐层摘要，数字布尔不受影响', () => {
  const params = {
    group_id: 12345,
    auto_escape: false,
    message: [
      { type: 'text', data: { text: '这是一句正常的话' } },
      { type: 'image', data: { file: `data:image/jpeg;base64,${'C'.repeat(1500000)}` } },
    ],
  };
  const out = summarizeLogValue(params);
  assert.equal(out.group_id, 12345);
  assert.equal(out.auto_escape, false);
  assert.equal(out.message[0].data.text, '这是一句正常的话');
  assert.match(out.message[1].data.file, /^<image\/jpeg base64 约 \d+KB>$/);

  const serialized = JSON.stringify(out);
  assert.ok(serialized.length < 500, `摘要后仍有 ${serialized.length} 字符，没起到作用`);
});

test('深层嵌套不会无限递归', () => {
  let deep = { v: 'x' };
  for (let i = 0; i < 20; i += 1) deep = { nested: deep };
  const out = summarizeLogValue(deep);
  assert.ok(JSON.stringify(out).includes('深层嵌套已省略'));
});
