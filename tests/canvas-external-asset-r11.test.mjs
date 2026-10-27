import test from 'node:test';
import assert from 'node:assert/strict';
import { CanvasStore, CanvasService, InMemoryAssetStore } from '../dist/packages/canvas-service/src/index.js';
import { createDefaultConfig } from '../dist/packages/config/src/index.js';

function service() {
  const cfg = createDefaultConfig();
  return new CanvasService({
    getConfig: () => cfg,
    generator: {
      async generate() { return { images: [{ kind: 'url', data: 'https://cdn.example/generated.png', mimeType: 'image/png' }] }; },
      async edit() { return { images: [] }; },
      async interrogate() { return { text: '' }; },
    },
    store: new CanvasStore(),
    assets: new InMemoryAssetStore(),
    previewResizer: null,
  });
}

test('canvas asset preview proxies legacy external asset URLs instead of returning 404', async () => {
  const svc = service();
  const generated = await svc.handle({ method: 'POST', path: '/canvas-api/images/generate', body: { prompt: 'cat' } });
  assert.equal(generated.status, 200);
  const asset = generated.body.record.outputs[0].asset;
  assert.match(asset.url, /^https:\/\/cdn\.example/);
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.equal(String(url), 'https://cdn.example/generated.png');
    return new Response(Buffer.from('PNG_BYTES'), { status: 200, headers: { 'content-type': 'image/png' } });
  };
  try {
    const preview = await svc.handle({ method: 'GET', path: `/canvas-api/assets/${encodeURIComponent(asset.id)}/preview?width=512` });
    assert.equal(preview.status, 200);
    assert.equal(preview.binary?.contentType, 'image/png');
    assert.equal(Buffer.from(preview.binary?.base64 || '', 'base64').toString('utf8'), 'PNG_BYTES');
  } finally {
    globalThis.fetch = previousFetch;
  }
});
