import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';

import { normalizeConfig } from '../dist/packages/config/src/index.js';
import { buildComfyUiWorkflow } from '../dist/packages/comfyui/src/index.js';
import { renderTextToImage, stitchImages } from '../dist/packages/image-compose/src/index.js';

const profile = {
  id: 'anime',
  name: '动漫',
  workflow: {
    '3': { class_type: 'KSampler', inputs: { seed: 0, steps: 20, cfg: 7, sampler_name: 'euler', scheduler: 'normal' } },
    '5': { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: '' } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: '' } },
  },
  parameterMap: { prompt: '6.inputs.text', negativePrompt: '7.inputs.text', width: '5.inputs.width', height: '5.inputs.height', steps: '3.inputs.steps', cfg: '3.inputs.cfg', sampler: '3.inputs.sampler_name', scheduler: '3.inputs.scheduler', seed: '3.inputs.seed', batchSize: '5.inputs.batch_size' },
  defaults: { prompt: '', negativePrompt: 'bad quality', width: 1024, height: 1024, steps: 20, cfg: 7, sampler: 'euler', scheduler: 'normal', seed: 0, batchSize: 1 },
  constraints: { steps: { type: 'number', min: 1, max: 50 }, batchSize: { type: 'number', min: 1, max: 8 } },
};

test('comfyui config: independent node and profile normalization', () => {
  const cfg = normalizeConfig({ llm: { apiKeys: [{ name: 'Comfy', baseUrl: 'http://comfy:8188', key: '', kind: 'comfyui', models: [], modelsFetchedAt: '', concurrency: 1, comfyui: { profiles: [profile], pollTimeoutMs: 120000, pollIntervalMs: 1000, maxBatchSize: 4 } }] } });
  const node = cfg.llm.apiKeys[0];
  assert.equal(node.kind, 'comfyui');
  assert.equal(node.comfyui?.profiles[0].id, 'anime');
  assert.equal(node.comfyui?.profiles[0].parameterMap.steps, '3.inputs.steps');
});

test('comfyui workflow: mapping applies prompt, params, seed and clamps batch', () => {
  const result = buildComfyUiWorkflow(profile, { prompt: 'a cat', negativePrompt: 'bad', width: 512, height: 768, steps: 99, cfg: 5, sampler: 'dpmpp_2m', scheduler: 'karras', batchSize: 99 }, 4);
  assert.equal(result.workflow['6'].inputs.text, 'a cat');
  assert.equal(result.workflow['7'].inputs.text, 'bad');
  assert.equal(result.workflow['3'].inputs.steps, 99);
  assert.equal(result.workflow['5'].inputs.width, 512);
  assert.equal(result.workflow['5'].inputs.height, 768);
  assert.equal(result.workflow['5'].inputs.batch_size, 4);
  assert.ok(result.seed && result.seed > 0);
});

test('image compose: multiple images stitch to one JPEG quality 70', async () => {
  const a = await sharp({ create: { width: 320, height: 320, channels: 3, background: '#ff0000' } }).png().toBuffer();
  const b = await sharp({ create: { width: 320, height: 320, channels: 3, background: '#00ff00' } }).png().toBuffer();
  const out = await stitchImages([a, b], { quality: 70, gap: 10 });
  assert.equal(out.mime, 'image/jpeg');
  assert.ok(out.buffer.length > 100);
  const meta = await sharp(out.buffer).metadata();
  assert.equal(meta.format, 'jpeg');
  assert.ok((meta.width || 0) > 320);
});

test('image compose: text becomes a local JPEG without browser', async () => {
  const out = await renderTextToImage('Miobot 文本转图片测试\n第二行中文内容', {
    enabled: true, width: 800, minHeight: 180, maxHeight: 2000, padding: 40, fontSize: 28, lineHeight: 1.6,
    fontFamily: 'sans-serif', background: '#0f172a', foreground: '#ffffff', accent: '#38bdf8', quality: 70, maxChars: 4000,
  });
  assert.equal(out.mime, 'image/jpeg');
  assert.ok(out.buffer.length > 100);
  const meta = await sharp(out.buffer).metadata();
  assert.equal(meta.format, 'jpeg');
});
