import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildFileForwardNodes,
  buildImageForwardNodes,
  buildMixedForwardNodes,
  buildNestedMixedForwardNodes,
  buildVideoForwardNodes,
  buildVideoSegment,
  dedupeImageUrls,
  formatReadyState,
  NapcatAdapter,
  NAPCAT_READY_STATE,
  normalizeVideoFilePayload,
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

test('napcat adapter: buildVideoSegment supports url/base64/data URL', () => {
  assert.deepEqual(buildVideoSegment('https://cdn.example/v.mp4'), { type: 'video', data: { file: 'https://cdn.example/v.mp4' } });
  assert.deepEqual(buildVideoSegment('base64://AAAA'), { type: 'video', data: { file: 'base64://AAAA' } });
  assert.equal(normalizeVideoFilePayload('data:video/mp4;base64,QQQQ'), 'base64://QQQQ');
  assert.deepEqual(buildVideoSegment('data:video/mp4;base64,QQQQ'), { type: 'video', data: { file: 'base64://QQQQ' } });
  assert.equal(buildVideoSegment(''), undefined);
});

test('napcat adapter: sendGroupVideo / sendPrivateVideo 构造 type:video 段', async () => {
  const { adapter, sockets } = createHarness();
  adapter.connect();
  sockets[0].open();

  const gPending = adapter.sendGroupVideo(1000, 'https://cdn.example/a.mp4', '生成完成');
  const gAction = sockets[0].sent[0];
  assert.equal(gAction.action, 'send_group_msg');
  assert.equal(gAction.params.group_id, 1000);
  assert.equal(gAction.params.message[0].type, 'text');
  assert.equal(gAction.params.message[1].type, 'video');
  assert.equal(gAction.params.message[1].data.file, 'https://cdn.example/a.mp4');
  sockets[0].message({ echo: gAction.echo, status: 'ok', retcode: 0, data: { message_id: 11 } });
  assert.equal((await gPending).success, true);

  const pPending = adapter.sendPrivateVideo(2000, 'base64://VID');
  const pAction = sockets[0].sent[1];
  assert.equal(pAction.action, 'send_private_msg');
  assert.equal(pAction.params.user_id, 2000);
  assert.deepEqual(pAction.params.message, [{ type: 'video', data: { file: 'base64://VID' } }]);
  sockets[0].message({ echo: pAction.echo, status: 'ok', retcode: 0, data: { message_id: 12 } });
  assert.equal((await pPending).success, true);
});

test('napcat adapter: buildVideoForwardNodes 去重', () => {
  const nodes = buildVideoForwardNodes(['v1', 'v2', 'v1'], { botName: 'Bot', userId: 1 });
  assert.equal(nodes.length, 2);
  assert.equal(nodes[0].data.content[0].type, 'video');
  assert.deepEqual(nodes.map((n) => n.data.content[0].data.file), ['v1', 'v2']);
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

test('napcat adapter: file messages are standalone or forward-only payloads', async () => {
  const nodes = buildFileForwardNodes([
    { file: 'https://example.test/a.pptx', name: 'a.pptx' },
    { file: 'https://example.test/a.pptx', name: 'dupe.pptx' },
    'https://example.test/b.zip',
  ], { botName: 'Miobot', userId: 42 });
  assert.equal(nodes.length, 2);
  assert.deepEqual(nodes[0].data.content, [
    { type: 'file', data: { file: 'https://example.test/a.pptx', name: 'a.pptx' } },
  ]);
  assert.deepEqual(nodes[1].data.content, [
    { type: 'file', data: { file: 'https://example.test/b.zip' } },
  ]);

  const { adapter, sockets } = createHarness({ forwardUserId: 999 });
  adapter.connect();
  sockets[0].open();
  const filePending = adapter.sendGroupFile(1000, 'https://example.test/report.pptx', 'report.pptx');
  const fileAction = sockets[0].sent[0];
  assert.equal(fileAction.action, 'send_group_msg');
  assert.deepEqual(fileAction.params.message, [
    { type: 'file', data: { file: 'https://example.test/report.pptx', name: 'report.pptx' } },
  ]);
  sockets[0].message({ echo: fileAction.echo, status: 'ok', retcode: 0, data: { message_id: 401 } });
  assert.equal((await filePending).messageId, 401);

  const forwardPending = adapter.sendGroupFilesForward(1000, [
    { file: 'https://example.test/one.pptx', name: 'one.pptx' },
    { file: 'https://example.test/two.zip', name: 'two.zip' },
  ], 'Miobot');
  const forwardAction = sockets[0].sent[1];
  assert.equal(forwardAction.action, 'send_group_forward_msg');
  assert.equal(forwardAction.params.messages.length, 2);
  assert.deepEqual(forwardAction.params.messages[0].data.content, [
    { type: 'file', data: { file: 'https://example.test/one.pptx', name: 'one.pptx' } },
  ]);
  sockets[0].message({ echo: forwardAction.echo, status: 'ok', retcode: 0, data: { forward_id: 'file-fwd-1' } });
  assert.equal((await forwardPending).forwardId, 'file-fwd-1');
});


test('napcat adapter: mixed forward keeps text images and files as separate nodes', () => {
  const nodes = buildMixedForwardNodes([
    { kind: 'text', text: '??' },
    { kind: 'image', file: 'base64://img-a' },
    { kind: 'file', file: 'https://example.test/a.pptx', name: 'a.pptx' },
  ], { botName: 'Miobot', userId: 42 });
  assert.equal(nodes.length, 3);
  assert.deepEqual(nodes.map((node) => node.data.content[0].type), ['text', 'image', 'file']);
  assert.deepEqual(nodes[2].data.content, [{ type: 'file', data: { file: 'https://example.test/a.pptx', name: 'a.pptx' } }]);
});

test('napcat adapter: file send retries after failed action without changing payload shape', async () => {
  const { adapter, sockets } = createHarness({ fileSendRetryCount: 1, fileSendRetryDelayMs: 0, fileSendTimeoutMs: 50 });
  adapter.connect();
  sockets[0].open();
  const pending = adapter.sendGroupFile(1000, 'https://example.test/report.pptx', 'report.pptx');
  const first = sockets[0].sent[0];
  assert.equal(first.action, 'send_group_msg');
  assert.deepEqual(first.params.message, [{ type: 'file', data: { file: 'https://example.test/report.pptx', name: 'report.pptx' } }]);
  sockets[0].message({ echo: first.echo, status: 'failed', retcode: 1400, wording: 'temporary fail' });
  for (let i = 0; i < 20 && sockets[0].sent.length < 2; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  const second = sockets[0].sent[1];
  assert.equal(second.action, 'send_group_msg');
  assert.deepEqual(second.params.message, first.params.message);
  sockets[0].message({ echo: second.echo, status: 'ok', retcode: 0, data: { message_id: 402 } });
  const result = await pending;
  assert.equal(result.success, true);
  assert.equal(result.messageId, 402);
  assert.deepEqual(result.attempts.map((attempt) => attempt.success), [false, true]);
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

test('napcat adapter: downloadFileStream writes chunk packets to disk', async () => {
  const { adapter, sockets } = createHarness({ actionTimeoutMs: 1000 });
  adapter.connect();
  sockets[0].open();
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miobot-stream-'));
  const outputPath = path.join(dir, 'a.txt');
  const promise = adapter.downloadFileStream({ file: 'f1', outputPath, timeoutMs: 2000 });
  await new Promise((resolve) => setImmediate(resolve));
  const request = sockets[0].sent.find((item) => item.action === 'download_file_stream');
  assert.ok(request?.echo);
  sockets[0].message({ status: 'ok', retcode: 0, echo: request.echo, data: { type: 'stream', data_type: 'file_info', file_name: 'a.txt', file_size: 5, chunk_size: 2 } });
  sockets[0].message({ status: 'ok', retcode: 0, echo: request.echo, data: { type: 'stream', data_type: 'file_chunk', index: 0, data: Buffer.from('he').toString('base64'), size: 2, progress: 40 } });
  sockets[0].message({ status: 'ok', retcode: 0, echo: request.echo, data: { type: 'stream', data_type: 'file_chunk', index: 1, data: Buffer.from('llo').toString('base64'), size: 3, progress: 100 } });
  sockets[0].message({ status: 'ok', retcode: 0, echo: request.echo, data: { type: 'response', data_type: 'file_complete', total_chunks: 2, total_bytes: 5 } });
  const result = await promise;
  assert.equal(result.totalBytes, 5);
  assert.equal(fs.readFileSync(outputPath, 'utf8'), 'hello');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('napcat adapter: retcode 1200 send timeout is marked uncertain, not definite failure', async () => {
  const { adapter, sockets } = createHarness({ imageSendTimeoutMs: 100 });
  adapter.connect();
  sockets[0].open();
  const pending = adapter.sendGroupImage(1098867961, 'http://example.test/canvas-api/assets/a.png');
  const action = sockets[0].sent[0];
  sockets[0].message({
    echo: action.echo,
    status: 'failed',
    retcode: 1200,
    wording: 'Timeout: NTEvent serviceAndMethod:NodeIKernelMsgService/sendMsg ListenerName:NodeIKernelMsgListener/onMsgInfoListUpdate EventRet:',
  });
  const result = await pending;
  assert.equal(result.success, false);
  assert.equal(result.timedOut, true);
  assert.equal(result.uncertain, true);
});

test('napcat adapter: nested mixed forward nodes contain inner node groups', () => {
  const nodes = buildNestedMixedForwardNodes([
    [{ kind: 'text', text: 'hello' }, { kind: 'image', file: 'img1' }],
    [{ kind: 'file', file: 'file1', name: 'a.pdf' }],
  ]);
  assert.equal(nodes.length, 2);
  assert.equal(nodes[0].data.content[0].type, 'node');
  assert.equal(nodes[0].data.content[0].data.content[0].type, 'text');
  assert.equal(nodes[1].data.content[0].data.content[0].type, 'file');
});

test('napcat adapter T2.1: 连续失败指数退避，连接成功后重置', async () => {
  const logs = [];
  const { adapter, sockets } = createHarness({ reconnectDelayMs: 1, reconnectMaxDelayMs: 4, logger: { info: (m, d) => logs.push({ m, d }), warn: () => {}, error: () => {} } });
  adapter.connect();
  sockets[0].open();
  const wait = () => new Promise((resolve) => setTimeout(resolve, 8));
  const closeAndAwaitReconnect = async () => {
    const current = sockets[sockets.length - 1];
    current.closeFromServer(1006, 'lost');
    await wait();
  };
  // 连续 3 次断开（每次等重连定时器触发），退避应逐次放大并受 max 封顶。
  await closeAndAwaitReconnect();
  await closeAndAwaitReconnect();
  await closeAndAwaitReconnect();
  const delays = logs.filter((item) => item.m === 'napcat reconnect scheduled').map((item) => Number(item.d.delayMs));
  assert.equal(delays.length >= 3, true);
  assert.ok(delays[2] > delays[0], '第三次退避应大于第一次: ' + delays.join(','));
  // 成功连接后重置：open 会清零退避计数，再次断开回到基准档。
  const last = sockets[sockets.length - 1];
  last.open();
  await wait();
  last.closeFromServer(1006, 'lost');
  await wait();
  const resetDelay = logs.filter((item) => item.m === 'napcat reconnect scheduled').map((item) => Number(item.d.delayMs)).pop();
  assert.ok(resetDelay <= 2, '重置后应回到基准档: ' + resetDelay);
});

test('napcat adapter T2.1: 心跳事件刷新时间戳，断开清理看门狗不泄漏', async () => {
  const { adapter, sockets } = createHarness({ reconnectDelayMs: 1, heartbeatStaleMs: 1 });
  adapter.on('close', () => {});
  adapter.connect();
  sockets[0].open();
  // 看门狗每 30s 巡检；测试里不等真实 30s，仅验证有心跳事件时时间戳被刷新、disconnect 清理看门狗。
  sockets[0].message({ post_type: 'meta_event', meta_event_type: 'heartbeat', self_id: 42 });
  adapter.disconnect();
  assert.equal(sockets[0].closed, true);
});

test('napcat 事故修复: ENOENT 分类与回退——真实 file:// 消息段路径', async () => {
  const os = await import('node:os');
  const fsSync = await import('node:fs');
  const pathMod = await import('node:path');
  const hostDir = fsSync.mkdtempSync(pathMod.join(os.tmpdir(), 'miobot-enoent2-'));
  fsSync.writeFileSync(pathMod.join(hostDir, 'v.mp3'), Buffer.from('abc'));
  const { adapter, sockets } = createHarness({
    resolveLocalFile: (uri) => (uri.startsWith('file:///app/napcat/output/')
      ? pathMod.join(hostDir, uri.slice('file:///app/napcat/output/'.length))
      : null),
  });
  adapter.connect();
  sockets[0].open();
  const pending = adapter.sendGroupRecord(1, 'file:///app/napcat/output/v.mp3').then(
    (r) => ({ ok: true, r }),
    (e) => ({ ok: false, message: String(e.message || e) }),
  );
  sockets[0].message({ echo: 'echo_send_group_msg_0', status: 'failed', retcode: 1200, wording: 'Failed to open input: No such file or directory' });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const retryFrame = sockets[0].sent[1];
  assert.ok(retryFrame, '应发出 base64 回退重发帧');
  const retryFile = retryFrame.params.message[0].data.file;
  assert.match(retryFile, /^base64:\/\//);
  assert.equal(Buffer.from(retryFile.slice('base64://'.length), 'base64').toString(), 'abc', '内容与宿主文件一致');
  sockets[0].message({ echo: 'echo_send_group_msg_1', status: 'ok', retcode: 0, data: { message_id: 42 } });
  const outcome = await pending;
  assert.equal(outcome.ok, true, '回退重发后成功');
  assert.equal(outcome.r.messageId, 42);
});

test('napcat 事故修复: 无 resolver 或文件不可读时不回退，且不再判 uncertain', async () => {
  const { adapter, sockets } = createHarness({});
  adapter.connect();
  sockets[0].open();
  const pending = adapter.sendGroupText(100, 'x').then(
    (r) => ({ ok: true, r }),
    (e) => ({ ok: false, e }),
  );
  sockets[0].message({ echo: 'echo_send_group_msg_0', status: 'failed', retcode: 1200, wording: 'Failed to open input: No such file or directory' });
  const outcome = await pending;
  assert.equal(outcome.ok, true, 'send 返回结果对象而非抛错');
  assert.equal(outcome.r.success, false);
  assert.notEqual(outcome.r.uncertain, true, 'ENOENT 不再判 uncertain');
  assert.equal(sockets[0].sent.length, 1, '无 resolver 不重发');
  assert.match(String(outcome.r.error), /No such file/);
});
