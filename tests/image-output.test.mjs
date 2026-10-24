import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compressOutboundImages, materializeImagesForNapcat } from '../dist/apps/bot/src/image-output.js';

test('image output: unsupported reference falls back unchanged', async () => {
  const out = await compressOutboundImages(['not-a-real-file'], { scale: 0.5, quality: 80 });
  assert.deepEqual(out, ['not-a-real-file']);
});

test('image output: data URL is resized and re-encoded', async () => {
  const input = await sharp({ create: { width: 32, height: 32, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } } }).png().toBuffer();
  const dataUrl = `data:image/png;base64,${input.toString('base64')}`;
  const out = await compressOutboundImages([dataUrl], { scale: 0.5, quality: 70 });
  assert.equal(out.length, 1);
  assert.match(out[0], /^data:image\/(?:png|jpeg);base64,/);
  const encoded = Buffer.from(out[0].slice(out[0].indexOf(',') + 1), 'base64');
  const meta = await sharp(encoded).metadata();
  assert.ok(Number(meta.width) <= 16);
});


test('image output: materializes images into shared Napcat directory', async () => {
  const hostDir = await fs.mkdtemp(path.join(os.tmpdir(), 'miobot-output-'));
  try {
    const input = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 0, g: 128, b: 255 } } }).png().toBuffer();
    const out = await materializeImagesForNapcat(
      [`data:image/png;base64,${input.toString('base64')}`],
      { hostDir, containerDir: '/app/napcat/output' },
    );
    assert.equal(out.length, 1);
    assert.match(out[0], /^file:\/\/\/app\/napcat\/output\/miobot-.*\.png$/);
    const file = path.join(hostDir, out[0].split('/').pop());
    const written = await fs.readFile(file);
    assert.equal(written.length, input.length);
  } finally {
    await fs.rm(hostDir, { recursive: true, force: true });
  }
});

test('audio 物化事故优化: base64 语音落共享目录返回 file:// 路径，URL 透传，失败回退', async () => {
  const { materializeAudioForNapcat } = await import('../dist/apps/bot/src/image-output.js');
  const os = await import('node:os');
  const path = await import('node:path');
  const fs = await import('node:fs');
  const hostDir = fs.mkdtempSync(path.join(os.tmpdir(), 'miobot-audio-out-'));
  const wav = Buffer.from('fake-mp3-bytes').toString('base64');
  const base64Ref = 'base64://' + wav;
  const [materialized] = await materializeAudioForNapcat([base64Ref], { hostDir, containerDir: '/app/napcat/output', logger: { info() {}, warn() {} } });
  assert.match(materialized, /^file:\/\/\/app\/napcat\/output\/miobot-voice-/);
  assert.match(materialized, /\.mp3$/);
  const written = fs.readdirSync(hostDir).find((name) => name.startsWith('miobot-voice-'));
  assert.ok(written, '宿主目录应有语音文件');
  // 远端 URL 透传不落盘。
  const [url] = await materializeAudioForNapcat(['https://cdn.suno.example/a.mp3'], { hostDir, containerDir: '/x' });
  assert.equal(url, 'https://cdn.suno.example/a.mp3');
  // 目录不可写时回退原引用。
  const [fallback] = await materializeAudioForNapcat([base64Ref], { hostDir: path.join(hostDir, 'no', 'such', 'dir', 'x'.repeat(300)), containerDir: '/x' });
  assert.equal(fallback, base64Ref);
});
