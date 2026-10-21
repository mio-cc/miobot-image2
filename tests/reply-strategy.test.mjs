import test from 'node:test';
import assert from 'node:assert/strict';

import { ReplyStrategyEngine, normalizeStrategy, resolveReplyStrategy } from '../dist/packages/reply/src/index.js';

class FakeReplyClient {
  calls = [];
  forwardResult = { success: true, forwardId: 'fwd-ok', forwardIds: ['fwd-ok'] };

  record(method, args, result = { success: true, messageId: `${method}-${this.calls.length + 1}` }) {
    this.calls.push({ method, args });
    return Promise.resolve({ ...result, messageIds: result.messageId ? [result.messageId] : result.messageIds });
  }

  sendGroupText(groupId, text, replyToMessageId) { return this.record('sendGroupText', { groupId, text, replyToMessageId }); }
  sendPrivateText(userId, text) { return this.record('sendPrivateText', { userId, text }); }
  sendGroupTextAt(groupId, text, userId) { return this.record('sendGroupTextAt', { groupId, text, userId }); }
  sendGroupTextForward(groupId, nodes, botName) { return this.record('sendGroupTextForward', { groupId, nodes, botName }); }
  sendPrivateTextForward(userId, nodes, botName) { return this.record('sendPrivateTextForward', { userId, nodes, botName }); }
  sendGroupNestedTextForward(groupId, groups, botName) { return this.record('sendGroupNestedTextForward', { groupId, groups, botName }); }
  sendPrivateNestedTextForward(userId, groups, botName) { return this.record('sendPrivateNestedTextForward', { userId, groups, botName }); }
  sendGroupImage(groupId, fileUrl, summaryText) { return this.record('sendGroupImage', { groupId, fileUrl, summaryText }); }
  sendPrivateImage(userId, fileUrl) { return this.record('sendPrivateImage', { userId, fileUrl }); }
  sendGroupVideo(groupId, fileUrl, summaryText) { return this.record('sendGroupVideo', { groupId, fileUrl, summaryText }); }
  sendPrivateVideo(userId, fileUrl) { return this.record('sendPrivateVideo', { userId, fileUrl }); }
  sendGroupVideosForward(groupId, fileUrls, botName) { return this.record('sendGroupVideosForward', { groupId, fileUrls, botName }, this.forwardResult); }
  sendPrivateVideosForward(userId, fileUrls, botName) { return this.record('sendPrivateVideosForward', { userId, fileUrls, botName }, this.forwardResult); }
  sendGroupImageAt(groupId, fileUrl, userId) { return this.record('sendGroupImageAt', { groupId, fileUrl, userId }); }
  sendGroupImageQuote(groupId, fileUrl, messageId) { return this.record('sendGroupImageQuote', { groupId, fileUrl, messageId }); }
  sendGroupImageForward(groupId, fileUrl, botName) { return this.record('sendGroupImageForward', { groupId, fileUrl, botName }, { success: true, forwardId: 'single-fwd', forwardIds: ['single-fwd'] }); }
  sendGroupImagesForward(groupId, fileUrls, botName) { return this.record('sendGroupImagesForward', { groupId, fileUrls, botName }, this.forwardResult); }
  sendGroupFile(groupId, fileUrl, fileName) { return this.record('sendGroupFile', { groupId, fileUrl, fileName }); }
  sendPrivateFile(userId, fileUrl, fileName) { return this.record('sendPrivateFile', { userId, fileUrl, fileName }); }
  sendGroupFilesForward(groupId, files, botName) { return this.record('sendGroupFilesForward', { groupId, files, botName }, this.forwardResult); }
  sendPrivateFilesForward(userId, files, botName) { return this.record('sendPrivateFilesForward', { userId, files, botName }, this.forwardResult); }
  sendGroupMixedForward(groupId, items, botName) { return this.record('sendGroupMixedForward', { groupId, items, botName }, { success: true, forwardId: 'mixed-fwd', forwardIds: ['mixed-fwd'] }); }
    sendGroupRecord(groupId, fileUrl) { return this.record('sendGroupRecord', { groupId, fileUrl }); }
    sendPrivateRecord(userId, fileUrl) { return this.record('sendPrivateRecord', { userId, fileUrl }); }
  sendPrivateMixedForward(userId, items, botName) { return this.record('sendPrivateMixedForward', { userId, items, botName }, { success: true, forwardId: 'private-mixed-fwd', forwardIds: ['private-mixed-fwd'] }); }
}

const groupContext = { chatType: 'group', groupId: 1000, senderId: 2000, replyToMessageId: 3000, botName: 'Bot' };
const privateContext = { chatType: 'private', userId: 2000, botName: 'Bot' };

test('reply strategy: normalize and resolve strategy values', () => {
  assert.equal(normalizeStrategy('at', 'plain'), 'at');
  assert.equal(normalizeStrategy('bad', 'quote'), 'quote');
  assert.equal(resolveReplyStrategy({ text: 'plain', image: 'quote', multiImage: 'forward' }, 'image'), 'quote');
});

test('reply strategy: group text forward uses text forward node', async () => {
  const client = new FakeReplyClient();
  const engine = new ReplyStrategyEngine(client, { text: 'forward' });
  const result = await engine.replyText(groupContext, 'hello');
  assert.equal(result.success, true);
  assert.equal(result.kind, 'text');
  assert.equal(result.strategy, 'forward');
  assert.equal(client.calls[0].method, 'sendGroupTextForward');
  assert.deepEqual(client.calls[0].args.nodes, [{ title: 'Bot', content: 'hello' }]);
});

test('reply strategy: group text at and quote route to dedicated methods', async () => {
  const client = new FakeReplyClient();
  const engine = new ReplyStrategyEngine(client, { text: 'at' });
  await engine.replyText(groupContext, 'hello at');
  await engine.replyText(groupContext, 'hello quote', 'quote');
  assert.equal(client.calls[0].method, 'sendGroupTextAt');
  assert.equal(client.calls[0].args.userId, 2000);
  assert.equal(client.calls[1].method, 'sendGroupText');
  assert.equal(client.calls[1].args.replyToMessageId, 3000);
});

test('reply strategy: private text forward falls back to private forward method', async () => {
  const client = new FakeReplyClient();
  const engine = new ReplyStrategyEngine(client, { text: 'forward' });
  await engine.replyText(privateContext, 'private hello');
  assert.equal(client.calls[0].method, 'sendPrivateTextForward');
  assert.deepEqual(client.calls[0].args.nodes, [{ title: 'Bot', content: 'private hello' }]);
});

test('reply strategy: single group image supports forward, at, quote, and plain', async () => {
  const client = new FakeReplyClient();
  const engine = new ReplyStrategyEngine(client, { image: 'forward' });
  await engine.replyImage(groupContext, 'img-forward');
  await engine.replyImage(groupContext, 'img-at', 'at');
  await engine.replyImage(groupContext, 'img-quote', 'quote');
  await engine.replyImage(groupContext, 'img-plain', 'plain');
  assert.deepEqual(client.calls.map((call) => call.method), ['sendGroupImageForward', 'sendGroupImageAt', 'sendGroupImageQuote', 'sendGroupImage']);
  assert.equal(client.calls[0].args.fileUrl, 'img-forward');
  assert.equal(client.calls[1].args.userId, 2000);
  assert.equal(client.calls[2].args.messageId, 3000);
});

test('reply strategy: private image sends direct private image', async () => {
  const client = new FakeReplyClient();
  const engine = new ReplyStrategyEngine(client, { image: 'forward' });
  const result = await engine.replyImage(privateContext, 'private-img');
  assert.equal(result.success, true);
  assert.equal(client.calls[0].method, 'sendPrivateImage');
  assert.equal(client.calls[0].args.fileUrl, 'private-img');
});

test('reply strategy: multi-image forward de-dupes and preserves order without repeating first', async () => {
  const client = new FakeReplyClient();
  const engine = new ReplyStrategyEngine(client, { multiImage: 'forward' });
  const result = await engine.replyImages(groupContext, ['img-a', 'img-b', 'img-a', 'img-c', 'img-b']);
  assert.equal(result.success, true);
  assert.equal(client.calls[0].method, 'sendGroupImagesForward');
  assert.deepEqual(client.calls[0].args.fileUrls, ['img-a', 'img-b', 'img-c']);
  assert.deepEqual(result.sentImages, ['img-a', 'img-b', 'img-c']);
  assert.notEqual(result.sentImages[1], result.sentImages[0]);
  assert.notEqual(result.sentImages[2], result.sentImages[0]);
});

test('reply strategy: multi-image forward failure falls back to sequential group images in order', async () => {
  const client = new FakeReplyClient();
  client.forwardResult = { success: false, error: 'forward failed' };
  const engine = new ReplyStrategyEngine(client, { multiImage: 'forward', fallbackSequentialOnForwardFailure: true });
  const result = await engine.replyImages(groupContext, ['img-a', 'img-b', 'img-a', 'img-c']);
  assert.equal(result.success, true);
  assert.deepEqual(client.calls.map((call) => call.method), ['sendGroupImagesForward', 'sendGroupImage', 'sendGroupImage', 'sendGroupImage']);
  assert.deepEqual(client.calls.slice(1).map((call) => call.args.fileUrl), ['img-a', 'img-b', 'img-c']);
  assert.deepEqual(result.sentImages, ['img-a', 'img-b', 'img-c']);
});

test('reply strategy: multi-image quote uses quote only on first image then preserves order', async () => {
  const client = new FakeReplyClient();
  const engine = new ReplyStrategyEngine(client, { multiImage: 'quote' });
  const result = await engine.replyImages(groupContext, ['img-a', 'img-b', 'img-c']);
  assert.equal(result.success, true);
  assert.deepEqual(client.calls.map((call) => call.method), ['sendGroupImageQuote', 'sendGroupImage', 'sendGroupImage']);
  assert.deepEqual(client.calls.map((call) => call.args.fileUrl), ['img-a', 'img-b', 'img-c']);
});

test('reply strategy: private multi-image sends sequential private images', async () => {
  const client = new FakeReplyClient();
  const engine = new ReplyStrategyEngine(client, { multiImage: 'forward' });
  const result = await engine.replyImages(privateContext, ['p1', 'p2', 'p1']);
  assert.equal(result.success, true);
  assert.deepEqual(client.calls.map((call) => call.method), ['sendPrivateImage', 'sendPrivateImage']);
  assert.deepEqual(client.calls.map((call) => call.args.fileUrl), ['p1', 'p2']);
  assert.deepEqual(result.sentImages, ['p1', 'p2']);
});


test('reply strategy: single file ignores quote and at strategies to avoid unsupported QQ file payloads', async () => {
  const client = new FakeReplyClient();
  const engine = new ReplyStrategyEngine(client, { file: 'quote' });
  const result = await engine.replyFiles(groupContext, [{ file: 'https://example.test/a.pptx', name: 'a.pptx' }], 'quote');
  assert.equal(result.success, true);
  assert.equal(result.kind, 'file');
  assert.deepEqual(client.calls.map((call) => call.method), ['sendGroupFile']);
  assert.deepEqual(client.calls[0].args, { groupId: 1000, fileUrl: 'https://example.test/a.pptx', fileName: 'a.pptx' });
});

test('reply strategy: file plus text keeps both in a mixed forward', async () => {
  const client = new FakeReplyClient();
  const engine = new ReplyStrategyEngine(client, { mixed: 'quote' });
  const result = await engine.replyMixed(groupContext, {
    text: '?????????????+??????',
    files: [{ file: 'https://example.test/a.pptx', name: 'a.pptx' }],
  }, 'quote');
  assert.equal(result.success, true);
  assert.deepEqual(client.calls.map((call) => call.method), ['sendGroupMixedForward']);
  assert.deepEqual(client.calls[0].args.items.map((item) => item.kind), ['text', 'file']);
});

test('reply strategy: file plus image forces group mixed forward nodes', async () => {
  const client = new FakeReplyClient();
  const engine = new ReplyStrategyEngine(client, { mixed: 'plain' });
  const result = await engine.replyMixed(groupContext, {
    text: '????',
    images: ['base64://img-a'],
    files: [{ file: 'https://example.test/a.pptx', name: 'a.pptx' }],
  }, 'quote');
  assert.equal(result.success, true);
  assert.equal(result.kind, 'mixed');
  assert.deepEqual(client.calls.map((call) => call.method), ['sendGroupMixedForward']);
  assert.deepEqual(client.calls[0].args.items.map((item) => item.kind), ['text', 'image', 'file']);
});

test('reply strategy: private files use private file and private forward methods', async () => {
  const client = new FakeReplyClient();
  const engine = new ReplyStrategyEngine(client, { multiFile: 'forward' });
  await engine.replyFiles(privateContext, [{ file: 'https://example.test/one.zip', name: 'one.zip' }]);
  await engine.replyFiles(privateContext, [
    { file: 'https://example.test/two.zip', name: 'two.zip' },
    { file: 'https://example.test/three.zip', name: 'three.zip' },
  ]);
  assert.deepEqual(client.calls.map((call) => call.method), ['sendPrivateFile', 'sendPrivateFilesForward']);
});

test('reply strategy: 单视频群/私聊直发 type:video', async () => {
  const client = new FakeReplyClient();
  const engine = new ReplyStrategyEngine(client);
  const g = await engine.replyVideo(groupContext, 'https://cdn.example/a.mp4');
  assert.equal(g.success, true);
  assert.equal(g.kind, 'video');
  assert.equal(client.calls[0].method, 'sendGroupVideo');
  assert.equal(client.calls[0].args.fileUrl, 'https://cdn.example/a.mp4');
  const p = await engine.replyVideo(privateContext, 'base64://VV');
  assert.equal(client.calls[1].method, 'sendPrivateVideo');
  assert.deepEqual(p.sentVideos, ['base64://VV']);
});

test('reply strategy: 多视频合并转发并去重', async () => {
  const client = new FakeReplyClient();
  const engine = new ReplyStrategyEngine(client, { multiVideo: 'forward' });
  const result = await engine.replyVideos(groupContext, ['v1', 'v2', 'v1']);
  assert.equal(result.success, true);
  assert.equal(result.kind, 'multiVideo');
  assert.equal(client.calls[0].method, 'sendGroupVideosForward');
  assert.deepEqual(client.calls[0].args.fileUrls, ['v1', 'v2']);
  assert.deepEqual(result.sentVideos, ['v1', 'v2']);
});

test('reply strategy: 图视混排走 mixed forward', async () => {
  const client = new FakeReplyClient();
  const engine = new ReplyStrategyEngine(client, { mixed: 'forward' });
  const result = await engine.replyMixed(groupContext, {
    text: '成品',
    images: ['img1'],
    videos: ['vid1'],
  });
  assert.equal(result.success, true);
  assert.equal(client.calls[0].method, 'sendGroupMixedForward');
  const items = client.calls[0].args.items;
  assert.ok(items.some((i) => i.kind === 'video' && i.file === 'vid1'));
  assert.ok(items.some((i) => i.kind === 'image' && i.file === 'img1'));
});

test('reply strategy: long text splits by maxChars with part prefixes', async () => {
  const { splitLongText, createReplyStrategyEngine } = await import('../dist/packages/reply/src/index.js');
  assert.deepEqual(splitLongText('1234567890', 4), ['1234', '5678', '90']);
  const sent = [];
  const engine = createReplyStrategyEngine({
    sendGroupText: async (_groupId, text) => { sent.push(text); return { success: true, messageId: sent.length }; },
    sendGroupImage: async () => ({ success: true }),
    sendPrivateImage: async () => ({ success: true }),
    sendPrivateText: async () => ({ success: true }),
  }, { text: 'plain', textReply: { maxChars: 5, splitDelayMs: 0, showPartPrefix: true } });
  const result = await engine.replyText({ chatType: 'group', groupId: '1', userId: '2' }, 'abcdefghijkl');
  assert.equal(result.success, true);
  assert.deepEqual(sent, ['(1/3) abcde', '(2/3) fghij', '(3/3) kl']);
});

test('reply strategy: long group forward is one outer forward with nested inner forwards', async () => {
  const client = new FakeReplyClient();
  const engine = new ReplyStrategyEngine(client, { text: 'forward', textReply: { maxChars: 8, showPartPrefix: true } });
  const result = await engine.replyText(
    { chatType: 'group', groupId: 1000, botName: 'Miobot' },
    '第一段内容很长。第二段继续补充说明。第三段收尾。',
  );
  assert.equal(result.success, true);
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].method, 'sendGroupNestedTextForward');
  assert.ok(client.calls[0].args.groups.length > 1);
  assert.match(client.calls[0].args.groups[0][0].content, /^\(1\/\d+\)/);
});

test('reply strategy: forward mixed results use nested mixed forward when supported', async () => {
  const client = new FakeReplyClient();
  client.sendGroupNestedMixedForward = (groupId, groups, botName) => client.record('sendGroupNestedMixedForward', { groupId, groups, botName }, { success: true, forwardId: 'nested-mixed', forwardIds: ['nested-mixed'] });
  const engine = new ReplyStrategyEngine(client, { mixed: 'forward' });
  const result = await engine.replyMixed(groupContext, { text: '成品', images: ['img1'], videos: ['vid1'] });
  assert.equal(result.success, true);
  assert.equal(client.calls[0].method, 'sendGroupNestedMixedForward');
  assert.deepEqual(client.calls[0].args.groups.map((group) => group.map((item) => item.kind)), [['text'], ['image'], ['video']]);
});

test('reply plan: forward group does not drop audio outputs', async () => {
  const client = new FakeReplyClient();
  const engine = new ReplyStrategyEngine(client, { text: 'forward', mixed: 'forward' });
  const plan = {
    groups: [{
      mode: 'flat_forward', messageCount: 1, outputs: [
        { kind: 'text', text: '图片说明' },
        { kind: 'image', url: 'https://cdn/image.png' },
        { kind: 'audio', url: 'https://cdn/voice.mp3', meta: { spokenText: '图片说明', preferredVoice: true } },
      ],
    }],
    messageCount: 1,
  };
  const result = await engine.replyPlan(groupContext, plan, { maxMessages: 3 });
  assert.equal(result.success, true);
  assert.deepEqual(client.calls.map((call) => call.method), ['sendGroupMixedForward', 'sendGroupRecord']);
  assert.equal(client.calls[1].args.fileUrl, 'https://cdn/voice.mp3');
});

test('reply plan: final dispatcher dedupes same text and explicit spoken audio', async () => {
  const client = new FakeReplyClient();
  const engine = new ReplyStrategyEngine(client, { text: 'plain' });
  const plan = {
    groups: [{ mode: 'direct', messageCount: 1, outputs: [
      { kind: 'text', text: '同一段内容', priority: 10 },
      { kind: 'audio', url: 'same.mp3', priority: 10, meta: { spokenText: '同一段内容', preferredVoice: true, voiceRequested: true } },
    ] }],
    messageCount: 1,
  };
  const result = await engine.replyPlan(privateContext, plan, { maxMessages: 3 });
  assert.equal(result.success, true);
  assert.deepEqual(client.calls.map((call) => call.method), ['sendPrivateRecord']);
  assert.equal(client.calls[0].args.fileUrl, 'same.mp3');
});
