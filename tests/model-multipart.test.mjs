import test from 'node:test';
import assert from 'node:assert/strict';

import { buildMultipartImageEdit, extensionForMime, resolveImageBytes } from '../dist/packages/model/src/dialects/multipart.js';
import { createModelClient } from '../dist/packages/model/src/client.js';
import { createCapabilityRegistry } from '../dist/packages/model/src/capability/registry.js';
import { GPT_IMAGE_PROFILE, GROK_IMAGINE_IMAGE_PROFILE } from '../dist/packages/model/src/capability/profiles.js';

/**
 * 改图请求体形态。
 * 官方 /images/edits 只接受 multipart/form-data，JSON 会被直接拒；
 * 而 xAI 官方文档明确说不支持 multipart。形态排错就是每次改图都白白失败一轮。
 */

const NODE = { baseUrl: 'https://api.example.com/v1', apiKey: 'k', dialect: 'openai' };
const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgo=';

test('resolveImageBytes: 解析 data URL 与 base64://', async () => {
  const fromData = await resolveImageBytes(PNG_DATA_URL);
  assert.equal(fromData.mimeType, 'image/png');
  assert.equal(fromData.fileName, 'image.png');
  assert.ok(fromData.bytes.length > 0);

  const fromBase64 = await resolveImageBytes('base64://iVBORw0KGgo=');
  assert.ok(fromBase64.bytes.length > 0);
});

test('resolveImageBytes: 下载 http 图片并按 content-type 命名', async () => {
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'image/jpeg' : null) },
    arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
  });
  const resolved = await resolveImageBytes('https://x.com/a.jpg', fakeFetch);
  assert.equal(resolved.mimeType, 'image/jpeg');
  assert.equal(resolved.fileName, 'image.jpg');
  assert.equal(resolved.bytes.length, 3);
});

test('resolveImageBytes: 下载失败与无法识别的引用都给明确错误', async () => {
  const failing = async () => ({ ok: false, status: 404, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) });
  await assert.rejects(() => resolveImageBytes('https://x.com/a.jpg', failing), /下载参考图失败/);
  await assert.rejects(() => resolveImageBytes('C:/some/local.png'), /无法解析参考图/);
});

test('extensionForMime: 常见类型映射', () => {
  assert.equal(extensionForMime('image/png'), 'png');
  assert.equal(extensionForMime('image/jpeg'), 'jpg');
  assert.equal(extensionForMime('image/webp'), 'webp');
  assert.equal(extensionForMime('application/octet-stream'), 'png');
});

test('buildMultipartImageEdit: 用 FormData 且不手工设置 Content-Type', () => {
  const image = { bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png', fileName: 'a.png' };
  const plan = buildMultipartImageEdit(NODE, { model: 'gpt-image-2', prompt: '换成夜晚', images: [] }, [image]);

  assert.equal(plan.multipart, true);
  assert.ok(plan.body instanceof FormData);
  assert.equal(plan.url, 'https://api.example.com/v1/images/edits');
  // boundary 由 FormData 生成，手工设 Content-Type 会让服务端解析不出分隔符
  const headerKeys = Object.keys(plan.headers).map((k) => k.toLowerCase());
  assert.ok(!headerKeys.includes('content-type'));
  assert.equal(plan.headers.Authorization, 'Bearer k');

  assert.equal(plan.body.get('model'), 'gpt-image-2');
  assert.equal(plan.body.get('prompt'), '换成夜晚');
  assert.ok(plan.body.get('image'));
});

test('buildMultipartImageEdit: 多图用 image[] 字段, 带 mask', () => {
  const mk = (name) => ({ bytes: new Uint8Array([1]), mimeType: 'image/png', fileName: name });
  const plan = buildMultipartImageEdit(NODE, { model: 'gpt-image-2', prompt: 'p', images: [], size: '1024x1024', quality: 'high' },
    [mk('a.png'), mk('b.png')], mk('mask.png'));

  assert.equal(plan.body.getAll('image[]').length, 2);
  assert.ok(plan.body.get('mask'));
  assert.equal(plan.body.get('size'), '1024x1024');
  assert.equal(plan.body.get('quality'), 'high');
});

test('buildMultipartImageEdit: 没有图片直接报错', () => {
  assert.throws(() => buildMultipartImageEdit(NODE, { model: 'gpt-image-2', prompt: 'p', images: [] }, []), /缺少图片/);
});

/** 端到端：官方 gpt-image 应当走 multipart，xAI 应当走 JSON。 */
function makeClient(profile, onRequest) {
  return createModelClient({
    nodes: [NODE],
    registry: createCapabilityRegistry({ fallback: profile }),
    transport: async (request) => {
      onRequest(request);
      return { status: 200, data: { data: [{ b64_json: 'AAA' }] } };
    },
  });
}

test('官方 gpt-image 改图走 multipart', async () => {
  let seen;
  const client = makeClient(GPT_IMAGE_PROFILE, (r) => { seen = r; });
  await client.editImage(0, { model: 'gpt-image-2', prompt: '换成夜晚', images: [PNG_DATA_URL] });

  assert.equal(seen.multipart, true);
  assert.ok(seen.body instanceof FormData);
});

test('xAI 改图仍走 JSON（官方明确不支持 multipart）', async () => {
  let seen;
  const client = makeClient(GROK_IMAGINE_IMAGE_PROFILE, (r) => { seen = r; });
  await client.editImage(0, { model: 'grok-imagine-image-quality', prompt: 'p', images: [PNG_DATA_URL] });

  assert.notEqual(seen.multipart, true);
  assert.equal(typeof seen.body, 'object');
  assert.equal(seen.body.model, 'grok-imagine-image-quality');
});

test('multipart 被拒时自动退回 JSON', async () => {
  const seen = [];
  const client = createModelClient({
    nodes: [NODE],
    registry: createCapabilityRegistry({ fallback: GPT_IMAGE_PROFILE }),
    transport: async (request) => {
      seen.push(request);
      if (request.multipart) {
        return { status: 415, data: { error: { message: 'Unsupported Media Type: multipart/form-data not accepted' } } };
      }
      return { status: 200, data: { data: [{ b64_json: 'AAA' }] } };
    },
  });

  const result = await client.editImage(0, { model: 'gpt-image-2', prompt: 'p', images: [PNG_DATA_URL] });
  assert.equal(result.images.length, 1);
  assert.equal(seen.length, 2);
  assert.equal(seen[0].multipart, true);
  assert.notEqual(seen[1].multipart, true);
});

test('非形态问题的错误不会触发退回（避免掩盖真实故障）', async () => {
  const seen = [];
  const client = createModelClient({
    nodes: [NODE],
    registry: createCapabilityRegistry({ fallback: GPT_IMAGE_PROFILE }),
    transport: async (request) => {
      seen.push(request);
      return { status: 401, data: { error: { message: 'Invalid API key provided' } } };
    },
  });

  await assert.rejects(() => client.editImage(0, { model: 'gpt-image-2', prompt: 'p', images: [PNG_DATA_URL] }), /Invalid API key/);
  assert.equal(seen.length, 1, '鉴权失败不应再试 JSON');
});
