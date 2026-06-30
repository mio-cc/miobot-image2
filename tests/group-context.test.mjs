import test from 'node:test';
import assert from 'node:assert/strict';

import { buildGroupContext, isForwardMessage, formatHistoryMessageText } from '../dist/apps/bot/src/group-context.js';
import { SessionStore } from '../dist/packages/core/src/index.js';

const OPTS = { messageCount: 30, skipForward: true, includeImages: true, maxChars: 4000 };
const OPTS_NO_IMG = { messageCount: 30, skipForward: true, includeImages: false, maxChars: 4000 };

function mkMsg(user_id, message_id, raw, segments, sender) {
  return { user_id, message_id, raw_message: raw, message: segments, sender: sender || { nickname: 'U' + user_id } };
}

test('isForwardMessage: segment forward + CQ forward 都识别', () => {
  assert.equal(isForwardMessage(mkMsg(1, 1, '[CQ:forward,file=x]')), true);
  assert.equal(isForwardMessage(mkMsg(1, 1, '', [{ type: 'forward', data: {} }])), true);
  assert.equal(isForwardMessage(mkMsg(1, 1, 'hello', [{ type: 'text', data: { text: 'hello' } }])), false);
});

test('buildGroupContext: 跳过合并转发', () => {
  const msgs = [
    mkMsg(1, 1, 'hi', [{ type: 'text', data: { text: 'hi' } }]),
    mkMsg(2, 2, '[CQ:forward]', [{ type: 'forward', data: {} }]),  // 转发，跳过
    mkMsg(3, 3, 'world', [{ type: 'text', data: { text: 'world' } }]),
  ];
  const out = buildGroupContext({ messages: msgs, anchorMessageId: '999', selfId: '0', options: OPTS });
  assert.ok(out.includes('U1: hi'));
  assert.ok(!out.includes('U2'));  // 转发跳过
  assert.ok(out.includes('U3: world'));
});

test('buildGroupContext: 排除 bot 自己 + 触发消息', () => {
  const msgs = [
    mkMsg(100, 100, 'bot msg', [{ type: 'text', data: { text: 'bot msg' } }]),  // bot 自己
    mkMsg(1, 50, '@bot 在吗', [{ type: 'text', data: { text: '@bot 在吗' } }]),  // 触发消息
    mkMsg(2, 60, '在的', [{ type: 'text', data: { text: '在的' } }]),
  ];
  const out = buildGroupContext({ messages: msgs, anchorMessageId: 50, selfId: 100, options: OPTS });
  assert.ok(!out.includes('bot msg'));  // bot 自己排除
  assert.ok(!out.includes('U1: @bot 在吗'));  // 触发消息排除
  assert.ok(out.includes('U2: 在的'));
});

test('buildGroupContext: 图片 URL 保留/占位', () => {
  const msgs = [
    mkMsg(1, 1, '', [{ type: 'text', data: { text: '看图' } }, { type: 'image', data: { url: 'http://x/a.png' } }]),
    mkMsg(2, 2, '', [{ type: 'video', data: {} }, { type: 'text', data: { text: '视频' } }]),
    mkMsg(3, 3, '', [{ type: 'file', data: { file: 'doc.pdf' } }]),
    mkMsg(4, 4, '', [{ type: 'record', data: {} }]),
  ];
  const withImg = buildGroupContext({ messages: msgs, anchorMessageId: '999', selfId: '0', options: OPTS });
  assert.ok(withImg.includes('http://x/a.png'));  // 图片 URL 保留
  assert.ok(withImg.includes('[视频]'));
  assert.ok(withImg.includes('[文件:doc.pdf]'));
  assert.ok(withImg.includes('[语音]'));

  const noImg = buildGroupContext({ messages: msgs, anchorMessageId: '999', selfId: '0', options: OPTS_NO_IMG });
  assert.ok(noImg.includes('[图片]'));  // includeImages=false 时占位
  assert.ok(!noImg.includes('http://x/a.png'));
});

test('buildGroupContext: maxChars 裁剪从最旧截断', () => {
  const msgs = [];
  for (let i = 1; i <= 10; i++) msgs.push(mkMsg(i, i, 'msg'.repeat(20), [{ type: 'text', data: { text: 'msg'.repeat(20) } }]));
  const out = buildGroupContext({ messages: msgs, anchorMessageId: '999', selfId: '0', options: { ...OPTS, maxChars: 100 } });
  assert.ok(out.length <= 100 + 50);  // 裁剪后不超太多（含换行容差）
  assert.ok(!out.includes('U1:'));  // 最旧的被截断
  assert.ok(out.includes('U10:'));  // 最新的保留
});

test('buildGroupContext: 空消息跳过', () => {
  const msgs = [
    mkMsg(1, 1, '', []),  // 空
    mkMsg(2, 2, 'hello', [{ type: 'text', data: { text: 'hello' } }]),
  ];
  const out = buildGroupContext({ messages: msgs, anchorMessageId: '999', selfId: '0', options: OPTS });
  assert.ok(!out.includes('U1'));  // 空消息跳过
  assert.ok(out.includes('U2: hello'));
});

test('buildGroupContext: messageCount 限制条数', () => {
  const msgs = [];
  for (let i = 1; i <= 50; i++) msgs.push(mkMsg(i, i, 'msg' + i, [{ type: 'text', data: { text: 'msg' + i } }]));
  const out = buildGroupContext({ messages: msgs, anchorMessageId: '999', selfId: '0', options: { ...OPTS, messageCount: 5 } });
  const lines = out.split('\n').filter(Boolean);
  assert.equal(lines.length, 5);  // 只取5条
  assert.ok(out.includes('msg50'));  // 最新保留
});

test('formatHistoryMessageText: 纯 CQ 字符串退化路径', () => {
  const out = formatHistoryMessageText(mkMsg(1, 1, '你好[图片]世界', undefined), { includeImages: true });
  // 退化路径用 stripNonTextCq，[图片]非CQ格式保留
  assert.ok(out.includes('你好'));
});

test('SessionStore TTL: cleanup 删除超时会话', () => {
  let now = 1000;
  const store = new SessionStore({ ttlMs: 60000, clock: () => now });
  store.append('s1', { role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' });
  store.append('s2', { role: 'user', content: 'yo' }, { role: 'assistant', content: 'yo' });
  assert.equal(store.get('s1').length, 2);
  // 时间前进 70 秒，s1 和 s2 都超时
  now += 70000;
  const removed = store.cleanup();
  assert.equal(removed, 2);
  assert.equal(store.get('s1').length, 0);
  assert.equal(store.get('s2').length, 0);
});

test('SessionStore TTL: 未超时的保留', () => {
  let now = 1000;
  const store = new SessionStore({ ttlMs: 60000, clock: () => now });
  store.append('s1', { role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' });
  now += 30000;  // 30秒，未超时
  const removed = store.cleanup();
  assert.equal(removed, 0);
  assert.equal(store.get('s1').length, 2);
  // get 更新访问时间
  now += 40000;  // 又过40秒，但 get 刚访问过
  assert.equal(store.cleanup(), 0);
});

test('SessionStore TTL: ttlMs=0 不清理', () => {
  let now = 1000;
  const store = new SessionStore({ ttlMs: 0, clock: () => now });
  store.append('s1', { role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' });
  now += 99999999;
  assert.equal(store.cleanup(), 0);
  assert.equal(store.get('s1').length, 2);
});
