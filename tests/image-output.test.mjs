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
