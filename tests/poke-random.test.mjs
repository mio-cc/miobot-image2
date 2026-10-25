// 戳一戳回复随机性验证：
//   1. 均匀性——所有配置文案都会出现（Math.random 均匀分布的统计验证）
//   2. 防连续重复——重抽机制让相邻两次同句的概率从 1/n 降到 (1/n)²
import test from 'node:test';
import assert from 'node:assert/strict';

import { createBotMessageRuntime } from '../dist/apps/bot/src/main.js';
import { createDefaultConfig } from '../dist/packages/config/src/index.js';

function makeCfg() {
  const cfg = createDefaultConfig();
  cfg.bot.botQqId = '10000';
  cfg.bot.poke = { enabled: true, cooldownSec: 0, replies: ['戳我干嘛呀', '别戳啦，在的呢', '收到收到，有事直接说~', '再戳就报警了哦'] };
  return cfg;
}

test('戳一戳: 400 次采样覆盖全部文案（均匀分布）且极少连续重复', async () => {
  const sentTexts = [];
  const runtime = createBotMessageRuntime({
    app: { handle: async () => null, engine: { async handleExplicit() { return null; } }, sessions: { clear() {}, get: () => [], append() {} }, registry: () => ({}), client: {} },
    reply: { async sendGroupText(_groupId, text) { sentTexts.push(text); return { success: true, messageId: sentTexts.length }; }, async sendPrivateText(_userId, text) { sentTexts.push(text); return { success: true, messageId: sentTexts.length }; } },
    getConfig: makeCfg,
    selfId: () => '10000', botName: 'Mio',
  });
  const handlers = {};
  runtime.attach({ on(event, handler) { handlers[event] = handler; } });
  const notice = (i) => ({ post_type: 'notice', notice_type: 'notify', sub_type: 'poke', target_id: 10000, user_id: 5, group_id: 100, time: i });
  for (let i = 0; i < 400; i += 1) await handlers.notice(notice(i));

  const pool = ['戳我干嘛呀', '别戳啦，在的呢', '收到收到，有事直接说~', '再戳就报警了哦'];
  assert.equal(sentTexts.length, 400, '冷却为 0 时每次戳都应回复');
  for (const text of pool) assert.ok(sentTexts.includes(text), `文案「${text}」400 次内应至少出现一次（均匀性）`);

  // 防连续重复：相邻两次同句的数量应显著低于无重抽的期望（400 次约 100 次）
  let sameInARow = 0;
  for (let i = 1; i < sentTexts.length; i += 1) if (sentTexts[i] === sentTexts[i - 1]) sameInARow += 1;
  assert.ok(sameInARow < 80, `连续重复应被重抽机制显著抑制（实测 ${sameInARow}/399，无重抽期望约 100）`);

  // 群白名单外（未配置白名单 = 全放行）与私聊戳也回复
  await handlers.notice({ post_type: 'notice', notice_type: 'notify', sub_type: 'poke', target_id: 10000, user_id: 9 });
  assert.ok(sentTexts.length > 400, '私聊戳也应回复');
});
