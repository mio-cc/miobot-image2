import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyModelSwitchDraft,
  buildModelCodeCatalog,
  buildBotGalleryPayload,
  collectMessageContext,
  extractForwardIds,
  extractMentionedUserIds,
  extractMessageText,
  parseOwnerCommand,
  parseRemotePromptInput,
  replyFailureTextWithoutTts,
  renderModelCodeList,
  buildTtsPreprocessMessages,
  renderTtsPreprocessPrompt,
  resolveReferencedMessage,
  splitReplyText,
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

test('bot runtime: owner commands require bot address where appropriate and target mentioned user', () => {
  assert.deepEqual(extractMentionedUserIds('[CQ:at,qq=10000][CQ:at,qq=20000] /拉黑'), ['10000', '20000']);

  assert.deepEqual(
    parseOwnerCommand({
      chatType: 'group',
      rawMessage: '[CQ:at,qq=20000] /拉黑',
      mentions: ['20000'],
    }, '10000'),
    { command: 'blacklist', targetUserId: '20000' },
  );

  assert.equal(
    parseOwnerCommand({
      chatType: 'group',
      rawMessage: '/c3',
      mentions: [],
    }, '10000'),
    undefined,
  );

  assert.deepEqual(
    parseOwnerCommand({
      chatType: 'group',
      rawMessage: '[CQ:at,qq=10000] /c3',
      mentions: ['10000'],
    }, '10000'),
    { command: 'recall', count: 3 },
  );

  assert.deepEqual(
    parseOwnerCommand({
      chatType: 'private',
      rawMessage: '/ttsk',
      mentions: [],
    }, '10000'),
    { command: 'ttsOn' },
  );
});

test('bot runtime: owner model list and switch commands parse', () => {
  assert.deepEqual(
    parseOwnerCommand({
      chatType: 'group',
      rawMessage: '[CQ:at,qq=10000] /模型',
      mentions: ['10000'],
    }, '10000'),
    { command: 'modelList' },
  );
  assert.deepEqual(
    parseOwnerCommand({
      chatType: 'group',
      rawMessage: '[CQ:at,qq=10000] /q hf.2',
      mentions: ['10000'],
    }, '10000'),
    { command: 'switchModel', code: 'hf.2' },
  );
  assert.deepEqual(
    parseOwnerCommand({
      chatType: 'private',
      rawMessage: '/切换 1.2',
      mentions: [],
    }, '10000'),
    { command: 'switchModel', code: '1.2' },
  );
});

test('bot runtime: tts preprocess prompt renders placeholders for upstream model', () => {
  const prompt = renderTtsPreprocessPrompt('请翻译并加入语气标签：{{text}} / {{replyText}}', '你好，世界');
  assert.equal(prompt, '请翻译并加入语气标签：你好，世界 / 你好，世界');

  const messages = buildTtsPreprocessMessages('只输出语音文本：{{input}}', '短回复');
  assert.deepEqual(messages, [
    { role: 'system', content: '只输出语音文本：短回复' },
    { role: 'user', content: '短回复' },
  ]);
});

test('bot runtime: failure replies bypass policy tts wrapper', async () => {
  const calls = [];
  const baseReply = {
    async replyText(context, text, strategy) {
      calls.push({ context, text, strategy });
      return { success: true, kind: 'text', strategy, attempts: [] };
    },
  };
  const context = { chatType: 'group', groupId: '100', userId: '200', replyToMessageId: 'm1' };
  const result = await replyFailureTextWithoutTts(baseReply, context, new Error('stream error: stream ID 7; INTERNAL_ERROR'), 'quote');

  assert.equal(result.success, true);
  assert.deepEqual(calls, [
    {
      context,
      text: '处理失败：stream error: stream ID 7; INTERNAL_ERROR',
      strategy: 'quote',
    },
  ]);
});

test('bot runtime: model code catalog orders ordinary nodes before hugging face and switch updates draft', () => {
  const cfg = {
    llm: {
      apiKeys: [
        { name: '普通节点一', enabled: true, baseUrl: 'http://node-1/v1', models: ['model-a', 'model-b'] },
        { name: '普通节点二', enabled: true, baseUrl: 'http://node-2/v1', models: ['model-c'] },
      ],
      chatNodeIndex: 0,
      chatModel: 'model-a',
      chatEnabled: true,
    },
    freeMode: { nodeIndex: 0, model: 'model-a' },
    huggingFace: {
      enabled: true,
      useForChat: false,
      cachedModels: [
        { id: 'org/hf-a', code: 'hf.1', provider: 'cerebras', pipelineTag: 'text-generation', inference: 'warm', requestMode: 'openai-chat' },
        { id: 'org/hf-b', code: 'hf.2', provider: 'hf-inference', pipelineTag: 'image-text-to-text', inference: 'warm', requestMode: 'openai-chat' },
      ],
    },
  };

  const catalog = buildModelCodeCatalog(cfg);
  assert.equal(catalog.ordinary[0].models[0].code, '1.1');
  assert.equal(catalog.ordinary[1].models[0].code, '2.1');
  assert.equal(catalog.huggingFace.models[0].code, 'hf.1');
  const rendered = renderModelCodeList(cfg);
  assert.match(rendered, /普通接口/);
  assert.match(rendered, /Hugging Face/);
  assert.ok(rendered.indexOf('1.1') < rendered.indexOf('hf.1'));

  let result = applyModelSwitchDraft(cfg, '2.1');
  assert.equal(result.ok, true);
  assert.equal(cfg.llm.chatNodeIndex, 1);
  assert.equal(cfg.llm.chatModel, 'model-c');
  assert.equal(cfg.huggingFace.useForChat, false);

  result = applyModelSwitchDraft(cfg, 'hf.2');
  assert.equal(result.ok, true);
  assert.equal(cfg.huggingFace.useForChat, true);
  assert.equal(cfg.huggingFace.selectedModelId, 'org/hf-b');
  assert.equal(cfg.huggingFace.selectedProvider, 'hf-inference');
  assert.equal(cfg.huggingFace.selectedModelCode, 'hf.2');
});

test('bot runtime: long text splitter preserves content without truncation', () => {
  const text = '第一段内容很长。第二段继续补充说明。第三段收尾。';
  const chunks = splitReplyText(text, { maxChars: 10 });
  assert.ok(chunks.length > 1);
  assert.equal(chunks.join(''), text);
  assert.deepEqual(splitReplyText('短文本', { maxChars: 0 }), ['短文本']);
});

