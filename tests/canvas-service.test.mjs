import test from 'node:test';
import assert from 'node:assert/strict';

import { createCanvasService } from '../dist/packages/canvas-service/src/index.js';
import { createDefaultConfig } from '../dist/packages/config/src/index.js';

function makeGen() {
  const calls = [];
  return {
    calls,
    generate: async (i) => { calls.push(['generate', i]); return { images: ['data:image/png;base64,AAA'] }; },
    edit: async (i) => { calls.push(['edit', i]); return { images: ['data:image/png;base64,BBB'] }; },
    interrogate: async (i) => { calls.push(['interrogate', i]); return { text: 'a cat on a sofa' }; },
  };
}

function makeService(generator, overrides = {}) {
  let n = 0;
  return createCanvasService({
    getConfig: () => { const c = createDefaultConfig(); Object.assign(c.canvas, overrides); return c; },
    generator,
    idFactory: () => `id${n++}`,
  });
}

test('health + config', async () => {
  const svc = makeService(makeGen());
  assert.equal((await svc.handle({ method: 'GET', path: '/canvas-api/health' })).body.status, 'ok');
  const cfg = await svc.handle({ method: 'GET', path: '/canvas-api/config' });
  assert.equal(cfg.body.model, 'gpt-image-2');
  assert.ok(Array.isArray(cfg.body.sizePresets));
});

test('generate: 成功落库到画廊与历史', async () => {
  const gen = makeGen();
  const svc = makeService(gen);
  const r = await svc.handle({ method: 'POST', path: '/canvas-api/images/generate', body: { prompt: '一只猫', count: 1 } });
  assert.equal(r.status, 200);
  assert.match(r.body.record.outputs[0].url, /^\/canvas-api\/assets\/.+\/download$/);
  assert.equal(gen.calls[0][1].model, 'gpt-image-2');
  assert.equal(gen.calls[0][1].nodeIndex, 0);
  const gallery = await svc.handle({ method: 'GET', path: '/canvas-api/gallery' });
  assert.equal(gallery.body.total, 1);
});

test('generate: 空提示词 400', async () => {
  const svc = makeService(makeGen());
  const r = await svc.handle({ method: 'POST', path: '/canvas-api/images/generate', body: { prompt: '   ' } });
  assert.equal(r.status, 400);
});

test('edit: 缺参考图 400；有参考图 200', async () => {
  const gen = makeGen();
  const svc = makeService(gen);
  const noRef = await svc.handle({ method: 'POST', path: '/canvas-api/images/edit', body: { prompt: '换背景' } });
  assert.equal(noRef.status, 400);
  const ok = await svc.handle({ method: 'POST', path: '/canvas-api/images/edit', body: { prompt: '换背景', referenceImage: { dataUrl: 'data:image/png;base64,XX' } } });
  assert.equal(ok.status, 200);
  assert.equal(gen.calls[0][0], 'edit');
  assert.deepEqual(gen.calls[0][1].images, ['data:image/png;base64,XX']);
});

test('gallery: 收藏与删除', async () => {
  const svc = makeService(makeGen());
  await svc.handle({ method: 'POST', path: '/canvas-api/images/generate', body: { prompt: 'cat' } });
  const item = (await svc.handle({ method: 'GET', path: '/canvas-api/gallery' })).body.items[0];
  const fav = await svc.handle({ method: 'PATCH', path: `/canvas-api/gallery/${item.id}/favorite`, body: { favorite: true } });
  assert.equal(fav.status, 200);
  const del = await svc.handle({ method: 'DELETE', path: `/canvas-api/gallery/${item.id}` });
  assert.equal(del.status, 200);
  assert.equal((await svc.handle({ method: 'GET', path: '/canvas-api/gallery' })).body.total, 0);
  const missing = await svc.handle({ method: 'DELETE', path: '/canvas-api/gallery/nope' });
  assert.equal(missing.status, 404);
});

test('interrogate: 落库反推记录', async () => {
  const gen = makeGen();
  const svc = makeService(gen);
  const r = await svc.handle({ method: 'POST', path: '/canvas-api/interrogate', body: { image: { dataUrl: 'data:image/png;base64,ZZ' } } });
  assert.equal(r.status, 200);
  assert.equal(r.body.item.text, 'a cat on a sofa');
  assert.equal(gen.calls[0][1].model, 'gpt-4o-mini');
  const list = await svc.handle({ method: 'GET', path: '/canvas-api/interrogations' });
  assert.equal(list.body.total, 1);
});

test('generate: generator 抛错 → 502', async () => {
  const gen = makeGen();
  gen.generate = async () => { throw new Error('上游 500'); };
  const svc = makeService(gen);
  const r = await svc.handle({ method: 'POST', path: '/canvas-api/images/generate', body: { prompt: 'cat' } });
  assert.equal(r.status, 502);
  assert.equal(r.body.error.code, 'generation_failed');
});

test('project: PUT 更新名字与快照', async () => {
  const svc = makeService(makeGen());
  const r = await svc.handle({ method: 'PUT', path: '/canvas-api/project', body: { name: 'My Board', snapshot: { shapes: 1 } } });
  assert.equal(r.status, 200);
  assert.equal(r.body.name, 'My Board');
  assert.deepEqual(r.body.snapshot, { shapes: 1 });
});

test('assets: 生成产物转存为可下载资产；删除画廊项联动删资产', async () => {
  const svc = makeService(makeGen());
  await svc.handle({ method: 'POST', path: '/canvas-api/images/generate', body: { prompt: 'cat' } });
  const item = (await svc.handle({ method: 'GET', path: '/canvas-api/gallery' })).body.items[0];
  assert.match(item.asset.url, /^\/canvas-api\/assets\/.+\/download$/);
  const dl = await svc.handle({ method: 'GET', path: `/canvas-api/assets/${item.id}/download` });
  assert.equal(dl.status, 200);
  assert.equal(dl.binary.contentType, 'image/png');
  assert.equal(dl.binary.base64, 'AAA');
  await svc.handle({ method: 'DELETE', path: `/canvas-api/gallery/${item.id}` });
  const gone = await svc.handle({ method: 'GET', path: `/canvas-api/assets/${item.id}/download` });
  assert.equal(gone.status, 404);
});

test('assets: 外链产物不转存(url 原样)', async () => {
  const gen = makeGen();
  gen.generate = async () => ({ images: ['https://cdn.example/img.png'] });
  const svc = makeService(gen);
  const r = await svc.handle({ method: 'POST', path: '/canvas-api/images/generate', body: { prompt: 'cat' } });
  assert.equal(r.body.record.outputs[0].url, 'https://cdn.example/img.png');
});
