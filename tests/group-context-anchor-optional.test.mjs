// 续跑取群历史时不得传空锚点（线上时测 2026-11-19）：
//   resume 分支为了凑「群上下文」用空串占位 anchorMessageId，
//   napcat 回 retcode=1400「message_id: expected an integer」，
//   整段群上下文静默变成空，日志里只留一条 get_group_msg_history failed。
// 契约：没有锚点时整条参数省略，按群最近历史取。
import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchGroupContext, buildGroupContext } from '../dist/apps/bot/src/group-context.js';

const HISTORY = [
  { message_id: 11, user_id: 5, sender: { nickname: 'mio' }, raw_message: '看本周三江' },
  { message_id: 12, user_id: 6, sender: { nickname: 'other' }, raw_message: '插一句' },
];

test('fetchGroupContext: 不传锚点时不带 message_id 参数', async () => {
  const seen = [];
  const result = await fetchGroupContext({
    fetchHistory: async (groupId, anchorMessageId, count) => {
      seen.push({ groupId, anchorMessageId, count });
      return HISTORY;
    },
    groupId: '1098867961',
    options: { messageCount: 30, skipForward: true, includeImages: false, maxChars: 4000 },
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].anchorMessageId, undefined, '锚点必须缺省，而不是空串');
  assert.match(result.context, /看本周三江/);
});

test('fetchGroupContext: 传了锚点就按锚点过滤触发消息本身', async () => {
  const result = await fetchGroupContext({
    fetchHistory: async () => HISTORY,
    groupId: '1',
    anchorMessageId: 11,
    options: { messageCount: 30, skipForward: true, includeImages: false, maxChars: 4000 },
  });
  assert.equal(result.context.includes('看本周三江'), false, '锚点那条不该出现在上下文里');
  assert.match(result.context, /插一句/);
});

test('buildGroupContext: 没有锚点时保留全部消息', () => {
  const built = buildGroupContext({
    messages: HISTORY,
    selfId: '10000',
    options: { messageCount: 30, skipForward: true, includeImages: false, maxChars: 4000 },
  });
  assert.match(built.context, /看本周三江/);
  assert.match(built.context, /插一句/);
  assert.deepEqual(built.messageIds, ['11', '12']);
});