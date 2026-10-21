import test from 'node:test';
import assert from 'node:assert/strict';

import { clampPreviewWidth, createSharpPreviewResizer, isResizable, DEFAULT_PREVIEW_WIDTH, createCanvasService, CanvasStore } from '../dist/packages/canvas-service/src/index.js';
import { normalizeConfig } from '../dist/packages/config/src/index.js';

/**
 * 缩略图。
 * /assets/:id/preview?width= 以前完全忽略 width 直接吐原图——
 * 几千张作品之后，光打开画廊列表就要下几百 MB。
 */

test('width 被夹到合理区间，缺省/非法给默认值', () => {
  assert.equal(clampPreviewWidth('512'), 512);
  assert.equal(clampPreviewWidth(undefined), DEFAULT_PREVIEW_WIDTH);
  assert.equal(clampPreviewWidth('abc'), DEFAULT_PREVIEW_WIDTH);
  assert.equal(clampPreviewWidth(-5), DEFAULT_PREVIEW_WIDTH);
  assert.equal(clampPreviewWidth(1), 64, '太小的值抬到下限');
  assert.equal(clampPreviewWidth(99999), 2048, '太大的值压到上限');
});

test('只缩位图，动图/矢量原样放行', () => {
  assert.equal(isResizable('image/png'), true);
  assert.equal(isResizable('image/jpeg'), true);
  assert.equal(isResizable('image/webp'), true);
  assert.equal(isResizable('image/gif'), false, 'gif 压了会只剩一帧');
  assert.equal(isResizable('image/svg+xml'), false);
});

/** 造一张真实的大 PNG（纯 sharp 生成，不依赖外部素材）。 */
async function makeBigPng(width = 2048, height = 2048) {
  const sharp = (await import('sharp')).default;
  return sharp({
    create: { width, height, channels: 3, background: { r: 180, g: 60, b: 200 } },
  }).png().toBuffer();
}

test('缩略图确实更小，且 sharp 可用时按请求宽度输出', async (t) => {
  const resizer = createSharpPreviewResizer();
  if (!resizer) return t.skip('sharp 不可用，跳过');

  const big = await makeBigPng();
  const asset = { contentType: 'image/png', base64: big.toString('base64'), createdAt: new Date().toISOString() };

  const thumb = await resizer('a1', asset, 256);
  assert.ok(thumb, '应当生成缩略图');
  const thumbBytes = Buffer.from(thumb.base64, 'base64').length;
  assert.ok(thumbBytes < big.length / 4, `缩略图 ${thumbBytes}B 相对原图 ${big.length}B 没有明显变小`);
  assert.equal(thumb.contentType, 'image/webp');

  const sharp = (await import('sharp')).default;
  const meta = await sharp(Buffer.from(thumb.base64, 'base64')).metadata();
  assert.equal(meta.width, 256, '输出宽度要跟请求一致');
});

test('同一张图重复请求走缓存，不重复解码', async (t) => {
  const resizer = createSharpPreviewResizer();
  if (!resizer) return t.skip('sharp 不可用，跳过');
  const big = await makeBigPng(1024, 1024);
  const asset = { contentType: 'image/png', base64: big.toString('base64'), createdAt: new Date().toISOString() };

  const first = await resizer('same', asset, 256);
  const t0 = process.hrtime.bigint();
  const second = await resizer('same', asset, 256);
  const cachedMs = Number(process.hrtime.bigint() - t0) / 1e6;

  assert.equal(second.base64, first.base64);
  assert.ok(cachedMs < 25, `缓存命中还花了 ${cachedMs.toFixed(1)}ms，看着不像走了缓存`);
});

test('原图比目标还小时不放大——放大只会让文件变大', async (t) => {
  const resizer = createSharpPreviewResizer();
  if (!resizer) return t.skip('sharp 不可用，跳过');
  const small = await makeBigPng(64, 64);
  const asset = { contentType: 'image/png', base64: small.toString('base64'), createdAt: new Date().toISOString() };
  const thumb = await resizer('tiny', asset, 1024);
  if (thumb) {
    const sharp = (await import('sharp')).default;
    const meta = await sharp(Buffer.from(thumb.base64, 'base64')).metadata();
    assert.ok(meta.width <= 64, '不该被放大');
  }
});

test('GET /assets/:id/preview?width= 真的返回缩小后的图', async (t) => {
  const resizer = createSharpPreviewResizer();
  if (!resizer) return t.skip('sharp 不可用，跳过');

  const big = await makeBigPng();
  const assets = new Map();
  const service = createCanvasService({
    getConfig: () => normalizeConfig({}),
    generator: { generate: async () => ({ images: [] }), edit: async () => ({ images: [] }), interrogate: async () => ({ text: '' }) },
    store: new CanvasStore(),
    assets: {
      put(id, a) { assets.set(id, a); },
      get(id) { return assets.get(id); },
      delete(id) { return assets.delete(id); },
    },
  });
  assets.set('big', { contentType: 'image/png', base64: big.toString('base64'), createdAt: new Date().toISOString() });

  const preview = await service.handle({ method: 'GET', path: '/assets/big/preview?width=256' });
  assert.equal(preview.status, 200);
  const previewBytes = Buffer.from(preview.binary.base64, 'base64').length;

  const full = await service.handle({ method: 'GET', path: '/assets/big/download' });
  const fullBytes = Buffer.from(full.binary.base64, 'base64').length;

  assert.ok(previewBytes < fullBytes / 4, `preview ${previewBytes}B vs download ${fullBytes}B —— 缩略图没起作用`);
  assert.equal(full.binary.contentType, 'image/png', 'download 必须还是原图原格式');
});

test('sharp 不可用时回退原图，不报错', async () => {
  const big = Buffer.from('not-a-real-image');
  const assets = new Map([['x', { contentType: 'image/png', base64: big.toString('base64'), createdAt: '' }]]);
  const service = createCanvasService({
    getConfig: () => normalizeConfig({}),
    generator: { generate: async () => ({ images: [] }), edit: async () => ({ images: [] }), interrogate: async () => ({ text: '' }) },
    assets: { put(id, a) { assets.set(id, a); }, get(id) { return assets.get(id); }, delete(id) { return assets.delete(id); } },
    previewResizer: null,   // 显式关闭，模拟装不上 sharp 的机器
  });
  const res = await service.handle({ method: 'GET', path: '/assets/x/preview?width=256' });
  assert.equal(res.status, 200);
  assert.equal(res.binary.base64, big.toString('base64'), '缩不了就原样给，不能失败');
});
