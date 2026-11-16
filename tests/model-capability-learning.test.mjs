// 能力学习的契约（2026-11-16 设计变更）：
//   旧：模型名认不出 → TEXT_ONLY → ModelClient 本地拒掉，请求从不发出，加模型要改代码。
//   新：未知 ≠ 不能。can() 诚实说「不知道」，shouldAttempt() 放行尝试，
//       真实结果（成功/上游拒绝/主脑判定）写进能力记忆并跨重启生效。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createCapabilityRegistry,
  createInMemoryCapabilityMemory,
  diagnoseCapabilityRejection,
  capabilityKey,
} from '../dist/packages/model/src/index.js';
import { FileModelCapabilityStore } from '../dist/apps/bot/src/model-capability-store.js';

const NODE = { baseUrl: 'https://api.example.test/v1', dialect: 'openai' };
// 刻意用一个任何内置规则都认不出的名字，模拟「网关新上线、名字没见过的模型」。
// （ZAnimeDistill_8Step_INT8 这类常见权重名已有名字启发，属于 builtin-hint，不算未知。）
const UNKNOWN_MODEL = 'MysteryWeights_v9_INT8';

test('未知模型：can() 说不知道，shouldAttempt() 放行', () => {
  const reg = createCapabilityRegistry();
  const resolved = reg.resolve(UNKNOWN_MODEL, NODE);
  assert.equal(resolved.source, 'unknown');
  assert.equal(reg.can(UNKNOWN_MODEL, 'image.generate', NODE), false, 'can() 不能把不知道说成能');
  assert.deepEqual(reg.operationsOf(UNKNOWN_MODEL, NODE), []);
  assert.equal(reg.shouldAttempt(UNKNOWN_MODEL, 'image.generate', NODE), true, '未知模型要允许真发一次');
});

test('已知不支持：既不能也不能试（快速失败）', () => {
  const reg = createCapabilityRegistry();
  // gpt-4o 是已知的多模态对话模型，不产图。
  assert.equal(reg.can('gpt-4o', 'image.generate'), false);
  assert.equal(reg.shouldAttempt('gpt-4o', 'image.generate'), false);
});

test('实测成功 → 记住能力，之后 can() 变 true', () => {
  const memory = createInMemoryCapabilityMemory();
  const reg = createCapabilityRegistry({ memory });
  reg.learnSupported(NODE, UNKNOWN_MODEL, 'image.generate');
  assert.equal(reg.can(UNKNOWN_MODEL, 'image.generate', NODE), true);
  assert.equal(reg.resolve(UNKNOWN_MODEL, NODE).source, 'learned-call');
  assert.equal(reg.can(UNKNOWN_MODEL, 'video.generate', NODE), false, '没实测过的操作不能被顺带算进来');
});

test('上游拒绝 → 记住不支持，之后 shouldAttempt() 立即 false', () => {
  const memory = createInMemoryCapabilityMemory();
  const reg = createCapabilityRegistry({ memory });
  reg.learnSupported(NODE, UNKNOWN_MODEL, 'image.generate');
  reg.learnUnsupported(NODE, UNKNOWN_MODEL, 'image.generate', 'model does not support image generation');
  assert.equal(reg.shouldAttempt(UNKNOWN_MODEL, 'image.generate', NODE), false);
  assert.equal(reg.resolve(UNKNOWN_MODEL, NODE).source, 'learned-rejected');
});

test('主脑判定优先于名字启发', () => {
  const memory = createInMemoryCapabilityMemory();
  const reg = createCapabilityRegistry({ memory });
  // flux 名字启发是「能生图」，但实测/判定说这个部署只做 chat → 以事实为准。
  reg.rememberJudgement(NODE, 'flux1-dev', ['chat'], '网关只代理对话');
  assert.equal(reg.can('flux1-dev', 'image.generate', NODE), false);
  assert.equal(reg.can('flux1-dev', 'chat', NODE), true);
  assert.equal(reg.resolve('flux1-dev', NODE).source, 'learned-llm');
});

test('用户覆盖优先级最高', () => {
  const memory = createInMemoryCapabilityMemory();
  memory.set(capabilityKey(NODE, 'my-model'), { operations: ['chat'], source: 'learned-call', updatedAt: new Date().toISOString() });
  const reg = createCapabilityRegistry({
    memory,
    overrides: [{ model: 'my-model', operations: ['image.generate'] }],
  });
  assert.equal(reg.resolve('my-model', NODE).source, 'user-override');
  assert.equal(reg.shouldAttempt('my-model', 'image.generate', NODE), true);
});

test('不同 baseUrl 的结论互不串味', () => {
  const memory = createInMemoryCapabilityMemory();
  const reg = createCapabilityRegistry({ memory });
  reg.learnSupported(NODE, UNKNOWN_MODEL, 'image.generate');
  const otherNode = { baseUrl: 'https://other.example.test/v1', dialect: 'openai' };
  assert.equal(reg.can(UNKNOWN_MODEL, 'image.generate', otherNode), false, '换服务商必须重新验证');
  assert.equal(reg.shouldAttempt(UNKNOWN_MODEL, 'image.generate', otherNode), true);
});

test('只有明确的能力类拒绝才算负向证据（不把 429/5xx 当结论）', () => {
  assert.equal(diagnoseCapabilityRejection(429, { error: 'rate limited' }), undefined);
  assert.equal(diagnoseCapabilityRejection(500, { error: 'upstream exploded' }), undefined);
  assert.equal(diagnoseCapabilityRejection(400, { error: { message: 'This model does not support image generation' } })?.rejected, true);
  assert.equal(diagnoseCapabilityRejection(404, { error: 'model not found' })?.rejected, true);
  // 路由不存在（中转标准回话）算结论：省掉每次重试。
  assert.equal(diagnoseCapabilityRejection(404, { error: 'Invalid URL (POST /v1/videos/generations)' })?.rejected, true);
  // 403 权限类绝不能学成「模型不支持」——换套餐就能好。
  assert.equal(diagnoseCapabilityRejection(403, { error: 'Access denied' }), undefined);
});

test('能力记忆落盘：新实例读回同一批结论', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miobot-cap-'));
  const file = path.join(dir, 'model-capabilities.json');
  const first = new FileModelCapabilityStore({ filePath: file });
  const reg1 = createCapabilityRegistry({ memory: first });
  reg1.learnSupported(NODE, UNKNOWN_MODEL, 'image.generate');
  first.flush();

  const second = new FileModelCapabilityStore({ filePath: file });
  const reg2 = createCapabilityRegistry({ memory: second });
  assert.equal(reg2.can(UNKNOWN_MODEL, 'image.generate', NODE), true, '重启后必须还记得');
  assert.equal(reg2.resolve(UNKNOWN_MODEL, NODE).source, 'learned-call');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('能力记忆文件损坏时不影响启动（丢掉重学）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miobot-cap-bad-'));
  const file = path.join(dir, 'model-capabilities.json');
  fs.writeFileSync(file, '{ not json', 'utf8');
  const store = new FileModelCapabilityStore({ filePath: file });
  assert.deepEqual(store.list(), []);
  fs.rmSync(dir, { recursive: true, force: true });
});
// ── 端到端：ModelClient 真的把「实测结论」写进能力记忆 ──
// 这是整套设计的关键闭环：未知模型不再被本地拒掉，而是发出去、按结果学习。

test('ModelClient 端到端：未知模型生图成功 → 记住支持；上游拒绝 → 记住不支持', async () => {
  const { createModelClient } = await import('../dist/packages/model/src/index.js');
  const memory = createInMemoryCapabilityMemory();
  const reg = createCapabilityRegistry({ memory });
  const node = { baseUrl: NODE.baseUrl, dialect: 'openai', models: [] };
  const calls = [];
  let nextReply = { status: 200, data: { data: [{ url: 'https://cdn.test/a.png' }] } };
  const client = createModelClient({
    nodes: () => [node],
    registry: () => reg,
    transport: async (request) => {
      calls.push(request.url);
      return nextReply;
    },
    retries: 0,
    failover: false,
  });

  // 第一次：上游接受 → 未知变成「已知支持」
  const ok = await client.generateImages(0, { model: UNKNOWN_MODEL, prompt: 'a cat', count: 1, timeoutMs: 1000 });
  assert.equal(ok.images.length >= 0, true);
  assert.equal(calls.length, 1, '未知模型必须真的发出请求（旧实现这里会抛 capability_unsupported）');
  assert.equal(reg.can(UNKNOWN_MODEL, 'image.generate', node), true, '成功后应记为支持');

  // 第二次：换一个模型，上游明确说这个模型不产图 → 记住，并且不再发同一个请求
  const other = 'AnotherMystery_7B';
  nextReply = { status: 400, data: { error: { message: 'This model does not support image generation' } } };
  await assert.rejects(() => client.generateImages(0, { model: other, prompt: 'a dog', count: 1, timeoutMs: 1000 }));
  assert.equal(reg.shouldAttempt(other, 'image.generate', node), false, '上游明确拒绝后应记住不支持');
  const before = calls.length;
  await assert.rejects(() => client.generateImages(0, { model: other, prompt: 'a dog', count: 1, timeoutMs: 1000 }));
  assert.equal(calls.length, before, '已知不支持后应快速失败，不再打上游');
});
