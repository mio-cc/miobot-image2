import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildBotGalleryPayload,
  collectMessageContext,
  extractForwardIds,
  extractMessageText,
  parseRemotePromptInput,
  resolveReferencedMessage,
  withReferenceContext,
} from '../scripts/bot-runtime.mjs';

class FakeAdapter {
  constructor(messages = {}, forwards = {}, bridges = {}) {
    this.messages = messages;
    this.forwards = forwards;
    this.bridges = bridges;
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
  getForwardBridgeTargets(id) {
    this.calls.push(['getForwardBridgeTargets', String(id)]);
    return this.bridges[String(id)] || [];
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
  assert.deepEqual(adapter.calls.map((call) => call[0]), ['getMessage', 'getForwardBridgeTargets', 'getForwardMessage']);
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

test('bot runtime: json forward ids and bridged forward targets are collected', async () => {
  const adapter = new FakeAdapter(
    {
      q: {
        sender: { user_id: '2000' },
        message: [
          {
            type: 'json',
            data: {
              data: JSON.stringify({
                meta: { news: { title: '合并记录卡片', desc: '请总结里面的方案' } },
                forward_id: 'outer-forward',
              }),
            },
          },
        ],
      },
    },
    {
      'inner-forward': {
        messages: [
          {
            sender: { nickname: '需求方' },
            message: [{ type: 'text', data: { text: '引用里的真实需求：保留合并聊天内容。' } }],
          },
        ],
      },
      'outer-forward': {
        messages: [{ sender: { nickname: '外层' }, message: [{ type: 'text', data: { text: '外层记录' } }] }],
      },
    },
    { 'outer-forward': ['inner-forward'] },
  );

  assert.deepEqual(extractForwardIds([{ type: 'json', data: { data: JSON.stringify({ forward_id: 'fwd-json' }) } }]), ['fwd-json']);
  assert.match(extractMessageText({ meta: { detail_1: { title: '标题', desc: '描述' } }, finalPrompt: '最终提示词' }), /最终提示词/);

  const ref = await resolveReferencedMessage(adapter, 'q', '10000');
  assert.match(ref.text, /合并记录卡片/);
  assert.match(ref.text, /真实需求/);
  assert.match(ref.text, /外层记录/);
  assert.deepEqual(adapter.calls.map((call) => call[0]), [
    'getMessage',
    'getForwardBridgeTargets',
    'getForwardBridgeTargets',
    'getForwardMessage',
    'getForwardMessage',
  ]);
});

test('bot runtime: remote prompt input parser supports v1 detail, paging and filters', () => {
  assert.deepEqual(parseRemotePromptInput('id:abc-123'), {
    query: '',
    id: 'abc-123',
    page: 1,
    type: '',
    category: '',
    tag: '',
  });
  assert.deepEqual(parseRemotePromptInput('type:image cat:anime tag:portrait cyber girl p3'), {
    query: 'cyber girl',
    id: '',
    page: 3,
    type: 'IMAGE',
    category: 'anime',
    tag: 'portrait',
  });
});

test('bot runtime: image results are normalized for canvas gallery sync', () => {
  const payload = buildBotGalleryPayload({
    prompt: 'effective prompt',
    params: { rawInput: 'raw prompt', size: '1024x1536', quality: 'high' },
    artifacts: [
      { kind: 'base64', data: 'AAAA', mimeType: 'image/png', index: 0 },
      { kind: 'url', data: 'https://example.test/image.png', index: 1 },
    ],
  }, {
    mode: 'edit',
    command: 'img2Img',
    context: { chatType: 'group', groupId: '100', userId: '200' },
  });

  assert.equal(payload.mode, 'edit');
  assert.equal(payload.command, 'img2Img');
  assert.equal(payload.prompt, 'raw prompt');
  assert.equal(payload.effectivePrompt, 'effective prompt');
  assert.equal(payload.sizeApiValue, '1024x1536');
  assert.equal(payload.quality, 'high');
  assert.deepEqual(payload.context, { chatType: 'group', groupId: '100', userId: '200' });
  assert.equal(payload.artifacts.length, 2);
  assert.equal(payload.artifacts[0].kind, 'base64');
  assert.equal(payload.artifacts[1].kind, 'url');
});

