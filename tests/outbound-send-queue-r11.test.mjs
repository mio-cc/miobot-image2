import test from 'node:test';
import assert from 'node:assert/strict';
import { sendResult } from '../dist/apps/bot/src/runtime.js';

test('outbound send queue: same group sends are serialized in call order', async () => {
  const order = [];
  const engine = {
    async replyText(_ctx, text) {
      if (text === 'first') await new Promise((resolve) => setTimeout(resolve, 30));
      order.push(text);
    },
  };
  const ctx = { chatType: 'group', groupId: '852969193', userId: '2238639363' };
  const result = (text) => ({ kind: 'chat', handled: true, text, decision: { kind: 'chat', params: {} } });
  const first = sendResult(engine, ctx, result('first'));
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = sendResult(engine, ctx, result('second'));
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first', 'second']);
});
test('outbound send queue: different groups do not block each other', async () => {
  const order = [];
  const engine = {
    async replyText(ctx, text) {
      if (text === 'A') await new Promise((resolve) => setTimeout(resolve, 30));
      order.push(`${ctx.groupId}:${text}`);
    },
  };
  const result = (text) => ({ kind: 'chat', handled: true, text, decision: { kind: 'chat', params: {} } });
  const first = sendResult(engine, { chatType: 'group', groupId: 'A', userId: 'u1' }, result('A'));
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = sendResult(engine, { chatType: 'group', groupId: 'B', userId: 'u2' }, result('B'));
  await Promise.all([first, second]);
  assert.deepEqual(order, ['B:B', 'A:A']);
});