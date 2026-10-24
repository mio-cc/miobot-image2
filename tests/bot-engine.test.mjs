import test from 'node:test';
import assert from 'node:assert/strict';

import { createBotEngine, resolveImageCapabilities } from '../dist/packages/bot-engine/src/index.js';
import { createCapabilityRegistry } from '../dist/packages/model/src/index.js';

function makeDeps() {
  const calls = [];
  return {
    calls,
    chat: async (r) => { calls.push(['chat', r]); return { text: 'CHAT:' + (r.text || r.model) }; },
    generateImages: async (r) => { calls.push(['generate', r]); return { images: ['img-gen'] }; },
    editImage: async (r) => { calls.push(['edit', r]); return { images: ['img-edit'] }; },
    interrogate: async (r) => { calls.push(['interrogate', r]); return { text: 'DESC' }; },
    generateVideo: async (r) => { calls.push(['video', r]); return { videos: ['https://vid.example/out.mp4'] }; },
  };
}

const baseCfg = {
  chatEnabled: true, chatModel: 'gpt-4o-mini',
  imageEnabled: true, imageModel: 'gpt-image-2', editModel: 'gpt-image-2', interrogateModel: 'gpt-4o',
  videoEnabled: true, videoModel: 'grok-imagine-video',
  freeModeModel: 'gpt-4o-mini', preferEditWhenImagePresent: true, maxOutputImages: 4,
};

class FakePlanner {
  constructor(text) { this.text = text; }
  async createText() { return { text: this.text }; }
}

test('engine: 生图意图 -> generateImages(imageModel)', async () => {
  const deps = makeDeps();
  const engine = createBotEngine({ deps, getConfig: () => baseCfg });
  const r = await engine.handleAuto({ text: '画一只赛博猫' });
  assert.equal(r.kind, 'image.generate');
  assert.deepEqual(r.images, ['img-gen']);
  assert.equal(deps.calls[0][0], 'generate');
  assert.equal(deps.calls[0][1].model, 'gpt-image-2');
});

test('engine: 改图意图 -> editImage(editModel)', async () => {
  const deps = makeDeps();
  const engine = createBotEngine({ deps, getConfig: () => baseCfg });
  const r = await engine.handleAuto({ text: '把背景换成海边', images: ['data:image/png;base64,AA'] });
  assert.equal(r.kind, 'image.edit');
  assert.equal(deps.calls[0][0], 'edit');
});

test('engine: 反推意图 -> interrogate(interrogateModel)', async () => {
  const deps = makeDeps();
  const engine = createBotEngine({ deps, getConfig: () => baseCfg });
  const r = await engine.handleAuto({ text: '反推这张图', images: ['http://x/a.png'] });
  assert.equal(r.kind, 'image.interrogate');
  assert.equal(r.text, 'DESC');
  assert.equal(deps.calls[0][1].model, 'gpt-4o');
});

test('engine: 歧义文本走规划器 -> chat(chatModel)', async () => {
  const deps = makeDeps();
  const engine = createBotEngine({ deps, getConfig: () => baseCfg, planner: new FakePlanner('{"action":"text","text":"在的"}') });
  const r = await engine.handleAuto({ text: '在吗' });
  assert.equal(r.kind, 'chat');
  assert.equal(deps.calls[0][1].model, 'gpt-4o-mini');
});

test('engine: chat 调用不再借用 plannerTimeoutMs，长回复不被规划超时腰斩', async () => {
  const deps = makeDeps();
  const tightPlannerCfg = { ...baseCfg, plannerTimeoutMs: 3000 };
  const engine = createBotEngine({ deps, getConfig: () => tightPlannerCfg, planner: new FakePlanner('{"action":"text","text":"在的"}') });
  await engine.handleAuto({ text: '在吗' });
  const chatCall = deps.calls.find((call) => call[0] === 'chat');
  assert.ok(chatCall);
  assert.equal(chatCall[1].timeoutMs, undefined);
});

test('engine: 能力门控 —— 生图模型其实是纯文本模型则降级为 chat，不调用 generateImages', async () => {
  const deps = makeDeps();
  const cfg = { ...baseCfg, imageModel: 'deepseek-chat', editModel: 'deepseek-chat' };
  const engine = createBotEngine({ deps, getConfig: () => cfg });
  const r = await engine.handleAuto({ text: '画一只猫' });
  assert.equal(r.decision.degradedFrom, 'image.generate');
  assert.equal(r.kind, 'chat');
  assert.equal(deps.calls.some((c) => c[0] === 'generate'), false);
});

test('resolveImageCapabilities: 正确反映模型档案', () => {
  const reg = createCapabilityRegistry();
  const caps = resolveImageCapabilities(baseCfg, reg);
  assert.equal(caps.imageGenerate, true);
  assert.equal(caps.imageEdit, true);
  assert.equal(caps.chat, true);
  const caps2 = resolveImageCapabilities({ ...baseCfg, imageModel: 'deepseek-chat' }, reg);
  assert.equal(caps2.imageGenerate, false);
});

test('engine: 图像开关关闭 -> 生图降级 chat', async () => {
  const deps = makeDeps();
  const engine = createBotEngine({ deps, getConfig: () => ({ ...baseCfg, imageEnabled: false }) });
  const r = await engine.handleAuto({ text: '画一只猫' });
  assert.equal(r.kind, 'chat');
});

test('engine: 视频意图 -> generateVideo(videoModel)', async () => {
  const deps = makeDeps();
  const engine = createBotEngine({ deps, getConfig: () => baseCfg });
  const r = await engine.handleAuto({ text: '生成视频 火箭从火星发射' });
  assert.equal(r.kind, 'video.generate');
  assert.deepEqual(r.videos, ['https://vid.example/out.mp4']);
  assert.equal(deps.calls[0][0], 'video');
  assert.equal(deps.calls[0][1].model, 'grok-imagine-video');
  assert.match(deps.calls[0][1].prompt, /火箭/);
});

test('engine: 图生视频带 imageUrl', async () => {
  const deps = makeDeps();
  const engine = createBotEngine({ deps, getConfig: () => baseCfg });
  const r = await engine.handleAuto({ text: '做个视频 让它动起来', images: ['https://img.example/still.png'] });
  assert.equal(r.kind, 'video.generate');
  assert.equal(deps.calls[0][1].imageUrl, 'https://img.example/still.png');
});

test('engine: 视频能力不可用则降级 chat', async () => {
  const deps = makeDeps();
  const cfg = { ...baseCfg, videoModel: 'gpt-4o-mini' }; // 无 video.generate
  const engine = createBotEngine({ deps, getConfig: () => cfg });
  const r = await engine.handleAuto({ text: '生成视频 一只猫跑步' });
  assert.equal(r.decision.degradedFrom, 'video.generate');
  assert.equal(r.kind, 'chat');
  assert.equal(deps.calls.some((c) => c[0] === 'video'), false);
});

test('resolveImageCapabilities: videoGenerate 反映档案', () => {
  const reg = createCapabilityRegistry();
  const caps = resolveImageCapabilities(baseCfg, reg);
  assert.equal(caps.videoGenerate, true);
  const caps2 = resolveImageCapabilities({ ...baseCfg, videoEnabled: false }, reg);
  assert.equal(caps2.videoGenerate, false);
});
