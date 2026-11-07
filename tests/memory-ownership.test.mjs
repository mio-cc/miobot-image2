import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';

import { ChatMemoryService } from '../dist/apps/bot/src/memory-service.js';
import { createMemorySearchHandler } from '../dist/apps/bot/src/memory-search-handler.js';
import { createDefaultConfig } from '../dist/packages/config/src/index.js';

/**
 * P1 单份归属（2026-11-07 拍板）回归护栏：
 * 群消息只写群索引一份（旧实现 g: 与 p: 双写是注入重复的结构性根源）。
 * "当前用户在本群"的个人语义由群索引超集查询天然覆盖（doc 带 userId，where 可过滤）；
 * 跨群个人画像仍走 userGlobalProfileEnabled 独立开关（默认关，原语义不变）。
 * 存量双写副本不物理删，由 P0 的 messageId 合并去重兜住。
 */

function memoryConfig(root, overrides = {}) {
  const cfg = createDefaultConfig();
  cfg.orchestration.memory = {
    ...cfg.orchestration.memory,
    enabled: true,
    dataDir: root,
    embeddingNodeIndex: 1,
    embeddingModel: 'test-embedding',
    embeddingDimensions: 3,
    retentionDays: 30,
    hybridSearch: true,
    autoIngest: true,
    ...overrides,
  };
  return cfg;
}

function vectorFor(text) {
  if (/pref/i.test(text)) return [1, 0, 0];
  if (/other/i.test(text)) return [0, 1, 0];
  return [0.5, 0.5, 0];
}

class FakeEmbedding {
  constructor() { this.model = 'test-embedding'; this.dimensions = 3; }
  async embed(texts) { return texts.map(vectorFor); }
}

function tmpRoot(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'miobot-ownership-' + label + '-'));
}

test('P1 归属 1: 群消息只写群索引一份（不再 g:*/p:* 双写）', async () => {
  const root = tmpRoot('single');
  const memory = new ChatMemoryService({ rootDir: root, getConfig: () => memoryConfig(root), embedding: new FakeEmbedding() });
  await memory.ingest({ botId: 'bot', chatType: 'group', groupId: 'g1', userId: 'u1', authorName: '小张', role: 'user', text: '我的 preference 是麻辣火锅', messageId: 'm1' });
  await memory.ingest({ botId: 'bot', chatType: 'group', groupId: 'g1', userId: 'u2', authorName: '小李', role: 'user', text: 'other 人闲聊一句', messageId: 'm2' });
  const namespaces = await memory.listNamespaces();
  assert.equal(namespaces.length, 1, '群消息单份归属：只有一个群索引（旧双写会产生 group + personal 两个）');
  assert.equal(namespaces[0].namespace.kind, 'group');
  assert.equal(namespaces[0].namespace.groupId, 'g1');
  assert.equal(namespaces[0].count, 2);
  const result = await memory.retrieve({ botId: 'bot', chatType: 'group', groupId: 'g1', userId: 'u1', query: 'preference' });
  assert.ok(result.hits.every((hit) => hit.id.startsWith('g:')), 'doc id 全部为 g:* 群索引形态');
});

test('P1 归属 2: "当前用户在本群"个人语义由群索引超集承载（检索期过滤补齐）', async () => {
  const root = tmpRoot('personal-scope');
  const memory = new ChatMemoryService({ rootDir: root, getConfig: () => memoryConfig(root), embedding: new FakeEmbedding() });
  await memory.ingest({ botId: 'bot', chatType: 'group', groupId: 'g1', userId: 'u1', authorName: '小张', role: 'user', text: '我的 preference 是早起跑步', messageId: 'm1' });
  await memory.ingest({ botId: 'bot', chatType: 'group', groupId: 'g1', userId: 'u2', authorName: '小李', role: 'user', text: 'other 的消息别混进来 preference', messageId: 'm2' });
  // memory.search 技能 scope=group_user（群共享+当前用户）：单写后仍必须召回当前用户自己的消息
  const groupUser = await memory.retrieve({ botId: 'bot', chatType: 'group', groupId: 'g1', userId: 'u1', query: 'preference', scopeFilter: ['group_shared', 'personal_group_user'] });
  assert.ok(groupUser.context.includes('我的 preference 是早起跑步'), '个人作用域（group_user）召回当前用户自己的群消息');
  // scope=group（仅群共享）是超集，同样包含
  const groupOnly = await memory.retrieve({ botId: 'bot', chatType: 'group', groupId: 'g1', userId: 'u1', query: 'preference', scopeFilter: ['group_shared'] });
  assert.ok(groupOnly.context.includes('我的 preference 是早起跑步'), '群共享作用域是超集，个人语义不因单写丢失');
});

test('P1 归属 3: 换群识别（默认关）——原语义：跨群不召回，与旧行为一致', async () => {
  const root = tmpRoot('cross-off');
  const memory = new ChatMemoryService({ rootDir: root, getConfig: () => memoryConfig(root), embedding: new FakeEmbedding() });
  await memory.ingest({ botId: 'bot', chatType: 'group', groupId: 'g1', userId: 'u1', authorName: '小张', role: 'user', text: '我的 preference 是不吃香菜', messageId: 'm1' });
  const otherGroup = await memory.retrieve({ botId: 'bot', chatType: 'group', groupId: 'g2', userId: 'u1', query: 'preference' });
  assert.equal(otherGroup.context.includes('不吃香菜'), false, '默认（userGlobalProfileEnabled=false）跨群不召回——与旧实现语义一致');
  const privateChat = await memory.retrieve({ botId: 'bot', chatType: 'private', userId: 'u1', query: 'preference' });
  assert.equal(privateChat.context.includes('不吃香菜'), false, '群消息不进私聊索引（原语义）');
});

test('P1 归属 4: 换群识别（全局画像开）——取消双写后跨群偏好召回仍然成立', async () => {
  const root = tmpRoot('cross-on');
  const cfg = memoryConfig(root, { userGlobalProfileEnabled: true });
  const memory = new ChatMemoryService({ rootDir: root, getConfig: () => cfg, embedding: new FakeEmbedding() });
  await memory.ingest({ botId: 'bot', chatType: 'group', groupId: 'g1', userId: 'u1', authorName: '小张', role: 'user', text: '我的 preference 是蓝色笔记本', messageId: 'm1' });
  // 换到另一个群仍能识别他的偏好（全局个人 ns + userId where 过滤）
  const otherGroup = await memory.retrieve({ botId: 'bot', chatType: 'group', groupId: 'g2', userId: 'u1', query: 'preference' });
  assert.ok(otherGroup.context.includes('蓝色笔记本'), '全局画像开启：换群仍可识别该用户的偏好（原语义保留）');
  // 其他用户换群不可见（userId 过滤）
  const otherUser = await memory.retrieve({ botId: 'bot', chatType: 'group', groupId: 'g2', userId: 'u2', query: 'preference' });
  assert.equal(otherUser.context.includes('蓝色笔记本'), false, '跨群画像按 userId 隔离');
});

test('P1 归属 5: memory.search 内部技能与主链同源（技能能查到单写后的群消息）', async () => {
  const root = tmpRoot('skill');
  const cfg = memoryConfig(root);
  const memory = new ChatMemoryService({ rootDir: root, getConfig: () => cfg, embedding: new FakeEmbedding() });
  await memory.ingest({ botId: '10000', chatType: 'group', groupId: 'g1', userId: 'u1', authorName: '小张', role: 'user', text: '我的 preference 是周五聚餐吃火锅', messageId: 'm1' });
  const handler = createMemorySearchHandler({ memoryService: memory, getConfig: () => cfg, resolveBotId: () => '10000' });
  const invocation = (args, chat, user) => ({
    request: { requestId: 'r1', chat, user, text: '' },
    plan: { planId: 'p1' },
    step: { id: 's1', capability: 'memory.search', args },
    dependencyResults: {},
  });
  const outcome = await handler.execute(invocation(
    { query: 'preference', scope: 'group_user' },
    { type: 'group', groupId: 'g1' },
    { qq: 'u1', role: 'user' },
  ));
  assert.equal(outcome.status, 'success');
  assert.ok(outcome.outputs[0].text.includes('周五聚餐吃火锅'), 'memory.search 技能（同一套 retrieve）能查到单写后的群消息——面板与技能不分叉');
});

test('P1 归属 6: 清理路径跨形态可用（群索引按 userId 精确删除，他人消息保留）', async () => {
  const root = tmpRoot('clear');
  const memory = new ChatMemoryService({ rootDir: root, getConfig: () => memoryConfig(root), embedding: new FakeEmbedding() });
  await memory.ingest({ botId: 'bot', chatType: 'group', groupId: 'g1', userId: 'u1', authorName: '小张', role: 'user', text: '我的 preference 是早睡', messageId: 'm1' });
  await memory.ingest({ botId: 'bot', chatType: 'group', groupId: 'g1', userId: 'u2', authorName: '小李', role: 'user', text: 'other 的话 preference 也留着', messageId: 'm2' });
  const removed = await memory.clearUser('bot', 'u1', 'g1');
  assert.ok(removed >= 1, '群索引内按 userId 删除目标用户消息');
  const after = await memory.retrieve({ botId: 'bot', chatType: 'group', groupId: 'g1', userId: 'u2', query: 'preference' });
  assert.equal(after.context.includes('早睡'), false, '目标用户的记忆已清');
  assert.ok(after.context.includes('other 的话'), '同群其他用户的记忆保留');
});

test('P1 归属 wiring: ingest 群聊分支只写群索引 + 开关控的全局画像', () => {
  const source = readFileSync(path.resolve(process.cwd(), 'apps/bot/src/memory-service.ts'), 'utf8');
  const groupBranch = source.slice(source.indexOf("if (input.chatType === 'group')"), source.indexOf("} else {", source.indexOf("if (input.chatType === 'group')")));
  // 群聊分支应恰好 1 处无条件 place + 1 处 userGlobalProfileEnabled 门控 place
  assert.equal((groupBranch.match(/await place\(/g) || []).length, 2, '群聊分支只剩 2 处 place：群索引 + 开关门控的全局画像');
  assert.ok(/await place\(\{ kind: 'group', botId: input\.botId, groupId \}, `g:\$\{messageId\}/.test(groupBranch), '群消息落位 g:* 群索引');
  assert.ok(groupBranch.includes("if (memory.userGlobalProfileEnabled)"), '全局画像写入保持在开关门控内');
  assert.equal(groupBranch.includes("kind: 'personal', botId: input.botId, groupId,"), false, '不再写"本群个人"namespace（p:* 本群双写副本）');
});
