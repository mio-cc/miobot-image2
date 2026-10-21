import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractForwardIds,
  normalizeForwardPayload,
  extractImagesFromForwardNodes,
  formatForwardMessages,
  extractReferenceText,
  isReferencedFromBot,
  composeEnrichedText,
} from '../dist/apps/bot/src/message-enrichment.js';

test('extractForwardIds: segment forward + CQ + json 卡片', () => {
  // segment 形式
  assert.deepEqual(
    extractForwardIds({ message: [{ type: 'forward', data: { id: 'abc' } }] }),
    ['abc'],
  );
  // CQ 码形式
  assert.deepEqual(
    extractForwardIds({ raw_message: '[CQ:forward,file=xyz123]' }),
    ['xyz123'],
  );
  // json 卡片嵌套
  assert.deepEqual(
    extractForwardIds({ message: [{ type: 'json', data: { data: '{"forward_id":"json1"}' } }] }),
    ['json1'],
  );
  // 混合去重
  assert.deepEqual(
    extractForwardIds({ message: [{ type: 'forward', data: { id: 'dup' } }], raw_message: '[CQ:forward,id=dup]' }),
    ['dup'],
  );
  // 空消息
  assert.deepEqual(extractForwardIds({}), []);
  assert.deepEqual(extractForwardIds(null), []);
});

test('normalizeForwardPayload: messages 数组 → 节点', () => {
  const payload = {
    messages: [
      { user_id: 1, sender: { nickname: 'Alice' }, content: [{ type: 'text', data: { text: '你好' } }] },
      { user_id: 2, nickname: 'Bob', content: '嗨' },
    ],
  };
  const nodes = normalizeForwardPayload(payload);
  assert.equal(nodes.length, 2);
  assert.equal(nodes[0].user_id, 1);
  assert.equal(nodes[0].sender?.nickname, 'Alice');
  assert.ok(Array.isArray(nodes[0].message));
  assert.equal(nodes[1].user_id, 2);
  assert.equal(nodes[1].sender?.nickname, 'Bob');
});

test('normalizeForwardPayload: data.messages 嵌套 + node 段', () => {
  const payload = {
    data: {
      messages: [{ user_id: 10, nickname: 'X', content: 'hi' }],
    },
  };
  const nodes = normalizeForwardPayload(payload);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].user_id, 10);
});

test('normalizeForwardPayload: 空返回 []', () => {
  assert.deepEqual(normalizeForwardPayload(null), []);
  assert.deepEqual(normalizeForwardPayload({}), []);
  assert.deepEqual(normalizeForwardPayload({ messages: 'not-array' }), []);
});

test('normalizeForwardPayload + extractImagesFromForwardNodes: 转发内图片可抽出', () => {
  const payload = {
    messages: [
      {
        user_id: 1,
        nickname: 'A',
        content: [
          { type: 'text', data: { text: '看图' } },
          { type: 'image', data: { url: 'http://fwd/a.png' } },
        ],
      },
      {
        user_id: 2,
        content: [{ type: 'image', data: { file: 'http://fwd/b.png', path: '/tmp/x' } }],
      },
    ],
  };
  const nodes = normalizeForwardPayload(payload);
  assert.equal(nodes.length, 2);
  const imgs = extractImagesFromForwardNodes(nodes);
  assert.ok(imgs.includes('http://fwd/a.png'));
  assert.ok(imgs.includes('http://fwd/b.png'));
});

test('normalizeForwardPayload: result.messages / body 字段兼容', () => {
  const nodes = normalizeForwardPayload({
    result: {
      messages: [{ uin: 7, nickname: 'N', body: [{ type: 'image', data: { url: 'http://z/1.png' } }] }],
    },
  });
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].user_id, 7);
  assert.ok(Array.isArray(nodes[0].message));
  assert.deepEqual(extractImagesFromForwardNodes(nodes), ['http://z/1.png']);
});

test('formatForwardMessages: 文本拼接 + 图片占位', () => {
  const nodes = [
    { user_id: 1, sender: { nickname: 'Alice' }, message: [{ type: 'text', data: { text: '你好' } }] },
    { user_id: 2, sender: { nickname: 'Bob' }, message: [{ type: 'image', data: { url: 'http://x/a.png' } }] },
  ];
  const out = formatForwardMessages(nodes);
  assert.ok(out.includes('Alice [QQ:1]: 你好'));
  assert.ok(out.includes('[图片]')); // includeImages=false 占位
  assert.ok(!out.includes('http://x/a.png'));
});

test('formatForwardMessages: maxChars 截断', () => {
  const nodes = [];
  for (let i = 0; i < 100; i++) nodes.push({ user_id: i, sender: { nickname: `U${i}` }, message: [{ type: 'text', data: { text: 'x'.repeat(100) } }] });
  const out = formatForwardMessages(nodes, { maxChars: 200 });
  assert.ok(out.length < 500);
  assert.ok(out.includes('已截断'));
});

test('extractReferenceText: 文本+图片占位', () => {
  const msg = { message: [{ type: 'text', data: { text: '看这个' } }, { type: 'image', data: { url: 'http://x/b.png' } }] };
  const out = extractReferenceText(msg);
  assert.ok(out.includes('看这个'));
  assert.ok(out.includes('[图片]'));
  assert.ok(!out.includes('http://x/b.png'));
});

test('isReferencedFromBot: user_id / sender.user_id 比对 selfId', () => {
  assert.equal(isReferencedFromBot({ user_id: 12345 }, '12345'), true);
  assert.equal(isReferencedFromBot({ user_id: 12345 }, 12345), true);
  assert.equal(isReferencedFromBot({ sender: { user_id: 12345 } }, '12345'), true);
  assert.equal(isReferencedFromBot({ user_id: 999 }, '12345'), false);
  assert.equal(isReferencedFromBot({ user_id: 12345 }, undefined), false); // 无 selfId 不判定
  assert.equal(isReferencedFromBot({}, '12345'), false);
});

test('composeEnrichedText: 三段合成', () => {
  const out = composeEnrichedText('这是什么', '引用文本', '转发文本');
  assert.ok(out.includes('这是什么'));
  assert.ok(out.includes('【引用内容】'));
  assert.ok(out.includes('引用文本'));
  assert.ok(out.includes('【合并转发内容】'));
  assert.ok(out.includes('转发文本'));
});

test('composeEnrichedText: 仅用户文本', () => {
  const out = composeEnrichedText('你好', '', '');
  assert.equal(out, '你好');
});

test('composeEnrichedText: 空用户文本但有引用', () => {
  const out = composeEnrichedText('', '引用内容', '');
  assert.ok(out.includes('【引用内容】'));
  assert.ok(out.includes('引用内容'));
});

test('composeEnrichedText: 全空 → 兜底', () => {
  const out = composeEnrichedText('', '', '');
  assert.ok(out.includes('请根据引用/转发内容处理'));
});
