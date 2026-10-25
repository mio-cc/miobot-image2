// Suno 歌曲历史全局共享 + 分支版本回归：
//   1. 旧 v1 文件自动回填 globalSeq（按 createdAt 升序），迁移后新旧查找均可用
//   2. 全局列表/查找跨会话跨用户；列表不标注来源群与生成者
//   3. 分支版本（variantOf/variantIndex）入库后 findVariantOf 双向可达；单版歌无可取分支
//   4. 三个 handler（history/replay/variant）全局语义：任何用户可查/可回放/可取另一版任何人的歌
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SunoSongHistoryStore } from '../dist/apps/bot/src/suno-song-history.js';
import { SunoHistoryCapabilityHandler, SunoReplayCapabilityHandler, SunoVariantCapabilityHandler } from '../dist/apps/bot/src/capability-suno-library.js';
import { builtinCapabilityDescriptors } from '../dist/packages/orchestration/src/index.js';

function tempStore(seed) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suno-hist-'));
  const filePath = path.join(dir, 'suno-song-history.json');
  if (seed) fs.writeFileSync(filePath, JSON.stringify(seed), 'utf8');
  const store = new SunoSongHistoryStore({ filePath, maxRecords: () => 100 });
  return { store, filePath, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const rec = (over = {}) => ({
  id: `song_${Math.random().toString(36).slice(2)}_x`,
  seq: 1,
  scopeKey: 'group:1:2',
  chatType: 'group',
  chatId: '1',
  userQq: '2',
  createdAt: new Date().toISOString(),
  requestText: '来首歌',
  taskId: 'task-A',
  audioUrl: 'https://example.com/a.mp3',
  ...over,
});

test('回归: 旧 v1 文件自动回填 globalSeq（按 createdAt 升序）', () => {
  const seed = {
    version: 1,
    records: [
      rec({ id: 'song_old_2', createdAt: '2026-10-24T10:00:00.000Z', audioUrl: 'https://example.com/2.mp3' }),
      rec({ id: 'song_old_1', createdAt: '2026-10-24T09:00:00.000Z', audioUrl: 'https://example.com/1.mp3' }),
    ],
  };
  const { store, cleanup } = tempStore(seed);
  try {
    const list = store.listGlobal(50);
    assert.equal(list.length, 2);
    assert.equal(list[0].id, 'song_old_2', '时间新的排前面');
    assert.equal(list[1].globalSeq, 1);
    assert.equal(list[0].globalSeq, 2);
  } finally { cleanup(); }
});

test('回归: add 递增 globalSeq；分支记录带 variantOf/variantIndex', () => {
  const { store, cleanup } = tempStore(null);
  try {
    const a = store.add({ chatType: 'group', groupId: 1, userQq: '2', requestText: '来首歌', taskId: 'task-A', audioUrl: 'https://example.com/a.mp3', variantIndex: 1 });
    const b = store.add({ chatType: 'group', groupId: 1, userQq: '2', requestText: '来首歌（分支）', taskId: 'task-A', audioUrl: 'https://example.com/b.mp3', variantOf: a.id, variantIndex: 2 });
    const c = store.add({ chatType: 'private', userQq: '9', requestText: '私聊点歌', taskId: 'task-B', audioUrl: 'https://example.com/c.mp3', variantIndex: 1 });
    assert.equal(a.globalSeq, 1);
    assert.equal(b.globalSeq, 2);
    assert.equal(c.globalSeq, 3);
    assert.deepEqual([a.variantIndex, b.variantIndex], [1, 2]);
    assert.equal(b.variantOf, a.id);
  } finally { cleanup(); }
});

test('回归: findGlobal 跨会话跨用户——recordId/globalSeq/标题均可命中', () => {
  const { store, cleanup } = tempStore(null);
  try {
    const a = store.add({ chatType: 'group', groupId: 1, userQq: '2', requestText: '甩葱歌', taskId: 'task-A', title: '甩葱歌', audioUrl: 'https://example.com/a.mp3', variantIndex: 1 });
    store.add({ chatType: 'private', userQq: '9', requestText: '别的歌', taskId: 'task-B', title: '别的歌', audioUrl: 'https://example.com/c.mp3', variantIndex: 1 });
    assert.equal(store.findGlobal({ recordId: a.id })?.id, a.id, 'recordId 全局唯一可查');
    assert.equal(store.findGlobal({ globalSeq: a.globalSeq })?.id, a.id);
    assert.equal(store.findGlobal({ title: '甩葱歌' })?.id, a.id, '另一用户的会话也能按标题命中');
    assert.equal(store.findGlobal({ globalSeq: 999 }), undefined);
  } finally { cleanup(); }
});

test('回归: findVariantOf 双向可达（主版↔B版）；单版歌返回 undefined', () => {
  const { store, cleanup } = tempStore(null);
  try {
    const a = store.add({ chatType: 'group', groupId: 1, userQq: '2', requestText: '歌A', taskId: 'task-A', audioUrl: 'https://example.com/a.mp3', variantIndex: 1 });
    const b = store.add({ chatType: 'group', groupId: 1, userQq: '2', requestText: '歌A（分支）', taskId: 'task-A', audioUrl: 'https://example.com/b.mp3', variantOf: a.id, variantIndex: 2 });
    const single = store.add({ chatType: 'private', userQq: '9', requestText: '单版歌', taskId: 'task-B', audioUrl: 'https://example.com/c.mp3', variantIndex: 1 });
    assert.equal(store.findVariantOf(a)?.id, b.id, '主版 → B版');
    assert.equal(store.findVariantOf(b)?.id, a.id, 'B版 → 主版');
    assert.equal(store.findVariantOf(single), undefined, '单版歌没有另一版');
  } finally { cleanup(); }
});

test('回归: formatListGlobal 不标注来源群与生成者，含分支标记；空列表文案', () => {
  const { store, cleanup } = tempStore(null);
  try {
    assert.equal(store.formatListGlobal(20), '还没有生成过歌曲。');
    const a = store.add({ chatType: 'group', groupId: 1, userQq: '2', requestText: '歌A', taskId: 'task-A', title: '歌A', audioUrl: 'https://example.com/a.mp3', duration: 92.4, variantIndex: 1 });
    store.add({ chatType: 'group', groupId: 1, userQq: '2', requestText: '歌A（分支）', taskId: 'task-A', title: '歌A', audioUrl: 'https://example.com/b.mp3', variantOf: a.id, variantIndex: 2 });
    const text = store.formatListGlobal(20);
    assert.ok(!text.includes('group:'), '不得出现来源群标注');
    assert.ok(!text.includes('2238639363') && !text.includes('userQq'), '不得出现生成者标注');
    assert.ok(/#1 歌A \| .* \| 92s \| 有B版/.test(text), `主版行应带"有B版"标记：${text}`);
    assert.ok(/#2 歌A \| .* \| B版/.test(text), 'B版行应带"B版"标记');
  } finally { cleanup(); }
});

function invocation(args, { chatType = 'group', groupId = 7, userQq = '777' } = {}) {
  return {
    request: { chat: { type: chatType, groupId: String(groupId), userId: userQq }, user: { qq: userQq, role: 'user' }, text: 'x', attachments: [], receivedAt: new Date().toISOString() },
    plan: { planId: 'plan_t' },
    step: { id: 's1', capability: 'x', args },
    dependencyResults: {},
  };
}

test('回归: 三个 handler 全局语义——任何用户可查/可回放/可取另一版任何人的歌', async () => {
  const { store, cleanup } = tempStore(null);
  try {
    const primary = store.add({ chatType: 'group', groupId: 1, userQq: '2', requestText: '甩葱歌', taskId: 'task-A', title: '甩葱歌', audioUrl: 'https://example.com/a.mp3', variantIndex: 1 });
    const branch = store.add({ chatType: 'group', groupId: 1, userQq: '2', requestText: '甩葱歌（分支）', taskId: 'task-A', title: '甩葱歌', audioUrl: 'https://example.com/b.mp3', variantOf: primary.id, variantIndex: 2 });

    // 用户 777 在群 7（与生成者 2/群 1 完全无关）
    const history = await new SunoHistoryCapabilityHandler(store).execute(invocation({}));
    assert.equal(history.status, 'success');
    assert.match(String(history.outputs[0].text), /甩葱歌/);

    const replay = await new SunoReplayCapabilityHandler(store).execute(invocation({ title: '甩葱歌' }, { userQq: '777', groupId: 7 }));
    assert.equal(replay.status, 'success');
    assert.equal(replay.outputs[0].url, 'https://example.com/a.mp3', '跨用户回放主版');

    const variant = await new SunoVariantCapabilityHandler(store).execute(invocation({ title: '甩葱歌' }, { userQq: '777', groupId: 7 }));
    assert.equal(variant.status, 'success');
    assert.equal(variant.outputs[0].url, 'https://example.com/b.mp3', '跨用户取 B 版');
    assert.equal(variant.outputs[0].meta?.variantIndex, 2);

    // 模型可能直接选中列表里的 B 版行（globalSeq/recordId 指向分支记录）——此时应发送该分支本身
    const direct = await new SunoVariantCapabilityHandler(store).execute(invocation({ recordId: branch.id }, { userQq: '777', groupId: 7 }));
    assert.equal(direct.status, 'success');
    assert.equal(direct.outputs[0].url, 'https://example.com/b.mp3', '直接传分支记录也应发送 B 版');
  } finally { cleanup(); }
});

test('回归: 单版歌取另一版 → needs_input 提示只有一个版本', async () => {
  const { store, cleanup } = tempStore(null);
  try {
    store.add({ chatType: 'group', groupId: 1, userQq: '2', requestText: '单版歌', taskId: 'task-B', title: '单版歌', audioUrl: 'https://example.com/c.mp3', variantIndex: 1 });
    const result = await new SunoVariantCapabilityHandler(store).execute(invocation({ title: '单版歌' }));
    assert.equal(result.status, 'needs_input');
    assert.ok(String(result.outputs[0].text).includes('只保留了一个版本'));
  } finally { cleanup(); }
});

test('回归: 找不到歌时 needs_input 附全局历史列表', async () => {
  const { store, cleanup } = tempStore(null);
  try {
    store.add({ chatType: 'group', groupId: 1, userQq: '2', requestText: '存在的歌', taskId: 't', title: '存在的歌', audioUrl: 'https://example.com/x.mp3', variantIndex: 1 });
    const result = await new SunoReplayCapabilityHandler(store).execute(invocation({ title: '不存在的歌' }));
    assert.equal(result.status, 'needs_input');
    assert.match(String(result.outputs[0].text), /存在的歌/);
  } finally { cleanup(); }
});

test('回归: audio.music.variant 描述符已注册（sync/low/audio，不进 sunoEnabled 门）', () => {
  const descriptor = builtinCapabilityDescriptors().find((d) => d.id === 'audio.music.variant');
  assert.ok(descriptor, 'audio.music.variant 描述符应存在');
  assert.equal(descriptor.mode, 'sync');
  assert.equal(descriptor.riskLevel, 'low');
  assert.deepEqual(descriptor.outputKinds, ['audio']);
  // 与 history/replay 一致：不依赖 Suno 开关（纯历史读取，Suno 关闭也能查）
  const gates = descriptor.external;
  assert.notEqual(gates, true, '不应标记 external');
});
