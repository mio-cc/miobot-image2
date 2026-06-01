import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildImageForwardNodes,
  dedupeImageUrls,
  formatReadyState,
  NapcatAdapter,
  NAPCAT_READY_STATE,
} from '../dist/packages/napcat/src/index.js';

class FakeSocket {
  readyState = NAPCAT_READY_STATE.CONNECTING;
  sent = [];
  handlers = new Map();
  closed = false;

  on(event, handler) {
    const list = this.handlers.get(event) || [];
    list.push(handler);
    this.handlers.set(event, list);
  }

  send(data, callback) {
    this.sent.push(JSON.parse(data));
    callback?.();
  }

  close() {
    this.closed = true;
    this.readyState = NAPCAT_READY_STATE.CLOSED;
  }

  removeAllListeners() {
    this.handlers.clear();
  }

  emit(event, ...args) {
    for (const handler of this.handlers.get(event) || []) handler(...args);
  }

  open() {
    this.readyState = NAPCAT_READY_STATE.OPEN;
    this.emit('open');
  }

  message(payload) {
    this.emit('message', JSON.stringify(payload));
  }

  closeFromServer(code = 1006, reason = 'lost') {
    this.readyState = NAPCAT_READY_STATE.CLOSED;
    this.emit('close', code, reason);
  }
}

function createHarness(options = {}) {
  const sockets = [];
  const adapter = new NapcatAdapter({
    wsUrl: 'ws://localhost:3001',
    token: 'redacted-token',
    actionTimeoutMs: 20,
    reconnectDelayMs: 5,
    requestIdFactory: (action) => `echo_${action}_${sockets.reduce((sum, socket) => sum + socket.sent.length, 0)}`,
    socketFactory: (_url, _options) => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    ...options,
  });
  return { adapter, sockets };
}

test('napcat adapter: connect passes auth header and tracks snapshot on open', () => {
  const capturedOptions = [];
  const adapter = new NapcatAdapter({
    wsUrl: 'ws://bot.example/ws',
    token: 'redacted-token-a',
    socketFactory: (_url, options) => {
      capturedOptions.push(options);
      return new FakeSocket();
    },
  });
  adapter.connect();
  assert.deepEqual(capturedOptions[0], { headers: { Authorization: 'Bearer redacted-token-a' } });
  assert.equal(adapter.getConnectionSnapshot().readyStateText, 'CONNECTING');
  assert.equal(formatReadyState(NAPCAT_READY_STATE.OPEN), 'OPEN');
});

test('napcat adapter: callAction sends echo params and resolves matching response', async () => {
  const { adapter, sockets } = createHarness();
  adapter.connect();
  sockets[0].open();

  const pending = adapter.callAction('get_login_info', {}, 50);
  assert.equal(sockets[0].sent[0].action, 'get_login_info');
  assert.equal(sockets[0].sent[0].echo, 'echo_get_login_info_0');
  sockets[0].message({ echo: 'echo_get_login_info_0', status: 'ok', retcode: 0, data: { user_id: 10001, nickname: 'bot' }, self_id: 10001 });
  const response = await pending;
  assert.equal(response.data.nickname, 'bot');
  assert.equal(adapter.selfQqId, '10001');
  assert.equal(adapter.getConnectionSnapshot().pendingActions, 0);
});

test('napcat adapter: action timeout is configurable', async () => {
  const { adapter, sockets } = createHarness({ actionTimeoutMs: 8 });
  adapter.connect();
  sockets[0].open();
  await assert.rejects(() => adapter.callAction('slow_action'), /slow_action \(8ms\)/);
  assert.equal(adapter.getConnectionSnapshot().pendingActions, 0);
});

test('napcat adapter: non-ok action response throws formatted error', async () => {
  const { adapter, sockets } = createHarness();
  adapter.connect();
  sockets[0].open();
  const pending = adapter.callAction('send_group_msg', { group_id: 1 }, 50);
  sockets[0].message({ echo: 'echo_send_group_msg_0', status: 'failed', retcode: 1400, wording: 'bad request' });
  await assert.rejects(() => pending, /send_group_msg 返回失败: retcode=1400, bad request/);
});

test('napcat adapter: close rejects pending action and schedules reconnect without throwing', async () => {
  const { adapter, sockets } = createHarness({ reconnectDelayMs: 1 });
  adapter.connect();
  sockets[0].open();
  const pending = adapter.callAction('get_msg', { message_id: 1 }, 100);
  sockets[0].closeFromServer(1006, 'network lost');
  await assert.rejects(() => pending, /closed/);
  assert.equal(adapter.getConnectionSnapshot().reconnectScheduled, true);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(sockets.length, 2);
});

test('napcat adapter: disconnect prevents auto reconnect', async () => {
  const { adapter, sockets } = createHarness({ reconnectDelayMs: 1 });
  adapter.connect();
  sockets[0].open();
  adapter.disconnect();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].closed, true);
});

test('napcat adapter: emits post_type and message subtype events', async () => {
  const { adapter, sockets } = createHarness();
  const seen = [];
  adapter.on('message', async (event) => seen.push(`post:${event.message_type}`));
  adapter.on('message.group', async (event) => seen.push(`group:${event.group_id}`));
  adapter.connect();
  sockets[0].open();
  sockets[0].message({ post_type: 'message', message_type: 'group', group_id: 123, user_id: 456 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(seen, ['post:group', 'group:123']);
});

test('napcat adapter: image url de-duplication preserves order', () => {
  assert.deepEqual(dedupeImageUrls([' a ', 'b', 'a', '', 'c', 'b']), ['a', 'b', 'c']);
});

test('napcat adapter: buildImageForwardNodes creates one independent node per image', () => {
  const nodes = buildImageForwardNodes(['img1', 'img2', 'img1', 'img3'], { botName: 'Bot', userId: 42 });
  assert.equal(nodes.length, 3);
  assert.deepEqual(nodes.map((node) => node.data.content[0].data.file), ['img1', 'img2', 'img3']);
  assert.deepEqual(nodes.map((node) => node.data.nickname), ['Bot 1/3', 'Bot 2/3', 'Bot 3/3']);
  assert.notStrictEqual(nodes[0], nodes[1]);
  assert.notStrictEqual(nodes[0].data.content, nodes[1].data.content);
});

test('napcat adapter: sendGroupImagesForward sends merged forward nodes with de-duped images', async () => {
  const { adapter, sockets } = createHarness({ forwardUserId: 999 });
  adapter.connect();
  sockets[0].open();
  const pending = adapter.sendGroupImagesForward(1000, ['base64://a', 'base64://b', 'base64://a', 'base64://c'], 'Miobot');
  const action = sockets[0].sent[0];
  assert.equal(action.action, 'send_group_forward_msg');
  assert.equal(action.params.group_id, 1000);
  assert.equal(action.params.messages.length, 3);
  assert.deepEqual(action.params.messages.map((node) => node.data.content[0].data.file), ['base64://a', 'base64://b', 'base64://c']);
  sockets[0].message({ echo: action.echo, status: 'ok', retcode: 0, data: { forward_id: 'fwd-1', message_id: 321 } });
  const result = await pending;
  assert.equal(result.success, true);
  assert.equal(result.forwardId, 'fwd-1');
  assert.deepEqual(result.messageIds, [321]);
});

test('napcat adapter: sendGroupImage uses image timeout and reports timeout result', async () => {
  const { adapter, sockets } = createHarness({ imageSendTimeoutMs: 6 });
  adapter.connect();
  sockets[0].open();
  const result = await adapter.sendGroupImage(1, 'base64://image');
  assert.equal(result.success, false);
  assert.equal(result.timedOut, true);
  assert.match(result.error, /send_group_msg \(6ms\)/);
});

test('napcat adapter: sends record segments for group and private voice messages', async () => {
  const { adapter, sockets } = createHarness();
  adapter.connect();
  sockets[0].open();

  const groupPending = adapter.sendGroupRecord(1000, 'base64://audio-data', 777);
  const groupAction = sockets[0].sent[0];
  assert.equal(groupAction.action, 'send_group_msg');
  assert.equal(groupAction.params.group_id, 1000);
  assert.deepEqual(groupAction.params.message, [
    { type: 'reply', data: { id: '777' } },
    { type: 'record', data: { file: 'base64://audio-data' } },
  ]);
  sockets[0].message({ echo: groupAction.echo, status: 'ok', retcode: 0, data: { message_id: 778 } });
  assert.equal((await groupPending).messageId, 778);

  const privatePending = adapter.sendPrivateRecord(2000, 'base64://audio-private');
  const privateAction = sockets[0].sent[1];
  assert.equal(privateAction.action, 'send_private_msg');
  assert.equal(privateAction.params.user_id, 2000);
  assert.deepEqual(privateAction.params.message, [
    { type: 'record', data: { file: 'base64://audio-private' } },
  ]);
  sockets[0].message({ echo: privateAction.echo, status: 'ok', retcode: 0, data: { message_id: 779 } });
  assert.equal((await privatePending).messageId, 779);
});
