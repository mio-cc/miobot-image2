// Suno 歌曲历史全局共享 + 分支版本回归：
//   1. 旧 v1 文件自动回填 globalSeq（按 createdAt 升序），迁移后新旧查找均可用
//   2. 全局列表/查找跨会话跨用户；列表不标注来源群与生成者
//   3. 分支版本（variantOf/variantIndex）入库后 findVariantOf 双向可达；单版歌无可取分支
//   4. 三个 handler（history/replay/variant）全局语义：任何用户可查/可回放/可取另一版任何人的歌
//   5. A/B 完整性护栏：scope/全局裁剪成对化（不产生孤儿 B，存量孤儿自然消失）、
//      混合态迁移只补缺不重排（已有编号不漂移）、孤儿 B 不标 B版（不伪造配对）、主版入库失败不落分支
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SunoSongHistoryStore } from '../dist/apps/bot/src/suno-song-history.js';
import { SunoHistoryCapabilityHandler, SunoReplayCapabilityHandler, SunoVariantCapabilityHandler } from '../dist/apps/bot/src/capability-suno-library.js';
import { SunoCapabilityHandler } from '../dist/apps/bot/src/capability-suno.js';
import { createDefaultConfig } from '../dist/packages/config/src/index.js';
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
    assert.match(text, /id=song_/, '历史列表必须带精确 recordId');
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

test('回归: scope 裁剪成对化——到达上限后不产生孤儿 B', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suno-hist-'));
  const filePath = path.join(dir, 'suno-song-history.json');
  try {
    const store = new SunoSongHistoryStore({ filePath, maxRecords: () => 5 });
    const addPair = (taskId) => {
      const a = store.add({ chatType: 'group', groupId: 1, userQq: '2', requestText: taskId, taskId, audioUrl: `https://example.com/${taskId}-a.mp3`, variantIndex: 1 });
      store.add({ chatType: 'group', groupId: 1, userQq: '2', requestText: `${taskId}（分支）`, taskId, audioUrl: `https://example.com/${taskId}-b.mp3`, variantOf: a.id, variantIndex: 2 });
    };
    for (let i = 1; i <= 4; i += 1) {
      addPair(`task-${i}`);
      // 不变量：任一存活分支的 variantOf 必须指向存活记录——裁剪不得拆对产生孤儿 B
      for (const item of store.records) {
        if (item.variantOf) assert.ok(store.records.some((x) => x.id === item.variantOf), `分支 ${item.id} 的主版 ${item.variantOf} 不应消失`);
      }
    }
    assert.ok(store.records.length <= 5, 'scope 记录数不超过上限');
    assert.ok(store.records.some((item) => (Number(item.variantIndex) || 1) === 2), '保留窗口内仍有成对分支');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('回归: 存量悬空孤儿在该 scope 下次裁剪时自然消失（不做一次性清理）', () => {
  // 孤儿分支 seq 较新（落在保留窗口内）：普通裁剪不会动它，依赖裁剪应将其剔除
  const seed = {
    version: 2,
    records: [
      rec({ id: 'song_normal_1', seq: 1, globalSeq: 1 }),
      rec({ id: 'song_orphan_branch', seq: 2, globalSeq: 2, taskId: 'task-dead', variantOf: 'song_missing_main', variantIndex: 2 }),
      rec({ id: 'song_normal_2', seq: 3, globalSeq: 3 }),
    ],
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suno-hist-'));
  const filePath = path.join(dir, 'suno-song-history.json');
  fs.writeFileSync(filePath, JSON.stringify(seed), 'utf8');
  try {
    const store = new SunoSongHistoryStore({ filePath, maxRecords: () => 3 });
    store.add({ chatType: 'group', groupId: 1, userQq: '2', requestText: '新歌', taskId: 'task-new', audioUrl: 'https://example.com/new.mp3', variantIndex: 1 });
    assert.ok(!store.records.some((item) => item.id === 'song_orphan_branch'), '悬空孤儿应在下次裁剪时被剔除');
    assert.ok(store.records.some((item) => item.id === 'song_normal_2'), '无关记录不受影响');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('回归: 混合态迁移只补缺——已有 globalSeq 不漂移', () => {
  const seed = {
    version: 2,
    records: [
      rec({ id: 'song_has_10', globalSeq: 10, createdAt: '2026-10-24T09:00:00.000Z' }),
      rec({ id: 'song_missing_early', createdAt: '2026-10-24T10:00:00.000Z' }),
      rec({ id: 'song_has_30', globalSeq: 30, createdAt: '2026-10-24T11:00:00.000Z' }),
      rec({ id: 'song_missing_late', createdAt: '2026-10-24T12:00:00.000Z' }),
    ],
  };
  const { store, cleanup } = tempStore(seed);
  try {
    const byId = new Map(store.records.map((item) => [item.id, item]));
    assert.equal(byId.get('song_has_10').globalSeq, 10, '已有编号不动');
    assert.equal(byId.get('song_has_30').globalSeq, 30, '已有编号不动');
    assert.equal(byId.get('song_missing_early').globalSeq, 31, '缺失记录在现有最大值之后顺延补号（createdAt 早者优先）');
    assert.equal(byId.get('song_missing_late').globalSeq, 32, '缺失记录在现有最大值之后顺延补号');
    const seqs = store.records.map((item) => item.globalSeq);
    assert.equal(new Set(seqs).size, seqs.length, '补号后无重复编号');
  } finally { cleanup(); }
});

test('回归: 孤儿 B 展示——主版不在库时不标 B版、不伪造配对', () => {
  const seed = {
    version: 2,
    records: [
      rec({ id: 'song_other_main', seq: 1, globalSeq: 1, taskId: 'task-other' }),
      rec({ id: 'song_branch_orphan', seq: 2, globalSeq: 2, taskId: 'task-dead', variantOf: 'song_gone', variantIndex: 2 }),
      rec({ id: 'song_main', seq: 3, globalSeq: 3, taskId: 'task-live', variantIndex: 1 }),
      rec({ id: 'song_branch_live', seq: 4, globalSeq: 4, taskId: 'task-live', variantOf: 'song_main', variantIndex: 2 }),
    ],
  };
  const { store, cleanup } = tempStore(seed);
  try {
    const text = store.formatListGlobal(10);
    const line = (seq) => text.split('\n').find((l) => l.startsWith(`#${seq} `));
    assert.match(line(4), /B版/, '主版存活的分支仍标 B版');
    assert.match(line(3), /有B版/, '主版行仍标 有B版');
    assert.ok(line(2) && !line(2).includes('B版'), `孤儿分支不应带任何 B版 标记：${line(2)}`);
    assert.ok(line(1) && !line(1).includes('B版'), `无关主版不应被伪造配对标记：${line(1)}`);
  } finally { cleanup(); }
});

test('回归: 主版入库失败时不落分支（无主 B 版不再产生）', async () => {
  const { store: real, cleanup } = tempStore(null);
  try {
    const failingMainStore = {
      add(input) {
        if ((Number(input.variantIndex) || 1) === 1) throw new Error('disk full');
        return real.add(input);
      },
    };
    const cfg = createDefaultConfig();
    cfg.orchestration.suno.enabled = true;
    const handler = new SunoCapabilityHandler({
      getConfig: () => cfg,
      history: failingMainStore,
      createClient: () => ({
        async create() { return { id: 'task-nomain', raw: {} }; },
        async wait() { return { id: 'task-nomain', status: 'success', raw: {}, outputs: [
          { url: 'https://cdn/a.mp3', audioId: 'a1', title: '歌A' },
          { url: 'https://cdn/b.mp3', audioId: 'b1', title: '歌A' },
        ] }; },
      }),
    });
    const result = await handler.execute({
      plan: { planId: 'p', requestId: 'r', goal: 'song', steps: [] },
      step: { id: 's', capability: 'audio.music.generate', args: {} },
      request: { requestId: 'r', text: '来首歌', chat: { type: 'private', userId: '1' }, user: { qq: '1', role: 'user' }, attachments: [] },
    });
    assert.equal(result.status, 'success');
    assert.equal(result.outputs[0].url, 'https://cdn/a.mp3', '交付不受历史写入失败影响');
    assert.equal(real.records.length, 0, '主版入库失败时不应落分支');
  } finally { cleanup(); }
});
