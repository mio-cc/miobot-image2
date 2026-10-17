import test from 'node:test';
import assert from 'node:assert/strict';

import { createCanvasService } from '../dist/packages/canvas-service/src/index.js';
import { createDefaultConfig } from '../dist/packages/config/src/index.js';

/** mock generator：返回 GenerationArtifact[](对齐新 CanvasGenerator 契约)。 */
function makeGen() {
  const calls = [];
  return {
    calls,
    generate: async (i) => { calls.push(['generate', i]); return { images: [{ kind: 'base64', data: 'AAA', mimeType: 'image/png' }] }; },
    edit: async (i) => { calls.push(['edit', i]); return { images: [{ kind: 'base64', data: 'BBB', mimeType: 'image/png' }] }; },
    interrogate: async (i) => { calls.push(['interrogate', i]); return { text: 'a cat on a sofa' }; },
    interrogateTemplate: async (i) => { calls.push(['interrogateTemplate', i]); return { text: 'a cat on a sofa with {{prompt}}' }; },
  };
}

function makeService(generator, overrides = {}) {
  let n = 0;
  return createCanvasService({
    getConfig: () => { const c = createDefaultConfig(); Object.assign(c.canvas, overrides); return c; },
    generator,
    idFactory: () => `${n++}`,
  });
}

test('health + config', async () => {
  const svc = makeService(makeGen());
  assert.equal((await svc.handle({ method: 'GET', path: '/canvas-api/health' })).body.status, 'ok');
  const cfg = await svc.handle({ method: 'GET', path: '/canvas-api/config' });
  assert.equal(cfg.body.model, 'gpt-image-2');
  assert.ok(Array.isArray(cfg.body.sizePresets));
});

test('auth/status + provider-config + storage/config(新路由)', async () => {
  const svc = makeService(makeGen());
  const auth = await svc.handle({ method: 'GET', path: '/canvas-api/auth/status' });
  assert.equal(auth.body.available, true);
  const provider = await svc.handle({ method: 'GET', path: '/canvas-api/provider-config' });
  assert.equal(provider.body.current, 'local');
  assert.equal(await svc.handle({ method: 'PUT', path: '/canvas-api/provider-config' }).then((r) => r.body.ok), true);
  const storage = await svc.handle({ method: 'GET', path: '/canvas-api/storage/config' });
  assert.equal(typeof storage.body.enabled, 'boolean');
  assert.equal((await svc.handle({ method: 'POST', path: '/canvas-api/storage/config/test' })).body.ok, true);
});

test('generate: 成功落库到画廊与历史(对齐单体 record.outputs[].asset.url)', async () => {
  const gen = makeGen();
  const svc = makeService(gen);
  const r = await svc.handle({ method: 'POST', path: '/canvas-api/images/generate', body: { prompt: '一只猫', count: 1 } });
  assert.equal(r.status, 200);
  assert.match(r.body.record.outputs[0].asset.url, /^\/canvas-api\/assets\/.+\/download$/);
  assert.equal(r.body.record.mode, 'generate');
  assert.equal(r.body.record.effectivePrompt, '一只猫');
  assert.equal(r.body.record.outputs[0].status, 'succeeded');
  assert.equal(gen.calls[0][1].model, 'gpt-image-2');
  assert.equal(gen.calls[0][1].nodeIndex, 0);
  const gallery = await svc.handle({ method: 'GET', path: '/canvas-api/gallery' });
  assert.equal(gallery.body.total, 1);
  assert.equal(gallery.body.items[0].generationId, r.body.record.id);
  assert.equal(gallery.body.items[0].effectivePrompt, '一只猫');
});

test('generate: 空提示词 → 502(对齐单体抛错)', async () => {
  const svc = makeService(makeGen());
  const r = await svc.handle({ method: 'POST', path: '/canvas-api/images/generate', body: { prompt: '   ' } });
  assert.equal(r.status, 502);
  assert.equal(r.body.error.code, 'generation_failed');
});

test('edit: 缺参考图 → 502；有参考图 200', async () => {
  const gen = makeGen();
  const svc = makeService(gen);
  const noRef = await svc.handle({ method: 'POST', path: '/canvas-api/images/edit', body: { prompt: '换背景' } });
  assert.equal(noRef.status, 502);
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

test('gallery: limit/favorite/query 过滤(对齐单体 collectionQuery)', async () => {
  const svc = makeService(makeGen());
  await svc.handle({ method: 'POST', path: '/canvas-api/images/generate', body: { prompt: 'red apple' } });
  await svc.handle({ method: 'POST', path: '/canvas-api/images/generate', body: { prompt: 'blue sky' } });
  const all = await svc.handle({ method: 'GET', path: '/canvas-api/gallery' });
  assert.equal(all.body.items.length, 2);
  const limited = await svc.handle({ method: 'GET', path: '/canvas-api/gallery?limit=1' });
  assert.equal(limited.body.items.length, 1);
  assert.equal(limited.body.total, 2);
  const searched = await svc.handle({ method: 'GET', path: '/canvas-api/gallery?query=apple' });
  assert.equal(searched.body.items.length, 1);
  assert.match(searched.body.items[0].prompt, /apple/);
});

test('interrogate: 落库反推记录(对齐单体 item.prompt + templatePrompt)', async () => {
  const gen = makeGen();
  const svc = makeService(gen);
  const r = await svc.handle({ method: 'POST', path: '/canvas-api/interrogate', body: { image: { dataUrl: 'data:image/png;base64,ZZ' } } });
  assert.equal(r.status, 200);
  assert.equal(r.body.item.prompt, 'a cat on a sofa');
  assert.equal(r.body.item.templatePrompt, 'a cat on a sofa with {{prompt}}');
  assert.match(r.body.item.asset.url, /^\/canvas-api\/assets\/.+\/download$/);
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
  // 下载资产：gallery item.id = output id = out_<assetId>；asset id 是 out_ 前缀后的部分。
  const assetId = item.id.replace(/^out_/, '');
  const dl = await svc.handle({ method: 'GET', path: `/canvas-api/assets/${assetId}/download` });
  assert.equal(dl.status, 200);
  assert.equal(dl.binary.contentType, 'image/png');
  assert.equal(dl.binary.base64, 'AAA');
  await svc.handle({ method: 'DELETE', path: `/canvas-api/gallery/${item.id}` });
  const gone = await svc.handle({ method: 'GET', path: `/canvas-api/assets/${assetId}/download` });
  assert.equal(gone.status, 404);
});

test('assets: 外链产物不转存(url 原样)', async () => {
  const gen = makeGen();
  gen.generate = async () => ({ images: [{ kind: 'url', data: 'https://cdn.example/img.png' }] });
  const svc = makeService(gen);
  const r = await svc.handle({ method: 'POST', path: '/canvas-api/images/generate', body: { prompt: 'cat' } });
  assert.equal(r.body.record.outputs[0].asset.url, 'https://cdn.example/img.png');
});

test('async job: images/generate?async=1 → 202 + 任务轮询', async () => {
  const svc = makeService(makeGen());
  const start = await svc.handle({ method: 'POST', path: '/canvas-api/images/generate?async=1', body: { prompt: 'cat' } });
  assert.equal(start.status, 202);
  assert.equal(start.body.job.kind, 'image');
  assert.ok(['queued', 'running', 'succeeded'].includes(start.body.job.status));
  const jobId = start.body.job.id;
  // 轮询直到终态。
  let job = start.body.job;
  for (let i = 0; i < 20 && job.status !== 'succeeded' && job.status !== 'failed'; i++) {
    await new Promise((r) => setTimeout(r, 10));
    const poll = await svc.handle({ method: 'GET', path: `/canvas-api/images/jobs/${jobId}` });
    job = poll.body.job;
  }
  assert.equal(job.status, 'succeeded');
  assert.ok(job.record);
  assert.match(job.record.outputs[0].asset.url, /^\/canvas-api\/assets\/.+\/download$/);
  const missing = await svc.handle({ method: 'GET', path: '/canvas-api/images/jobs/nope' });
  assert.equal(missing.status, 404);
});

test('bot/gallery: 鉴权 + 入库(对齐单体 addBotGalleryRecord)', async () => {
  let authed = false;
  const svc = createCanvasService({
    getConfig: () => createDefaultConfig(),
    generator: makeGen(),
    idFactory: () => 'b1',
    isAuthorized: () => authed,
  });
  const unauth = await svc.handle({ method: 'POST', path: '/canvas-api/bot/gallery', body: { artifacts: [{ kind: 'base64', data: 'CCC' }], prompt: 'bot cat' } });
  assert.equal(unauth.status, 401);
  authed = true;
  const ok = await svc.handle({ method: 'POST', path: '/canvas-api/bot/gallery', body: { artifacts: [{ kind: 'base64', data: 'CCC' }], prompt: 'bot cat', mode: 'generate' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.record.source, 'bot');
  assert.equal(ok.body.record.presetId, 'bot');
  assert.equal(ok.body.record.outputs[0].id.startsWith('out_'), true);
  const empty = await svc.handle({ method: 'POST', path: '/canvas-api/bot/gallery', body: { artifacts: [] } });
  assert.equal(empty.status, 400);
  assert.equal(empty.body.error.code, 'bot_gallery_import_failed');
});

test('bot files: uploads arbitrary files and serves them from asset download', async () => {
  const svc = makeService(makeGen());
  const payload = Buffer.from('hello generated file').toString('base64');
  const uploaded = await svc.handle({
    method: 'POST',
    path: '/canvas-api/bot/files',
    body: { name: 'report.txt', mime: 'text/plain', base64: payload },
  });
  assert.equal(uploaded.status, 200);
  assert.match(uploaded.body.file.url, /^\/canvas-api\/assets\/.+\/download$/);
  const download = await svc.handle({ method: 'GET', path: uploaded.body.file.url });
  assert.equal(download.status, 200);
  assert.equal(download.binary.contentType, 'text/plain');
  assert.equal(Buffer.from(download.binary.base64, 'base64').toString('utf8'), 'hello generated file');
});
