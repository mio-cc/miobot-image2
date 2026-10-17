import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createImageInputPreparer,
  createNapcatImageReferenceResolver,
  describeImageReference,
  imageDataUrlFromBase64,
} from '../dist/apps/bot/src/main.js';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test('image input: 远程 QQ 图片下载后转 data URL', async () => {
  const calls = [];
  const prepare = createImageInputPreparer({
    env: { MIOBOT_INLINE_REMOTE_IMAGES: '1' },
    fetchImpl: async (url) => {
      calls.push(url);
      return new Response(PNG_SIGNATURE, {
        status: 200,
        headers: { 'content-type': 'image/png' },
      });
    },
  });

  const images = await prepare(['https://multimedia.nt.qq.com.cn/download?fileid=abc']);
  assert.equal(calls.length, 1);
  assert.equal(images.length, 1);
  assert.ok(images[0].startsWith('data:image/png;base64,'));
});

test('image input: content-type 不可靠时按文件头识别图片', async () => {
  const prepare = createImageInputPreparer({
    env: { MIOBOT_INLINE_REMOTE_IMAGES: '1' },
    fetchImpl: async () => new Response(PNG_SIGNATURE, {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
    }),
  });

  const [image] = await prepare(['https://example.test/image']);
  assert.ok(image.startsWith('data:image/png;base64,'));
});

test('image input: data/base64/file 引用原样保留', async () => {
  let called = false;
  const prepare = createImageInputPreparer({
    env: { MIOBOT_INLINE_REMOTE_IMAGES: '1' },
    fetchImpl: async () => {
      called = true;
      return new Response(PNG_SIGNATURE, { status: 200, headers: { 'content-type': 'image/png' } });
    },
  });

  const input = [
    'data:image/png;base64,AAAA',
    'base64://BBBB',
    'file:///app/napcat/a.png',
  ];
  assert.deepEqual(await prepare(input), input);
  assert.equal(called, false);
});

test('image input: 下载失败或超过体积上限时保留原 URL', async () => {
  const failed = createImageInputPreparer({
    env: { MIOBOT_INLINE_REMOTE_IMAGES: '1' },
    fetchImpl: async () => new Response('no', { status: 403 }),
  });
  const tooLarge = createImageInputPreparer({
    env: { MIOBOT_INLINE_REMOTE_IMAGES: '1', MIOBOT_INLINE_IMAGE_MAX_BYTES: '4' },
    fetchImpl: async () => new Response(PNG_SIGNATURE, {
      status: 200,
      headers: { 'content-type': 'image/png', 'content-length': '8' },
    }),
  });

  const url = 'https://example.test/a.png';
  assert.deepEqual(await failed([url]), [url]);
  assert.deepEqual(await tooLarge([url]), [url]);
});

test('image input: MIOBOT_INLINE_REMOTE_IMAGES=0 时不请求', async () => {
  let called = false;
  const prepare = createImageInputPreparer({
    env: { MIOBOT_INLINE_REMOTE_IMAGES: '0' },
    fetchImpl: async () => {
      called = true;
      return new Response(PNG_SIGNATURE, { status: 200, headers: { 'content-type': 'image/png' } });
    },
  });

  const url = 'https://example.test/a.png';
  assert.deepEqual(await prepare([url]), [url]);
  assert.equal(called, false);
});

test('describeImageReference: 只暴露图片类型/域名', () => {
  assert.equal(describeImageReference('data:image/png;base64,AAAA'), 'data-url');
  assert.equal(describeImageReference('base64://AAAA'), 'base64://');
  assert.equal(describeImageReference('https://multimedia.nt.qq.com.cn/download?token=secret'), 'https://multimedia.nt.qq.com.cn');
  assert.equal(describeImageReference('abc123.image'), 'local:abc123.image');
});

test('image input: Napcat get_image 返回 base64 时转成 data URL', async () => {
  const resolver = createNapcatImageReferenceResolver({
    callGetImage: async (file) => {
      assert.equal(file, '2F4E9D49282C5B22757A249618A7AE95.jpg');
      return {
        data: {
          base64: PNG_SIGNATURE.toString('base64'),
          file_name: 'qq-image.png',
        },
      };
    },
  });

  const image = await resolver('2F4E9D49282C5B22757A249618A7AE95.jpg');
  assert.ok(image?.startsWith('data:image/png;base64,'));
});

test('image input: 本地图片引用先走 get_image，再复用远程内联', async () => {
  const resolver = createNapcatImageReferenceResolver({
    callGetImage: async () => ({ data: { url: 'https://example.test/get-image' } }),
  });
  const calls = [];
  const prepare = createImageInputPreparer({
    env: { MIOBOT_INLINE_REMOTE_IMAGES: '1' },
    resolveLocalImage: resolver,
    fetchImpl: async (url) => {
      calls.push(url);
      return new Response(PNG_SIGNATURE, { status: 200, headers: { 'content-type': 'image/png' } });
    },
  });

  const [image] = await prepare(['2F4E9D49282C5B22757A249618A7AE95.jpg']);
  assert.deepEqual(calls, ['https://example.test/get-image']);
  assert.ok(image.startsWith('data:image/png;base64,'));
});

test('image input: get_image 返回 local path 时保留原引用并告警', async () => {
  let warned = false;
  const resolver = createNapcatImageReferenceResolver({
    callGetImage: async () => ({ data: { url: '/app/napcat/cache/a.jpg', file: '/app/napcat/cache/a.jpg' } }),
    logger: { warn: () => { warned = true; } },
  });

  assert.equal(await resolver('a.jpg'), undefined);
  assert.equal(warned, true);
});

test('imageDataUrlFromBase64: 识别 PNG/JPEG 并拒绝非图片内容', () => {
  assert.ok(imageDataUrlFromBase64(PNG_SIGNATURE.toString('base64'))?.startsWith('data:image/png;base64,'));
  assert.equal(imageDataUrlFromBase64('not-an-image'), undefined);
});

test('image input: 关闭远程 URL 内联时仍解析 Napcat 本地引用', async () => {
  const prepare = createImageInputPreparer({
    env: { MIOBOT_INLINE_REMOTE_IMAGES: '0' },
    resolveLocalImage: async () => `data:image/png;base64,${PNG_SIGNATURE.toString('base64')}`,
    fetchImpl: async () => {
      throw new Error('不应请求远程 URL');
    },
  });

  const [image] = await prepare(['2F4E9D49282C5B22757A249618A7AE95.jpg']);
  assert.ok(image.startsWith('data:image/png;base64,'));
});

test('image input: QQ CDN download failure drops the image instead of passing a signed URL upstream', async () => {
  const prepare = createImageInputPreparer({
    env: { MIOBOT_INLINE_REMOTE_IMAGES: '1' },
    fetchImpl: async () => new Response('denied', { status: 400 }),
  });
  const [image] = await prepare(['https://gchat.qpic.cn/download?appid=1407&rkey=secret']);
  assert.equal(image, '');
});

test('image input: unresolved local Napcat reference is dropped', async () => {
  const prepare = createImageInputPreparer({
    env: { MIOBOT_INLINE_REMOTE_IMAGES: '1' },
    resolveLocalImage: async () => undefined,
  });
  const [image] = await prepare(['2F4E9D49282C5B22757A249618A7AE95.jpg']);
  assert.equal(image, '');
});
