import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyTtsVoiceSwitchDraft,
  applyModelSwitchDraft,
  buildSplitTextForwardNodes,
  buildModelCodeCatalog,
  buildBotGalleryPayload,
  collectMessageContext,
  collectRecentUserStandaloneContext,
  createPolicyReply,
  extractStandaloneMessageContext,
  extractForwardIds,
  extractMentionedUserIds,
  extractMessageText,
  isOnlyBotMentionMessage,
  looksLikeImageIntent,
  normalizeBotEditImagesForProvider,
  parseOwnerCommand,
  parseRemotePromptInput,
  replyFailureTextWithoutTts,
  renderModelCodeList,
  buildTtsPreprocessMessages,
  renderTtsPreprocessPrompt,
  resolveReferencedMessage,
  shouldRetryEditWithInlinedImages,
  splitReplyText,
  withReferenceContext,
} from '../scripts/bot-runtime.mjs';

class FakeAdapter {
  constructor(messages = {}, forwards = {}, bridges = {}, actions = {}) {
    this.messages = messages;
    this.forwards = forwards;
    this.bridges = bridges;
    this.actions = actions;
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
  async callAction(action, params) {
    this.calls.push(['callAction', action, params]);
    const value = this.actions[action];
    if (value === undefined) throw new Error(`missing action ${action}`);
    return typeof value === 'function' ? value(params) : value;
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

test('bot runtime: nested merged forward content is collected from inner forwards', async () => {
  const adapter = new FakeAdapter(
    {
      quote: {
        sender: { user_id: '3000' },
        message: [{ type: 'forward', data: { id: 'outer' } }],
      },
    },
    {
      outer: {
        messages: [
          { sender: { nickname: '外层' }, message: [{ type: 'text', data: { text: '外层说明' } }, { type: 'forward', data: { id: 'inner' } }] },
        ],
      },
      inner: {
        messages: [
          { sender: { nickname: '内层' }, message: [{ type: 'text', data: { text: '内层真实需求：把反推结果保留。' } }] },
        ],
      },
    },
  );

  const ref = await resolveReferencedMessage(adapter, 'quote', '10000');
  assert.match(ref.text, /外层说明/);
  assert.match(ref.text, /内层真实需求/);
  assert.deepEqual(adapter.calls.map((call) => call[0]), [
    'getMessage',
    'getForwardBridgeTargets',
    'getForwardMessage',
    'getForwardBridgeTargets',
    'getForwardMessage',
  ]);
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

test('bot runtime: QQ image segment and raw CQ image are deduped as one reference image', async () => {
  const url = 'https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=EhQSingleImageId&rkey=RKEY-A';
  const context = await collectMessageContext(null, {
    message: [
      { type: 'image', data: { file: 'D4A735EAE0E6966FE5F22C1DD20231CB.png', url } },
    ],
    raw_message: '[CQ:image,file=D4A735EAE0E6966FE5F22C1DD20231CB.png,sub_type=0,url=https://multimedia.nt.qq.com.cn/download?appid=1407&amp;fileid=EhQSingleImageId&amp;rkey=RKEY-B,file_size=108999]',
  });

  assert.equal(context.images.length, 1);
  assert.deepEqual(context.images, [url]);
});

test('bot runtime: remote edit image URLs are inlined as data URLs before provider calls', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      headers: { get: (name) => name.toLowerCase() === 'content-type' ? 'image/jpeg; charset=binary' : '' },
      arrayBuffer: async () => Uint8Array.from([1, 2, 3, 4]).buffer,
    };
  };

  const images = await normalizeBotEditImagesForProvider([
    'https://multimedia.nt.qq.com.cn/download?fileid=abc&rkey=def',
    'data:image/png;base64,EXISTING',
    'base64://RAW',
  ], { fetchImpl, maxBytes: 1024 });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://multimedia.nt.qq.com.cn/download?fileid=abc&rkey=def');
  assert.equal(images[0], 'data:image/jpeg;base64,AQIDBA==');
  assert.equal(images[1], 'data:image/png;base64,EXISTING');
  assert.equal(images[2], 'data:image/png;base64,RAW');
});

test('bot runtime: edit image fallback inlines remote URLs only after URL delivery failures', () => {
  const images = ['https://multimedia.nt.qq.com.cn/download?fileid=abc&rkey=def'];
  assert.equal(
    shouldRetryEditWithInlinedImages(
      { normalized: { category: 'network', retryable: true, message: 'stream error: stream disconnected before completion' } },
      images,
    ),
    true,
  );
  assert.equal(
    shouldRetryEditWithInlinedImages(
      { normalized: { category: 'validation', retryable: false, message: 'Your authentication token has been invalidated.', code: 'auth_unavailable' } },
      images,
    ),
    false,
  );
  assert.equal(
    shouldRetryEditWithInlinedImages(
      { normalized: { category: 'network', retryable: true, message: 'stream error' } },
      ['data:image/png;base64,abc'],
    ),
    false,
  );
});

test('bot runtime: pure bot mention is detected only for a bare bot at', () => {
  const message = {
    chatType: 'group',
    rawMessage: '[CQ:at,qq=10000]',
    mentions: ['10000'],
    segments: [{ type: 'at', data: { qq: '10000' } }],
  };
  const decision = {
    kind: 'freeMode',
    commandText: '',
    trigger: { mentionTriggered: true, replyTriggered: false, commandTriggered: false, commandText: '', textWithoutReply: '[CQ:at,qq=10000]' },
  };
  assert.equal(isOnlyBotMentionMessage(message, '10000', decision), true);
  assert.equal(isOnlyBotMentionMessage({ ...message, rawMessage: '[CQ:at,qq=10000] 画一张猫' }, '10000', { ...decision, commandText: '画一张猫' }), false);
  assert.equal(isOnlyBotMentionMessage({ ...message, mentions: ['10000', '20000'], rawMessage: '[CQ:at,qq=10000][CQ:at,qq=20000]' }, '10000', decision), false);
  assert.equal(isOnlyBotMentionMessage({ ...message, replyToMessageId: 'r1' }, '10000', decision), false);
});

test('bot runtime: recent user standalone context filters by user, minute window and never expands forwards', async () => {
  const now = 1_780_406_400_000;
  const history = [
    {
      message_id: '1',
      time: Math.floor((now - 15_000) / 1000),
      sender: { user_id: '20000' },
      message: [
        { type: 'text', data: { text: '别人消息' } },
      ],
    },
    {
      message_id: '2',
      time: Math.floor((now - 20_000) / 1000),
      sender: { user_id: '12345' },
      message: [
        { type: 'text', data: { text: '把这张图片补充完整' } },
        { type: 'image', data: { url: 'https://example.test/a.png' } },
      ],
    },
    {
      message_id: '3',
      time: Math.floor((now - 25_000) / 1000),
      sender: { user_id: '12345' },
      message: [
        { type: 'forward', data: { id: 'secret-forward' } },
      ],
    },
    {
      message_id: '4',
      time: Math.floor((now - 120_000) / 1000),
      sender: { user_id: '12345' },
      message: [{ type: 'text', data: { text: '两分钟前的备用消息' } }],
    },
    {
      message_id: '5',
      time: Math.floor(now / 1000),
      sender: { user_id: '12345' },
      message: [{ type: 'at', data: { qq: '10000' } }],
    },
  ];
  const adapter = new FakeAdapter({}, {}, {}, {
    get_group_msg_history: { status: 'ok', retcode: 0, data: { messages: history } },
  });

  const context = await collectRecentUserStandaloneContext(adapter, {
    chatType: 'group',
    groupId: '9000',
    userId: '12345',
    messageId: '5',
  }, { freeMode: { maxInputImages: 1 }, napcat: { getMessageTimeoutMs: 5000 } }, { now });

  assert.equal(context.mode, 'last-minute');
  assert.equal(context.messages.length, 2);
  assert.match(context.messages[0].text, /把这张图片补充完整/);
  assert.match(context.messages[1].text, /合并聊天记录/);
  assert.deepEqual(context.images, ['https://example.test/a.png']);
  assert.deepEqual(adapter.calls.filter((call) => call[0] === 'getForwardMessage'), []);
});

test('bot runtime: standalone extraction and image-intent guard avoid non-text TTS paths', () => {
  const standalone = extractStandaloneMessageContext({
    message: [
      { type: 'text', data: { text: '看看这个' } },
      { type: 'forward', data: { id: 'fwd-never-read' } },
      { type: 'node', data: { content: [{ type: 'text', data: { text: '不应读取的节点内容' } }] } },
      { type: 'image', data: { url: 'https://example.test/1.png' } },
      { type: 'image', data: { url: 'https://example.test/2.png' } },
    ],
  }, { maxImages: 1 });

  assert.match(standalone.text, /看看这个/);
  assert.match(standalone.text, /内容未读取/);
  assert.doesNotMatch(standalone.text, /不应读取的节点内容/);
  assert.deepEqual(standalone.images, ['https://example.test/1.png']);
  assert.equal(looksLikeImageIntent('把这张图片补充完整'), true);
  assert.equal(looksLikeImageIntent('画一张猫猫头像'), true);
  assert.equal(looksLikeImageIntent('今天天气怎么样'), false);
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

  assert.deepEqual(
    parseOwnerCommand({
      chatType: 'group',
      rawMessage: '[CQ:at,qq=10000] /tts.2',
      mentions: ['10000'],
    }, '10000'),
    { command: 'switchTtsVoice', index: 2 },
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
  const adapter = {
    async sendGroupText(groupId, text, replyToMessageId) {
      calls.push({ method: 'sendGroupText', groupId, text, replyToMessageId });
      return { success: true };
    },
  };
  const context = { chatType: 'group', groupId: '100', userId: '200', replyToMessageId: 'm1' };
  const result = await replyFailureTextWithoutTts(adapter, context, new Error('stream error: stream ID 7; INTERNAL_ERROR'));

  assert.equal(result.success, true);
  assert.deepEqual(calls, [
    {
      method: 'sendGroupText',
      groupId: '100',
      text: 'LSP，你想干什么',
      replyToMessageId: 'm1',
    },
  ]);
});

test('bot runtime: owner tts voice switch uses numbered fish reference ids', () => {
  const draft = { bot: { tts: { enabled: true, voiceId: 'voice-a', voiceIds: ['voice-b', 'voice-c'] } } };
  const result = applyTtsVoiceSwitchDraft(draft, 2);
  assert.equal(result.ok, true);
  assert.equal(draft.bot.tts.voiceId, 'voice-b');
  assert.deepEqual(draft.bot.tts.voiceIds, ['voice-a', 'voice-b', 'voice-c']);
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

test('bot runtime: long forward text is split into nodes inside one merged forward message', async () => {
  const adapterCalls = [];
  const adapter = {
    async sendGroupTextForward(groupId, nodes, botName) {
      adapterCalls.push({ method: 'sendGroupTextForward', groupId, nodes, botName });
      return { success: true, forwardId: 'fwd-text' };
    },
  };
  const baseReply = {
    async replyText() {
      throw new Error('baseReply.replyText should not be called for split forward text');
    },
  };
  const reply = createPolicyReply(baseReply, adapter, {
    bot: {
      replyStrategies: { text: 'forward' },
      textReply: { maxChars: 10, showPartPrefix: true, splitDelayMs: 0 },
      tts: { enabled: false },
    },
  });
  const result = await reply.replyText({ chatType: 'group', groupId: 1000, botName: 'Miobot' }, '第一段内容很长。第二段继续补充说明。');
  assert.equal(result.success, true);
  assert.equal(adapterCalls.length, 1);
  assert.equal(adapterCalls[0].method, 'sendGroupTextForward');
  assert.ok(adapterCalls[0].nodes.length > 1);
  assert.match(adapterCalls[0].nodes[0].content, /^\(1\/\d+\)/);
  assert.equal(buildSplitTextForwardNodes(['a', 'b'], { showPartPrefix: false }, 'Bot')[1].title, 'Bot 2/2');
});
