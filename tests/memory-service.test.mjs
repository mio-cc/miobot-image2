import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChatMemoryService } from '../dist/apps/bot/src/memory-service.js';
import { createDefaultConfig } from '../dist/packages/config/src/index.js';

function config(root) {
  const cfg = createDefaultConfig();
  cfg.orchestration.memory = {
    ...cfg.orchestration.memory,
    enabled: true,
    dataDir: root,
    embeddingNodeIndex: 1,
    embeddingModel: 'test-embedding',
    embeddingDimensions: 3,
    topK: 6,
    minScore: 0,
    maxContextChars: 5000,
    recentTurns: 2,
    retentionDays: 30,
    hybridSearch: true,
    autoIngest: true,
  };
  return cfg;
}

function vectorFor(text) {
  if (/cat/i.test(text)) return [1, 0, 0];
  if (/dog/i.test(text)) return [0, 1, 0];
  if (/secret/i.test(text)) return [0, 0, 1];
  return [0.5, 0.5, 0];
}

class FakeEmbedding {
  constructor() { this.model = 'test-embedding'; this.dimensions = 3; this.fail = false; }
  async embed(texts) {
    if (this.fail) throw new Error('embedding_down');
    return texts.map(vectorFor);
  }
}

test('memory: group and private namespaces are physically isolated', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miobot-memory-'));
  const embedding = new FakeEmbedding();
  const memory = new ChatMemoryService({ rootDir: root, getConfig: () => config(root), embedding });
  await memory.ingest({ botId: 'bot', chatType: 'group', groupId: 'g1', userId: 'u1', authorName: '同名', role: 'user', text: 'I like cat', messageId: 'm1' });
  await memory.ingest({ botId: 'bot', chatType: 'group', groupId: 'g1', userId: 'u2', authorName: '同名', role: 'user', text: 'I like dog', messageId: 'm2' });
  await memory.ingest({ botId: 'bot', chatType: 'group', groupId: 'g2', userId: 'u1', authorName: '同名', role: 'user', text: 'other group secret', messageId: 'm3' });
  await memory.ingest({ botId: 'bot', chatType: 'private', userId: 'u1', authorName: 'u1', role: 'user', text: 'private secret', messageId: 'm4' });

  const g1 = await memory.retrieve({ botId: 'bot', chatType: 'group', groupId: 'g1', userId: 'u1', query: 'cat' });
  assert.ok(g1.context.includes('I like cat'));
  assert.ok(g1.context.includes('同名 [QQ:u1]'));
  assert.equal(g1.context.includes('other group secret'), false);
  assert.equal(g1.context.includes('private secret'), false);
  assert.equal(g1.namespaces.length, 2);

  const privateU1 = await memory.retrieve({ botId: 'bot', chatType: 'private', userId: 'u1', query: 'secret' });
  assert.ok(privateU1.context.includes('private secret'));
  const privateU2 = await memory.retrieve({ botId: 'bot', chatType: 'private', userId: 'u2', query: 'secret' });
  assert.equal(privateU2.context.includes('private secret'), false);
});

test('memory: persists across service restart and falls back when embedding fails', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miobot-memory-persist-'));
  const embedding = new FakeEmbedding();
  const first = new ChatMemoryService({ rootDir: root, getConfig: () => config(root), embedding });
  await first.ingest({ botId: 'bot', chatType: 'private', userId: 'u1', authorName: 'u1', role: 'user', text: 'cat memory', messageId: 'p1' });
  // 防抖落盘（T3.4）后，重启前需优雅 flush——对应生产路径 SIGTERM → stop() → flush。
  await first.flush();
  const second = new ChatMemoryService({ rootDir: root, getConfig: () => config(root), embedding });
  const restored = await second.retrieve({ botId: 'bot', chatType: 'private', userId: 'u1', query: 'cat' });
  assert.ok(restored.context.includes('cat memory'));
  embedding.fail = true;
  const fallback = await second.retrieve({ botId: 'bot', chatType: 'private', userId: 'u1', query: 'cat' });
  assert.equal(fallback.degraded, true);
  assert.ok(fallback.context.includes('cat memory'));
});

test('memory: clearNamespace removes only that isolated namespace', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miobot-memory-clear-'));
  const embedding = new FakeEmbedding();
  const memory = new ChatMemoryService({ rootDir: root, getConfig: () => config(root), embedding });
  await memory.ingest({ botId: 'bot', chatType: 'group', groupId: 'g1', userId: 'u1', authorName: 'u1', role: 'user', text: 'cat', messageId: 'c1' });
  await memory.ingest({ botId: 'bot', chatType: 'group', groupId: 'g2', userId: 'u1', authorName: 'u1', role: 'user', text: 'cat', messageId: 'c2' });
  await memory.clearNamespace({ kind: 'group', botId: 'bot', groupId: 'g1' });
  const g1 = await memory.retrieve({ botId: 'bot', chatType: 'group', groupId: 'g1', userId: 'u1', query: 'cat' });
  const g2 = await memory.retrieve({ botId: 'bot', chatType: 'group', groupId: 'g2', userId: 'u1', query: 'cat' });
  assert.equal(g1.context.includes('cat'), false);
  assert.ok(g2.context.includes('cat'));
});
test('memory: rolling summary is generated every configured interval', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miobot-memory-summary-'));
  const cfg = config(root);
  cfg.orchestration.memory.summarizeEvery = 2;
  const embedding = new FakeEmbedding();
  let summarizeCalls = 0;
  const memory = new ChatMemoryService({
    rootDir: root,
    getConfig: () => cfg,
    embedding,
    summarize: async ({ messages }) => {
      summarizeCalls += 1;
      assert.ok(messages.length >= 2);
      return '用户喜欢猫，未完成事项是选海报尺寸。';
    },
  });
  await memory.ingest({ botId: 'bot', chatType: 'private', userId: 'u1', authorName: 'u1', role: 'user', text: 'cat preference', messageId: 's1' });
  await memory.ingest({ botId: 'bot', chatType: 'private', userId: 'u1', authorName: 'u1', role: 'assistant', text: 'noted', messageId: 's2' });
  for (let i = 0; i < 40 && summarizeCalls === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(summarizeCalls, 1);
  const result = await memory.retrieve({ botId: 'bot', chatType: 'private', userId: 'u1', query: 'summary' });
  assert.ok(result.context.includes('【会话摘要】用户喜欢猫'));
  assert.ok(result.context.includes('(摘要)'));
});
test('memory: admin management can list and clear one user without touching another user', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miobot-memory-admin-'));
  const embedding = new FakeEmbedding();
  const memory = new ChatMemoryService({ rootDir: root, getConfig: () => config(root), embedding });
  await memory.ingest({ botId: 'bot', chatType: 'group', groupId: 'g1', userId: 'u1', authorName: 'u1', role: 'user', text: 'cat one', messageId: 'a1' });
  await memory.ingest({ botId: 'bot', chatType: 'private', userId: 'u1', authorName: 'u1', role: 'user', text: 'private one', messageId: 'a2' });
  await memory.ingest({ botId: 'bot', chatType: 'group', groupId: 'g1', userId: 'u2', authorName: 'u2', role: 'user', text: 'dog two', messageId: 'a3' });
  const namespaces = await memory.listNamespaces();
  assert.ok(namespaces.length >= 4);
  assert.ok(namespaces.every((item) => typeof item.count === 'number'));
  const removed = await memory.clearUser('bot', 'u1', 'g1');
  assert.ok(removed >= 2);
  const u1 = await memory.retrieve({ botId: 'bot', chatType: 'group', groupId: 'g1', userId: 'u1', query: 'cat' });
  const u2 = await memory.retrieve({ botId: 'bot', chatType: 'group', groupId: 'g1', userId: 'u2', query: 'dog' });
  assert.equal(u1.context.includes('cat one'), false);
  assert.ok(u2.context.includes('dog two'));
});
test('memory: optional user-global profile crosses groups only for the same user', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miobot-memory-global-'));
  const cfg = config(root);
  cfg.orchestration.memory.userGlobalProfileEnabled = true;
  const embedding = new FakeEmbedding();
  const memory = new ChatMemoryService({ rootDir: root, getConfig: () => cfg, embedding });
  await memory.ingest({ botId: 'bot', chatType: 'group', groupId: 'g1', userId: 'u1', authorName: 'u1', role: 'user', text: 'global cat preference', messageId: 'gl1' });
  const sameUserOtherGroup = await memory.retrieve({ botId: 'bot', chatType: 'group', groupId: 'g2', userId: 'u1', query: 'global cat' });
  const otherUser = await memory.retrieve({ botId: 'bot', chatType: 'group', groupId: 'g2', userId: 'u2', query: 'global cat' });
  assert.ok(sameUserOtherGroup.context.includes('global cat preference'));
  assert.equal(sameUserOtherGroup.namespaces.length, 3);
  assert.equal(otherUser.context.includes('global cat preference'), false);
});

test('memory T3.4 consolidate: 相似归并 + 低分淘汰 + retention prune 一次完成', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miobot-memory-consolidate-'));
  const embedding = new FakeEmbedding();
  const now = Date.now();
  const memory = new ChatMemoryService({
    rootDir: root, getConfig: () => config(root), embedding,
    scoreImportance: async ({ documents }) => documents.map((doc) => /trash/.test(doc.text) ? 1 : 8),
  });
  await memory.ingest({ botId: 'bot', chatType: 'private', userId: 'u1', role: 'user', text: 'cat dup older', messageId: 'd1', createdAt: new Date(now - 48 * 3600 * 1000).toISOString() });
  await memory.ingest({ botId: 'bot', chatType: 'private', userId: 'u1', role: 'user', text: 'cat dup newer', messageId: 'd2', createdAt: new Date(now - 47 * 3600 * 1000).toISOString() });
  await memory.ingest({ botId: 'bot', chatType: 'private', userId: 'u1', role: 'user', text: 'keep dog fact', messageId: 'k1', createdAt: new Date(now - 46 * 3600 * 1000).toISOString() });
  await memory.ingest({ botId: 'bot', chatType: 'private', userId: 'u1', role: 'user', text: 'trash small talk', messageId: 't1', createdAt: new Date(now - 45 * 3600 * 1000).toISOString() });
  const stats = await memory.consolidate({ now: () => now });
  assert.equal(stats.merged, 1, '两条 cat 向量重复应归并一条（保新）');
  assert.equal(stats.evicted, 1, '低分(1)且超 24h 应淘汰');
  const after = await memory.retrieve({ botId: 'bot', chatType: 'private', userId: 'u1', query: 'cat' });
  assert.ok(after.context.includes('cat dup newer'), '保留更新的一条');
  assert.equal(after.context.includes('cat dup older'), false);
  assert.equal(after.context.includes('trash small talk'), false, '低分应被淘汰');
  const dog = await memory.retrieve({ botId: 'bot', chatType: 'private', userId: 'u1', query: 'dog' });
  assert.ok(dog.context.includes('keep dog fact'), '高分记忆保留');
});

test('memory T3.4 consolidate: 冷启动跨进程仍能从 manifest 加载全部 namespace 巩固', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miobot-memory-consolidate-restart-'));
  const embedding = new FakeEmbedding();
  const now = Date.now();
  const first = new ChatMemoryService({ rootDir: root, getConfig: () => config(root), embedding });
  await first.ingest({ botId: 'bot', chatType: 'group', groupId: 'g1', userId: 'u1', role: 'user', text: 'cat A', messageId: 'a1', createdAt: new Date(now - 40 * 3600 * 1000).toISOString() });
  await first.ingest({ botId: 'bot', chatType: 'group', groupId: 'g1', userId: 'u1', role: 'user', text: 'cat B', messageId: 'a2', createdAt: new Date(now - 39 * 3600 * 1000).toISOString() });
  await first.flush();
  // 新进程：dbs 为空，只能靠 manifest 找到 namespace
  const second = new ChatMemoryService({ rootDir: root, getConfig: () => config(root), embedding });
  const stats = await second.consolidate({ now: () => now });
  assert.ok(stats.namespaces >= 2, '应从 manifest 加载 group 与 personal namespace：' + stats.namespaces);
  assert.equal(stats.merged, 2, '两个 namespace 各归并一条重复');
  const after = await second.retrieve({ botId: 'bot', chatType: 'group', groupId: 'g1', userId: 'u1', query: 'cat' });
  assert.ok(after.context.includes('cat B'));
  assert.equal(after.context.includes('cat A'), false);
});

test('memory T3.4 consolidate: 未配置 scorer 时只归并不淘汰', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miobot-memory-consolidate-noscore-'));
  const embedding = new FakeEmbedding();
  const now = Date.now();
  const memory = new ChatMemoryService({ rootDir: root, getConfig: () => config(root), embedding });
  await memory.ingest({ botId: 'bot', chatType: 'private', userId: 'u1', role: 'user', text: 'trash small talk', messageId: 't1', createdAt: new Date(now - 48 * 3600 * 1000).toISOString() });
  const stats = await memory.consolidate({ now: () => now });
  assert.equal(stats.scored, 0);
  assert.equal(stats.evicted, 0, '无 scorer 不得做低分淘汰');
  const after = await memory.retrieve({ botId: 'bot', chatType: 'private', userId: 'u1', query: 'secret' });
  assert.ok(after.context.includes('trash small talk'), '无 scorer 时保留原文');
});
