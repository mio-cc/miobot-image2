// 模型能力档案识别回归（线上时测 2026-11-16）：
//   用户导出配置里 生图=ZAnimeDistill_8Step_INT8、视频=MiniMaxH3_33B_Turbo_INT8，
//   两个模型名都不匹配任何内置规则 → 兜底 TEXT_ONLY(只有 chat) → registry.can()=false
//   → ModelClient 在本地抛 capability_unsupported，请求根本没发到上游。
// 契约：
//   1) 自建/中转常见权重文件名必须被认成对应模态；
//   2) 不能把同名族的对话模型误判成生图/视频。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCapabilityRegistry } from '../dist/packages/model/src/capability/registry.js';
import { inferProfileByName } from '../dist/packages/model/src/capability/profiles.js';

const reg = createCapabilityRegistry();

test('profile rules: 自建生图权重族识别为 image.generate', () => {
  for (const model of [
    'ZAnimeDistill_8Step_INT8',
    'ZImageTurbo_INT8',
    'Flux1schnell',
    'Flux_2_Klein_4B_BF16',
    'QwenImageEdit_Plus_NF4',
  ]) {
    assert.equal(reg.can(model, 'image.generate'), true, model + ' 应具备 image.generate，实际 ops=' + reg.operationsOf(model).join(','));
  }
});

test('profile rules: 自建视频权重族识别为 video.generate', () => {
  for (const model of [
    'MiniMaxH3_33B_Turbo_INT8',
    'Ltx2_3_22B_Dist_INT8',
    'Ltx2_5_22B_Dist_INT8',
    'Ltxv_13B_0_9_8_Distilled_FP8',
  ]) {
    assert.equal(reg.can(model, 'video.generate'), true, model + ' 应具备 video.generate，实际 ops=' + reg.operationsOf(model).join(','));
  }
});

test('profile rules: 同族对话模型不得被误判为生图/视频', () => {
  const chatModels = [
    'minimax-m3',            // 不能因 minimax 前缀被当成 MiniMaxH 视频系
    'MiniMax-M1',
    'glm-5.3-flash',
    'grok-4.5',
    'deepseek-v4.1-flash',
    'mimo-2.6-flash',
    'big-pickle',
  ];
  for (const model of chatModels) {
    const ops = reg.operationsOf(model);
    assert.equal(ops.includes('video.generate'), false, model + ' 不应具备 video.generate');
    assert.equal(ops.includes('image.generate'), false, model + ' 不应具备 image.generate');
  }
});

test('profile rules: 视频模型不会顺带获得 image.generate（避免串模态）', () => {
  for (const model of ['MiniMaxH3_33B_Turbo_INT8', 'Ltx2_5_22B_Dist_INT8']) {
    assert.equal(reg.can(model, 'image.generate'), false, model + ' 不应具备 image.generate');
  }
});

test('capability overrides still win over builtin rules', () => {
  // deepseek-v4.1-flash 内置规则判为纯文本（无 vision）。
  assert.equal(reg.can('deepseek-v4.1-flash', 'vision'), false);
  // 覆盖可以把它提升为多模态——这是用户配置里 deepseek-flash 走的那条路。
  const withOverride = createCapabilityRegistry({
    overrides: [{ model: 'deepseek-v4.1-flash', operations: ['chat', 'vision', 'interrogate'] }],
  });
  assert.equal(withOverride.can('deepseek-v4.1-flash', 'vision'), true);
  assert.equal(withOverride.can('deepseek-v4.1-flash', 'interrogate'), true);
  // 覆盖同样可以补上生图能力（自建网关常用这一招）。
  const imageOverride = createCapabilityRegistry({
    overrides: [{ model: 'MyPrivateModel', operations: ['image.generate'] }],
  });
  assert.equal(imageOverride.can('MyPrivateModel', 'image.generate'), true);
});
