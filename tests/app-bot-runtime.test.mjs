import test from 'node:test';
import assert from 'node:assert/strict';

import { createBotApp, createBotMessageRuntime, extractImages, segmentsToRaw } from '../dist/apps/bot/src/main.js';
import { createDefaultConfig } from '../dist/packages/config/src/index.js';

function makeModelClient() {
  const calls = [];
  return {
    calls,
    can: (m, op) => {
      if (op === 'vision') return /gpt-4o/.test(m);
      if (op === 'image.generate' || op === 'image.edit') return /image|dall/.test(m);
      if (op === 'interrogate') return /gpt-4o/.test(m);
      return true;
    },
    chat: async (i, r) => { calls.push(['chat', r]); return { text: 'CHAT', raw: {} }; },
    vision: async (i, r) => { calls.push(['vision', r]); return { text: 'VISION', raw: {} }; },
    generateImages: async (i, r) => { calls.push(['generate', r]); return { images: [{ kind: 'base64', data: 'AAA', mimeType: 'image/png', index: 0 }], raw: {} }; },
    editImage: async (i, r) => { calls.push(['edit', r]); return { images: [{ kind: 'base64', data: 'BBB', mimeType: 'image/png', index: 0 }], raw: {} }; },
    interrogate: async (i, r) => { calls.push(['interrogate', r]); return { text: 'a cat on a sofa', raw: {} }; },
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
  };
}

function setup() {
  const client = makeModelClient();
  const reply = makeReply();
  const getConfig = () => { const c = createDefaultConfig(); c.bot.botQqId = '10000'; return c; };
  const app = createBotApp({ getConfig, client });
  const rt = createBotMessageRuntime({ app, reply, getConfig, botName: 'Mio' });
  return { client, reply, rt };
}

test('extractImages: from segments and CQ image, deduped', () => {
  const imgs = extractImages({
    message: [{ type: 'image', data: { url: 'http://x/a.png' } }],
    raw_message: 'hi[CQ:image,file=http://x/a.png][CQ:image,file=http://x/b.png]',
  });
  assert.deepEqual(imgs, ['http://x/a.png', 'http://x/b.png']);
});

test('segmentsToRaw: rebuilds at/reply/image/text', () => {
  const raw = segmentsToRaw([
    { type: 'reply', data: { id: '99' } },
    { type: 'at', data: { qq: '10000' } },
    { type: 'text', data: { text: 'hello' } },
  ]);
  assert.equal(raw, '[CQ:reply,id=99][CQ:at,qq=10000]hello');
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
  const getConfig = () => { const c = createDefaultConfig(); c.bot.botQqId = '10000'; return c; };
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
  const getConfig = () => createDefaultConfig();
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
  const getConfig = () => { const c = createDefaultConfig(); c.bot.ownerQQs = ['5']; return c; };
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
  const getConfig = () => { const c = createDefaultConfig(); c.bot.ownerQQs = ['5']; return c; };
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
