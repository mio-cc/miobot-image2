// 尺寸契约（2026-11-19）：约束来自 fal gpt-image-2.6 文档原文
//   multiples of 16 / max edge 3840 / aspect <= 3:1 / pixels 655,360 ~ 8,294,400
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_IMAGE_SIZE_LIMITS,
  IMAGE_QUALITY_ENUM,
  IMAGE_SIZE_PRESETS,
  parseRequestedSize,
  retiredImageModelNotice,
  solveImageSize,
} from '../dist/packages/model/src/index.js';

const LIMITS = DEFAULT_IMAGE_SIZE_LIMITS;

function assertLegal(w, h, label) {
  assert.equal(w % LIMITS.multipleOf, 0, label + ' 宽度必须是 ' + LIMITS.multipleOf + ' 的倍数，实际 ' + w);
  assert.equal(h % LIMITS.multipleOf, 0, label + ' 高度必须是 ' + LIMITS.multipleOf + ' 的倍数，实际 ' + h);
  assert.equal(w <= LIMITS.maxEdge, true, label + ' 宽度超上限：' + w);
  assert.equal(h <= LIMITS.maxEdge, true, label + ' 高度超上限：' + h);
  assert.equal(Math.max(w, h) / Math.min(w, h) <= LIMITS.aspectMax, true, label + ' 宽高比超限');
  const pixels = w * h;
  assert.equal(pixels >= LIMITS.minPixels, true, label + ' 像素过少：' + pixels);
  assert.equal(pixels <= LIMITS.maxPixels, true, label + ' 像素过多：' + pixels);
}

test('历史 6 个预设的名称与像素值一个都不能变', () => {
  const legacy = {
    square: [1024, 1024],
    portrait: [1024, 1536],
    'portrait-3-4': [1152, 1536],
    portrait34: [1152, 1536],
    landscape: [1536, 1024],
    'landscape-4-5': [1280, 1024],
    landscape45: [1280, 1024],
  };
  for (const [name, [w, h]] of Object.entries(legacy)) {
    assert.deepEqual(IMAGE_SIZE_PRESETS[name], { width: w, height: h }, name + ' 被改动了');
  }
});

test('新增 2K/4K 预设全部合法', () => {
  for (const name of ['2k-16-9', '2k-9-16', '2k-square', '4k-16-9', '4k-9-16', '4k-square']) {
    const preset = IMAGE_SIZE_PRESETS[name];
    assert.ok(preset, name + ' 缺失');
    assertLegal(preset.width, preset.height, name);
    const solved = solveImageSize(name, LIMITS);
    assert.equal(solved.snapped, false, name + ' 本身合法，不该被调整：' + solved.reason);
  }
});

test('4k-16-9 正好顶到像素上限（不容许再大一点）', () => {
  const preset = IMAGE_SIZE_PRESETS['4k-16-9'];
  assert.equal(preset.width * preset.height, LIMITS.maxPixels);
});

test('3840x3840 会被缩到 2880x2880（14.7M 超预算 78%）', () => {
  const solved = solveImageSize('3840x3840', LIMITS);
  assert.deepEqual([solved.width, solved.height], [2880, 2880]);
  assert.equal(solved.snapped, true);
  assert.equal(solved.width * solved.height, LIMITS.maxPixels);
  assert.match(solved.reason, /总像素超过/);
});

test('1000x1000 会对齐到 16 的倍数（1008x1008）', () => {
  const solved = solveImageSize('1000x1000', LIMITS);
  assert.deepEqual([solved.width, solved.height], [1008, 1008]);
  assert.equal(solved.snapped, true);
  assert.match(solved.reason, /对齐到 16 的倍数/);
});

test('4:1 超宽会被裁到 3:1', () => {
  const solved = solveImageSize('4096x1024', LIMITS);
  assert.equal(solved.width / solved.height <= 3, true);
  assert.deepEqual([solved.width, solved.height], [3840, 1280]);
  assertLegal(solved.width, solved.height, '4:1 裁切后');
});

test('auto / 空值 / 非法值 → 默认 1024x1024', () => {
  for (const value of ['auto', '', undefined, null, '随便什么']) {
    const solved = solveImageSize(value, LIMITS);
    assert.deepEqual([solved.width, solved.height], [1024, 1024], String(value) + ' 应回落默认');
  }
});

test('极小尺寸会被抬到像素下限以上', () => {
  const solved = solveImageSize('16x16', LIMITS);
  assertLegal(solved.width, solved.height, '16x16 放大后');
  assert.equal(solved.snapped, true);
});

test('严格模式下所有预设 + 常见输入都满足约束（穷举）', () => {
  const inputs = [
    ...Object.keys(IMAGE_SIZE_PRESETS),
    '512x512', '768x768', '1080x1920', '1920x1080', '2560x1440', '3840x2160',
    '2160x3840', '14142x14142', '100x4000', '4000x100', 'auto',
  ];
  for (const input of inputs) {
    const solved = solveImageSize(input, LIMITS);
    assertLegal(solved.width, solved.height, input + ' → ' + solved.size);
  }
});

test('自定义 limits 生效（证明不是写死 fal 一家）', () => {
  const solved = solveImageSize('2048x2048', { multipleOf: 64, maxEdge: 1024, aspectMax: 2, minPixels: 200_000, maxPixels: 1_000_000 });
  assert.equal(solved.width % 64, 0);
  assert.equal(solved.height % 64, 0);
  assert.equal(Math.max(solved.width, solved.height) <= 1024, true);
  assert.equal(solved.width * solved.height <= 1_000_000, true);
});

test('parseRequestedSize 兼容 x / × / * 三种分隔符', () => {
  assert.deepEqual(parseRequestedSize('1024x1536'), { width: 1024, height: 1536 });
  assert.deepEqual(parseRequestedSize('1024×1536'), { width: 1024, height: 1536 });
  assert.deepEqual(parseRequestedSize('1024*1536'), { width: 1024, height: 1536 });
  assert.deepEqual(parseRequestedSize('4k-16-9'), { width: 3840, height: 2160 });
  assert.equal(parseRequestedSize('auto'), undefined);
});

test('已退役模型能给出提示（不改变请求形态）', () => {
  assert.match(String(retiredImageModelNotice('dall-e-3')), /2026-05-12/);
  assert.match(String(retiredImageModelNotice('gpt-image-1')), /2026-10-23/);
  assert.match(String(retiredImageModelNotice('gpt-image-1-mini')), /gpt-image-1/, '前缀匹配不能误伤 gpt-image-1-mini 之外的当代模型');
  assert.equal(retiredImageModelNotice('gpt-image-2.6-sunburst'), undefined);
});

test('quality 枚举包含 xhigh / max（2026-11 官方与 fal 均支持）', () => {
  assert.deepEqual([...IMAGE_QUALITY_ENUM], ['auto', 'low', 'medium', 'high', 'xhigh', 'max']);
});