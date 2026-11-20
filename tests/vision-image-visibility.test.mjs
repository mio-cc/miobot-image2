// 「引用了图让改图，图改了也发了，但文字说没看到图」（2026-11-20）
//
// 根因链（已用脚本验证）：
//   1. 改图工具走 attachments（meta.attachments → invocation.request.attachments），
//      不依赖主模型的 vision，所以图能改、能发。
//   2. 主模型看没看到图，走的是另一条路（context-builder 的 imageRefs → vision parts），
//      或者旧直连路径 deps.chat 的 canAttempt('vision') 判定。
//   3. 一旦能力记忆把 vision 判死（一次 400 → learnUnsupported），deps.chat 就静默丢图，
//      模型只能回「我看不到图」。而不支持 vision 的判定原本是**永久**的。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('负向能力判定有 TTL：过期后允许重新验证（不再永久判死）', async () => {
  const { createCapabilityRegistry, NEGATIVE_LEARNING_TTL_MS } = await import('../dist/packages/model/src/capability/registry.js');
  const { createInMemoryCapabilityMemory } = await import('../dist/packages/model/src/capability/memory.js');
  const memory = createInMemoryCapabilityMemory();
  const reg = createCapabilityRegistry({ memory });
  const model = 'zai-glm-5-3-flash';
  const node = { dialect: 'openai', baseUrl: 'https://api.mistral.ai/v1', credentialFingerprint: 'abc' };

  assert.equal(reg.shouldAttempt(model, 'vision', node), true, '未知模型应先允许尝试');
  reg.learnUnsupported(node, model, 'vision', 'image_url is not supported');
  assert.equal(reg.shouldAttempt(model, 'vision', node), false, '刚判死时应拦住');

  const key = memory.list()[0].key;
  assert.ok(memory.get(key).revokedAt, '必须记录负向判定时间，否则没法算 TTL');
  memory.set(key, { ...memory.get(key), revokedAt: new Date(Date.now() - NEGATIVE_LEARNING_TTL_MS - 1000).toISOString() });
  assert.equal(reg.shouldAttempt(model, 'vision', node), true, 'TTL 过期后应允许重试');
  assert.equal(reg.can(model, 'vision', node), false, 'can() 仍严格：没证据就不说能');
});

test('TTL 不能太大也不能太小（6 小时量级）', async () => {
  const { NEGATIVE_LEARNING_TTL_MS } = await import('../dist/packages/model/src/capability/registry.js');
  const hours = NEGATIVE_LEARNING_TTL_MS / 3_600_000;
  assert.ok(hours >= 1 && hours <= 24, '实际 ' + hours + ' 小时');
});

test('旧直连 chat：vision 不可用时丢图必须注入系统事实（不能静默丢）', () => {
  const src = fs.readFileSync('apps/bot/src/deps.ts', 'utf8');
  assert.match(src, /visionUnavailableNote/);
  assert.match(src, /不要声称"用户没有发图片"/);
  assert.match(src, /image\.interrogate/);
  // 必须是 system 消息，不能拼进用户文本（否则被当成用户原话存进历史）
  assert.match(src, /role: 'system'/);
  assert.match(src, /if \(visionUnavailableNote\) messages\.push\(visionUnavailableNote\)/);
});

test('agent 路径：带图时始终给系统事实（看不到也别否认收到图）', () => {
  const src = fs.readFileSync('apps/bot/src/runtime.ts', 'utf8');
  assert.match(src, /本轮用户附带了 /);
  assert.match(src, /已作为视觉输入与工具附件同时提供/);
  assert.match(src, /不要說"用户没发图片"|不要说"用户没发图片"/);
  assert.match(src, /image\.interrogate/);
});

test('agent 路径：图片确实转成真实视觉输入（不是一行附件文本）', () => {
  const builder = fs.readFileSync('packages/agent-runtime/src/context-builder.ts', 'utf8');
  assert.match(builder, /imageRefs/, 'context-builder 必须带 imageRefs');
  const port = fs.readFileSync('apps/bot/src/agent-model-port.ts', 'utf8');
  assert.match(port, /imageRefs/, 'agent-model-port 必须把 imageRefs 转成 provider 多模态 part');
  assert.match(port, /image_url/, '必须是 image_url part，不是纯文本');
});