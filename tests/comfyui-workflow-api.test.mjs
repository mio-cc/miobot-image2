import test from 'node:test';
import assert from 'node:assert/strict';
import { ConfigRepository, WebApi, derivePanelToken } from '../dist/packages/web-api/src/index.js';
import { BUILTIN_COMFYUI_PROFILES, createDefaultConfig, normalizeConfig } from '../dist/packages/config/src/index.js';
import { buildComfyUiWorkflow, validateComfyUiProfile } from '../dist/packages/comfyui/src/index.js';
import { generateComfyUiImages } from '../dist/apps/bot/src/comfyui.js';
import { sanitizeComfyUiParams } from '../dist/apps/bot/src/main.js';

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

test('comfyui builtin: three baseline workflows migrate old 10-node profiles', () => {
  assert.deepEqual(BUILTIN_COMFYUI_PROFILES.map((profile) => Object.keys(profile.workflow || {}).length), [16, 20, 16]);
  assert.deepEqual(BUILTIN_COMFYUI_PROFILES.find((profile) => profile.id === 'krea-2-turbo')?.negativePromptNodeIds, ['6']);
  const cfg = createDefaultConfig();
  cfg.llm.apiKeys = [{
    name: 'Comfy', baseUrl: 'http://comfy:8188', key: '', enabled: true, models: ['moss-image-sft'], modelsFetchedAt: '', concurrency: 1, kind: 'comfyui',
    comfyui: {
      profiles: [{
        id: 'moss-image-sft', name: 'old moss', workflow: { '1': { class_type: 'UNETLoader', inputs: {} } },
        parameterMap: { prompt: '4.inputs.text' }, promptNodeIds: ['4'], negativePromptNodeIds: [], defaults: { steps: 25 }, outputNodeId: '10', constraints: {},
      }],
      pollTimeoutMs: 120000, pollIntervalMs: 1000, maxBatchSize: 1, maxConcurrent: 1, maxQueue: 2, queueTimeoutMs: 30000,
    },
  }];
  const normalized = normalizeConfig(cfg);
  const profile = normalized.llm.apiKeys[0].comfyui.profiles[0];
  assert.equal(Object.keys(profile.workflow).length, 16);
  assert.deepEqual(profile.promptNodeIds, ['5', '13']);
  assert.deepEqual(profile.negativePromptNodeIds, ['6']);
  assert.equal(profile.outputNodeId, '16');
  assert.equal(profile.customized, false);
  assert.equal(profile.fallbackEnabled, true);
  assert.equal(profile.defaults.seed, 0);
  assert.equal(profile.defaults.detailerSeed, 0);
  assert.equal(profile.defaults.upscaleSeed, 0);
});

test('comfyui builtin: Krea2 configured negative prompt rewires ConditioningZeroOut', () => {
  const profile = BUILTIN_COMFYUI_PROFILES.find((item) => item.id === 'krea-2-turbo');
  assert.ok(profile);
    assert.equal(profile.promptPolicy.supportsNegativePrompt, true);
    const sanitized = sanitizeComfyUiParams(profile, { prompt: 'poster prompt', negativePrompt: 'bad hands, watermark' }, 'fallback', undefined, 1);
    assert.equal(sanitized.negativePrompt, 'bad hands, watermark');
  const built = buildComfyUiWorkflow(profile, { prompt: 'poster prompt', negativePrompt: 'bad hands, watermark' });
  assert.deepEqual(built.workflow['10'].inputs.negative, ['6', 0]);
  assert.deepEqual(built.workflow['15'].inputs.negative, ['6', 0]);
  assert.equal(built.workflow['7'], undefined);
  assert.equal(built.workflow['6'].inputs.text, 'bad hands, watermark');
  const plain = buildComfyUiWorkflow(profile, { prompt: 'poster prompt' });
  assert.deepEqual(plain.workflow['10'].inputs.negative, ['7', 0]);
  assert.equal(plain.workflow['7'].class_type, 'ConditioningZeroOut');
});

test('comfyui fallback: invalid primary prompt node automatically runs builtin baseline', async () => {
  const cfg = createDefaultConfig();
  const builtin = BUILTIN_COMFYUI_PROFILES.find((item) => item.id === 'z-image-turbo');
  assert.ok(builtin);
  const primary = { ...JSON.parse(JSON.stringify(builtin)), promptNodeIds: ['999'], fallbackProfileId: 'z-image-turbo', fallbackEnabled: true };
  cfg.llm.apiKeys = [{
    name: 'Comfy', baseUrl: 'http://comfy:8188', key: '', enabled: true, models: ['z-image-turbo'], modelsFetchedAt: '', concurrency: 1, kind: 'comfyui',
    comfyui: { profiles: [primary], pollTimeoutMs: 5000, pollIntervalMs: 20, maxBatchSize: 1, maxConcurrent: 1, maxQueue: 2, queueTimeoutMs: 5000 },
  }];
  cfg.comfyuiTransform = { enabled: false, nodeIndex: 0, model: '', timeoutMs: 1000, maxTokens: 100, promptTemplate: '' };
  cfg.llm.imageNodeIndex = 0;
  let submitted;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const value = String(url);
    if (value.endsWith('/prompt')) {
      submitted = JSON.parse(String(init.body)).prompt;
      return new Response(JSON.stringify({ prompt_id: 'fallback-prompt' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (value.includes('/history/fallback-prompt')) {
      return new Response(JSON.stringify({ 'fallback-prompt': { outputs: { '16': { images: [{ filename: 'fallback.png', subfolder: '', type: 'output' }] } } } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (value.includes('/view?')) return new Response(Buffer.from('fallback-image'), { status: 200, headers: { 'content-type': 'image/png' } });
    throw new Error('unexpected fetch ' + value);
  };
  try {
    const result = await generateComfyUiImages({
      getConfig: () => cfg,
      client: { async chat() { return { text: 'unused' }; } },
    }, { nodeIndex: 0, profileId: 'z-image-turbo', prompt: 'fallback test prompt', count: 1 });
    assert.ok(result.images.length >= 1);
    assert.equal(result.raw.usedFallback, true);
    assert.equal(result.raw.primaryProfileId, 'z-image-turbo');
    assert.equal(result.raw.fallbackProfileId, 'z-image-turbo');
    assert.match(String(result.raw.primaryError), /提示词节点不存在|校验失败/);
    assert.equal(submitted['4'].inputs.text, 'fallback test prompt');
    assert.equal(submitted['13'].inputs.text, 'fallback test prompt');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('comfyui workflow API: restoreBuiltin replaces customized primary with baseline', async () => {
  const cfg = createDefaultConfig();
  const builtin = BUILTIN_COMFYUI_PROFILES.find((item) => item.id === 'z-image-turbo');
  assert.ok(builtin);
  cfg.llm.apiKeys = [{
    name: 'Comfy', baseUrl: 'http://comfy:8188', key: '', enabled: true, models: ['z-image-turbo'], modelsFetchedAt: '', concurrency: 1, kind: 'comfyui',
    comfyui: {
      profiles: [{ ...JSON.parse(JSON.stringify(builtin)), workflow: { '1': { class_type: 'UNETLoader', inputs: {} } }, customized: true, fallbackEnabled: true, fallbackProfileId: 'z-image-turbo' }],
      pollTimeoutMs: 120000, pollIntervalMs: 1000, maxBatchSize: 1, maxConcurrent: 1, maxQueue: 2, queueTimeoutMs: 30000,
    },
  }];
  const repository = new ConfigRepository({ initialConfig: cfg });
  const api = new WebApi({ repository });
  const auth = { authorization: `Bearer ${derivePanelToken(cfg.panel.passwordSeed)}` };
  const restored = await api.handle({
    method: 'PUT', path: '/api/orchestration/comfyui/workflows/0/z-image-turbo', headers: auth,
    body: { restoreBuiltin: true },
  });
  assert.equal(restored.status, 200);
  assert.equal(restored.body.profile.customized, false);
  assert.equal(Object.keys(restored.body.profile.workflow).length, 16);
  assert.deepEqual(restored.body.profile.promptNodeIds, ['4', '13']);
  assert.equal(restored.body.validation.ok, true);
  const changed = await api.handle({
    method: 'PUT', path: '/api/orchestration/comfyui/workflows/0/z-image-turbo', headers: auth,
    body: { defaults: { ...(restored.body.profile.defaults || {}), steps: 12 }, customized: false },
  });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.profile.customized, true);
});
test('comfyui fallback: when baseline also fails it throws fallback_exhausted without returning images', async () => {
  const cfg = createDefaultConfig();
  const builtin = BUILTIN_COMFYUI_PROFILES.find((item) => item.id === 'z-image-turbo');
  assert.ok(builtin);
  const primary = { ...JSON.parse(JSON.stringify(builtin)), promptNodeIds: ['999'], fallbackProfileId: 'z-image-turbo', fallbackEnabled: true };
  cfg.llm.apiKeys = [{
    name: 'Comfy', baseUrl: 'http://comfy:8188', key: '', enabled: true, models: ['z-image-turbo'], modelsFetchedAt: '', concurrency: 1, kind: 'comfyui',
    comfyui: { profiles: [primary], pollTimeoutMs: 5000, pollIntervalMs: 20, maxBatchSize: 1, maxConcurrent: 1, maxQueue: 2, queueTimeoutMs: 5000 },
  }];
  cfg.comfyuiTransform = { enabled: false, nodeIndex: 0, model: '', timeoutMs: 1000, maxTokens: 100, promptTemplate: '' };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.endsWith('/prompt')) return new Response(JSON.stringify({ prompt_id: 'baseline-failed', node_errors: { '4': { error: 'bad node' } } }), { status: 200, headers: { 'content-type': 'application/json' } });
    throw new Error('unexpected fetch ' + value);
  };
  try {
    await assert.rejects(
      () => generateComfyUiImages({ getConfig: () => cfg, client: { async chat() { return { text: 'unused' }; } } }, { nodeIndex: 0, profileId: 'z-image-turbo', prompt: 'will fail', count: 1 }),
      /fallback_exhausted|主 workflow 和 fallback 均失败/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('comfyui builtin: one random base seed drives main/detailer/upscale while other params stay fixed', () => {
  const originalRandom = Math.random;
  let call = 0;
  Math.random = () => (++call % 2 === 1 ? 0.25 : 0.75);
  try {
    for (const profile of BUILTIN_COMFYUI_PROFILES) {
      assert.equal(profile.defaults.seed, 0);
      assert.equal(profile.defaults.detailerSeed, 0);
      assert.equal(profile.defaults.upscaleSeed, 0);
      const first = buildComfyUiWorkflow(profile, { prompt: '同一个提示词' });
      const second = buildComfyUiWorkflow(profile, { prompt: '同一个提示词' });
      assert.ok(first.seeds?.seed > 0);
      assert.equal(first.seeds.detailerSeed, first.seeds.seed + 1);
      assert.equal(first.seeds.upscaleSeed, first.seeds.seed + 2);
      assert.notEqual(first.seeds.seed, second.seeds.seed);
      assert.equal(first.applied.seed, first.seeds.seed);
      assert.equal(first.applied.detailerSeed, first.seeds.detailerSeed);
      assert.equal(first.applied.upscaleSeed, first.seeds.upscaleSeed);
      const fixedKeys = ['width', 'height', 'batchSize', 'steps', 'cfg', 'sampler', 'scheduler', 'loraStrength', 'detailerSteps', 'detailerCfg', 'detailerSampler', 'detailerScheduler', 'detailerDenoise', 'guideSize', 'upscaleBy', 'upscaleSteps', 'upscaleCfg', 'upscaleSampler', 'upscaleScheduler', 'upscaleDenoise'];
      for (const key of fixedKeys) {
        assert.deepEqual(first.applied[key], second.applied[key], `${profile.id}:${key}`);
      }
    }
  } finally {
    Math.random = originalRandom;
  }
});
test('comfyui fallback: poll timeout never starts a second generation', async () => {
  const cfg = createDefaultConfig();
  const builtin = BUILTIN_COMFYUI_PROFILES.find((item) => item.id === 'z-image-turbo');
  assert.ok(builtin);
  const primary = { ...JSON.parse(JSON.stringify(builtin)), defaults: { ...builtin.defaults, steps: 7 }, fallbackProfileId: 'z-image-turbo', fallbackEnabled: true };
  cfg.llm.apiKeys = [{
    name: 'Comfy', baseUrl: 'http://comfy:8188', key: '', enabled: true, models: ['z-image-turbo'], modelsFetchedAt: '', concurrency: 1, kind: 'comfyui',
    comfyui: { profiles: [primary], pollTimeoutMs: 80, pollIntervalMs: 10, maxBatchSize: 1, maxConcurrent: 1, maxQueue: 2, queueTimeoutMs: 5000 },
  }];
  cfg.comfyuiTransform = { enabled: false, nodeIndex: 0, model: '', timeoutMs: 1000, maxTokens: 100, promptTemplate: '' };
  let promptCalls = 0;
  let queueCancels = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.endsWith('/prompt')) {
      promptCalls += 1;
      return new Response(JSON.stringify({ prompt_id: 'timeout-prompt' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (value.includes('/history/timeout-prompt')) return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    if (value.endsWith('/queue')) {
      queueCancels += 1;
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error('unexpected fetch ' + value);
  };
  try {
    await assert.rejects(
      () => generateComfyUiImages({ getConfig: () => cfg, client: { async chat() { return { text: 'unused' }; } } }, { nodeIndex: 0, profileId: 'z-image-turbo', prompt: 'timeout', count: 1 }),
      /轮询超时|poll_timeout/,
    );
    assert.equal(promptCalls, 1);
    assert.equal(queueCancels, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test('comfyui migration: customized 10-node workflow is preserved, non-customized migration keeps backup', () => {
  const base = createDefaultConfig();
  const builtin = BUILTIN_COMFYUI_PROFILES.find((item) => item.id === 'moss-image-sft');
  const workflow = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [String(index + 1), { class_type: 'CLIPTextEncode', inputs: { text: 'x' } }]));
  const makeCfg = (customized) => {
    const cfg = JSON.parse(JSON.stringify(base));
    cfg.llm.apiKeys = [{
      name: 'Comfy', baseUrl: 'http://comfy:8188', key: '', enabled: true, models: ['moss-image-sft'], modelsFetchedAt: '', concurrency: 1, kind: 'comfyui',
      comfyui: { profiles: [{ ...JSON.parse(JSON.stringify(builtin)), workflow, promptNodeIds: ['1'], negativePromptNodeIds: [], outputNodeId: '10', customized }], pollTimeoutMs: 1000, pollIntervalMs: 10, maxBatchSize: 1, maxConcurrent: 1, maxQueue: 1, queueTimeoutMs: 1000 },
    }];
    return normalizeConfig(cfg).llm.apiKeys[0].comfyui.profiles[0];
  };
  const preserved = makeCfg(true);
  assert.equal(Object.keys(preserved.workflow).length, 10);
  assert.equal(preserved.customized, true);
  const migrated = makeCfg(false);
  assert.equal(Object.keys(migrated.workflow).length, 16);
  assert.equal(migrated.customized, false);
  assert.equal(Object.keys(migrated.legacyWorkflow || {}).length, 10);
});

test('comfyui workflow API: fallback fields sent by panel are persisted', async () => {
  const cfg = createDefaultConfig();
  const builtin = BUILTIN_COMFYUI_PROFILES.find((item) => item.id === 'z-image-turbo');
  cfg.llm.apiKeys = [{
    name: 'Comfy', baseUrl: 'http://comfy:8188', key: '', enabled: true, models: ['z-image-turbo'], modelsFetchedAt: '', concurrency: 1, kind: 'comfyui',
    comfyui: { profiles: [{ ...JSON.parse(JSON.stringify(builtin)), fallbackEnabled: true, fallbackProfileId: 'z-image-turbo' }], pollTimeoutMs: 1000, pollIntervalMs: 10, maxBatchSize: 1, maxConcurrent: 1, maxQueue: 1, queueTimeoutMs: 1000 },
  }];
  const repository = new ConfigRepository({ initialConfig: cfg });
  const api = new WebApi({ repository });
  const auth = { authorization: `Bearer ${derivePanelToken(cfg.panel.passwordSeed)}` };
  const response = await api.handle({
    method: 'PUT', path: '/api/orchestration/comfyui/workflows/0/z-image-turbo', headers: auth,
    body: { fallbackEnabled: false, fallbackProfileId: 'z-image-turbo', skipFaceDetailer: true, customized: false },
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.profile.fallbackEnabled, false);
  assert.equal(response.body.profile.fallbackProfileId, 'z-image-turbo');
  assert.equal(response.body.profile.skipFaceDetailer, true);
});
test('comfyui profile: skipFaceDetailer rewires UltimateSDUpscale directly to VAEDecode', () => {
  for (const profile of BUILTIN_COMFYUI_PROFILES) {
    const detailer = Object.entries(profile.workflow || {}).find(([, node]) => node?.class_type === 'FaceDetailer');
    assert.ok(detailer, profile.id);
    const [detailerId, detailerNode] = detailer;
    const upstreamImage = detailerNode.inputs.image;
    const upscale = Object.entries(profile.workflow || {}).find(([, node]) => node?.class_type === 'UltimateSDUpscale');
    assert.ok(upscale, profile.id);
    const [upscaleId, upscaleNode] = upscale;
    const skipped = buildComfyUiWorkflow({ ...profile, skipFaceDetailer: true }, { prompt: 'skip face detailer' });
    assert.equal(Object.values(skipped.workflow).some((node) => node?.class_type === 'FaceDetailer'), false);
    assert.deepEqual(skipped.workflow[upscaleId].inputs.image, upstreamImage);
    assert.equal(skipped.applied.detailerSeed, undefined);
    assert.ok(skipped.seeds.seed > 0);
    assert.ok(skipped.seeds.upscaleSeed > 0);
    const normal = buildComfyUiWorkflow({ ...profile, skipFaceDetailer: false }, { prompt: 'normal' });
    assert.equal(normal.workflow[detailerId].class_type, 'FaceDetailer');
    assert.deepEqual(upscaleNode.inputs.image, [detailerId, 0]);
  }
});