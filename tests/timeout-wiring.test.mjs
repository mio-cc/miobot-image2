import test from 'node:test';
import assert from 'node:assert/strict';

import { createModelClient } from '../dist/packages/model/src/index.js';
import { createCapabilityRegistry } from '../dist/packages/model/src/capability/registry.js';
import { GPT_IMAGE_PROFILE } from '../dist/packages/model/src/capability/profiles.js';
import { toBotRouting } from '../dist/apps/bot/src/config-bridge.js';
import { normalizeConfig } from '../dist/packages/config/src/index.js';

/**
 * 生图超时。
 * 配置里 imageTimeoutMs 默认 300000、面板上也能改，但以前从没传给 ModelClient，
 * 于是全部落到客户端默认的 60s——而 gpt-image 系单次出图 60-180s 很常见，
 * 等于所有生图必然超时。而且超时是 retryable，会在每个同名模型节点再各跑一次真实生图。
 */

const NODES = [
  { name: 'n0', baseUrl: 'https://a.example/v1', apiKey: 'k0', dialect: 'openai', models: ['gpt-image-2'] },
  { name: 'n1', baseUrl: 'https://b.example/v1', apiKey: 'k1', dialect: 'openai', models: ['gpt-image-2'] },
];

test('toBotRouting 把生图/反推超时带出来', () => {
  const cfg = normalizeConfig({ llm: { imageTimeoutMs: 300000, interrogateTimeoutMs: 240000 } });
  const routing = toBotRouting(cfg);
  assert.equal(routing.imageTimeoutMs, 300000, '生图超时必须传下去，否则落到 60s 默认值');
  assert.equal(routing.interrogateTimeoutMs, 240000);
});

test('generateImages 的 timeoutMs 真的透到 transport', async () => {
  let seen;
  const client = createModelClient({
    nodes: NODES,
    registry: createCapabilityRegistry({ fallback: GPT_IMAGE_PROFILE }),
    transport: async (req) => { seen = req.timeoutMs; return { status: 200, data: { data: [{ b64_json: 'AAA' }] } }; },
  });
  await client.generateImages(0, { model: 'gpt-image-2', prompt: 'x', timeoutMs: 300000 });
  assert.equal(seen, 300000);
});

test('不传时才落到 60s 默认值', async () => {
  let seen;
  const client = createModelClient({
    nodes: NODES,
    registry: createCapabilityRegistry({ fallback: GPT_IMAGE_PROFILE }),
    transport: async (req) => { seen = req.timeoutMs; return { status: 200, data: { data: [{ b64_json: 'AAA' }] } }; },
  });
  await client.generateImages(0, { model: 'gpt-image-2', prompt: 'x' });
  assert.equal(seen, 60000);
});

test('生图超时不再挨个节点重跑——那是在重复计费', async () => {
  const calls = [];
  const client = createModelClient({
    nodes: NODES,
    registry: createCapabilityRegistry({ fallback: GPT_IMAGE_PROFILE }),
    transport: async (req) => {
      calls.push(req.url);
      const err = new Error('request timed out after 60000ms');
      err.name = 'ModelError';
      // 模拟 transport 层的超时：抛 category='timeout' 的 ModelError
      const { ModelError } = await import('../dist/packages/model/src/ports.js');
      throw new ModelError('request timed out', { category: 'timeout', retryable: true });
    },
  });

  await assert.rejects(() => client.generateImages(0, { model: 'gpt-image-2', prompt: 'x' }), /timed out/);
  assert.equal(calls.length, 1, `超时只该打一次，实际打了 ${calls.length} 次（每次都是一张真实的图）`);
});

test('网络类错误仍然换节点——那是真的连不上', async () => {
  const calls = [];
  const client = createModelClient({
    nodes: NODES,
    registry: createCapabilityRegistry({ fallback: GPT_IMAGE_PROFILE }),
    transport: async (req) => {
      calls.push(req.url);
      if (calls.length === 1) {
        const { ModelError } = await import('../dist/packages/model/src/ports.js');
        throw new ModelError('connection refused', { category: 'network', retryable: true });
      }
      return { status: 200, data: { data: [{ b64_json: 'AAA' }] } };
    },
  });

  const res = await client.generateImages(0, { model: 'gpt-image-2', prompt: 'x' });
  assert.equal(res.images.length, 1);
  assert.equal(calls.length, 2, '连不上就该换节点');
  assert.match(calls[1], /b\.example/);
});

test('对话超时仍然可以换节点（对话不产出计费物）', async () => {
  const calls = [];
  const { CHAT_PROFILE } = await import('../dist/packages/model/src/capability/profiles.js');
  const client = createModelClient({
    nodes: [
      { ...NODES[0], models: ['gpt-4o-mini'] },
      { ...NODES[1], models: ['gpt-4o-mini'] },
    ],
    registry: createCapabilityRegistry({ fallback: CHAT_PROFILE }),
    transport: async (req) => {
      calls.push(req.url);
      if (calls.length === 1) {
        const { ModelError } = await import('../dist/packages/model/src/ports.js');
        throw new ModelError('timeout', { category: 'timeout', retryable: true });
      }
      return { status: 200, data: { choices: [{ message: { content: 'ok' } }] } };
    },
  });
  const res = await client.chat(0, { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(res.text, 'ok');
  assert.equal(calls.length, 2);
});
