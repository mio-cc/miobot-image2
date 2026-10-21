import test from 'node:test';
import assert from 'node:assert/strict';
import { ConfigRepository, WebApi, derivePanelToken } from '../dist/packages/web-api/src/index.js';
import { createDefaultConfig } from '../dist/packages/config/src/index.js';
import { buildComfyUiWorkflow, validateComfyUiProfile } from '../dist/packages/comfyui/src/index.js';
import { generateComfyUiImages } from '../dist/apps/bot/src/comfyui.js';

function workflow() {
  return {
    '1': { class_type: 'CLIPTextEncode', inputs: { text: 'old prompt', clip: ['3', 0] } },
    '2': { class_type: 'KSampler', inputs: { model: ['3', 0], positive: ['1', 0], negative: ['1', 0], latent_image: ['4', 0], seed: 1, steps: 8, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1 } },
    '3': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'model.safetensors' } },
    '4': { class_type: 'EmptyLatentImage', inputs: { width: 1280, height: 720, batch_size: 1 } },
    '5': { class_type: 'SaveImage', inputs: { images: ['2', 0], filename_prefix: 'x' } },
  };
}

function makeApi() {
  const cfg = createDefaultConfig();
  cfg.llm.apiKeys = [{
    name: 'Comfy', baseUrl: 'http://comfy:8188', key: '', enabled: true, models: ['anime'], modelsFetchedAt: '', concurrency: 1, kind: 'comfyui',
    comfyui: {
      profiles: [{
        id: 'anime', name: 'Anime', workflow: workflow(), promptNodeIds: ['1'], negativePromptNodeIds: [], outputNodeId: '5',
        parameterMap: { steps: '2.inputs.steps', cfg: '2.inputs.cfg', sampler: '2.inputs.sampler_name', width: '4.inputs.width', height: '4.inputs.height' },
        defaults: { steps: 8, cfg: 1, sampler: 'euler', width: 1280, height: 720 },
        constraints: {}, promptPolicy: undefined,
      }],
      pollTimeoutMs: 120000, pollIntervalMs: 1000, maxBatchSize: 1, maxConcurrent: 1, maxQueue: 2, queueTimeoutMs: 30000,
    },
  }];
  const repository = new ConfigRepository({ initialConfig: cfg });
  const api = new WebApi({ repository });
  const auth = { authorization: `Bearer ${derivePanelToken(cfg.panel.passwordSeed)}` };
  return { api, repository, auth };
}

test('comfyui workflow API: list, read, validate and save profile parameters', async () => {
  const { api, repository, auth } = makeApi();
  const list = await api.handle({ method: 'GET', path: '/api/orchestration/comfyui/workflows', headers: auth });
  assert.equal(list.status, 200);
  assert.equal(list.body.nodes[0].profiles[0].id, 'anime');
  assert.equal(list.body.nodes[0].profiles[0].validation.ok, true);
  const detail = await api.handle({ method: 'GET', path: '/api/orchestration/comfyui/workflows/0/anime', headers: auth });
  assert.equal(detail.status, 200);
  assert.equal(detail.body.profile.promptNodeIds[0], '1');
  const saved = await api.handle({
    method: 'PUT', path: '/api/orchestration/comfyui/workflows/0/anime', headers: auth,
    body: {
      name: 'Anime updated', workflow: workflow(), promptNodeIds: ['1'], negativePromptNodeIds: [], outputNodeId: '5',
      parameterMap: { steps: '2.inputs.steps', cfg: '2.inputs.cfg', sampler: '2.inputs.sampler_name', width: '4.inputs.width', height: '4.inputs.height' },
      defaults: { steps: 30, cfg: 5.5, sampler: 'dpmpp_2m', width: 768, height: 1344 },
    },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.profile.defaults.steps, 30);
  const cfg = repository.getConfig();
  assert.equal(cfg.llm.apiKeys[0].comfyui.profiles[0].defaults.steps, 30);
  const invalid = await api.handle({
    method: 'PUT', path: '/api/orchestration/comfyui/workflows/0/anime', headers: auth,
    body: { workflow: workflow(), promptNodeIds: ['missing'], outputNodeId: '5', parameterMap: { steps: '2.inputs.steps' }, defaults: { steps: 20 } },
  });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error, 'comfyui_workflow_invalid');
  const protectedDelete = await api.handle({ method: 'DELETE', path: '/api/orchestration/comfyui/workflows/0/anime', headers: auth });
  assert.equal(protectedDelete.status, 400);
  assert.equal(protectedDelete.body.error, 'comfyui_last_profile_protected');
});

test('comfyui workflow: prompt injection never changes workflow numeric parameters', () => {
  const profile = {
    id: 'anime', name: 'Anime', workflow: workflow(), promptNodeIds: ['1'], negativePromptNodeIds: [], outputNodeId: '5',
    parameterMap: { steps: '2.inputs.steps', cfg: '2.inputs.cfg' }, defaults: { steps: 8, cfg: 1 },
  };
  assert.equal(validateComfyUiProfile(profile).ok, true);
  const built = buildComfyUiWorkflow(profile, { prompt: 'enhanced visual prompt', negativePrompt: 'ignored', steps: 99, cfg: 12, width: 1, height: 1 });
  assert.equal(built.workflow['1'].inputs.text, 'enhanced visual prompt');
  assert.equal(built.workflow['2'].inputs.steps, 99);
  assert.equal(built.workflow['2'].inputs.cfg, 12);
  assert.equal(built.workflow['4'].inputs.width, 1280);
  assert.equal(built.workflow['4'].inputs.height, 720);
});
test('comfyui generation: LLM enhances prompt only and workflow params stay fixed', async () => {
  const { repository } = makeApi();
  const cfg = repository.getConfig();
  cfg.comfyuiTransform = { enabled: true, nodeIndex: 0, model: 'prompt-model', timeoutMs: 10000, maxTokens: 1000, promptTemplate: 'Enhance only this visual prompt: {{userRequest}}' };
  cfg.llm.imageNodeIndex = 0;
  cfg.llm.apiKeys[0].comfyui.pollTimeoutMs = 5000;
  cfg.llm.apiKeys[0].comfyui.pollIntervalMs = 50;
  let submittedWorkflow;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith('/prompt')) {
      submittedWorkflow = JSON.parse(String(init.body)).prompt;
      return new Response(JSON.stringify({ prompt_id: 'prompt-1' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('/history/prompt-1')) {
      return new Response(JSON.stringify({ 'prompt-1': { outputs: { '5': { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] } } } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('/view?')) {
      return new Response(Buffer.from('fake-png'), { status: 200, headers: { 'content-type': 'image/png' } });
    }
    throw new Error('unexpected fetch ' + u);
  };
  try {
    const result = await generateComfyUiImages({
      getConfig: () => cfg,
      client: { async chat() { return { text: 'ENHANCED_VISUAL_PROMPT' }; } },
    }, { nodeIndex: 0, profileId: 'anime', prompt: '原图提示词', count: 1 });
    assert.ok(result.images.length >= 1);
    assert.equal(submittedWorkflow['1'].inputs.text, 'ENHANCED_VISUAL_PROMPT');
    assert.equal(submittedWorkflow['2'].inputs.steps, 8);
    assert.equal(submittedWorkflow['2'].inputs.cfg, 1);
    assert.equal(submittedWorkflow['4'].inputs.width, 1280);
    assert.equal(submittedWorkflow['4'].inputs.height, 720);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
