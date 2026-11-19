// 生图链路的三处契约（线上时测 2026-11-19）：
//   1) fal.ai 节点曾被当成 OpenAI 兼容网关 → 请求打到 /images/generations，1.5 秒被拒；
//   2) 润色模板要求模型输出 {prompt, negative_prompt} JSON，但整段 JSON 被当成 prompt；
//   3) LLM 生图与 ComfyUI 各用哪段提示词，面板/工具里看不到。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createModelClient,
  createCapabilityRegistry,
  falDialect,
} from '../dist/packages/model/src/index.js';
import { createImagePromptPipeline } from '../dist/apps/bot/src/image-pipeline.js';
import { collectPromptStages } from '../dist/apps/bot/src/capability-basic.js';
import { createDefaultConfig } from '../dist/packages/config/src/index.js';

const FAL_NODE = {
  name: 'fal',
  dialect: 'fal',
  baseUrl: 'https://fal.ai/api',
  apiKey: 'fal-key',
  models: ['openai/gpt-image-2.6/sunburst/text-to-image'],
};

test('fal 方言：URL 是「baseUrl + 模型 id」，鉴权是 Key 前缀', async () => {
  const requests = [];
  const client = createModelClient({
    nodes: () => [FAL_NODE],
    registry: () => createCapabilityRegistry(),
    retries: 0,
    failover: false,
    transport: async (request) => {
      requests.push(request);
      return { status: 200, data: { images: [{ url: 'https://cdn.fal.test/a.png', content_type: 'image/png' }] } };
    },
  });
  const result = await client.generateImages(0, {
    model: 'openai/gpt-image-2.6/sunburst/text-to-image',
    prompt: 'a cat',
    count: 1,
    timeoutMs: 5000,
  });
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    'https://fal.run/openai/gpt-image-2.6/sunburst/text-to-image',
    '目录主机 fal.ai 必须换成推理主机 fal.run（实测 2026-11-19），且模型 id 就是路径',
  );
  assert.equal(requests[0].headers.Authorization, 'Key fal-key', 'fal 用 Key 前缀，不是 Bearer');
  assert.equal(requests[0].body.prompt, 'a cat');
  assert.equal(requests[0].body.model, undefined, 'fal 不接受 body 里的 model 字段');
  assert.equal(result.images.length, 1);
  assert.equal(result.images[0].data, 'https://cdn.fal.test/a.png');
  assert.equal(result.images[0].mimeType, 'image/png');
});

test('fal 方言：视频出参 { video: { url } } 能解析，参考图走 reference_image_urls', async () => {
  let seenBody;
  const client = createModelClient({
    nodes: () => [{ ...FAL_NODE, models: ['minimax/h3-max/reference-to-video'] }],
    registry: () => createCapabilityRegistry(),
    retries: 0,
    failover: false,
    transport: async (request) => {
      seenBody = request.body;
      assert.equal(request.url, 'https://fal.run/minimax/h3-max/reference-to-video');
      return { status: 200, data: { video: { url: 'https://cdn.fal.test/v.mp4' } } };
    },
  });
  const result = await client.generateVideo(0, {
    model: 'minimax/h3-max/reference-to-video',
    prompt: 'a cat walking',
    imageUrl: 'https://img.test/a.png',
    waitForCompletion: true,
    timeoutMs: 5000,
  });
  assert.equal(result.pending, false);
  assert.equal(result.videos[0].data, 'https://cdn.fal.test/v.mp4');
  assert.deepEqual(seenBody.reference_image_urls, ['https://img.test/a.png'], 'reference-to-video 必须用 reference_image_urls');
  assert.equal(seenBody.image_urls, undefined);
});

test('fal 方言：改图必须发 image_urls 数组（实测单发 image_url 会 422）', async () => {
  let seenBody;
  const client = createModelClient({
    nodes: () => [{ ...FAL_NODE, models: ['openai/gpt-image-2/edit'] }],
    registry: () => createCapabilityRegistry(),
    retries: 0,
    failover: false,
    transport: async (request) => {
      seenBody = request.body;
      return { status: 200, data: { images: [{ url: 'https://cdn.fal.test/e.png' }] } };
    },
  });
  await client.editImage(0, {
    model: 'openai/gpt-image-2/edit',
    prompt: 'make it blue',
    images: ['https://img.test/a.png'],
    timeoutMs: 5000,
  });
  assert.deepEqual(seenBody.image_urls, ['https://img.test/a.png']);
  assert.equal(seenBody.image_url, undefined);
});

test('fal 方言：显式 inferenceBaseUrl 优先于主机推断', async () => {
  let seenUrl;
  const client = createModelClient({
    nodes: () => [{ ...FAL_NODE, inferenceBaseUrl: 'https://my-fal-proxy.test', models: ['fal-ai/flux/schnell'] }],
    registry: () => createCapabilityRegistry(),
    retries: 0,
    failover: false,
    transport: async (request) => {
      seenUrl = request.url;
      return { status: 200, data: { images: [{ url: 'https://cdn.test/a.png' }] } };
    },
  });
  await client.generateImages(0, { model: 'fal-ai/flux/schnell', prompt: 'x', count: 1, timeoutMs: 5000 });
  assert.equal(seenUrl, 'https://my-fal-proxy.test/fal-ai/flux/schnell');
});

test('fal 方言：上游 error 字段转成可读错误', async () => {
  const client = createModelClient({
    nodes: () => [FAL_NODE],
    registry: () => createCapabilityRegistry(),
    retries: 0,
    failover: false,
    transport: async () => ({ status: 200, data: { error: { message: 'invalid key' } } }),
  });
  await assert.rejects(
    () => client.generateImages(0, { model: FAL_NODE.models[0], prompt: 'x', count: 1, timeoutMs: 5000 }),
    (error) => /invalid key/.test(String(error.message)),
  );
});

test('提示词阶段：润色模型回结构化 JSON 时只取 prompt 字段', async () => {
  const cfg = createDefaultConfig();
  cfg.llm.enhanceEnabled = true;
  cfg.llm.enhanceModel = 'enhancer';
  cfg.llm.enhanceNodeIndex = 0;
  const client = {
    async chat() {
      return {
        text: JSON.stringify({ prompt: 'a red apple on a wooden table, studio light', negative_prompt: 'blurry' }),
        raw: {},
      };
    },
  };
  const pipeline = createImagePromptPipeline(client, () => cfg);
  const prompt = await pipeline.prepare({ prompt: '一个红苹果' });
  assert.match(prompt, /a red apple on a wooden table/, '必须取出 JSON 的 prompt 字段');
  assert.equal(prompt.includes('{"prompt"'), false, '整段 JSON 不能再被当成提示词');
});

test('提示词阶段：LLM 生图专用模板会局部渲染（无模型调用）', async () => {
  const cfg = createDefaultConfig();
  cfg.llm.enhanceEnabled = false;
  cfg.llm.imagePromptTemplate = '画面主体：{{prompt}}。构图克制，柔和光影。';
  let modelCalls = 0;
  const pipeline = createImagePromptPipeline({ async chat() { modelCalls += 1; return { text: '', raw: {} }; } }, () => cfg);
  const prompt = await pipeline.prepare({ prompt: '一个红苹果' });
  assert.equal(prompt, '画面主体：一个红苹果。构图克制，柔和光影。');
  assert.equal(modelCalls, 0, '局部模板不应产生模型调用');
});

test('提示词注册表：LLM 生图与 ComfyUI 分别列出，互不混淆', () => {
  const cfg = createDefaultConfig();
  cfg.llm.imagePromptTemplate = 'LLM 专用 {{prompt}}';
  cfg.comfyuiTransform.promptTemplate = 'ComfyUI 专用 {{userRequest}}';
  const stages = collectPromptStages(cfg);
  const llmStage = stages.find((entry) => entry.configPath === 'llm.imagePromptTemplate');
  const comfyStage = stages.find((entry) => entry.configPath === 'comfyuiTransform.promptTemplate');
  assert.ok(llmStage, 'LLM 生图提示词必须出现在注册表里');
  assert.ok(comfyStage, 'ComfyUI 提示词必须出现在注册表里');
  assert.match(llmStage.scope, /LLM 生图/);
  assert.match(comfyStage.scope, /ComfyUI/);
  assert.equal(llmStage.enabled, true);
  assert.equal(comfyStage.enabled, true);
});

test('fal 方言在协议层声明支持图片/视频，不声明未实现的能力', () => {
  assert.equal(falDialect.supports('image.generate'), true);
  assert.equal(falDialect.supports('image.edit'), true);
  assert.equal(falDialect.supports('video.generate'), true);
});