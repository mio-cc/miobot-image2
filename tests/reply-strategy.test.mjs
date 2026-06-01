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
  sendGroupImage(groupId, fileUrl, summaryText) { return this.record('sendGroupImage', { groupId, fileUrl, summaryText }); }
  sendPrivateImage(userId, fileUrl) { return this.record('sendPrivateImage', { userId, fileUrl }); }
  sendGroupImageAt(groupId, fileUrl, userId) { return this.record('sendGroupImageAt', { groupId, fileUrl, userId }); }
  sendGroupImageQuote(groupId, fileUrl, messageId) { return this.record('sendGroupImageQuote', { groupId, fileUrl, messageId }); }
  sendGroupImageForward(groupId, fileUrl, botName) { return this.record('sendGroupImageForward', { groupId, fileUrl, botName }, { success: true, forwardId: 'single-fwd', forwardIds: ['single-fwd'] }); }
  sendGroupImagesForward(groupId, fileUrls, botName) { return this.record('sendGroupImagesForward', { groupId, fileUrls, botName }, this.forwardResult); }
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
