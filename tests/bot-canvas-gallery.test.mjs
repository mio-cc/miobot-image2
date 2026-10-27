import test from 'node:test';
import assert from 'node:assert/strict';

import { createCanvasGallerySync } from '../dist/apps/bot/src/main.js';
import { createDefaultConfig } from '../dist/packages/config/src/index.js';
import { derivePanelToken } from '../dist/packages/web-api/src/index.js';

function baseConfig() {
  const config = createDefaultConfig();
  config.panel.port = 3018;
  config.panel.passwordSeed = 'test-password';
  return config;
}

function galleryResponse(urls = ['/canvas-api/assets/a1/download']) {
  return new Response(JSON.stringify({
    ok: true,
    record: {
      outputs: urls.map((url, index) => ({ asset: { id: `a${index + 1}`, url } })),
    },
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

test('canvas gallery sync: 保存进图库并把相对资产 URL 转成 Napcat 可访问的绝对 URL', async () => {
  const config = baseConfig();
  const calls = [];
  const sync = createCanvasGallerySync({
    getConfig: () => config,
    env: {
      MIOBOT_PORT: '3018',
      MIOBOT_PUBLIC_BASE_URL: 'https://i.mioku.cn',
    },
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return galleryResponse(['/canvas-api/assets/a1/download']);
    },
  });

  const images = await sync.syncImages({
    mode: 'generate',
    prompt: '一只猫',
    images: ['data:image/png;base64,AAAA'],
    context: { chatType: 'group', groupId: 9, userId: 5 },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:3018/canvas-api/bot/gallery');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.authorization, `Bearer ${derivePanelToken(config.panel.passwordSeed)}`);

  const payload = JSON.parse(calls[0].init.body);
  assert.equal(payload.source, 'bot');
  assert.equal(payload.mode, 'generate');
  assert.equal(payload.prompt, '一只猫');
  assert.deepEqual(payload.context, { chatType: 'group', groupId: '9', userId: '5' });
  assert.deepEqual(payload.artifacts, [{
    kind: 'url',
    data: 'data:image/png;base64,AAAA',
    mimeType: 'image/png',
  }]);

  assert.deepEqual(images, ['https://i.mioku.cn/canvas-api/assets/a1/download']);
});

test('canvas gallery sync: 未配置 MIOBOT_PUBLIC_BASE_URL 时仍然入库，但发送回退原图', async () => {
  const config = baseConfig();
  const sync = createCanvasGallerySync({
    getConfig: () => config,
    env: { MIOBOT_PORT: '3018' },
    fetchImpl: async () => galleryResponse(['/canvas-api/assets/a1/download']),
  });

  const original = ['data:image/png;base64,AAAA'];
  const images = await sync.syncImages({
    mode: 'generate',
    prompt: 'cat',
    images: original,
    context: { chatType: 'private', userId: 5 },
  });

  assert.deepEqual(images, original);
});

test('canvas gallery sync: HTTP 失败时回退原图，不阻断回复', async () => {
  const config = baseConfig();
  const sync = createCanvasGallerySync({
    getConfig: () => config,
    env: { MIOBOT_PORT: '3018', MIOBOT_PUBLIC_BASE_URL: 'http://host:3018' },
    fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'unauthorized' } }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    }),
  });

  const original = ['data:image/png;base64,AAAA'];
  const images = await sync.syncImages({
    mode: 'edit',
    prompt: 'cat',
    images: original,
    context: { chatType: 'private', userId: 5 },
  });

  assert.deepEqual(images, original);
});

test('canvas gallery sync: base64:// 入参按 base64 artifact 提交', async () => {
  const config = baseConfig();
  let body;
  const sync = createCanvasGallerySync({
    getConfig: () => config,
    env: { MIOBOT_PORT: '3018', MIOBOT_PUBLIC_BASE_URL: 'http://host:3018' },
    fetchImpl: async (_url, init) => {
      body = JSON.parse(init.body);
      return galleryResponse(['https://cdn.example/generated.png']);
    },
  });

  const images = await sync.syncImages({
    mode: 'generate',
    prompt: 'cat',
    images: ['base64://BBBB'],
    context: { chatType: 'private', userId: 5 },
  });

  assert.deepEqual(body.artifacts, [{ kind: 'base64', data: 'BBBB', mimeType: 'image/png' }]);
  assert.deepEqual(images, ['https://cdn.example/generated.png']);
});

test('canvas gallery sync: 明确关闭时完全不请求 Canvas', async () => {
  const config = baseConfig();
  let called = false;
  const sync = createCanvasGallerySync({
    getConfig: () => config,
    env: { MIOBOT_SYNC_BOT_GALLERY: '0' },
    fetchImpl: async () => {
      called = true;
      return galleryResponse();
    },
  });

  const original = ['data:image/png;base64,AAAA'];
  const images = await sync.syncImages({
    mode: 'generate',
    prompt: 'cat',
    images: original,
    context: { chatType: 'private', userId: 5 },
  });

  assert.equal(called, false);
  assert.deepEqual(images, original);
});

test('canvas gallery sync: existing canvas asset URLs are never re-imported', async () => {
  const config = baseConfig();
  let calls = 0;
  const sync = createCanvasGallerySync({
    getConfig: () => config,
    env: { MIOBOT_PORT: '3018', MIOBOT_PUBLIC_BASE_URL: 'https://i.mioku.cn' },
    fetchImpl: async () => {
      calls += 1;
      return galleryResponse(['/canvas-api/assets/b1/download']);
    },
  });
  const original = ['http://host.docker.internal:3018/canvas-api/assets/file_x/download'];
  const images = await sync.syncImages({
    mode: 'generate',
    prompt: 'cat',
    images: original,
    context: { chatType: 'group', groupId: 9, userId: 5 },
  });
  assert.equal(calls, 0);
  assert.deepEqual(images, original);
});
test('canvas gallery sync: private public base stores gallery but sends original images', async () => {
  const config = baseConfig();
  let called = false;
  const sync = createCanvasGallerySync({
    getConfig: () => config,
    env: { MIOBOT_PORT: '3018', MIOBOT_PUBLIC_BASE_URL: 'http://host.docker.internal:3018' },
    fetchImpl: async () => {
      called = true;
      return galleryResponse(['/canvas-api/assets/private1/download']);
    },
  });
  const original = ['data:image/png;base64,AAAA'];
  const images = await sync.syncImages({
    mode: 'generate',
    prompt: 'cat',
    images: original,
    context: { chatType: 'group', groupId: 9, userId: 5 },
  });
  assert.equal(called, true);
  assert.deepEqual(images, original);
});

test('canvas gallery sync: external image URL is fetched and submitted as base64 for preview-safe storage', async () => {
  const config = baseConfig();
  const calls = [];
  const sync = createCanvasGallerySync({
    getConfig: () => config,
    env: { MIOBOT_PORT: '3018', MIOBOT_PUBLIC_BASE_URL: 'https://i.mioku.cn' },
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (url === 'https://cdn.example/generated.png') {
        return new Response(Buffer.from('PNG_BYTES'), { status: 200, headers: { 'content-type': 'image/png' } });
      }
      return galleryResponse(['/canvas-api/assets/ext1/download']);
    },
  });
  const images = await sync.syncImages({
    mode: 'generate', prompt: 'external cat', images: ['https://cdn.example/generated.png'],
    context: { chatType: 'private', userId: '1' },
  });
  assert.equal(calls.length, 2);
  const payload = JSON.parse(calls[1].init.body);
  assert.equal(payload.artifacts[0].kind, 'base64');
  assert.equal(payload.artifacts[0].mimeType, 'image/png');
  assert.equal(Buffer.from(payload.artifacts[0].data, 'base64').toString('utf8'), 'PNG_BYTES');
  assert.deepEqual(images, ['https://i.mioku.cn/canvas-api/assets/ext1/download']);
});
