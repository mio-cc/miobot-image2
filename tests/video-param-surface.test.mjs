// 视频参数面（2026-11-19）：首帧 / 尾帧 / 参考素材是上游三个不同字段。
// 之前一律按参考素材发，「把这张图做成视频」出来的视频不以该图开头。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCapabilityRegistry, createModelClient } from '../dist/packages/model/src/index.js';

const NODE = {
  name: 'fal',
  dialect: 'fal',
  baseUrl: 'https://fal.run',
  apiKey: 'k',
  models: ['minimax/h3-max/reference-to-video'],
};

async function bodyOf(req) {
  let seen;
  const client = createModelClient({
    nodes: () => [NODE],
    registry: () => createCapabilityRegistry(),
    retries: 0,
    failover: false,
    transport: async (request) => {
      seen = request.body;
      return { status: 200, data: { video: { url: 'https://cdn.test/v.mp4' } } };
    },
  });
  await client.generateVideo(0, { model: NODE.models[0], prompt: 'x', waitForCompletion: true, timeoutMs: 5000, ...req });
  return seen;
}

test('imageRole=first-frame → image_url，且不带 reference_image_urls', async () => {
  const body = await bodyOf({ imageUrl: 'https://img.test/a.png', imageRole: 'first-frame' });
  assert.equal(body.image_url, 'https://img.test/a.png');
  assert.equal(body.reference_image_urls, undefined);
  assert.equal(body.end_image_url, undefined);
});

test('imageRole=last-frame → end_image_url', async () => {
  const body = await bodyOf({ imageUrl: 'https://img.test/a.png', imageRole: 'last-frame' });
  assert.equal(body.end_image_url, 'https://img.test/a.png');
  assert.equal(body.image_url, undefined);
});

test('imageRole=reference → reference_image_urls', async () => {
  const body = await bodyOf({ imageUrl: 'https://img.test/a.png', imageRole: 'reference' });
  assert.deepEqual(body.reference_image_urls, ['https://img.test/a.png']);
  assert.equal(body.image_url, undefined);
});

test('未传 imageRole 且模型是 reference-to-video → 仍走参考素材（回归，不破坏现有行为）', async () => {
  const body = await bodyOf({ imageUrl: 'https://img.test/a.png' });
  assert.deepEqual(body.reference_image_urls, ['https://img.test/a.png']);
  assert.equal(body.image_url, undefined);
});

test('未传 imageRole 且模型是普通 image-to-video → 默认首帧', async () => {
  let seen;
  const client = createModelClient({
    nodes: () => [{ ...NODE, models: ['kling/v4/image-to-video'] }],
    registry: () => createCapabilityRegistry(),
    retries: 0,
    failover: false,
    transport: async (request) => { seen = request.body; return { status: 200, data: { video: { url: 'https://cdn.test/v.mp4' } } }; },
  });
  await client.generateVideo(0, { model: 'kling/v4/image-to-video', prompt: 'x', imageUrl: 'https://img.test/a.png', waitForCompletion: true, timeoutMs: 5000 });
  assert.equal(seen.image_url, 'https://img.test/a.png');
});

test('resolution 小写转大写，aspectRatio 与 promptExpansionMode 透传', async () => {
  const body = await bodyOf({ resolution: '1080p', aspectRatio: '9:16', promptExpansionMode: 'quality' });
  assert.equal(body.resolution, '1080P');
  assert.equal(body.aspect_ratio, '9:16');
  assert.equal(body.prompt_expansion_mode, 'quality');
});

test('不传 resolution 时不下发（跟随上游默认 768P）', async () => {
  const body = await bodyOf({});
  assert.equal(body.resolution, undefined);
  assert.equal(body.aspect_ratio, undefined);
});
test('1080P 视频任务超时加档；非视频/低分辨率不加', async () => {
  const mod = await import('../dist/apps/bot/src/async-job-timeout.js');
  assert.equal(mod.resolutionTimeoutBonusMs('video.generate', { resolution: '1080p' }), 600000);
  assert.equal(mod.resolutionTimeoutBonusMs('video.generate', { resolution: '768P' }), 300000);
  assert.equal(mod.resolutionTimeoutBonusMs('video.generate', { resolution: '480p' }), 0);
  assert.equal(mod.resolutionTimeoutBonusMs('video.generate', {}), 0);
  assert.equal(mod.resolutionTimeoutBonusMs('image.generate', { resolution: '1080p' }), 0);
});
