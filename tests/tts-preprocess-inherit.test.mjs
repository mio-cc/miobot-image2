import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { resolveTtsPreprocessTarget } from '../dist/apps/bot/src/tts.js';
import { createDefaultConfig } from '../dist/packages/config/src/index.js';

/**
 * 「跟随」语义锁（2026-11-06 拍板）：tts.preprocess.model 为空 = 用途表「恢复跟随」，
 * 节点与模型都回落主对话（toMainModelSelection 单点，trigger-intent.ts chatNode() 同款先例）。
 * 此前运行时把空当「跳过改写」，与 ModelsPage「未选择 → 回落主对话」承诺割裂——
 * 966 字原文零处理直送 Fish Audio 的实测根因。
 */

test('tts 前置继承：有显式改写模型 → 走自身节点与模型', () => {
  const cfg = createDefaultConfig();
  cfg.agent.mainModel = 'main-chat';
  cfg.agent.mainNodeIndex = 7;
  const pre = { enabled: true, nodeIndex: 2, model: 'own-pre-model' };
  assert.deepEqual(resolveTtsPreprocessTarget(pre, cfg), { nodeIndex: 2, model: 'own-pre-model' });
});

test('tts 前置继承：model 为空 → 节点与模型都跟主对话走（「恢复跟随」）', () => {
  const cfg = createDefaultConfig();
  cfg.agent.mainModel = 'main-chat';
  cfg.agent.mainNodeIndex = 7;
  cfg.llm.chatModel = 'legacy-chat';
  cfg.llm.chatNodeIndex = 1;
  // 残留 nodeIndex（清空跟随前的旧选择）必须被忽略，与 trigger-intent 修复同款语义
  const pre = { enabled: true, nodeIndex: 3, model: '' };
  assert.deepEqual(resolveTtsPreprocessTarget(pre, cfg), { nodeIndex: 7, model: 'main-chat' });
});

test('tts 前置继承：agent 主位为空 → 回落 llm.chat*（toMainModelSelection 单点语义）', () => {
  const cfg = createDefaultConfig();
  cfg.agent.mainModel = '';
  cfg.agent.mainNodeIndex = undefined;
  cfg.llm.chatModel = 'legacy-chat';
  cfg.llm.chatNodeIndex = 4;
  const pre = { enabled: true, nodeIndex: 3, model: '' };
  assert.deepEqual(resolveTtsPreprocessTarget(pre, cfg), { nodeIndex: 4, model: 'legacy-chat' });
});

test('tts 前置继承：主对话也没配 → model 空（调用方门控降级跳过改写）', () => {
  const cfg = createDefaultConfig();
  cfg.agent.mainModel = '';
  cfg.llm.chatModel = '';
  const pre = { enabled: true, nodeIndex: 3, model: '' };
  const target = resolveTtsPreprocessTarget(pre, cfg);
  assert.equal(target.model, '');
});

test('tts 前置继承：pre 未配置时同样回落主对话', () => {
  const cfg = createDefaultConfig();
  cfg.agent.mainModel = 'main-chat';
  cfg.agent.mainNodeIndex = 7;
  assert.deepEqual(resolveTtsPreprocessTarget(undefined, cfg), { nodeIndex: 7, model: 'main-chat' });
});

test('wiring: start.ts 前置转化用解析后的绑定调用，不再直接读 pre.model', () => {
  const source = readFileSync(path.resolve(process.cwd(), 'apps/bot/src/start.ts'), 'utf8');
  assert.ok(
    /resolveTtsPreprocessTarget\(pre, getConfig\(\)\)/.test(source),
    'start.ts 应通过 resolveTtsPreprocessTarget(pre, getConfig()) 解析改写绑定',
  );
  assert.ok(
    /withPurposeFallback\(modelFallback, 'tts', preTarget, preprocessCall\)/.test(source),
    'start.ts 应把解析后的 preTarget 传给 withPurposeFallback',
  );
  assert.ok(
    !/pre\?\.enabled && String\(pre\.model \|\| ''\)\.trim\(\)/.test(source),
    '旧的「空模型即跳过」门控应已删除',
  );
});
