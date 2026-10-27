import test from 'node:test';
import assert from 'node:assert/strict';

import { createBotApp, createBotMessageRuntime, extractImages, extractVideos, extractReplyIdFromEvent, segmentsToRaw } from '../dist/apps/bot/src/main.js';
import { createDefaultConfig } from '../dist/packages/config/src/index.js';
/** R9 修复后 Agent 默认 enforce：本文件测旧引擎/命令路径，显式关闭 agent（聊天语义另测）。 */
function createDefaultConfigAgentOff() {
  const c = withAgentOff(createDefaultConfig());
  c.agent.enabled = false;
  c.agent.mode = 'off';
  c.intentRecognition.enabled = false;
  return c;
}
function withAgentOff(c) {
  c.agent.enabled = false;
  c.agent.mode = 'off';
  c.intentRecognition.enabled = false;
  return c;
}


function makeModelClient() {
  const calls = [];
  return {
    calls,
    can: (m, op) => {
      if (op === 'vision') return /gpt-4o/.test(m);
      if (op === 'image.generate' || op === 'image.edit') return /image|dall/.test(m);
      if (op === 'interrogate') return /gpt-4o/.test(m);
      if (op === 'video.generate') return /video|imagine-video/i.test(m);
      return true;
    },
    chat: async (i, r) => { calls.push(['chat', r]); return { text: 'CHAT', raw: {} }; },
    vision: async (i, r) => { calls.push(['vision', r]); return { text: 'VISION', raw: {} }; },
    generateImages: async (i, r) => { calls.push(['generate', r]); return { images: [{ kind: 'base64', data: 'AAA', mimeType: 'image/png', index: 0 }], raw: {} }; },
    editImage: async (i, r) => { calls.push(['edit', r]); return { images: [{ kind: 'base64', data: 'BBB', mimeType: 'image/png', index: 0 }], raw: {} }; },
    interrogate: async (i, r) => { calls.push(['interrogate', r]); return { text: 'a cat on a sofa', raw: {} }; },
    generateVideo: async (i, r) => { calls.push(['video', r]); return { videos: [{ kind: 'url', data: 'https://vid.example/out.mp4', index: 0 }], pending: false, raw: {} }; },
  };
}

function makeReply() {
  const sent = [];
  const ok = () => ({ success: true, messageId: 1 });
  return {
    sent,
    sendGroupText: async (g, t) => { sent.push(['groupText', g, t]); return ok(); },
    sendPrivateText: async (u, t) => { sent.push(['privateText', u, t]); return ok(); },
    sendGroupImage: async (g, f) => { sent.push(['groupImage', g, f]); return ok(); },
    sendPrivateImage: async (u, f) => { sent.push(['privateImage', u, f]); return ok(); },
    sendGroupVideo: async (g, f) => { sent.push(['groupVideo', g, f]); return ok(); },
    sendPrivateVideo: async (u, f) => { sent.push(['privateVideo', u, f]); return ok(); },
  };
}

function setup(overrides = {}) {
  const client = makeModelClient();
  const reply = makeReply();
  const getConfig = () => { const c = withAgentOff(createDefaultConfig()); c.bot.botQqId = '10000'; return c; };
  const app = createBotApp({ getConfig, client });
  const rt = createBotMessageRuntime({ app, reply, getConfig, botName: 'Mio', ...overrides });
  return { client, reply, rt };
}

test('extractImages: from segments and CQ image, deduped', () => {
  const imgs = extractImages({
    message: [{ type: 'image', data: { url: 'http://x/a.png' } }],
    raw_message: 'hi[CQ:image,file=http://x/a.png][CQ:image,file=http://x/b.png]',
  });
  assert.deepEqual(imgs, ['http://x/a.png', 'http://x/b.png']);
});

test('extractVideos: type:video 段与 CQ:video', () => {
  assert.deepEqual(
    extractVideos({
      message: [{ type: 'video', data: { url: 'http://x/a.mp4' } }],
      raw_message: '[CQ:video,file=http://x/a.mp4][CQ:video,file=http://x/b.mp4]',
    }),
    ['http://x/a.mp4', 'http://x/b.mp4'],
  );
  assert.deepEqual(
    extractVideos({ message: [{ type: 'video', data: { path: 'http://x/c.mp4' } }] }),
    ['http://x/c.mp4'],
  );
});

test('extractImages: path 字段 / content 转发节点 / message 为 CQ 字符串', () => {
  assert.deepEqual(
    extractImages({ message: [{ type: 'image', data: { path: 'http://x/c.png' } }] }),
    ['http://x/c.png'],
  );
  assert.deepEqual(
    extractImages({ content: [{ type: 'image', data: { file: 'http://x/d.png' } }] }),
    ['http://x/d.png'],
  );
  assert.deepEqual(
    extractImages({ message: '[CQ:image,url=http://x/e.png]' }),
    ['http://x/e.png'],
  );
});

test('extractReplyIdFromEvent: segments 优先于残缺 raw_message', () => {
  const id = extractReplyIdFromEvent({
    message: [
      { type: 'reply', data: { id: '7788' } },
      { type: 'at', data: { qq: '10000' } },
      { type: 'text', data: { text: '这是什么' } },
    ],
    // 模拟部分 Napcat: raw 不含 reply CQ
    raw_message: '[CQ:at,qq=10000] 这是什么',
  });
  assert.equal(id, '7788');
});

test('segmentsToRaw: rebuilds at/reply/image/text', () => {
  const raw = segmentsToRaw([
    { type: 'reply', data: { id: '99' } },
    { type: 'at', data: { qq: '10000' } },
    { type: 'text', data: { text: 'hello' } },
  ]);
  assert.equal(raw, '[CQ:reply,id=99][CQ:at,qq=10000]hello');
});

test('freeMode: 生成视频 → generateVideo + 发 groupVideo', async () => {
  const client = makeModelClient();
  const reply = makeReply();
  const getConfig = () => {
    const c = withAgentOff(createDefaultConfig());
    c.bot.botQqId = '10000';
    c.freeMode.enabled = true;
    c.freeMode.model = 'gpt-4o-mini';
    c.llm.videoModel = 'grok-imagine-video';
    c.llm.videoEnabled = true;
    c.llm.chatModel = 'gpt-4o-mini';
    c.bot.whitelistPrivate = ['2000'];
    return c;
  };
  const app = createBotApp({ getConfig, client });
  const rt = createBotMessageRuntime({ app, reply, getConfig, botName: 'Mio' });
  const result = await rt.handleMessageEvent({
    post_type: 'message',
    message_type: 'private',
    user_id: 2000,
    message_id: 1,
    raw_message: '生成视频 火箭升空',
    message: [{ type: 'text', data: { text: '生成视频 火箭升空' } }],
  });
  assert.equal(result.handled, true);
  assert.equal(result.kind, 'video.generate');
  assert.ok(client.calls.some((c) => c[0] === 'video'));
  assert.ok(reply.sent.some((s) => s[0] === 'privateVideo' && s[2] === 'https://vid.example/out.mp4'));
});

test('freeMode: 引用图片 + @bot + 文本 → 引擎拿到引用图并走 vision/edit 路径', async () => {
  const client = makeModelClient();
  const reply = makeReply();
  const getConfig = () => {
    const c = withAgentOff(createDefaultConfig());
    c.bot.botQqId = '10000';
    c.freeMode.enabled = true;
    c.freeMode.includeQuotedMessage = true;
    c.freeMode.model = 'gpt-4o-mini';
    c.llm.chatModel = 'gpt-4o';
    c.llm.editModel = 'gpt-image-2';
    return c;
  };
  const app = createBotApp({ getConfig, client });
  const rt = createBotMessageRuntime({
    app,
    reply,
    getConfig,
    botName: 'Mio',
    fetchReferencedMessage: async (id) => {
      assert.equal(String(id), '4242');
      return {
        message_id: 4242,
        user_id: 9,
        message: [{ type: 'image', data: { url: 'http://ref/quoted.png' } }],
        raw_message: '[CQ:image,url=http://ref/quoted.png]',
      };
    },
  });
  // 关键: reply 只在 segments,raw_message 无 [CQ:reply] —— 旧实现会丢图
  const r = await rt.handleMessageEvent({
    post_type: 'message',
    message_type: 'group',
    group_id: 9,
    user_id: 5,
    message_id: 100,
    raw_message: '[CQ:at,qq=10000] 描述一下这张图',
    message: [
      { type: 'reply', data: { id: '4242' } },
      { type: 'at', data: { qq: '10000' } },
      { type: 'text', data: { text: ' 描述一下这张图' } },
    ],
  });
  assert.equal(r.handled, true);
  // 反推信号: 有图 + "描述" → interrogate 或 vision chat
  const ops = client.calls.map((c) => c[0]);
  assert.ok(ops.includes('interrogate') || ops.includes('vision') || ops.includes('chat') || ops.includes('edit'), `ops=${ops}`);
  const withImages = client.calls.find((c) => {
    const payload = c[1] || {};
    const imgs = payload.imageUrls || payload.images || [];
    return Array.isArray(imgs) && imgs.includes('http://ref/quoted.png');
  });
  assert.ok(withImages, `引用图应进入模型调用: ${JSON.stringify(client.calls)}`);
});

test('private chat: 闲聊 -> 文本回复', async () => {
  const { reply, rt } = setup();
  const r = await rt.handleMessageEvent({ post_type: 'message', message_type: 'private', user_id: 5, message_id: 1, raw_message: '在吗' });
  assert.equal(r.handled, true);
  assert.equal(r.kind, 'chat');
  assert.deepEqual(reply.sent[0], ['privateText', 5, 'CHAT']);
});

test('private genImage 命令 -> 图片回复', async () => {
  const { client, reply, rt } = setup();
  const r = await rt.handleMessageEvent({ post_type: 'message', message_type: 'private', user_id: 5, message_id: 2, raw_message: '生图 一只猫' });
  assert.equal(r.kind, 'image.generate');
  assert.equal(client.calls[0][0], 'generate');
  assert.deepEqual(reply.sent[0], ['privateImage', 5, 'data:image/png;base64,AAA']);
});

test('group 无 @ -> 忽略', async () => {
  const { reply, rt } = setup();
  const r = await rt.handleMessageEvent({ post_type: 'message', message_type: 'group', group_id: 9, user_id: 5, message_id: 3, raw_message: '随便说说' });
  assert.equal(r.handled, false);
  assert.equal(r.reason, 'group-not-triggered');
  assert.equal(reply.sent.length, 0);
});

test('group @bot 闲聊 -> 群文本回复', async () => {
  const { reply, rt } = setup();
  const r = await rt.handleMessageEvent({ post_type: 'message', message_type: 'group', group_id: 9, user_id: 5, message_id: 4, raw_message: '[CQ:at,qq=10000]在吗' });
  assert.equal(r.handled, true);
  assert.equal(r.kind, 'chat');
  assert.deepEqual(reply.sent[0], ['groupText', 9, 'CHAT']);
});

test('private editImage 带参考图 -> 改图并回图(CQ 从 prompt 剥离)', async () => {
  const { client, reply, rt } = setup();
  const r = await rt.handleMessageEvent({
    post_type: 'message', message_type: 'private', user_id: 5, message_id: 5,
    raw_message: '改图 换背景[CQ:image,file=http://x/a.png]',
    message: [{ type: 'text', data: { text: '改图 换背景' } }, { type: 'image', data: { url: 'http://x/a.png' } }],
  });
  assert.equal(r.kind, 'image.edit');
  assert.equal(client.calls[0][0], 'edit');
  assert.deepEqual(client.calls[0][1].images, ['http://x/a.png']);
  assert.equal(client.calls[0][1].prompt, '换背景');
  assert.deepEqual(reply.sent[0], ['privateImage', 5, 'data:image/png;base64,BBB']);
});

test('private interrogate 带图 -> 反推并回文本', async () => {
  const { client, reply, rt } = setup();
  const r = await rt.handleMessageEvent({
    post_type: 'message', message_type: 'private', user_id: 5, message_id: 6,
    raw_message: '反推[CQ:image,file=http://x/b.png]',
    message: [{ type: 'text', data: { text: '反推' } }, { type: 'image', data: { url: 'http://x/b.png' } }],
  });
  assert.equal(r.kind, 'image.interrogate');
  assert.equal(client.calls[0][0], 'interrogate');
  assert.deepEqual(client.calls[0][1].imageUrls, ['http://x/b.png']);
  assert.deepEqual(reply.sent[0], ['privateText', 5, 'a cat on a sofa']);
});

test('non-message post_type ignored', async () => {
  const { rt } = setup();
  const r = await rt.handleMessageEvent({ post_type: 'notice' });
  assert.equal(r.handled, false);
  assert.equal(r.reason, 'not-a-message');
});

test('self-message: user_id === selfId(botQqId) -> 忽略, 不回复', async () => {
  const { reply, rt } = setup(); // botQqId = '10000'
  const r = await rt.handleMessageEvent({ post_type: 'message', message_type: 'private', user_id: 10000, message_id: 40, raw_message: '自己发的' });
  assert.equal(r.handled, false);
  assert.equal(r.reason, 'self-message');
  assert.equal(reply.sent.length, 0);
});

test('stale-message: 事件时间超过阈值 -> 丢弃不回复', async () => {
  const { reply, rt } = setup();
  const oldTime = Math.floor(Date.now() / 1000) - 600; // 10 分钟前, 默认阈值 90s
  const r = await rt.handleMessageEvent({ post_type: 'message', message_type: 'private', user_id: 5, message_id: 41, time: oldTime, raw_message: '在吗' });
  assert.equal(r.handled, false);
  assert.equal(r.reason, 'stale-message');
  assert.equal(reply.sent.length, 0);
});

test('stale-message: 新消息(带 time)正常处理', async () => {
  const { reply, rt } = setup();
  const r = await rt.handleMessageEvent({ post_type: 'message', message_type: 'private', user_id: 5, message_id: 42, time: Math.floor(Date.now() / 1000), raw_message: '在吗' });
  assert.equal(r.handled, true);
  assert.equal(r.kind, 'chat');
  assert.deepEqual(reply.sent[0], ['privateText', 5, 'CHAT']);
});

test('empty-mention: 群里纯 @bot 无内容 -> 快捷回复, 不进引擎', async () => {
  const { client, reply, rt } = setup();
  const r = await rt.handleMessageEvent({
    post_type: 'message', message_type: 'group', group_id: 9, user_id: 5, message_id: 43,
    raw_message: '[CQ:at,qq=10000]',
    message: [{ type: 'at', data: { qq: '10000' } }],
  });
  assert.equal(r.handled, true);
  assert.equal(r.kind, 'empty-mention');
  assert.equal(client.calls.length, 0); // 没有调用任何模型能力
  assert.equal(reply.sent[0][0], 'groupText');
});

test('voice: record 明确失败 -> 不再回退文字，避免语音和文字双发', async () => {
  const client = makeModelClient();
  const getConfig = () => { const c = withAgentOff(createDefaultConfig()); c.bot.botQqId = '10000'; return c; };
  const app = createBotApp({ getConfig, client });
  const sent = [];
  const reports = [];
  const reply = {
    sendGroupText: async () => ({ success: true }),
    sendPrivateText: async (u, t) => { sent.push(['text', u, t]); return { success: true }; },
    sendGroupImage: async () => ({ success: true }),
    sendPrivateImage: async () => ({ success: true }),
    sendPrivateRecord: async () => ({ success: false, error: 'codec failed' }),
  };
  const rt = createBotMessageRuntime({
    app, reply, getConfig, botName: 'Mio', voice: async () => 'base64://VOICE',
    reportProblem: async (input) => { reports.push(input); return true; },
  });
  const r = await rt.handleMessageEvent({ post_type: 'message', message_type: 'private', user_id: 5, message_id: 44, raw_message: '在吗' });
  assert.equal(r.kind, 'chat');
  assert.deepEqual(sent, []);
  assert.ok(reports.some((item) => item.kind === 'voice-send-failed'));
});


test('private /clear 命令 -> 清会话并确认', async () => {
  const { reply, rt } = setup();
  const r = await rt.handleMessageEvent({ post_type: 'message', message_type: 'private', user_id: 5, message_id: 10, raw_message: '/clear' });
  assert.equal(r.handled, true);
  assert.equal(r.kind, 'clear');
  assert.equal(reply.sent[0][0], 'privateText');
  assert.match(reply.sent[0][2], /新对话|清除/);
});

test('private 帮助 命令 -> 指令说明', async () => {
  const { reply, rt } = setup();
  const r = await rt.handleMessageEvent({ post_type: 'message', message_type: 'private', user_id: 5, message_id: 11, raw_message: '帮助' });
  assert.equal(r.handled, true);
  assert.equal(r.kind, 'help');
  assert.match(reply.sent[0][2], /Miobot 指令/);
});

test('voice: 文本结果转语音 -> 发 record(私聊)', async () => {
  const client = makeModelClient();
  const getConfig = () => { const c = withAgentOff(createDefaultConfig()); c.bot.botQqId = '10000'; return c; };
  const app = createBotApp({ getConfig, client });
  const recSent = [];
  const reply = {
    sendGroupText: async () => ({ success: true }),
    sendPrivateText: async () => ({ success: true }),
    sendGroupImage: async () => ({ success: true }),
    sendPrivateImage: async () => ({ success: true }),
    sendPrivateRecord: async (u, f) => { recSent.push([u, f]); return { success: true }; },
  };
  const rt = createBotMessageRuntime({ app, reply, getConfig, botName: 'Mio', voice: async () => 'base64://VOICE' });
  const r = await rt.handleMessageEvent({ post_type: 'message', message_type: 'private', user_id: 5, message_id: 20, raw_message: '在吗' });
  assert.equal(r.kind, 'chat');
  assert.deepEqual(recSent[0], [5, 'base64://VOICE']);
});

test('voice: 返回空则回退文本', async () => {
  const client = makeModelClient();
  const getConfig = () => { const c = withAgentOff(createDefaultConfig()); c.bot.botQqId = '10000'; return c; };
  const app = createBotApp({ getConfig, client });
  const sent = [];
  const reply = {
    sendGroupText: async () => ({ success: true }),
    sendPrivateText: async (u, t) => { sent.push(['text', u, t]); return { success: true }; },
    sendGroupImage: async () => ({ success: true }),
    sendPrivateImage: async () => ({ success: true }),
    sendPrivateRecord: async () => { throw new Error('should not be called'); },
  };
  const rt = createBotMessageRuntime({ app, reply, getConfig, voice: async () => null });
  await rt.handleMessageEvent({ post_type: 'message', message_type: 'private', user_id: 7, message_id: 21, raw_message: '在吗' });
  assert.equal(sent[0][0], 'text'); // 语音返回空 -> 文本
});

test('owner: /模型 -> 调 owner.handle 并回复(owner 优先)', async () => {
  const client = makeModelClient();
  const getConfig = () => { const c = withAgentOff(createDefaultConfig()); c.bot.ownerQQs = ['5']; return c; };
  const app = createBotApp({ getConfig, client });
  const sent = [];
  const reply = {
    sendGroupText: async () => ({ success: true }),
    sendPrivateText: async (u, t) => { sent.push(['text', u, t]); return { success: true }; },
    sendGroupImage: async () => ({ success: true }),
    sendPrivateImage: async () => ({ success: true }),
  };
  const handled = [];
  const rt = createBotMessageRuntime({ app, reply, getConfig, owner: { ownerQQs: () => getConfig().bot.ownerQQs, handle: async (cmd) => { handled.push(cmd); return 'MODELS'; } } });
  const r = await rt.handleMessageEvent({ post_type: 'message', message_type: 'private', user_id: 5, message_id: 30, raw_message: '/模型' });
  assert.equal(r.kind, 'owner:modelList');
  assert.deepEqual(handled[0], { command: 'modelList' });
  assert.deepEqual(sent[0], ['text', 5, 'MODELS']);
});

test('owner: 非 owner 不触发 owner 通道', async () => {
  const client = makeModelClient();
  const getConfig = () => { const c = withAgentOff(createDefaultConfig()); c.bot.ownerQQs = ['5']; return c; };
  const app = createBotApp({ getConfig, client });
  const handled = [];
  const reply = {
    sendGroupText: async () => ({ success: true }),
    sendPrivateText: async () => ({ success: true }),
    sendGroupImage: async () => ({ success: true }),
    sendPrivateImage: async () => ({ success: true }),
  };
  const rt = createBotMessageRuntime({ app, reply, getConfig, owner: { ownerQQs: () => ['5'], handle: async (cmd) => { handled.push(cmd); return 'X'; } } });
  await rt.handleMessageEvent({ post_type: 'message', message_type: 'private', user_id: 999, message_id: 31, raw_message: '/模型' });
  assert.equal(handled.length, 0); // 非 owner,owner.handle 不被调用
});

test('v2 genImage: 图库同步成功后用图库 URL 交给 Napcat 发送', async () => {
  const client = makeModelClient();
  const reply = makeReply();
  const getConfig = () => { const c = withAgentOff(createDefaultConfig()); c.bot.botQqId = '10000'; return c; };
  const app = createBotApp({ getConfig, client });
  const syncCalls = [];
  const rt = createBotMessageRuntime({
    app,
    reply,
    getConfig,
    botName: 'Mio',
    syncImagesToGallery: async (input) => {
      syncCalls.push(input);
      return ['http://host.docker.internal:3018/canvas-api/assets/a1/download'];
    },
  });

  const r = await rt.handleMessageEvent({
    post_type: 'message',
    message_type: 'private',
    user_id: 5,
    message_id: 77,
    raw_message: '画 cat',
    message: [{ type: 'text', data: { text: '画 cat' } }],
  });

  assert.equal(r.kind, 'image.generate');
  assert.equal(syncCalls.length, 1);
  assert.equal(syncCalls[0].mode, 'generate');
  assert.equal(syncCalls[0].prompt, 'cat');
  assert.deepEqual(syncCalls[0].context, { chatType: 'private', groupId: undefined, userId: 5 });
  assert.deepEqual(syncCalls[0].images, ['data:image/png;base64,AAA']);
  assert.deepEqual(reply.sent[0], [
    'privateImage',
    5,
    'http://host.docker.internal:3018/canvas-api/assets/a1/download',
  ]);
});

test('v2 genImage: 图库同步异常时回退原图，不阻断 QQ 回复', async () => {
  const client = makeModelClient();
  const reply = makeReply();
  const getConfig = () => { const c = withAgentOff(createDefaultConfig()); c.bot.botQqId = '10000'; return c; };
  const app = createBotApp({ getConfig, client });
  const rt = createBotMessageRuntime({
    app,
    reply,
    getConfig,
    botName: 'Mio',
    syncImagesToGallery: async () => { throw new Error('canvas unavailable'); },
  });

  const r = await rt.handleMessageEvent({
    post_type: 'message',
    message_type: 'private',
    user_id: 5,
    message_id: 78,
    raw_message: '画 cat',
    message: [{ type: 'text', data: { text: '画 cat' } }],
  });

  assert.equal(r.kind, 'image.generate');
  assert.deepEqual(reply.sent[0], ['privateImage', 5, 'data:image/png;base64,AAA']);
});

test('v2 收图: 远程图片先内联成 data URL 再送意图路由和模型', async () => {
  const reply = makeReply();
  const getConfig = () => { const c = withAgentOff(createDefaultConfig()); c.bot.botQqId = '10000'; return c; };
  let captured;
  let preparedFrom;
  const app = {
    engine: {},
    sessions: { clear() {} },
    handle: async (input) => {
      captured = input;
      return {
        kind: 'chat',
        decision: { kind: 'chat', params: {} },
        text: 'ok',
        handled: true,
      };
    },
  };
  const rt = createBotMessageRuntime({
    app,
    reply,
    getConfig,
    botName: 'Mio',
    prepareInputImages: async (images) => {
      preparedFrom = images;
      return ['data:image/png;base64,AAAA'];
    },
  });

  const r = await rt.handleMessageEvent({
    post_type: 'message',
    message_type: 'private',
    user_id: 5,
    message_id: 79,
    raw_message: '这张图是什么[CQ:image,file=https://example.test/qq-image]',
    message: [
      { type: 'text', data: { text: '这张图是什么' } },
      { type: 'image', data: { url: 'https://example.test/qq-image' } },
    ],
  });

  assert.equal(r.handled, true);
  assert.deepEqual(preparedFrom, ['https://example.test/qq-image']);
  assert.deepEqual(captured.images, ['data:image/png;base64,AAAA']);
  assert.deepEqual(reply.sent[0], ['privateText', 5, 'ok']);
});

test('extractImages: segment with both file and url prefers Napcat local file for get_image', () => {
  const imgs = extractImages({
    message: [{ type: 'image', data: { file: '2F4E9D49282C5B22757A249618A7AE95.jpg', url: 'https://gchat.qpic.cn/download?rkey=secret' } }],
  });
  assert.deepEqual(imgs, ['2F4E9D49282C5B22757A249618A7AE95.jpg']);
});


test('owner: ch -> 撤回当前私聊最近一条机器人消息', async () => {
  const client = makeModelClient();
  const getConfig = () => {
    const c = withAgentOff(createDefaultConfig());
    c.bot.botQqId = '10000';
    c.bot.ownerQQs = ['5'];
    return c;
  };
  const app = createBotApp({ getConfig, client });
  const sent = [];
  const deleted = [];
  let nextId = 500;
  const reply = {
    sendGroupText: async () => ({ success: true, messageId: ++nextId }),
    sendPrivateText: async (u, t) => { sent.push(['text', u, t]); return { success: true, messageId: ++nextId }; },
    sendGroupImage: async () => ({ success: true, messageId: ++nextId }),
    sendPrivateImage: async () => ({ success: true, messageId: ++nextId }),
  };
  const handled = [];
  const rt = createBotMessageRuntime({
    app, reply, getConfig,
    owner: { ownerQQs: () => getConfig().bot.ownerQQs, handle: async (cmd) => { handled.push(cmd); return 'UNEXPECTED'; } },
    deleteMessage: async (id) => { deleted.push(String(id)); return true; },
  });
  const first = await rt.handleMessageEvent({ post_type: 'message', message_type: 'private', user_id: 5, message_id: 60, raw_message: '你好' });
  assert.equal(first.handled, true);
  const recall = await rt.handleMessageEvent({ post_type: 'message', message_type: 'private', user_id: 5, message_id: 61, raw_message: '/ch' });
  assert.equal(recall.kind, 'owner:recall');
  assert.deepEqual(deleted, ['501']);
  assert.equal(handled.length, 0);
  assert.ok(sent.some(([kind, user, text]) => kind === 'text' && user === 5 && text.includes('已撤回 1 条')));
});

test('private genImage default progress is silent -> image only', async () => {
  const { reply, rt } = setup({ progressMessages: true, progressReminderMs: 0 });
  const r = await rt.handleMessageEvent({ post_type: 'message', message_type: 'private', user_id: 5, message_id: 22, raw_message: '生图 一只猫' });
  assert.equal(r.kind, 'image.generate');
  assert.equal(reply.sent.length, 1);
  assert.deepEqual(reply.sent[0], ['privateImage', 5, 'data:image/png;base64,AAA']);
});

test('voice: record 发送结果不确定时不再回退文字，避免语音和文字双发', async () => {
  const client = makeModelClient();
  const getConfig = () => {
    const c = withAgentOff(createDefaultConfig());
    c.bot.botQqId = '10000';
    c.bot.textReply.maxChars = 1;
    c.bot.replyStrategies.text = 'forward';
    return c;
  };
  const app = createBotApp({ getConfig, client });
  const sent = [];
  const reply = {
    sendGroupText: async () => { sent.push(['groupText']); return { success: true }; },
    sendGroupTextForward: async () => { sent.push(['groupForward']); return { success: true }; },
    sendGroupNestedTextForward: async () => { sent.push(['groupNestedForward']); return { success: true }; },
    sendPrivateText: async () => { sent.push(['privateText']); return { success: true }; },
    sendGroupImage: async () => ({ success: true }),
    sendPrivateImage: async () => ({ success: true }),
    sendPrivateRecord: async () => ({ success: false, uncertain: true, error: 'retcode=1200 accepted but timed out' }),
  };
  const rt = createBotMessageRuntime({ app, reply, getConfig, botName: 'Mio', voice: async () => 'base64://VOICE' });
  const r = await rt.handleMessageEvent({ post_type: 'message', message_type: 'private', user_id: 5, message_id: 45, raw_message: '鍦ㄥ悧' });
  assert.equal(r.kind, 'chat');
  assert.deepEqual(sent, []);
});

test('errors: 运行异常只私聊管理员，不再回复用户', async () => {
  const client = makeModelClient();
  client.chat = async () => { throw new Error('upstream 500'); };
  const reply = makeReply();
  const reports = [];
  const getConfig = () => { const c = withAgentOff(createDefaultConfig()); c.bot.botQqId = '10000'; c.intentRecognition.enabled = false; return c; };
  const app = createBotApp({ getConfig, client });
  const rt = createBotMessageRuntime({
    app, reply, getConfig, botName: 'Mio',
    reportProblem: async (input) => { reports.push(input); return true; },
  });
  const result = await rt.handleMessageEvent({ post_type: 'message', message_type: 'private', user_id: 5, message_id: 46, raw_message: '你好' });
  assert.equal(result.handled, false);
  assert.ok(reports.some((item) => item.kind === 'engine-error' || item.kind === 'legacy-engine-error'), JSON.stringify(reports.map((r) => r.kind)));
  assert.deepEqual(reply.sent, []);
});

test('group context: 同名群成员通过 QQ 号区分，并标注当前提问用户', async () => {
  const client = makeModelClient();
  const reply = makeReply();
  const getConfig = () => {
    const c = withAgentOff(createDefaultConfig());
    c.bot.botQqId = '10000';
    c.bot.groupContext.enabled = true;
    c.bot.groupContext.messageCount = 10;
    return c;
  };
  const app = createBotApp({ getConfig, client });
  const history = [
    { message_id: 1, user_id: 101, sender: { nickname: '同名', card: '同名' }, message: [{ type: 'text', data: { text: '第一人' } }] },
    { message_id: 2, user_id: 202, sender: { nickname: '同名', card: '同名' }, message: [{ type: 'text', data: { text: '第二人' } }] },
  ];
  const rt = createBotMessageRuntime({
    app, reply, getConfig, botName: 'Mio',
    fetchGroupHistory: async () => history,
  });
  await rt.handleMessageEvent({
    post_type: 'message', message_type: 'group', group_id: 900, user_id: 303,
    sender: { nickname: '提问者', card: '提问者' }, message_id: 77,
    raw_message: '[CQ:at,qq=10000] 他们在说什么',
    message: [{ type: 'at', data: { qq: '10000' } }, { type: 'text', data: { text: ' 他们在说什么' } }],
  });
  const all = JSON.stringify(client.calls);
  assert.ok(all.includes('同名 [QQ:101]'));
  assert.ok(all.includes('同名 [QQ:202]'));
  assert.ok(all.includes('当前提问用户'));
  assert.ok(all.includes('QQ:303'));
});

test('voice: capability audio result sends record without duplicate text', async () => {
  const reply = makeReply();
  const records = [];
  reply.sendPrivateRecord = async (u, f) => { records.push([u, f]); return { success: true }; };
  const app = {
    handle: async () => ({ kind: 'chat', handled: true, text: 'fallback text', audio: ['base64://AUDIO'] }),
    engine: { handleExplicit: async () => ({ kind: 'chat', handled: true, text: 'unused' }) },
    sessions: { clear() {} },
    registry: () => ({}),
    client: {},
  };
  // off 回退 + 关闭模型意图识别：走正则兜底 chat → app.handle 的 audio 路径。
  const getConfig = () => { const c = withAgentOff(createDefaultConfig()); c.intentRecognition.enabled = false; return c; };
  const rt = createBotMessageRuntime({ app, reply, getConfig, botName: 'Mio' });
  await rt.handleMessageEvent({ post_type: 'message', message_type: 'private', user_id: 5, message_id: 47, raw_message: '你好' });
  assert.deepEqual(records, [[5, 'base64://AUDIO']]);
  assert.equal(reply.sent.length, 0);
});

test('runtime command gateway: mapped exact command bypasses legacy engine', async () => {
  const reply = makeReply();
  const replies = [];
  const getConfig = () => {
    const c = withAgentOff(createDefaultConfig());
    c.bot.botQqId = '10000';
    c.orchestration.enabled = true;
    c.orchestration.mode = 'enforce';
    return c;
  };
  const app = {
    sessions: { clear() { return true; } },
    engine: {
      handleExplicit: async () => { replies.push('legacy-explicit'); return { kind: 'image.generate', handled: true, images: ['legacy'] }; },
    },
    handle: async () => { replies.push('legacy-handle'); return { kind: 'chat', handled: true, text: 'legacy' }; },
    registry: () => ({}),
    client: {},
  };
  const calls = [];
  const rt = createBotMessageRuntime({
    app,
    reply,
    getConfig,
    commandOrchestration: async (input) => {
      calls.push(input);
      return { handled: true, result: { kind: 'image.generate', handled: true, images: ['gateway-image'] } };
    },
  });
  const result = await rt.handleMessageEvent({
    post_type: 'message', message_type: 'private', user_id: 5, message_id: 90,
    raw_message: '生图 一只猫', message: [{ type: 'text', data: { text: '生图 一只猫' } }],
  });
  assert.equal(result.kind, 'image.generate');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'genImage');
  assert.deepEqual(replies, []);
  assert.deepEqual(reply.sent[0], ['privateImage', 5, 'gateway-image']);
});

test('runtime command gateway: only command_not_mapped may fall back to legacy implementation', async () => {
  const reply = makeReply();
  const getConfig = () => {
    const c = withAgentOff(createDefaultConfig());
    c.bot.botQqId = '10000';
    c.orchestration.enabled = true;
    c.orchestration.mode = 'enforce';
    return c;
  };
  const app = {
    sessions: { clear() { return true; } },
    engine: { handleExplicit: async () => null },
    handle: async () => ({ kind: 'chat', handled: true, text: 'legacy' }),
    registry: () => ({}),
    client: {},
  };
  const rt = createBotMessageRuntime({
    app,
    reply,
    getConfig,
    commandOrchestration: async () => ({ handled: false, reason: 'command_not_mapped' }),
  });
  const result = await rt.handleMessageEvent({
    post_type: 'message', message_type: 'private', user_id: 5, message_id: 91,
    raw_message: '/clear', message: [{ type: 'text', data: { text: '/clear' } }],
  });
  assert.equal(result.kind, 'clear');
  assert.match(reply.sent[0][2], /新对话|清除/);
});

test('runtime command gateway: mapped command orchestration failure never replays legacy path', async () => {
  const reply = makeReply();
  const legacyCalls = [];
  const getConfig = () => {
    const c = withAgentOff(createDefaultConfig());
    c.bot.botQqId = '10000';
    c.orchestration.enabled = true;
    c.orchestration.mode = 'enforce';
    return c;
  };
  const app = {
    sessions: { clear() { return true; } },
    engine: { handleExplicit: async () => { legacyCalls.push('explicit'); return { kind: 'image.generate', handled: true, images: ['legacy'] }; } },
    handle: async () => ({ kind: 'chat', handled: true, text: 'legacy' }),
    registry: () => ({}),
    client: {},
  };
  const rt = createBotMessageRuntime({
    app,
    reply,
    getConfig,
    commandOrchestration: async () => ({ handled: false, reason: 'capability_failed' }),
  });
  const result = await rt.handleMessageEvent({
    post_type: 'message', message_type: 'private', user_id: 5, message_id: 92,
    raw_message: '生图 一只猫', message: [{ type: 'text', data: { text: '生图 一只猫' } }],
  });
  assert.equal(result.handled, false);
  assert.equal(result.reason, 'command-orchestration-failed');
  assert.deepEqual(legacyCalls, []);
  assert.deepEqual(reply.sent, []);
});

test('runtime command gateway: owner recall uses unified command plan', async () => {
  const reply = makeReply();
  const getConfig = () => {
    const c = withAgentOff(createDefaultConfig());
    c.bot.botQqId = '10000';
    c.bot.ownerQQs = ['5'];
    c.orchestration.enabled = true;
    c.orchestration.mode = 'enforce';
    return c;
  };
  const app = {
    sessions: { clear() { return true; } },
    engine: { handleExplicit: async () => null },
    handle: async () => ({ kind: 'chat', handled: true, text: 'legacy' }),
    registry: () => ({}),
    client: {},
  };
  const calls = [];
  const rt = createBotMessageRuntime({
    app,
    reply,
    getConfig,
    commandOrchestration: async (input) => {
      calls.push(input);
      return { handled: true, result: { kind: 'chat', handled: true, text: '已撤回 1 条消息。' } };
    },
    owner: { ownerQQs: () => ['5'], handle: async () => 'legacy-owner' },
  });
  const result = await rt.handleMessageEvent({ post_type: 'message', message_type: 'private', user_id: 5, message_id: 93, raw_message: '/ch' });
  assert.equal(result.kind, 'owner:recall');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'ownerRecall');
  assert.equal(calls[0].args, '1');
  assert.deepEqual(reply.sent[0], ['privateText', 5, '已撤回 1 条消息。']);
});
test('runtime: orchestrated result is sent only through ReplyPlan and final maxMessages wins', async () => {
  const reply = makeReply();
  const getConfig = () => {
    const c = withAgentOff(createDefaultConfig());
    c.bot.botQqId = '10000';
    c.orchestration.enabled = true;
    c.orchestration.mode = 'enforce';
    c.orchestration.reply.maxMessages = 1;
    return c;
  };
  const app = {
    sessions: { clear() { return true; } },
    engine: { handleExplicit: async () => ({ kind: 'image.generate', handled: true, images: ['legacy'] }) },
    handle: async () => ({ kind: 'chat', handled: true, text: 'legacy' }),
    registry: () => ({}),
    client: {},
  };
  const rt = createBotMessageRuntime({
    app,
    reply,
    getConfig,
    enforceOrchestration: async () => ({
      handled: true,
      result: {
        kind: 'chat', handled: true, text: 'first',
        replyPlan: {
          groups: [
            { mode: 'direct', outputs: [{ id: 't', kind: 'text', text: 'first' }], messageCount: 1 },
            { mode: 'direct', outputs: [{ id: 'i', kind: 'image', url: 'second.png' }], messageCount: 1 },
          ],
          messageCount: 2, truncated: [], warnings: [], maxMessages: 1,
        },
      },
    }),
  });
  const result = await rt.handleMessageEvent({ post_type: 'message', message_type: 'private', user_id: 5, message_id: 94, raw_message: '画一只猫' });
  assert.equal(result.handled, true);
  assert.deepEqual(reply.sent, [['privateText', 5, 'first']]);
});
test('runtime: orchestrated voice plan uncertain does not fall back to text', async () => {
  const sent = [];
  const reports = [];
  const getConfig = () => {
    const c = withAgentOff(createDefaultConfig());
    c.bot.botQqId = '10000';
    c.orchestration.enabled = true;
    c.orchestration.mode = 'enforce';
    return c;
  };
  const reply = {
    sendGroupText: async () => ({ success: true }),
    sendPrivateText: async (userId, text) => { sent.push(['text', text]); return { success: true }; },
    sendGroupImage: async () => ({ success: true }),
    sendPrivateImage: async () => ({ success: true }),
    sendPrivateRecord: async () => ({ success: false, uncertain: true, error: 'retcode=1200' }),
  };
  const app = {
    sessions: { clear() { return true; } },
    engine: { handleExplicit: async () => null },
    handle: async () => ({ kind: 'chat', handled: true, text: 'legacy' }),
    registry: () => ({}), client: {},
  };
  const rt = createBotMessageRuntime({
    app, reply, getConfig, voice: async () => 'base64://VOICE',
    reportProblem: async (input) => { reports.push(input); return true; },
    enforceOrchestration: async () => ({
      handled: true,
      result: {
        kind: 'chat', handled: true, text: '你好',
        replyPlan: {
          groups: [{ mode: 'direct', outputs: [{ id: 't', kind: 'text', text: '你好' }], messageCount: 1 }],
          messageCount: 1, truncated: [], warnings: [], maxMessages: 1,
        },
      },
    }),
  });
  const result = await rt.handleMessageEvent({ post_type: 'message', message_type: 'private', user_id: 5, message_id: 95, raw_message: '你好' });
  assert.equal(result.handled, true);
  assert.deepEqual(sent, []);
  assert.ok(reports.some((item) => item.kind === 'reply-send-uncertain'));
});
test('runtime command gateway: owner config command uses unified gateway and does not call legacy owner handler', async () => {
  const reply = makeReply();
  const getConfig = () => {
    const c = withAgentOff(createDefaultConfig());
    c.bot.botQqId = '10000';
    c.bot.ownerQQs = ['5'];
    c.orchestration.enabled = true;
    c.orchestration.mode = 'enforce';
    return c;
  };
  const app = {
    sessions: { clear() { return true; } },
    engine: { handleExplicit: async () => null },
    handle: async () => ({ kind: 'chat', handled: true, text: 'legacy' }),
    registry: () => ({}), client: {},
  };
  const calls = [];
  let legacyOwnerCalls = 0;
  const rt = createBotMessageRuntime({
    app,
    reply,
    getConfig,
    commandOrchestration: async (input) => {
      calls.push(input);
      return { handled: true, result: { kind: 'chat', handled: true, text: '已切换 chat 模型' } };
    },
    owner: { ownerQQs: () => ['5'], handle: async () => { legacyOwnerCalls += 1; return 'legacy-owner'; } },
  });
  const result = await rt.handleMessageEvent({ post_type: 'message', message_type: 'private', user_id: 5, message_id: 96, raw_message: '/切换 gpt-4o' });
  assert.equal(result.kind, 'owner:switchModel');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'ownerSwitchModel');
  assert.equal(calls[0].args, 'gpt-4o');
  assert.equal(legacyOwnerCalls, 0);
  assert.deepEqual(reply.sent[0], ['privateText', 5, '已切换 chat 模型']);
});
test('runtime: duplicate QQ message events are idempotent and do not reply twice', async () => {
  const { reply, rt } = setup();
  const event = { post_type: 'message', message_type: 'private', user_id: 5, message_id: 123456, raw_message: '在吗' };
  const first = await rt.handleMessageEvent(event);
  const second = await rt.handleMessageEvent({ ...event });
  assert.equal(first.handled, true);
  assert.equal(second.handled, false);
  assert.equal(second.reason, 'duplicate-message');
  assert.equal(reply.sent.length, 1);
});
test('runtime: memory context and group history are both fetched and merged (不再二选一)', async () => {
  const ingested = [];
  let historyCalls = 0;
  let memoryQueries = 0;
  const { rt } = setup({
    loadMemoryContext: async () => {
      memoryQueries += 1;
      return '【长期记忆】\n用户 [QQ:5]: 之前讨论过猫';
    },
    ingestMemory: (input) => { ingested.push(input); },
    fetchGroupHistory: async () => {
      historyCalls += 1;
      return [];
    },
  });
  const result = await rt.handleMessageEvent({
    post_type: 'message', message_type: 'group', group_id: 3000, user_id: 5, message_id: 8801,
    sender: { nickname: '同名' },
    raw_message: '[CQ:at,qq=10000] 继续聊刚才的话题',
    message: [{ type: 'at', data: { qq: '10000' } }, { type: 'text', data: { text: ' 继续聊刚才的话题' } }],
  });
  assert.equal(result.handled, true);
  assert.equal(memoryQueries, 1);
  // 修复：群历史不再被记忆命中短路——两类上下文互补（记忆=历史事实，群历史=刚才群里说了什么）
  assert.equal(historyCalls, 1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(ingested.some((item) => item.role === 'user' && item.text.includes('继续聊刚才的话题')));
  assert.ok(ingested.some((item) => item.role === 'assistant'));
});
test('runtime: ignored group message is not written into long-term memory', async () => {
  const ingested = [];
  const { rt } = setup({ ingestMemory: (input) => { ingested.push(input); } });
  const result = await rt.handleMessageEvent({
    post_type: 'message', message_type: 'group', group_id: 3001, user_id: 5, message_id: 8802,
    sender: { nickname: '路人' }, raw_message: '群里普通闲聊',
    message: [{ type: 'text', data: { text: '群里普通闲聊' } }],
  });
  assert.equal(result.handled, false);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(ingested.length, 0);
});

test('runtime T2.2: 每用户消息频率超限静默丢弃，不回复不报错', async () => {
  const { reply, rt } = setup({ getConfig: () => { const c = withAgentOff(createDefaultConfig()); c.bot.botQqId = '10000'; c.bot.messageRateLimitPerMinute = 3; return c; } });
  const results = [];
  for (let i = 1; i <= 5; i += 1) {
    results.push(await rt.handleMessageEvent({ post_type: 'message', message_type: 'private', user_id: 5, message_id: 700 + i, raw_message: '第' + i + '条' }));
  }
  assert.equal(results[0].handled, true);
  assert.equal(results[2].handled, true);
  assert.equal(results[3].handled, false);
  assert.equal(results[3].reason, 'user-rate-limited');
  assert.equal(results[4].reason, 'user-rate-limited');
  assert.equal(reply.sent.length, 3, '限流后的消息不再产生回复（防刷屏静默）');
});

test('runtime T2.2b: 戳一戳响应——只回被戳的 bot 本人、带冷却、遵守开关与群白名单', async () => {
  const { reply, rt } = setup();
  const handlers = {};
  rt.attach({ on: (event, handler) => { handlers[event] = handler; } });
  assert.ok(handlers.notice, 'attach 应订阅 notice 事件');
  const pokeAtBot = { post_type: 'notice', notice_type: 'notify', sub_type: 'poke', group_id: 200, user_id: 5, target_id: 10000 };
  const pokeAtOther = { post_type: 'notice', notice_type: 'notify', sub_type: 'poke', group_id: 200, user_id: 5, target_id: 6 };
  await handlers.notice(pokeAtBot);
  assert.equal(reply.sent.length, 1);
  assert.equal(reply.sent[0][0], 'groupText');
  // 冷却内第二次不回；戳别人不回。
  await handlers.notice(pokeAtBot);
  await handlers.notice(pokeAtOther);
  assert.equal(reply.sent.length, 1);
  // 私聊戳（无 group_id）走 privateText。
  await handlers.notice({ post_type: 'notice', notice_type: 'notify', sub_type: 'poke', user_id: 7, target_id: 10000 });
  assert.equal(reply.sent.length, 2);
  assert.equal(reply.sent[1][0], 'privateText');
  assert.equal(reply.sent[1][1], 7);
  // 关闭开关后不再响应。
  const { reply: reply2, rt: rt2 } = setup({ getConfig: () => { const c = withAgentOff(createDefaultConfig()); c.bot.botQqId = '10000'; c.bot.poke.enabled = false; return c; } });
  const handlers2 = {};
  rt2.attach({ on: (event, handler) => { handlers2[event] = handler; } });
  await handlers2.notice(pokeAtBot);
  assert.equal(reply2.sent.length, 0);
  // 群白名单不包含时群戳不响应（空名单=全放行已由第一段覆盖）。
  const { reply: reply3, rt: rt3 } = setup({ getConfig: () => { const c = withAgentOff(createDefaultConfig()); c.bot.botQqId = '10000'; c.bot.whitelistGroups = ['999']; return c; } });
  const handlers3 = {};
  rt3.attach({ on: (event, handler) => { handlers3[event] = handler; } });
  await handlers3.notice(pokeAtBot);
  assert.equal(reply3.sent.length, 0);
});

test('runtime T2.2b: 入群欢迎——开关/群冷却/自身入群跳过/群白名单', async () => {
  const { reply, rt } = setup({ getConfig: () => { const c = withAgentOff(createDefaultConfig()); c.bot.botQqId = '10000'; c.bot.welcome.enabled = true; return c; } });
  const handlers = {};
  rt.attach({ on: (event, handler) => { handlers[event] = handler; } });
  const join = { post_type: 'notice', notice_type: 'group_increase', sub_type: 'approve', group_id: 200, user_id: 5 };
  await handlers.notice(join);
  assert.equal(reply.sent.length, 1);
  assert.equal(reply.sent[0][0], 'groupText');
  assert.match(reply.sent[0][2], /@5/);
  // 冷却内第二名入群不迎；bot 自身入群不迎。
  await handlers.notice({ ...join, user_id: 6 });
  await handlers.notice({ ...join, user_id: 10000 });
  assert.equal(reply.sent.length, 1);
  // 默认关闭时不迎。
  const { reply: r2, rt: rt2 } = setup();
  const h2 = {};
  rt2.attach({ on: (e, h) => { h2[e] = h; } });
  await h2.notice(join);
  assert.equal(r2.sent.length, 0);
});

test('runtime T2.2b: 好友请求——accept 调 action、notify 私聊 owner、ignore 不动', async () => {
  const actions = [];
  const base = (mode) => () => { const c = withAgentOff(createDefaultConfig()); c.bot.botQqId = '10000'; c.bot.ownerQQs = ['42']; c.bot.friendRequest.mode = mode; return c; };
  const req = { post_type: 'request', request_type: 'friend', user_id: 77, flag: 'flag-1', comment: '你好' };
  // accept：调用 set_friend_add_request(approve=true)
  const a = setup({ getConfig: base('accept'), callNapcatAction: async (action, params) => { actions.push([action, params]); return {}; } });
  const ha = {};
  a.rt.attach({ on: (e, h) => { ha[e] = h; } });
  await ha.request(req);
  assert.equal(actions.length, 1);
  assert.equal(actions[0][0], 'set_friend_add_request');
  assert.equal(actions[0][1].approve, true);
  assert.equal(actions[0][1].flag, 'flag-1');
  assert.equal(a.reply.sent.length, 0, 'accept 模式不额外发消息');
  // notify：私聊 owner 一条含验证消息的通知
  const n = setup({ getConfig: base('notify') });
  const hn = {};
  n.rt.attach({ on: (e, h) => { hn[e] = h; } });
  await hn.request(req);
  assert.equal(n.reply.sent.length, 1);
  assert.equal(n.reply.sent[0][0], 'privateText');
  assert.equal(n.reply.sent[0][1], 42);
  assert.match(n.reply.sent[0][2], /77/);
  assert.match(n.reply.sent[0][2], /你好/);
  // ignore：无副作用
  const i = setup({ getConfig: base('ignore'), callNapcatAction: async (action, params) => { actions.push([action, params]); return {}; } });
  const hi = {};
  i.rt.attach({ on: (e, h) => { hi[e] = h; } });
  await hi.request(req);
  assert.equal(actions.length, 1);
  assert.equal(i.reply.sent.length, 0);
});

test('runtime T3.7: 高危 owner 命令二次确认——/plch 20 先确认，/ok 后执行', async () => {
  const handled = [];
  const { reply, rt } = setup({
    owner: {
      ownerQQs: () => ['5'],
      handle: async (command) => { handled.push(command.command); return null; },
    },
  });
  const first = await rt.handleMessageEvent({ post_type: 'message', message_type: 'private', user_id: 5, message_id: 900, raw_message: '/plch 20' });
  assert.equal(first.kind, 'owner:confirm-required');
  assert.equal(handled.length, 0, '未确认前不得执行');
  assert.match(reply.sent[0][2], /批量撤回 20 条消息/);
  const confirm = await rt.handleMessageEvent({ post_type: 'message', message_type: 'private', user_id: 5, message_id: 901, raw_message: '/ok' });
  assert.equal(confirm.kind, 'owner:recall', '确认后进入 recall 执行路径（recallRecentMessages 通道）');
  // 无待确认时 /ok 得到过期提示。
  const stray = await rt.handleMessageEvent({ post_type: 'message', message_type: 'private', user_id: 5, message_id: 902, raw_message: '/ok' });
  assert.equal(stray.kind, 'owner:confirm-expired');
});

test('runtime B: 群历史与记忆合并注入（上下文统一组装，enforce 单字段接收）', async () => {
  const inputs = [];
  let historyCalls = 0;
  const enforceCfg = () => { const c = withAgentOff(createDefaultConfig()); c.bot.botQqId = '10000'; c.orchestration.enabled = true; c.orchestration.mode = 'enforce'; c.bot.groupContext = { ...c.bot.groupContext, enabled: true }; return c; };
  const base = {
    fetchGroupHistory: async () => { historyCalls += 1; return [{ time: 1, sender: { user_id: 5, nickname: 'u' }, message: [{ type: 'text', data: { text: '群历史一条' } }] }]; },
    enforceOrchestration: async (input) => {
      inputs.push({ groupContext: input.groupContext, memoryContext: input.memoryContext });
      return { handled: true, result: { kind: 'chat', handled: true, text: 'ok', decision: { kind: 'chat', source: 'model', confidence: 1, reason: 'test', params: { prompt: '', tokens: [] }, usedPlanner: false } } };
    },
  };
  const event = (id) => ({ post_type: 'message', message_type: 'group', group_id: 3000, user_id: 5, message_id: id, sender: { nickname: 'u' }, raw_message: '[CQ:at,qq=10000] 在吗', message: [{ type: 'at', data: { qq: '10000' } }, { type: 'text', data: { text: ' 在吗' } }] });
  // 记忆命中：群历史照常拉取，两类上下文合并进 groupContext 单字段。
  const a = setup({ ...base, getConfig: enforceCfg, loadMemoryContext: async () => '【长期记忆】之前聊过猫' });
  const ra = await a.rt.handleMessageEvent(event(9001));
  assert.equal(ra.handled, true);
  assert.equal(inputs.length, 1);
  assert.match(inputs[0].groupContext, /猫/, '合并上下文应包含记忆命中');
  assert.match(inputs[0].groupContext, /群历史一条/, '合并上下文应包含群历史');
  assert.equal(inputs[0].memoryContext, undefined, '合并后不再单独携带 memoryContext');
  assert.equal(historyCalls, 1, '记忆命中时群历史照常拉取');
  // 记忆未命中：只有群历史段。
  const b = setup({ ...base, getConfig: enforceCfg, loadMemoryContext: async () => undefined });
  const rb = await b.rt.handleMessageEvent(event(9002));
  assert.equal(rb.handled, true);
  assert.equal(historyCalls, 2, '每次都拉群历史');
  assert.match(inputs[1].groupContext, /群历史一条/);
  assert.ok(!/相关记忆/.test(inputs[1].groupContext), '无记忆命中时不出现记忆段');
});
