import test from 'node:test';
import assert from 'node:assert/strict';
import { CanvasGalleryCapabilityHandler } from '../dist/apps/bot/src/capability-canvas.js';
import { isGallerySyncEligibleImageOutput } from '../dist/apps/bot/src/runtime.js';

test('gallery sync: historical canvas gallery outputs are read-only and never re-synced', async () => {
  const handler = new CanvasGalleryCapabilityHandler({
    gallery: () => [{
      id: 'out_old', status: 'succeeded', prompt: 'old cat',
      asset: { id: 'old', url: '/canvas-api/assets/old/download', width: 10, height: 10 },
    }],
  });
  const result = await handler.execute({
    request: { text: '最近生成了什么', chat: { type: 'private' }, user: { qq: '1' }, attachments: [] },
    plan: { planId: 'p', steps: [] }, step: { id: 's', args: {} }, dependencyResults: {},
  });
  const output = result.outputs?.[0];
  assert.equal(output?.kind, 'image');
  assert.equal(output?.meta?.sourceCapability, 'canvas.gallery');
  assert.equal(output?.meta?.readOnlyArtifact, true);
  assert.equal(isGallerySyncEligibleImageOutput(output), false);
});

test('gallery sync: only newly generated image capabilities are eligible', () => {
  assert.equal(isGallerySyncEligibleImageOutput({ kind: 'image', url: 'https://x/1.png', meta: { sourceCapability: 'image.generate' } }), true);
  assert.equal(isGallerySyncEligibleImageOutput({ kind: 'image', url: 'https://x/2.png', meta: { sourceCapability: 'code.render' } }), true);
  assert.equal(isGallerySyncEligibleImageOutput({ kind: 'image', url: 'https://x/3.png', meta: { sourceCapability: 'image.stitch' } }), true);
  assert.equal(isGallerySyncEligibleImageOutput({ kind: 'image', url: 'https://x/4.png', meta: { sourceCapability: 'canvas.gallery' } }), false);
  assert.equal(isGallerySyncEligibleImageOutput({ kind: 'image', url: 'https://x/5.png', meta: { sourceCapability: 'file.read' } }), false);
  assert.equal(isGallerySyncEligibleImageOutput({ kind: 'image', url: 'https://x/6.png', meta: { sourceCapability: 'browser.render' } }), false);
});
