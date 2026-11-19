// 请求整形（2026-11-19）：
//   有契约 → snap 到合法值并记 requested → sent；
//   无契约 → 保守模式只发 prompt（+ n），不再把 1152x1536 裸发给未知网关。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  contractFromOpenApi,
  contractFromProfile,
  createContract,
  explainImageRequest,
  nearestSizeEnum,
  shapeGenerationRequest,
  shapeEditRequest,
  shapeImageParams,
} from '../dist/packages/model/src/index.js';

const NODE = { name: 'n', dialect: 'openai', baseUrl: 'https://gw.test/v1', apiKey: 'k' };

function contractWithSize(params) {
  return createContract({ key: 'k', model: 'm', op: 'image.generate', source: 'schema', params });
}

test('无契约 → 保守模式：size/quality 一律不下发', () => {
  const shaped = shapeImageParams({ model: 'MysteryImage_v9', prompt: 'cat', size: '1152x1536', quality: 'high' }, undefined);
  assert.equal(shaped.conservative, true);
  assert.equal(shaped.size, undefined, '无契约时不能裸发 size');
  assert.equal(shaped.quality, undefined);
  assert.deepEqual(shaped.dropped.sort(), ['quality', 'size']);
});

test('无契约 → 真实请求体里不含 size/quality（端到端断言）', () => {
  const { request } = shapeGenerationRequest({ model: 'MysteryImage_v9', prompt: 'cat', size: '1152x1536', quality: 'high', count: 2 }, undefined, { supportsCount: true, maxImagesPerRequest: 4 });
  assert.equal(request.size, undefined);
  assert.equal(request.quality, undefined);
  assert.equal(request.count, 2, '张数不属于格式选项，保守模式仍可下发');
  assert.equal(request.prompt, 'cat');
});

test('有契约（enum 4 档）→ 1152x1536 snap 到 1024x1536', () => {
  const contract = contractWithSize({
    size: { kind: 'size', enum: ['1024x1024', '1536x1024', '1024x1536', 'auto'] },
  });
  const shaped = shapeImageParams({ model: 'm', prompt: 'cat', size: '1152x1536' }, contract);
  assert.equal(shaped.snapped, true);
  assert.match(String(shaped.snapReason), /契约只接受枚举|尺寸/);
  // 契约只有枚举、没有对象约束 → 走 aspect 最近的枚举
  assert.equal(shaped.size, '1024x1536', '实际 = ' + shaped.size + '，原因 = ' + shaped.snapReason);
});

test('有契约（对象约束）→ 3840x3840 缩到 2880x2880', () => {
  const contract = contractWithSize({
    image_size: {
      kind: 'size',
      size: { multipleOf: 16, maxEdge: 3840, aspectMax: 3, pixels: { min: 655360, max: 8294400 } },
    },
  });
  const shaped = shapeImageParams({ model: 'm', prompt: 'cat', size: '3840x3840' }, contract);
  assert.equal(shaped.size, '2880x2880');
  assert.equal(shaped.snapped, true);
});

test('有契约 + 合法尺寸 → 原样通过，snapped=false', () => {
  const contract = contractWithSize({
    size: { kind: 'size', enum: ['1024x1024', '1024x1536'], size: { multipleOf: 16, maxEdge: 3840, aspectMax: 3, pixels: { min: 1000, max: 8294400 } } },
  });
  const shaped = shapeImageParams({ model: 'm', prompt: 'cat', size: '1024x1536' }, contract);
  assert.equal(shaped.size, '1024x1536');
  assert.equal(shaped.snapped, false);
});

test('契约不允许的参数 → dropped，不下发', () => {
  const contract = contractWithSize({ size: { kind: 'size', enum: ['1024x1024'] } });
  const shaped = shapeImageParams({ model: 'm', prompt: 'cat', size: '1024x1024', quality: 'high', background: 'transparent' }, contract);
  assert.equal(shaped.quality, undefined, '契约没有 quality → 不发');
  assert.equal(shaped.background, undefined);
  assert.ok(shaped.dropped.includes('quality'));
});

test('契约有 enum 但值非法 → dropped（宁用上游默认也不发非法值）', () => {
  const contract = contractWithSize({ quality: { kind: 'enum', enum: ['low', 'high'] } });
  const shaped = shapeImageParams({ model: 'm', prompt: 'cat', quality: 'max' }, contract);
  assert.equal(shaped.quality, undefined);
  assert.ok(shaped.dropped.includes('quality'));
});

test('output_compression 只在 jpeg/webp 下下发（onlyFor）', () => {
  const contract = contractWithSize({
    output_format: { kind: 'enum', enum: ['png', 'jpeg', 'webp'] },
    output_compression: { kind: 'int', min: 0, max: 100, onlyFor: { param: 'output_format', values: ['jpeg', 'webp'] } },
  });
  const png = shapeImageParams({ model: 'm', prompt: 'c', outputFormat: 'png', outputCompression: 80 }, contract);
  assert.equal(png.outputCompression, undefined, 'png 下不该发 output_compression');
  const jpeg = shapeImageParams({ model: 'm', prompt: 'c', outputFormat: 'jpeg', outputCompression: 80 }, contract);
  assert.equal(jpeg.outputCompression, 80);
});

test('transforms 优先于重新推导（学到的映射直接用）', () => {
  const base = contractWithSize({ image_size: { kind: 'size', enum: ['portrait_4_3', 'landscape_16_9'] } });
  const contract = { ...base, transforms: { image_size: { '1152x1536': 'portrait_4_3' } } };
  const shaped = shapeImageParams({ model: 'm', prompt: 'c', size: '1152x1536' }, contract);
  assert.equal(shaped.size, 'portrait_4_3');
  assert.equal(shaped.snapped, true);
  assert.match(String(shaped.snapReason), /已学到的映射/);
});

test('nearestSizeEnum 按 aspect 找最近', () => {
  assert.equal(nearestSizeEnum('1152x1536', ['square_hd', 'portrait_4_3', 'landscape_16_9']), 'portrait_4_3');
  assert.equal(nearestSizeEnum('3840x2160', ['square_hd', 'portrait_4_3', 'landscape_16_9']), 'landscape_16_9');
  assert.equal(nearestSizeEnum('1024x1024', ['square_hd', 'portrait_4_3']), 'square_hd');
});

test('dry-run 与真实请求体完全一致（同一契约同一入参）', () => {
  const contract = contractFromOpenApi(
    JSON.parse(fs.readFileSync('tests/fixtures/fal-gpt-image-2.6.openapi.json', 'utf8')),
    { key: 'k', model: 'openai/gpt-image-2.6/sunburst/text-to-image', op: 'image.generate' },
  );
  const falNode = {
    name: 'fal', dialect: 'fal', baseUrl: 'https://fal.run', apiKey: 'k',
  };
  const request = { model: 'openai/gpt-image-2.6/sunburst/text-to-image', prompt: 'cat', size: '4k-square', count: 1 };
  const explained = explainImageRequest({ node: falNode, op: 'image.generate', request, contract });
  const { request: shapedReq } = shapeGenerationRequest(request, contract, {});
  assert.ok(explained.url.startsWith('https://fal.run/'), 'dry-run 应给出真实推理 URL');
  assert.equal(explained.body.image_size.width, shapedReq.size ? Number(shapedReq.size.split('x')[0]) : undefined);
  assert.equal(explained.body.image_size.height, shapedReq.size ? Number(shapedReq.size.split('x')[1]) : undefined);
});
test('弱契约回退：已知模型（gpt-image 4 档）→ snap；完全陌生的模型 → 保守', () => {
  const known = contractFromProfile('gpt-image-2.6-sunburst', { sizes: ['1024x1024', '1536x1024', '1024x1536', 'auto'], supportsSize: true, supportsQuality: true });
  assert.ok(known, '已知模型应合成弱契约');
  const shaped = shapeImageParams({ model: 'gpt-image-2.6-sunburst', prompt: 'c', size: '1152x1536' }, known);
  assert.equal(shaped.size, '1024x1536', '竖图必须 snap 到竖版枚举，不能给横版');
  assert.equal(shaped.conservative, false);

  const unknown = contractFromProfile('MysteryImage_v9', { sizes: [], supportsSize: true });
  assert.equal(unknown, undefined, '档案没有尺寸信息时不该合成契约');
  const conservative = shapeImageParams({ model: 'MysteryImage_v9', prompt: 'c', size: '1152x1536' }, unknown);
  assert.equal(conservative.conservative, true);
  assert.equal(conservative.size, undefined);
});
