import test from 'node:test';
import assert from 'node:assert/strict';

import {
  collectMessageContext,
  extractForwardIds,
  extractMessageText,
  resolveReferencedMessage,
  withReferenceContext,
} from '../scripts/bot-runtime.mjs';

class FakeAdapter {
  constructor(messages = {}, forwards = {}) {
    this.messages = messages;
    this.forwards = forwards;
    this.calls = [];
  }
  async getMessage(id) {
    this.calls.push(['getMessage', String(id)]);
    if (!(String(id) in this.messages)) throw new Error(`missing message ${id}`);
    return this.messages[String(id)];
  }
  async getForwardMessage(id) {
    this.calls.push(['getForwardMessage', String(id)]);
    if (!(String(id) in this.forwards)) throw new Error(`missing forward ${id}`);
    return this.forwards[String(id)];
  }
}

test('bot runtime: referenced merged forward content is collected for upstream context', async () => {
  const adapter = new FakeAdapter(
    {
      'quote-1': {
        sender: { user_id: '3000' },
        message: [
          { type: 'text', data: { text: '请看这段合并记录' } },
          { type: 'forward', data: { id: 'fwd-1' } },
        ],
      },
    },
    {
      'fwd-1': {
        messages: [
          { sender: { nickname: '甲' }, message: [{ type: 'text', data: { text: '第一条：需求是保留引用内容。' } }] },
          {
            sender: { nickname: '乙' },
            message: [
              { type: 'text', data: { text: '第二条：这里还有图片。' } },
              { type: 'image', data: { url: 'https://example.test/a.png' } },
            ],
          },
        ],
      },
    },
  );

  const ref = await resolveReferencedMessage(adapter, 'quote-1', '10000');
  assert.equal(ref.replyToBot, false);
  assert.match(ref.text, /请看这段合并记录/);
  assert.match(ref.text, /合并聊天记录 fwd-1/);
  assert.match(ref.text, /甲：第一条/);
  assert.match(ref.text, /乙：第二条/);
  assert.deepEqual(ref.images, ['https://example.test/a.png']);

  const upstream = withReferenceContext('总结一下', { referenceMessageId: 'quote-1', referenceText: ref.text });
  assert.match(upstream, /^总结一下/);
  assert.match(upstream, /【引用内容 #quote-1】/);
  assert.match(upstream, /第一条：需求是保留引用内容/);
  assert.deepEqual(adapter.calls.map((call) => call[0]), ['getMessage', 'getForwardMessage']);
});

test('bot runtime: referenced bot ownership and CQ forward ids are parsed', async () => {
  const adapter = new FakeAdapter({ bot: { sender: { user_id: '10000' }, raw_message: '[CQ:forward,id=fwd-cq]' } }, {
    'fwd-cq': { messages: [{ sender: { nickname: 'Bot' }, raw_message: '上一轮回答' }] },
  });

  assert.deepEqual(extractForwardIds('[CQ:forward,id=fwd-cq]'), ['fwd-cq']);
  assert.equal(extractMessageText('[CQ:reply,id=x][CQ:at,qq=10000] 继续'), '继续');

  const ref = await resolveReferencedMessage(adapter, 'bot', '10000');
  assert.equal(ref.replyToBot, true);
  assert.match(ref.text, /上一轮回答/);
});

