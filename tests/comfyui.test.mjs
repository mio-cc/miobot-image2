import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';

import { normalizeConfig } from '../dist/packages/config/src/index.js';
import { sanitizeComfyUiParams } from '../dist/apps/bot/src/main.js';
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


test('comfyui prompt policy: MOSS-Image and Krea 2 are inferred from profile id', () => {
  const cfg = normalizeConfig({
    llm: {
      apiKeys: [{
        name: 'Comfy', baseUrl: 'http://comfy:8188', key: '', kind: 'comfyui', models: [], modelsFetchedAt: '', concurrency: 1,
        comfyui: {
          pollTimeoutMs: 600000, pollIntervalMs: 2000, maxBatchSize: 4,
          profiles: [
            { id: 'moss-image-sft', name: 'MOSS Image SFT', workflow: {}, parameterMap: {}, defaults: {}, constraints: {} },
            { id: 'krea-2-turbo', name: 'Krea 2 Turbo', workflow: {}, parameterMap: {}, defaults: {}, constraints: {} },
          ],
        },
      }],
    },
  });
  const profiles = cfg.llm.apiKeys[0].comfyui?.profiles || [];
  assert.equal(profiles[0].promptPolicy?.modelFamily, 'moss-image');
  assert.equal(profiles[0].promptPolicy?.promptSyntax, 'moss');
  assert.equal(profiles[0].promptPolicy?.supportsNegativePrompt, true);
  assert.equal(profiles[0].promptPolicy?.supportsWeights, false);
  assert.equal(profiles[1].promptPolicy?.modelFamily, 'krea-2');
  assert.equal(profiles[1].promptPolicy?.variant, 'turbo');
  assert.equal(profiles[1].promptPolicy?.supportsNegativePrompt, false);
});

test('comfyui params: MOSS keeps decimals and strips unsupported weights', () => {
  const cfg = normalizeConfig({
    llm: {
      apiKeys: [{
        name: 'MOSS', baseUrl: 'http://comfy:8188', key: '', kind: 'comfyui', models: [], modelsFetchedAt: '', concurrency: 1,
        comfyui: {
          pollTimeoutMs: 600000, pollIntervalMs: 2000, maxBatchSize: 4,
          profiles: [{
            id: 'moss-image-sft', name: 'MOSS Image SFT',
            workflow: {}, parameterMap: { prompt: '1.inputs.text', negativePrompt: '2.inputs.text', cfg: '3.inputs.cfg', steps: '3.inputs.steps' },
            defaults: { prompt: '', negativePrompt: 'nsfw, worst quality', cfg: 3, steps: 50 },
            constraints: { cfg: { type: 'number', min: 3, max: 6 }, steps: { type: 'number', min: 1, max: 100 } },
          }],
        },
      }],
    },
  });
  const profile = cfg.llm.apiKeys[0].comfyui?.profiles[0];
  assert.ok(profile);
  const params = sanitizeComfyUiParams(profile, {
    prompt: '(cat:1.2) BREAK <lora:style:0.8> on a sofa',
    negativePrompt: 'bad anatomy',
    cfg: 3.5,
    steps: 50,
  }, 'fallback', undefined, 4);
  assert.equal(params.prompt, 'cat on a sofa');
  assert.equal(params.cfg, 3.5);
  assert.equal(params.negativePrompt, 'bad anatomy');
});

test('comfyui params: Krea Turbo removes negative prompt and weights', () => {
  const cfg = normalizeConfig({
    llm: {
      apiKeys: [{
        name: 'Krea', baseUrl: 'http://comfy:8188', key: '', kind: 'comfyui', models: [], modelsFetchedAt: '', concurrency: 1,
        comfyui: {
          pollTimeoutMs: 600000, pollIntervalMs: 2000, maxBatchSize: 4,
          profiles: [{
            id: 'krea-2-turbo', name: 'Krea 2 Turbo',
            workflow: {}, parameterMap: { prompt: '1.inputs.text', cfg: '3.inputs.cfg', steps: '3.inputs.steps', neg: '2.inputs.text' },
            defaults: { prompt: '', cfg: 0, steps: 8 },
            constraints: { cfg: { type: 'number', min: 0, max: 1 }, steps: { type: 'number', min: 8, max: 8 } },
          }],
        },
      }],
    },
  });
  const profile = cfg.llm.apiKeys[0].comfyui?.profiles[0];
  assert.ok(profile);
  const params = sanitizeComfyUiParams(profile, { prompt: 'A (cat:1.3) in rain', negativePrompt: 'bad', cfg: 0, steps: 8 }, 'fallback', undefined, 4);
  assert.equal(params.prompt, 'A cat in rain');
  assert.equal(params.negativePrompt, undefined);
  assert.equal(params.cfg, 0);
});


test('comfyui config: legacy default transform prompt is upgraded', () => {
  const cfg = normalizeConfig({
    comfyuiTransform: {
      promptTemplate: '你是 ComfyUI 生图参数转换器。旧模板 最大批量：{{maxBatchSize}}',
      maxTokens: 1200,
    },
  });
  assert.match(cfg.comfyuiTransform.promptTemplate, /MOSS-Image/);
  assert.match(cfg.comfyuiTransform.promptTemplate, /Krea 2/);
  assert.ok(cfg.comfyuiTransform.maxTokens >= 2400);
});
