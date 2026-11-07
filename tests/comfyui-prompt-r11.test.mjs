import test from 'node:test';
import assert from 'node:assert/strict';
import { builtinComfyUiProfile, createDefaultConfig } from '../dist/packages/config/src/index.js';
import { enhanceComfyUiPrompt } from '../dist/apps/bot/src/comfyui.js';

function optionsFor(client, logs = []) {
  const cfg = createDefaultConfig();
  cfg.comfyuiTransform.enabled = true;
  cfg.comfyuiTransform.nodeIndex = 0;
  cfg.comfyuiTransform.model = 'prompt-test';
  cfg.comfyuiTransform.promptTemplate = 'Rewrite this request: {{userRequest}}';
  return {
    getConfig: () => cfg,
    client: { async chat(_node, request) { return client(request); } },
    logger: {
      info(message, data) { logs.push({ level: 'info', message, data }); },
      warn(message, data) { logs.push({ level: 'warn', message, data }); },
    },
  };
}

test('comfyui prompt: empty enhancement is retried before fallback', async () => {
  let calls = 0;
  const opts = optionsFor(async () => {
    calls += 1;
    return { text: calls === 1 ? '' : 'A cinematic portrait of a cat, soft rim light.' };
  });
  const profile = builtinComfyUiProfile('krea-2-turbo');
  assert.ok(profile);
  const result = await enhanceComfyUiPrompt(opts, profile, '画一只猫');
  assert.equal(calls, 2);
  assert.equal(result.source, 'model');
  assert.match(result.prompt, /cat/);
});

test('comfyui prompt: fallback uses the real user request, not an internal continuation notice', async () => {
  const opts = optionsFor(async () => ({ text: '' }));
  const profile = builtinComfyUiProfile('krea-2-turbo');
  const result = await enhanceComfyUiPrompt(opts, profile, '画一只赛博朋克猫');
  assert.equal(result.source, 'fallback');
  assert.equal(result.prompt, '画一只赛博朋克猫');
});

test('comfyui prompt: JSON-wrapped model output is unwrapped', async () => {
  const opts = optionsFor(async () => ({ text: '{"prompt":"A blue circular button, clean vector style."}' }));
  const profile = builtinComfyUiProfile('krea-2-turbo');
  const result = await enhanceComfyUiPrompt(opts, profile, '画蓝色按钮');
  assert.equal(result.source, 'model');
  assert.match(result.prompt, /blue circular button/i);
});

/* ── 「跟随」语义锁（2026-11-06 拍板）：transform.model 为空 = 用途表「恢复跟随」，回落主对话 ── */

function captureOptions(cfg) {
  const calls = [];
  return {
    calls,
    opts: {
      getConfig: () => cfg,
      client: { async chat(nodeIndex, request) { calls.push({ nodeIndex, model: request.model }); return { text: 'A cinematic portrait of a cat, soft rim light.' }; } },
      logger: { info() {}, warn() {} },
    },
  };
}

test('comfyui prompt: model 为空 → 节点与模型回落主对话（恢复跟随）', async () => {
  const cfg = createDefaultConfig();
  cfg.comfyuiTransform.enabled = true;
  cfg.comfyuiTransform.nodeIndex = 3;
  cfg.comfyuiTransform.model = '';
  cfg.comfyuiTransform.promptTemplate = 'Rewrite this request: {{userRequest}}';
  cfg.agent.mainModel = 'main-chat-model';
  cfg.agent.mainNodeIndex = 7;
  const { calls, opts } = captureOptions(cfg);
  const profile = builtinComfyUiProfile('krea-2-turbo');
  const result = await enhanceComfyUiPrompt(opts, profile, '画一只猫');
  assert.equal(result.source, 'model');
  assert.deepEqual(calls[0], { nodeIndex: 7, model: 'main-chat-model' }, '残留 nodeIndex=3 应被忽略，跟主对话走');
});

test('comfyui prompt: 有显式转化模型 → 走自身节点与模型', async () => {
  const cfg = createDefaultConfig();
  cfg.comfyuiTransform.enabled = true;
  cfg.comfyuiTransform.nodeIndex = 3;
  cfg.comfyuiTransform.model = 'own-transform-model';
  cfg.comfyuiTransform.promptTemplate = 'Rewrite this request: {{userRequest}}';
  cfg.agent.mainModel = 'main-chat-model';
  cfg.agent.mainNodeIndex = 7;
  const { calls, opts } = captureOptions(cfg);
  const profile = builtinComfyUiProfile('krea-2-turbo');
  const result = await enhanceComfyUiPrompt(opts, profile, '画一只猫');
  assert.equal(result.source, 'model');
  assert.deepEqual(calls[0], { nodeIndex: 3, model: 'own-transform-model' });
});

test('comfyui prompt: model 与主对话均为空 → 维持降级跳过转化（回 raw）', async () => {
  const cfg = createDefaultConfig();
  cfg.comfyuiTransform.enabled = true;
  cfg.comfyuiTransform.nodeIndex = 3;
  cfg.comfyuiTransform.model = '';
  cfg.comfyuiTransform.promptTemplate = 'Rewrite this request: {{userRequest}}';
  cfg.agent.mainModel = '';
  cfg.llm.chatModel = '';
  const { calls, opts } = captureOptions(cfg);
  const profile = builtinComfyUiProfile('krea-2-turbo');
  const result = await enhanceComfyUiPrompt(opts, profile, '画一只赛博朋克猫');
  assert.equal(result.source, 'fallback');
  assert.equal(result.prompt, '画一只赛博朋克猫');
  assert.equal(calls.length, 0, '无可用模型时不应发起任何 chat 调用');
});
