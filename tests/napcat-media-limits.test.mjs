import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  VIDEO_MAX_BYTES,
  WS_BASE64_SAFE_BYTES,
  describeBytes,
  guardVideoPayload,
  guardWebSocketPayload,
  inspectMediaPayload,
} from '../dist/packages/napcat/src/media-limits.js';

/**
 * 媒体体积护栏。
 * 最要紧的是第一条：base64 超过 WS 帧上限时 Napcat 会**直接断开连接**，
 * 不是返回错误——机器人掉线且用户看不到任何原因。必须在发送前拦住。
 */

/** 造一个解码后约 n 字节的 base64 载荷。 */
function base64OfBytes(bytes) {
  return `base64://${'A'.repeat(Math.ceil(bytes / 3) * 4)}`;
}

test('inspectMediaPayload: 分辨载荷形态', () => {
  assert.equal(inspectMediaPayload('https://x.com/a.mp4').kind, 'remote-url');
  assert.equal(inspectMediaPayload('https://x.com/a.mp4').travelsOverWebSocket, false);

  const b64 = inspectMediaPayload('base64://QUJD');
  assert.equal(b64.kind, 'base64');
  assert.equal(b64.travelsOverWebSocket, true);
  assert.equal(b64.bytes, 3);

  const dataUrl = inspectMediaPayload('data:video/mp4;base64,QUJD');
  assert.equal(dataUrl.kind, 'base64');
  assert.equal(dataUrl.bytes, 3);

  assert.equal(inspectMediaPayload('').kind, 'unknown');
});

test('inspectMediaPayload: 本地文件读到真实大小, 且不经 WS 传内容', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miobot-media-'));
  const file = path.join(dir, 'a.bin');
  fs.writeFileSync(file, Buffer.alloc(1234));

  const info = inspectMediaPayload(file);
  assert.equal(info.kind, 'local-file');
  assert.equal(info.bytes, 1234);
  assert.equal(info.travelsOverWebSocket, false, '本地路径只传字符串，不受帧上限约束');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('base64 超过 WS 安全阈值会被拦下（否则直接断连）', () => {
  const verdict = guardWebSocketPayload(base64OfBytes(WS_BASE64_SAFE_BYTES + 1024 * 1024), '视频');
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /WebSocket/);
  assert.match(verdict.reason, /断开连接/);
});

test('小 base64 与远程 URL 正常放行', () => {
  assert.equal(guardWebSocketPayload(base64OfBytes(1024)).ok, true);
  assert.equal(guardWebSocketPayload('https://x.com/a.mp4').ok, true);
});

test('视频超过 100MB 建议改用文件发送', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miobot-video-'));
  const file = path.join(dir, 'big.mp4');
  // 稀疏文件：只设长度，不实际占盘
  const fd = fs.openSync(file, 'w');
  fs.ftruncateSync(fd, VIDEO_MAX_BYTES + 1024);
  fs.closeSync(fd);

  const verdict = guardVideoPayload(file);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.suggestFileSend, true);
  assert.match(verdict.reason, /100MB/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('100MB 以内的本地视频放行', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miobot-video-ok-'));
  const file = path.join(dir, 'small.mp4');
  fs.writeFileSync(file, Buffer.alloc(2048));
  assert.equal(guardVideoPayload(file).ok, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('远程 URL 的视频不做体积判断（内容不经我们传）', () => {
  assert.equal(guardVideoPayload('https://cdn.example.com/huge.mp4').ok, true);
});

test('describeBytes 输出可读单位', () => {
  assert.equal(describeBytes(2 * 1024 * 1024), '2.0MB');
  assert.equal(describeBytes(2048), '2KB');
});
