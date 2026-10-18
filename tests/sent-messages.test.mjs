import test from 'node:test';
import assert from 'node:assert/strict';

import { createSentMessageTracker, createTrackingReplyClient, sentChatKey } from '../dist/apps/bot/src/main.js';

test('sent message tracker: records successful bot message ids by chat', async () => {
  const tracker = createSentMessageTracker();
  let next = 100;
  const client = {
    sendGroupText: async () => ({ success: true, messageId: ++next }),
    sendPrivateText: async () => ({ success: true, messageId: ++next }),
    sendGroupImage: async () => ({ success: true, messageIds: [++next, ++next] }),
  };
  const tracked = createTrackingReplyClient(client, tracker);
  await tracked.sendGroupText('g1', 'hello');
  await tracked.sendGroupImage('g1', 'image');
  await tracked.sendPrivateText('u1', 'private');
  assert.deepEqual(tracker.take('group:g1', 5), [103, 102, 101]);
  assert.deepEqual(tracker.take('private:u1', 1), [104]);
  assert.equal(sentChatKey('group', 'g1', 'u1'), 'group:g1');
  assert.equal(sentChatKey('private', 'g1', 'u1'), 'private:u1');
});

test('sent message tracker: failed sends are not recorded and restored ids remain', async () => {
  const tracker = createSentMessageTracker();
  tracker.record('group:g1', [1, 2, 3]);
  assert.deepEqual(tracker.take('group:g1', 2), [3, 2]);
  tracker.restore('group:g1', [3, 2]);
  assert.deepEqual(tracker.take('group:g1', 5), [3, 2, 1]);
  tracker.restore('group:g1', [3, 2, 1]);
  tracker.remove('group:g1', [2]);
  assert.deepEqual(tracker.take('group:g1', 5), [3, 1]);

  const failing = { sendGroupText: async () => ({ success: false, messageId: 999 }) };
  const tracked = createTrackingReplyClient(failing, tracker);
  await tracked.sendGroupText('g1', 'failed');
  assert.deepEqual(tracker.take('group:g1', 5), []);
});


