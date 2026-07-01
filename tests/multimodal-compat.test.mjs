import test from 'node:test';
import assert from 'node:assert/strict';

import { inferProfileByName, CHAT_PROFILE, TEXT_ONLY_PROFILE } from '../dist/packages/model/src/capability/profiles.js';
import { createCapabilityRegistry } from '../dist/packages/model/src/capability/registry.js';
import { normalizeConfig, createDefaultConfig } from '../dist/packages/config/src/index.js';
import { normalizeImageUrl, extractImages } from '../dist/apps/bot/src/runtime.js';

// ── profiles: 多模态模型正则匹配 ──

test('profiles: deepseek-vl2 命中 CHAT_PROFILE(非 TEXT_ONLY)', () => {
  const p = inferProfileByName('deepseek-vl2');
  assert.ok(p, 'deepseek-vl2 应有 profile');
  assert.deepEqual(p.operations, CHAT_PROFILE.operations);
  assert.ok(p.operations.includes('vision'));
});

test('profiles: deepseek-vl 命中 CHAT_PROFILE', () => {
  const p = inferProfileByName('deepseek-vl');
  assert.ok(p && p.operations.includes('vision'));
});

test('profiles: minimax-vl-01 命中 CHAT_PROFILE', () => {
  const p = inferProfileByName('MiniMax-VL-01');
  assert.ok(p && p.operations.includes('vision'));
});

test('profiles: doubao-vision 命中 CHAT_PROFILE', () => {
  const p = inferProfileByName('doubao-vision-pro');
  assert.ok(p && p.operations.includes('vision'));
});

test('profiles: deepseek-chat 仍为 TEXT_ONLY(不受 vl 规则影响)', () => {
  const p = inferProfileByName('deepseek-chat');
  assert.ok(p, 'deepseek-chat 应有 profile');
  assert.deepEqual(p.operations, TEXT_ONLY_PROFILE.operations);
  assert.ok(!p.operations.includes('vision'));
});

test('profiles: gpt-4o 仍命中 vision', () => {
  const p = inferProfileByName('gpt-4o');
  assert.ok(p && p.operations.includes('vision'));
});

test('profiles: claude-3-5-sonnet 仍命中 vision', () => {
  const p = inferProfileByName('claude-3-5-sonnet-20241022');
  assert.ok(p && p.operations.includes('vision'));
});

// ── registry: 兜底为 TEXT_ONLY + overrides 生效 ──

test('registry: 未识别模型兜底为 TEXT_ONLY(不含 vision)', () => {
  const reg = createCapabilityRegistry();
  // TEXT_ONLY_PROFILE = { operations: ['chat'] }: 能 chat 但不能 vision
  assert.ok(!reg.can('some-unknown-model-xyz', 'vision'));
  assert.ok(reg.can('some-unknown-model-xyz', 'chat'));
  assert.ok(!reg.can('some-unknown-model-xyz', 'interrogate'));
});

test('registry: overrides 可给模型补 vision 能力', () => {
  const reg = createCapabilityRegistry({
    overrides: [{ model: 'my-custom-vlm', operations: ['chat', 'vision', 'interrogate'] }],
  });
  assert.ok(reg.can('my-custom-vlm', 'vision'));
  assert.ok(reg.can('my-custom-vlm', 'chat'));
  assert.ok(reg.can('my-custom-vlm', 'interrogate'));
  assert.ok(!reg.can('my-custom-vlm', 'image.generate'));
});

test('registry: overrides 用正则匹配', () => {
  const reg = createCapabilityRegistry({
    overrides: [{ model: '/^grok-\\d+$/', operations: ['chat', 'vision'] }],
  });
  assert.ok(reg.can('grok-2', 'vision'));
  assert.ok(!reg.can('grok-image', 'vision')); // grok-image 是生图,不应被这条 override 命中
});

// ── config: capabilityOverrides 归一化 ──

test('config: 默认 capabilityOverrides 为空数组', () => {
  const cfg = normalizeConfig({});
  assert.deepEqual(cfg.llm.capabilityOverrides, []);
});

test('config: capabilityOverrides 归一化保留合法 operations', () => {
  const cfg = normalizeConfig({
    llm: {
      capabilityOverrides: [
        { model: 'my-vlm', operations: ['chat', 'vision', 'bogus-op'] },
        { model: '/^test-/', operations: ['interrogate'] },
        { model: '', operations: ['chat'] }, // model 为空,过滤掉
      ],
    },
  });
  assert.equal(cfg.llm.capabilityOverrides.length, 2);
  assert.deepEqual(cfg.llm.capabilityOverrides[0].operations, ['chat', 'vision']);
  assert.deepEqual(cfg.llm.capabilityOverrides[1].operations, ['interrogate']);
});

test('config: capabilityOverrides 非数组时归一化为空', () => {
  const cfg = normalizeConfig({ llm: { capabilityOverrides: 'not-an-array' } });
  assert.deepEqual(cfg.llm.capabilityOverrides, []);
});

// ── runtime: normalizeImageUrl base64 归一化 ──

test('normalizeImageUrl: base64:// → data:image/png;base64,', () => {
  assert.equal(
    normalizeImageUrl('base64://iVBORw0KGgoAAAANSUh=='),
    'data:image/png;base64,iVBORw0KGgoAAAANSUh==',
  );
});

test('normalizeImageUrl: base64:(无//) → data:image/png;base64,', () => {
  assert.equal(
    normalizeImageUrl('base64:iVBORw0KGgo=='),
    'data:image/png;base64,iVBORw0KGgo==',
  );
});

test('normalizeImageUrl: http URL 原样保留', () => {
  assert.equal(
    normalizeImageUrl('https://example.com/img.png'),
    'https://example.com/img.png',
  );
});

test('normalizeImageUrl: data: URL 原样保留', () => {
  assert.equal(
    normalizeImageUrl('data:image/jpeg;base64,abc123=='),
    'data:image/jpeg;base64,abc123==',
  );
});

test('extractImages: base64:// 段被归一化为 data: URL', () => {
  const event = {
    message: [{ type: 'image', data: { url: 'base64://iVBORw0KGgo==' } }],
  };
  const imgs = extractImages(event);
  assert.equal(imgs.length, 1);
  assert.ok(imgs[0].startsWith('data:image/png;base64,'));
});
