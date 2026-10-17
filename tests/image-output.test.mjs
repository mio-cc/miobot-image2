import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { compressOutboundImages } from '../dist/apps/bot/src/image-output.js';

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
