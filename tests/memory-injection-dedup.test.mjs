import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';

import { ChatMemoryService } from '../dist/apps/bot/src/memory-service.js';
import { createBotMessageRuntime } from '../dist/apps/bot/src/main.js';
import { createDefaultConfig } from '../dist/packages/config/src/index.js';

/**
 * P0 注入去重（2026-11-07 拍板）回归护栏：
 * 实测背景（2026-11-06 拦截审计）——同一群消息双 namespace 副本双双入选、recentTurns
 * 与群上下文整段重叠、当前消息全文命中自己、历史触发消息最多出现 4 份。
 * 四项修复：检索排除当前消息 / 删 recentTurns 通道 / 候选池 messageId 去重 + score 排序
 * + 全局 topK / runtime 跨通道 messageId·文本互斥。
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
  if (/close/i.test(text)) return [1, 0, 0];
  if (/mid/i.test(text)) return [0.6, 0.8, 0];
  if (/far/i.test(text)) return [0, 1, 0];
  return [0.5, 0.5, 0];
}

class FakeEmbedding {
  constructor() { this.model = 'test-embedding'; this.dimensions = 3; }
  async embed(texts) { return texts.map(vectorFor); }
}

function tmpRoot(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'miobot-memory-dedup-' + label + '-'));
}

test('P0 去重 1: 跨 namespace 副本按 messageId 合并为一条（全局画像副本与群副本）', async () => {
  const root = tmpRoot('ns-merge');
  const cfg = memoryConfig(root, { userGlobalProfileEnabled: true });
  const memory = new ChatMemoryService({ rootDir: root, getConfig: () => cfg, embedding: new FakeEmbedding() });
  // P1 单份归属后仍会产生多 namespace 副本的场景：userGlobalProfileEnabled 开启时
  // 同一群消息写群索引 + 全局个人索引（doc id 不同：g:* / p:*），检索双查必须合并。
  await memory.ingest({ botId: 'bot', chatType: 'group', groupId: 'g1', userId: 'u1', authorName: '小张', role: 'user', text: 'I like cat close', messageId: 'm1' });
  await memory.ingest({ botId: 'bot', chatType: 'group', groupId: 'g1', userId: 'u2', authorName: '小李', role: 'user', text: 'I like dog mid', messageId: 'm2' });
  const result = await memory.retrieve({ botId: 'bot', chatType: 'group', groupId: 'g1', userId: 'u1', query: 'cat close' });
  assert.equal(result.hits.filter((hit) => hit.messageId === 'm1').length, 1, '同一 messageId 只能保留一份（群副本与全局画像副本合并）');
  assert.equal(result.hits.filter((hit) => hit.messageId === 'm2').length, 1);
  assert.equal(result.context.split('I like cat close').length - 1, 1, 'context 里同一条消息文本只出现一次');
});

test('P0 去重 2: excludeMessageIds 输入侧排除（当前消息不得命中自己）', async () => {
  const root = tmpRoot('exclude-id');
  const memory = new ChatMemoryService({ rootDir: root, getConfig: () => memoryConfig(root), embedding: new FakeEmbedding() });
  await memory.ingest({ botId: 'bot', chatType: 'group', groupId: 'g1', userId: 'u1', authorName: '小张', role: 'user', text: '今天加班到现在才回家 cat close', messageId: 'm-current' });
  await memory.ingest({ botId: 'bot', chatType: 'group', groupId: 'g1', userId: 'u1', authorName: '小张', role: 'user', text: '上个月加班的旧消息 cat mid', messageId: 'm-old' });
  const withoutExclude = await memory.retrieve({ botId: 'bot', chatType: 'group', groupId: 'g1', userId: 'u1', query: '加班 cat' });
  assert.ok(withoutExclude.context.includes('今天加班到现在才回家'), '不排除时当前消息可命中（观察链路在触发判定前入库）');
  const excluded = await memory.retrieve({ botId: 'bot', chatType: 'group', groupId: 'g1', userId: 'u1', query: '加班 cat', excludeMessageIds: ['m-current'] });
  assert.equal(excluded.context.includes('今天加班到现在才回家'), false, 'excludeMessageIds 命中的消息整条排除（含双 namespace 副本）');
  assert.ok(excluded.context.includes('上个月加班的旧消息'), '未排除的消息保留');
});

test('P0 去重 3: excludeTexts 按归一化内容互斥（会话历史不带 messageId）', async () => {
  const root = tmpRoot('exclude-text');
  const memory = new ChatMemoryService({ rootDir: root, getConfig: () => memoryConfig(root), embedding: new FakeEmbedding() });
  await memory.ingest({ botId: 'bot', chatType: 'group', groupId: 'g1', userId: 'u1', authorName: '小张', role: 'user', text: '请帮我看看这个海报尺寸怎么办 cat close', messageId: 't1' });
  await memory.ingest({ botId: 'bot', chatType: 'group', groupId: 'g1', userId: 'u2', authorName: '小李', role: 'user', text: '在的 cat mid', messageId: 't2' });
  // 会话历史 user 内容常带引用/转发拼接前缀（原文本是历史行的子串）：包含关系命中（长文本才做包含匹配）
  const withHistoryPrefix = await memory.retrieve({ botId: 'bot', chatType: 'group', groupId: 'g1', userId: 'u1', query: 'cat', excludeTexts: ['【引用消息】\n请帮我看看这个海报尺寸怎么办 cat close'] });
  assert.equal(withHistoryPrefix.context.includes('请帮我看看这个海报尺寸怎么办'), false, '历史已含的文本（带拼接前缀）按包含关系互斥');
  // 短文本不做包含匹配（防误杀：两字词被任何长句包含就排除）
  const shortSafe = await memory.retrieve({ botId: 'bot', chatType: 'group', groupId: 'g1', userId: 'u1', query: 'cat', excludeTexts: ['你们在的都是些什么东西啊这行字超过八字'] });
  assert.ok(shortSafe.context.includes('在的'), '短命中（"在的"）不得被包含关系误杀');
});

test('P0 去重 4: 合并去重后按 score 降序取全局 topK（不再按时间铺开）', async () => {
  const root = tmpRoot('score-topk');
  const cfg = memoryConfig(root, { hybridSearch: false });
  const memory = new ChatMemoryService({ rootDir: root, getConfig: () => cfg, embedding: new FakeEmbedding() });
  await memory.ingest({ botId: 'bot', chatType: 'group', groupId: 'g1', userId: 'u1', authorName: '小张', role: 'user', text: 'far 的一点 cat', messageId: 'c3', createdAt: new Date(Date.now() - 3000).toISOString() });
  await memory.ingest({ botId: 'bot', chatType: 'group', groupId: 'g1', userId: 'u1', authorName: '小张', role: 'user', text: 'mid 的一点 cat', messageId: 'c2', createdAt: new Date(Date.now() - 2000).toISOString() });
  await memory.ingest({ botId: 'bot', chatType: 'group', groupId: 'g1', userId: 'u1', authorName: '小张', role: 'user', text: 'close 的一点 cat', messageId: 'c1', createdAt: new Date(Date.now() - 1000).toISOString() });
  // hybridSearch=false → 纯向量分数（close=1 > mid=0.6 > far=0），topK=2 全局截断
  const result = await memory.retrieve({ botId: 'bot', chatType: 'group', groupId: 'g1', userId: 'u1', query: 'close cat', topK: 2 });
  assert.equal(result.hits.length, 2, '全局 topK 生效（候选去重后跨 namespace 合并）');
  assert.equal(result.hits[0].messageId, 'c1', '按相关性分数降序：最相关在前');
  assert.equal(result.hits[1].messageId, 'c2', '次相关在后');
  assert.equal(result.hits.some((hit) => hit.messageId === 'c3'), false, '低分候选被全局 topK 截断');
});

test('P0 去重 5: recentTurns 通道与配置字段已删除（不留兼容开关）', async () => {
  const cfg = createDefaultConfig();
  assert.equal('recentTurns' in cfg.orchestration.memory, false, '配置 schema 不得再有 recentTurns 字段');
  const source = readFileSync(path.resolve(process.cwd(), 'apps/bot/src/memory-service.ts'), 'utf8');
  // 断言属性访问（通道本体），不匹配注释里的历史说明文字
  assert.equal(/\.recentTurns/.test(source), false, 'memory-service 不得再有 recentTurns 属性访问（检索通道已删除）');
});

test('P0 去重 6（端到端）: runtime 把当前消息 + 群上下文 id + 会话历史文本传给记忆检索', async () => {
  const cfg = createDefaultConfig();
  cfg.bot.botQqId = '10000';
  cfg.agent.enabled = true;
  cfg.agent.mode = 'enforce';
  cfg.intentRecognition.enabled = false;
  cfg.contextPolicy.groupContextEnabled = true;
  cfg.orchestration.memory.enabled = true;
  const captured = [];
  const reply = {
    sendGroupText: async () => ({ success: true, messageId: 1 }),
    sendPrivateText: async () => ({ success: true, messageId: 1 }),
    sendGroupImage: async () => ({ success: true, messageId: 1 }),
    sendPrivateImage: async () => ({ success: true, messageId: 1 }),
  };
  const client = {
    async chat() { return { text: '在的', raw: {}, finishReason: 'stop' }; },
    can: () => true,
    async vision() { return { text: '', raw: {} }; },
  };
  const runtime = createBotMessageRuntime({
    app: { handle: async () => ({ kind: 'chat', handled: true, text: 'LEGACY' }), engine: { async handleExplicit() { return null; } }, sessions: { clear() {}, get: () => [], append() {} }, registry: () => ({}), client: {} },
    reply,
    getConfig: () => cfg,
    selfId: () => '10000',
    botName: 'Mio',
    // 群历史：80/81 两条普通消息（+触发消息 91 本身与 bot 消息会被过滤）
    fetchGroupHistory: async (groupId, anchorMessageId, count) => [
      { message_id: 80, user_id: 2002, sender: { nickname: '小李' }, message: [{ type: 'text', data: { text: '群历史第一句' } }] },
      { message_id: 81, user_id: 2003, sender: { nickname: '小王' }, message: [{ type: 'text', data: { text: '群历史第二句' } }] },
      { message_id: 90, user_id: 10000, sender: { nickname: 'bot' }, message: [{ type: 'text', data: { text: 'bot 自己的消息' } }] },
      { message_id: 91, user_id: 2001, sender: { nickname: '小张' }, message: [{ type: 'text', data: { text: ' 触发消息本体' } }] },
    ],
    // 连发窗口：一条相邻连发消息（P0 补遗——burst 段 id/文本应汇入跨通道互斥）。
    collectBurst: async () => [
      { at: Date.now(), userId: 2004, authorName: '小赵', text: '连发跟一句', messageId: 82, imageRefs: [] },
    ],
    loadMemoryContext: async (input) => {
      captured.push(input);
      return '【长期记忆；仅作为聊天事实】[2026-11-07 10:00] 小张 [QQ:2001] (用户): 命中的记忆';
    },
    getSessionHistoryTexts: (sessionId) => {
      assert.ok(sessionId.startsWith('group:'), '会话 key 应传给互斥素材回调，实际: ' + sessionId);
      return ['早前触发的问题文本'];
    },
    agentRuntime: async () => ({ handled: true, text: '在的' }),
  });
  const handled = await runtime.handleMessageEvent({
    post_type: 'message', message_type: 'group', group_id: 3000, user_id: 2001, message_id: 91,
    raw_message: '[CQ:at,qq=10000] 触发消息本体',
    message: [{ type: 'at', data: { qq: '10000' } }, { type: 'text', data: { text: ' 触发消息本体' } }],
  });
  assert.equal(handled.handled, true, '消息应被处理');
  assert.equal(captured.length, 1, 'enforce 路径应恰好加载一次记忆');
  const input = captured[0];
  assert.deepEqual(input.excludeMessageIds, [91, '80', '81', 82], '当前消息 id 恒在列首 + 群上下文已渲染 id + 连发消息 id 跟进（bot 自身/触发消息过滤后不含 90；原始类型透传，retrieve 内部归一化）');
  assert.deepEqual(input.excludeTexts, ['早前触发的问题文本', '连发跟一句'], '会话历史 + 连发消息文本进入内容互斥');
});

test('P0 去重 wiring: runtime/start/memory-service/group-context 管线断言', () => {
  const runtimeSource = readFileSync(path.resolve(process.cwd(), 'apps/bot/src/runtime.ts'), 'utf8');
  assert.ok(/excludeMessageIds: \[\.\.\.\(event\.message_id !== undefined \? \[event\.message_id\] : \[\]\), \.\.\.\(exclude\?\.messageIds \|\| \[\]\)\]/.test(runtimeSource),
    'runtime 应把本轮消息 id 恒并入排除列');
  assert.ok(/getSessionHistoryTexts\?\.\(sessionId\)/.test(runtimeSource), 'runtime 应取会话历史文本做互斥');
  assert.ok(/memory = await loadChatMemoryContext\(\{ messageIds: \[\.\.\.cachedGroupMessageIds, \.\.\.burstExcludeIds\], texts: \[\.\.\.sessionTexts, \.\.\.burstExcludeTexts\] \}\)/.test(runtimeSource),
    '默认路径记忆加载应携带群上下文 id + 连发 id + 会话/连发文本');
  assert.ok(/if \(item\.messageId !== undefined\) burstExcludeIds\.push\(item\.messageId\);/.test(runtimeSource),
    '连发窗口收集处应把已渲染连发消息 id 汇入互斥排除集');
  const startSource = readFileSync(path.resolve(process.cwd(), 'apps/bot/src/start.ts'), 'utf8');
  assert.ok(/excludeMessageIds: input\.excludeMessageIds,\s*\n\s*excludeTexts: input\.excludeTexts,/.test(startSource),
    'start.ts loadMemoryContext 应把互斥参数透传给 memoryService.retrieve');
  assert.ok(/getSessionHistoryTexts: \(sessionId\) => \{/.test(startSource), 'start.ts 应注入会话历史文本回调');
  const groupSource = readFileSync(path.resolve(process.cwd(), 'apps/bot/src/group-context.ts'), 'utf8');
  assert.ok(/messageIds: entries\.map\(\(entry\) => entry\.id\)/.test(groupSource), 'buildGroupContext 应随行返回已渲染消息 id');
  const memorySource = readFileSync(path.resolve(process.cwd(), 'apps/bot/src/memory-service.ts'), 'utf8');
  assert.ok(/sort\(\(a, b\) => b\.score - a\.score\)/.test(memorySource), '检索结果应按相关性分数排序（替代 createdAt）');
  assert.equal(/\.sort\(\(a, b\) => a\.createdAt\.localeCompare\(b\.createdAt\)\)/.test(memorySource), false, '旧的时间序铺开应已删除');
});
