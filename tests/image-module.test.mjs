import test from 'node:test';
import assert from 'node:assert/strict';

import { LlmProviderError } from '../dist/packages/llm/src/index.js';
import {
  ImageModule,
  applyPromptTemplate,
  applyTemplateById,
  artifactsToSendableImages,
  isUpstreamImageError,
  parseImageCommand,
  renderPromptTemplate,
  shouldRetrySingleReferenceEdit,
} from '../dist/packages/image/src/index.js';

class FakeLlm {
  calls = [];
  generateResponse = { images: [{ kind: 'base64', data: 'img-a', index: 0 }, { kind: 'base64', data: 'img-b', index: 1 }], raw: {}, status: 200 };
  editResponse = { images: [{ kind: 'url', data: 'https://example.test/edited.png', index: 0 }], raw: {}, status: 200 };
  visionResponse = { text: '反推提示词', raw: { ok: true }, status: 200 };
  editError = undefined;

  async generateImages(request) {
    this.calls.push({ method: 'generateImages', request });
    return this.generateResponse;
  }

  async editImage(request) {
    this.calls.push({ method: 'editImage', request });
    if (this.editError) throw this.editError;
    return this.editResponse;
  }

  async createVision(request) {
    this.calls.push({ method: 'createVision', request });
    return this.visionResponse;
  }
}

class FakeReply {
  calls = [];
  async replyImages(context, images) {
    this.calls.push({ method: 'replyImages', context, images });
    return { success: true, kind: 'multiImage', strategy: 'forward', attempts: [], sentImages: images };
  }
}

const templates = [
  { id: 'mb_1', title: '插画', prompt: '以高质量插画风格生成：{{prompt}}。' },
  { id: 'mb_2', title: '写实', prompt: 'cinematic realistic photo of {{rawPrompt}}' },
];

test('image params: parses template, ratio, count, quality and prompt tokens', () => {
  const params = parseImageCommand('mb_1! 9:16! 3! high! 一只猫 在月光下', { defaultSize: '1024x1024', defaultCount: 1 });
  assert.equal(params.templateId, 'mb_1');
  assert.equal(params.ratio, '9:16');
  assert.equal(params.size, '1024x1536');
  assert.equal(params.count, 3);
  assert.equal(params.quality, 'high');
  assert.equal(params.prompt, '一只猫 在月光下');
  assert.deepEqual(params.tokens, ['mb_1!', '9:16!', '3!', 'high!']);
});

test('image params: parses explicit size and clamps count', () => {
  const params = parseImageCommand('2048x1024! n=9! low! landscape', { maxCount: 4 });
  assert.equal(params.size, '2048x1024');
  assert.equal(params.count, 4);
  assert.equal(params.quality, 'low');
  assert.equal(params.prompt, 'landscape');
});

test('image params: parses v1 scale directives with aspect ratio', () => {
  const wide = parseImageCommand('2k! 16:9! 星空城市');
  assert.equal(wide.scale, '2k');
  assert.equal(wide.ratio, '16:9');
  assert.equal(wide.size, '2048x1152');
  assert.equal(wide.prompt, '星空城市');

  const square = parseImageCommand('4k! 头像');
  assert.equal(square.size, '4096x4096');
});

test('image params: unknown bang token is kept in prompt with warning', () => {
  const params = parseImageCommand('weird! subject');
  assert.equal(params.prompt, 'weird! subject');
  assert.equal(params.warnings.length, 1);
});

test('template: renders prompt placeholders and blanks unknown placeholders', () => {
  assert.equal(renderPromptTemplate('hello {{ prompt }} {{missing}}', { prompt: 'cat' }), 'hello cat');
  assert.equal(applyPromptTemplate('cat', 'draw {{prompt}} / {{rawPrompt}}'), 'draw cat / cat');
});

test('template: applies template by id case-insensitively', () => {
  assert.equal(applyTemplateById('山中的狐狸', 'MB_1', templates), '以高质量插画风格生成：山中的狐狸。');
  assert.equal(applyTemplateById('山中的狐狸', 'missing', templates), '山中的狐狸');
});

test('image module: generate applies params/template, calls llm, converts images, and replies', async () => {
  const llm = new FakeLlm();
  const reply = new FakeReply();
  const module = new ImageModule({
    llm,
    reply,
    imageModel: 'gpt-image-2',
    defaultSize: '1024x1024',
    defaultCount: 1,
    imageTimeoutMs: 111000,
    promptTemplates: templates,
  });
  const context = { chatType: 'group', groupId: 1000, senderId: 2000 };
  const result = await module.generate({ rawPrompt: 'mb_1! 16:9! 2! medium! 日落海边', context });
  assert.equal(llm.calls[0].method, 'generateImages');
  assert.equal(llm.calls[0].request.model, 'gpt-image-2');
  assert.equal(llm.calls[0].request.prompt, '以高质量插画风格生成：日落海边。');
  assert.equal(llm.calls[0].request.size, '1536x1024');
  assert.equal(llm.calls[0].request.count, 2);
  assert.equal(llm.calls[0].request.quality, 'medium');
  assert.equal(llm.calls[0].request.timeoutMs, 111000);
  assert.deepEqual(result.images, ['base64://img-a', 'base64://img-b']);
  assert.deepEqual(reply.calls[0].images, ['base64://img-a', 'base64://img-b']);
});

test('image module: edit passes image inputs, mask, model, size, quality and timeout', async () => {
  const llm = new FakeLlm();
  const module = new ImageModule({ llm, imageModel: 'gpt-image-2', editModel: 'gpt-image-edit', editTimeoutMs: 222000, defaultQuality: 'auto' });
  const result = await module.edit({ rawPrompt: '1024x1024! high! 把天空改成蓝色', images: ['base64://input'], mask: 'base64://mask' });
  assert.equal(llm.calls[0].method, 'editImage');
  assert.equal(llm.calls[0].request.model, 'gpt-image-edit');
  assert.equal(llm.calls[0].request.prompt, '把天空改成蓝色');
  assert.deepEqual(llm.calls[0].request.images, ['base64://input']);
  assert.equal(llm.calls[0].request.mask, 'base64://mask');
  assert.equal(llm.calls[0].request.quality, 'high');
  assert.equal(llm.calls[0].request.timeoutMs, 222000);
  assert.deepEqual(result.images, ['https://example.test/edited.png']);
});

test('image module: edit upstream errors are recognizable', async () => {
  const llm = new FakeLlm();
  llm.editError = new LlmProviderError('data[0].error: INTERNAL_ERROR', { category: 'upstream', retryable: true, code: 'internal_server_error' });
  const module = new ImageModule({ llm, imageModel: 'gpt-image-2' });
  await assert.rejects(
    () => module.edit({ rawPrompt: '改图', images: ['base64://input'] }),
    (error) => error.operation === 'edit' && error.normalized.category === 'upstream' && isUpstreamImageError(error),
  );
});

test('image module: multi-reference edit retries once with the first image on transient stream failures', async () => {
  const llm = new FakeLlm();
  let attempt = 0;
  llm.editImage = async (request) => {
    llm.calls.push({ method: 'editImage', request });
    attempt += 1;
    if (attempt === 1) {
      assert.deepEqual(request.images, ['base64://first', 'base64://second']);
      throw new LlmProviderError('stream error: stream disconnected before completion', { category: 'network', retryable: true });
    }
    assert.deepEqual(request.images, ['base64://first']);
    return llm.editResponse;
  };
  const module = new ImageModule({ llm, imageModel: 'gpt-image-2' });
  const result = await module.edit({ rawPrompt: '美颜', images: ['base64://first', 'base64://second'] });
  assert.equal(llm.calls.length, 2);
  assert.deepEqual(result.images, ['https://example.test/edited.png']);
});

test('image module: single-reference fallback only applies to transient multi-image edit errors', () => {
  assert.equal(
    shouldRetrySingleReferenceEdit(
      new LlmProviderError('stream error: stream disconnected before completion', { category: 'network', retryable: true }),
      ['a', 'b'],
    ),
    true,
  );
  assert.equal(
    shouldRetrySingleReferenceEdit(
      new LlmProviderError('Image response missing data[]', { category: 'validation', retryable: false }),
      ['a', 'b'],
    ),
    false,
  );
  assert.equal(
    shouldRetrySingleReferenceEdit(
      new LlmProviderError('stream error: stream disconnected before completion', { category: 'network', retryable: true }),
      ['a'],
    ),
    false,
  );
});

test('image module: interrogate uses configurable timeout and prompt', async () => {
  const llm = new FakeLlm();
  const module = new ImageModule({
    llm,
    imageModel: 'gpt-image-2',
    interrogateModel: 'gpt-4o-mini',
    interrogateTimeoutMs: 123456,
    interrogatePromptTemplate: '请反推图片：{{prompt}}',
  });
  const result = await module.interrogate({ imageUrl: 'base64://img' });
  assert.equal(result.timeoutMs, 123456);
  assert.equal(result.text, '反推提示词');
  assert.equal(llm.calls[0].method, 'createVision');
  assert.equal(llm.calls[0].request.model, 'gpt-4o-mini');
  assert.equal(llm.calls[0].request.timeoutMs, 123456);
  assert.deepEqual(llm.calls[0].request.imageUrls, ['base64://img']);
});

test('image module: artifactsToSendableImages preserves order and kind conversion', () => {
  const images = artifactsToSendableImages([
    { kind: 'base64', data: 'a', index: 0 },
    { kind: 'url', data: 'https://example.test/b.png', index: 1 },
    { kind: 'base64', data: 'c', index: 2 },
  ]);
  assert.deepEqual(images, ['base64://a', 'https://example.test/b.png', 'base64://c']);
});
