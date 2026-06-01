import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FreeModeEngine,
  buildRawPromptWithOverrides,
  extractFreeModeDirectives,
  parsePlannerResult,
  renderPlannerPrompt,
} from '../dist/packages/free-mode/src/index.js';

class FakePlanner {
  text;
  calls = [];
  constructor(text) { this.text = text; }
  async createText(request) { this.calls.push(request); return { text: this.text, raw: { ok: true } }; }
}

class FakeImageModule {
  calls = [];
  async generate(input) {
    this.calls.push({ method: 'generate', input });
    const countMatch = input.rawPrompt.match(/\b(\d+)!/);
    const count = countMatch ? Number(countMatch[1]) : 1;
    const images = Array.from({ length: count }, (_item, idx) => `base64://gen-${idx + 1}-${input.rawPrompt}`);
    return { prompt: input.rawPrompt, params: { rawInput: input.rawPrompt, prompt: input.rawPrompt, size: '1024x1024', count, tokens: [], warnings: [] }, images, artifacts: [] };
  }
  async edit(input) {
    this.calls.push({ method: 'edit', input });
    return { prompt: input.rawPrompt, params: { rawInput: input.rawPrompt, prompt: input.rawPrompt, size: '1024x1024', count: 1, tokens: [], warnings: [] }, images: [`base64://edit-${input.images[0]}-${input.rawPrompt}`], artifacts: [] };
  }
}

class FakeReply {
  calls = [];
  async replyText(context, text) { this.calls.push({ method: 'replyText', context, text }); return { success: true, kind: 'text', strategy: 'forward', attempts: [] }; }
  async replyImages(context, images) { this.calls.push({ method: 'replyImages', context, images }); return { success: true, kind: 'multiImage', strategy: 'forward', attempts: [], sentImages: images }; }
}

const context = { chatType: 'group', groupId: 1000, senderId: 2000, botName: 'Bot' };

test('free mode: parses planner JSON inside markdown fences', () => {
  const result = parsePlannerResult('```json\n{"action":"text","text":"你好"}\n```');
  assert.deepEqual(result, { action: 'text', text: '你好' });
});

test('free mode: parses image planner with images array', () => {
  const result = parsePlannerResult('{"action":"image","mode":"generate","images":[{"prompt":"cat","size":"1024x1024"},{"prompt":"dog","count":1}]}');
  assert.equal(result.action, 'image');
  assert.equal(result.mode, 'generate');
  assert.deepEqual(result.images.map((item) => item.prompt), ['cat', 'dog']);
});

test('free mode: extracts bang directives from user content', () => {
  const directives = extractFreeModeDirectives('mb_1! 16:9! 3! high! 画三只猫');
  assert.equal(directives.templateId, 'mb_1');
  assert.equal(directives.size, '1536x1024');
  assert.equal(directives.count, 3);
  assert.equal(directives.quality, 'high');
  assert.equal(directives.rawPrompt, '画三只猫');
});

test('free mode: buildRawPromptWithOverrides lets user bang params override planner params', () => {
  const raw = buildRawPromptWithOverrides(
    { prompt: 'planner cat', size: '1024x1024', count: 1, quality: 'low' },
    { rawPrompt: 'user cat', tokens: ['16:9!', '3!', 'high!'], size: '1536x1024', count: 3, quality: 'high' },
  );
  assert.equal(raw, '1536x1024! 3! high! planner cat');
});

test('free mode: text planner sends text reply', async () => {
  const planner = new FakePlanner('{"action":"text","text":"这是一段回复"}');
  const image = new FakeImageModule();
  const reply = new FakeReply();
  const engine = new FreeModeEngine({ planner, image, reply, model: 'gpt-4o-mini', timeoutMs: 12345 });
  const result = await engine.handle({ userContent: '你好', context });
  assert.equal(result.action, 'text');
  assert.equal(result.text, '这是一段回复');
  assert.equal(planner.calls[0].model, 'gpt-4o-mini');
  assert.equal(planner.calls[0].timeoutMs, 12345);
  assert.equal(reply.calls[0].method, 'replyText');
  assert.equal(reply.calls[0].text, '这是一段回复');
});

test('free mode: image generate planner calls ImageModule.generate and replies with images', async () => {
  const planner = new FakePlanner('{"action":"image","mode":"generate","prompt":"画一只猫","size":"1024x1024","count":2,"quality":"medium"}');
  const image = new FakeImageModule();
  const reply = new FakeReply();
  const engine = new FreeModeEngine({ planner, image, reply, model: 'gpt-4o-mini', maxOutputImages: 4 });
  const result = await engine.handle({ userContent: '帮我画图', context });
  assert.equal(result.action, 'image');
  assert.equal(result.mode, 'generate');
  assert.equal(image.calls[0].method, 'generate');
  assert.equal(image.calls[0].input.rawPrompt, '1024x1024! 2! medium! 画一只猫');
  assert.equal(result.images.length, 2);
  assert.equal(reply.calls[0].method, 'replyImages');
  assert.deepEqual(reply.calls[0].images, result.images);
});

test('free mode: mixed image input planner edit calls ImageModule.edit with input images', async () => {
  const planner = new FakePlanner('{"action":"image","mode":"edit","prompt":"把图片改成赛博朋克","size":"1024x1024"}');
  const image = new FakeImageModule();
  const reply = new FakeReply();
  const engine = new FreeModeEngine({ planner, image, reply, model: 'gpt-4o-mini' });
  const result = await engine.handle({ userContent: '改一下这张图', images: ['base64://input-a'], context });
  assert.equal(result.mode, 'edit');
  assert.equal(image.calls[0].method, 'edit');
  assert.deepEqual(image.calls[0].input.images, ['base64://input-a']);
  assert.equal(image.calls[0].input.rawPrompt, '1024x1024! 把图片改成赛博朋克');
  assert.equal(reply.calls[0].images[0], 'base64://edit-base64://input-a-1024x1024! 把图片改成赛博朋克');
});

test('free mode: user bang params override planner image size/count/quality', async () => {
  const planner = new FakePlanner('{"action":"image","mode":"generate","prompt":"planner cat","size":"1024x1024","count":1,"quality":"low"}');
  const image = new FakeImageModule();
  const engine = new FreeModeEngine({ planner, image, model: 'gpt-4o-mini' });
  const result = await engine.handle({ userContent: '16:9! 3! high! 画三只猫' });
  assert.equal(image.calls[0].input.rawPrompt, '1536x1024! 3! high! planner cat');
  assert.equal(result.images.length, 3);
});

test('free mode: multi-image planner executes several image plan items and caps output', async () => {
  const planner = new FakePlanner('{"action":"image","mode":"generate","images":[{"prompt":"cat","count":1},{"prompt":"dog","count":1},{"prompt":"bird","count":1}]}');
  const image = new FakeImageModule();
  const reply = new FakeReply();
  const engine = new FreeModeEngine({ planner, image, reply, model: 'gpt-4o-mini', maxOutputImages: 2 });
  const result = await engine.handle({ userContent: '生成三张不同图片', context });
  assert.deepEqual(image.calls.map((call) => call.input.rawPrompt), ['1! cat', '1! dog']);
  assert.equal(result.images.length, 2);
  assert.deepEqual(reply.calls[0].images, result.images);
});

test('free mode: renderPlannerPrompt includes user content and edit preference', () => {
  const prompt = renderPlannerPrompt('Plan for {{userContent}}', '用户内容', true);
  assert.match(prompt, /Plan for 用户内容/);
  assert.match(prompt, /prefer mode=edit/);
});
