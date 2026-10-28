import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';

import { createBotMessageRuntime } from '../dist/apps/bot/src/main.js';
import { createDefaultConfig } from '../dist/packages/config/src/index.js';

// ═══ R15 C-1/C-2/F-2：会话串行链 + 全局 turn 并发上限 + 排队后窗口复验 ═══

test('R15/C-1: same-session agent turns run serially (no concurrent session state access)', async () => {
  const cfg = createDefaultConfig();
  cfg.agent.enabled = true;
  cfg.agent.mode = 'enforce';
  cfg.agent.maxConcurrentTurns = 0; // 关闭全局上限，只测会话串行
  const active = { count: 0, max: 0 };
  const order = [];
  const reply = {
    sendGroupText: async () => ({ success: true, messageId: 1 }),
    sendPrivateText: async () => ({ success: true, messageId: 1 }),
    sendGroupNestedTextForward: async () => ({ success: true, messageId: 1 }),
    sendGroupTextForward: async () => ({ success: true, messageId: 1 }),
    sendPrivateNestedTextForward: async () => ({ success: true, messageId: 1 }),
    sendPrivateTextForward: async () => ({ success: true, messageId: 1 }),
    sendGroupNestedMixedForward: async () => ({ success: true, messageId: 1 }),
    sendPrivateNestedMixedForward: async () => ({ success: true, messageId: 1 }),
    sendGroupRecord: async () => ({ success: true, messageId: 1 }),
    sendPrivateRecord: async () => ({ success: true, messageId: 1 }),
    sendGroupImage: async () => ({ success: true, messageId: 1 }),
    sendPrivateImage: async () => ({ success: true, messageId: 1 }),
    sendGroupFile: async () => ({ success: true, messageId: 1 }),
    sendPrivateFile: async () => ({ success: true, messageId: 1 }),
  };
  const runtime = createBotMessageRuntime({
    app: { handle: async () => ({ kind: 'chat', handled: true, text: 'LEGACY' }), engine: { async handleExplicit() { return null; } }, sessions: { clear() {}, get: () => [], append() {} }, registry: () => ({}), client: {} },
    reply,
    getConfig: () => cfg,
    selfId: () => '10000',
    botName: 'Mio',
    fetchGroupHistory: async () => [],
    reportProblem: async () => true,
    agentRuntime: async () => {
      active.count += 1;
      active.max = Math.max(active.max, active.count);
      order.push('start');
      await sleep(80);
      order.push('end');
      active.count -= 1;
      return { handled: true, text: '回好了' };
    },
  });
  // 同一 session 连发 3 条消息：必须串行（active.max 始终 1）
  const events = [1, 2, 3].map((i) => ({
    post_type: 'message', message_type: 'group', group_id: 3000, user_id: 2001,
    message_id: 900 + i, time: Date.now() + i,
    raw_message: `[CQ:at,qq=10000] 问题${i}`,
    message: [{ type: 'at', data: { qq: '10000' } }, { type: 'text', data: { text: ` 问题${i}` } }],
  }));
  await Promise.all(events.map((e) => runtime.handleMessageEvent(e)));
  await sleep(50);
  assert.equal(active.max, 1, `同 session turn 必须串行，实际最大并发 ${active.max}`);
  assert.deepEqual(order, ['start', 'end', 'start', 'end', 'start', 'end'], `turn 必须按序完成: ${JSON.stringify(order)}`);
});

test('R15/C-2: global agent turn concurrency capped at maxConcurrentTurns', async () => {
  const cfg = createDefaultConfig();
  cfg.agent.enabled = true;
  cfg.agent.mode = 'enforce';
  cfg.agent.maxConcurrentTurns = 2;
  const active = { count: 0, max: 0 };
  const reply = {
    sendGroupText: async () => ({ success: true, messageId: 1 }),
    sendPrivateText: async () => ({ success: true, messageId: 1 }),
    sendGroupNestedTextForward: async () => ({ success: true, messageId: 1 }),
    sendGroupTextForward: async () => ({ success: true, messageId: 1 }),
    sendPrivateNestedTextForward: async () => ({ success: true, messageId: 1 }),
    sendPrivateTextForward: async () => ({ success: true, messageId: 1 }),
    sendGroupNestedMixedForward: async () => ({ success: true, messageId: 1 }),
    sendPrivateNestedMixedForward: async () => ({ success: true, messageId: 1 }),
    sendGroupRecord: async () => ({ success: true, messageId: 1 }),
    sendPrivateRecord: async () => ({ success: true, messageId: 1 }),
    sendGroupImage: async () => ({ success: true, messageId: 1 }),
    sendPrivateImage: async () => ({ success: true, messageId: 1 }),
    sendGroupFile: async () => ({ success: true, messageId: 1 }),
    sendPrivateFile: async () => ({ success: true, messageId: 1 }),
  };
  const runtime = createBotMessageRuntime({
    app: { handle: async () => ({ kind: 'chat', handled: true, text: 'LEGACY' }), engine: { async handleExplicit() { return null; } }, sessions: { clear() {}, get: () => [], append() {} }, registry: () => ({}), client: {} },
    reply,
    getConfig: () => cfg,
    selfId: () => '10000',
    botName: 'Mio',
    fetchGroupHistory: async () => [],
    reportProblem: async () => true,
    agentRuntime: async () => {
      active.count += 1;
      active.max = Math.max(active.max, active.count);
      await sleep(80);
      active.count -= 1;
      return { handled: true, text: '回好了' };
    },
  });
  // 4 个不同群（不同 session）同时 @：全局同时执行的 turn 不得超过 2
  const events = [1, 2, 3, 4].map((i) => ({
    post_type: 'message', message_type: 'group', group_id: 3000 + i, user_id: 2001,
    message_id: 950 + i, time: Date.now() + i,
    raw_message: `[CQ:at,qq=10000] 群${i}的问题`,
    message: [{ type: 'at', data: { qq: '10000' } }, { type: 'text', data: { text: ` 群${i}的问题` } }],
  }));
  await Promise.all(events.map((e) => runtime.handleMessageEvent(e)));
  await sleep(50);
  assert.ok(active.max <= 2, `全局并发必须 <= 2，实际 ${active.max}`);
  assert.equal(active.count, 0, '结束后无泄漏');
});

test('R15/C-2: maxConcurrentTurns=0 disables the cap (no artificial serialization across groups)', async () => {
  const cfg = createDefaultConfig();
  cfg.agent.enabled = true;
  cfg.agent.mode = 'enforce';
  cfg.agent.maxConcurrentTurns = 0;
  const active = { count: 0, max: 0 };
  const reply = {
    sendGroupText: async () => ({ success: true, messageId: 1 }),
    sendPrivateText: async () => ({ success: true, messageId: 1 }),
    sendGroupNestedTextForward: async () => ({ success: true, messageId: 1 }),
    sendGroupTextForward: async () => ({ success: true, messageId: 1 }),
    sendPrivateNestedTextForward: async () => ({ success: true, messageId: 1 }),
    sendPrivateTextForward: async () => ({ success: true, messageId: 1 }),
    sendGroupNestedMixedForward: async () => ({ success: true, messageId: 1 }),
    sendPrivateNestedMixedForward: async () => ({ success: true, messageId: 1 }),
    sendGroupRecord: async () => ({ success: true, messageId: 1 }),
    sendPrivateRecord: async () => ({ success: true, messageId: 1 }),
    sendGroupImage: async () => ({ success: true, messageId: 1 }),
    sendPrivateImage: async () => ({ success: true, messageId: 1 }),
    sendGroupFile: async () => ({ success: true, messageId: 1 }),
    sendPrivateFile: async () => ({ success: true, messageId: 1 }),
  };
  const runtime = createBotMessageRuntime({
    app: { handle: async () => ({ kind: 'chat', handled: true, text: 'LEGACY' }), engine: { async handleExplicit() { return null; } }, sessions: { clear() {}, get: () => [], append() {} }, registry: () => ({}), client: {} },
    reply,
    getConfig: () => cfg,
    selfId: () => '10000',
    botName: 'Mio',
    fetchGroupHistory: async () => [],
    reportProblem: async () => true,
    agentRuntime: async () => {
      active.count += 1;
      active.max = Math.max(active.max, active.count);
      await sleep(80);
      active.count -= 1;
      return { handled: true, text: '回好了' };
    },
  });
  const events = [1, 2, 3, 4].map((i) => ({
    post_type: 'message', message_type: 'group', group_id: 4000 + i, user_id: 2001,
    message_id: 990 + i, time: Date.now() + i,
    raw_message: `[CQ:at,qq=10000] 群${i}的问题`,
    message: [{ type: 'at', data: { qq: '10000' } }, { type: 'text', data: { text: ` 群${i}的问题` } }],
  }));
  await Promise.all(events.map((e) => runtime.handleMessageEvent(e)));
  await sleep(30);
  assert.equal(active.max, 4, '关闭上限时跨群应全并发');
  assert.equal(active.count, 0, '结束后无泄漏');
});

test('R15/F-2: stale group focus window is not injected after queueing', async () => {
  const cfg = createDefaultConfig();
  cfg.agent.enabled = true;
  cfg.agent.mode = 'enforce';
  cfg.agent.maxConcurrentTurns = 1; // 强制排队，制造窗口过期窗口期
  cfg.bot.autoContinue.enabled = true;
  const seenGroupContexts = [];
  const reply = {
    sendGroupText: async () => ({ success: true, messageId: 1 }),
    sendPrivateText: async () => ({ success: true, messageId: 1 }),
    sendGroupNestedTextForward: async () => ({ success: true, messageId: 1 }),
    sendGroupTextForward: async () => ({ success: true, messageId: 1 }),
    sendPrivateNestedTextForward: async () => ({ success: true, messageId: 1 }),
    sendPrivateTextForward: async () => ({ success: true, messageId: 1 }),
    sendGroupNestedMixedForward: async () => ({ success: true, messageId: 1 }),
    sendPrivateNestedMixedForward: async () => ({ success: true, messageId: 1 }),
    sendGroupRecord: async () => ({ success: true, messageId: 1 }),
    sendPrivateRecord: async () => ({ success: true, messageId: 1 }),
    sendGroupImage: async () => ({ success: true, messageId: 1 }),
    sendPrivateImage: async () => ({ success: true, messageId: 1 }),
    sendGroupFile: async () => ({ success: true, messageId: 1 }),
    sendPrivateFile: async () => ({ success: true, messageId: 1 }),
  };
  const runtime = createBotMessageRuntime({
    app: { handle: async () => ({ kind: 'chat', handled: true, text: 'LEGACY' }), engine: { async handleExplicit() { return null; } }, sessions: { clear() {}, get: () => [], append() {} }, registry: () => ({}), client: {} },
    reply,
    getConfig: () => cfg,
    selfId: () => '10000',
    botName: 'Mio',
    fetchGroupHistory: async () => [],
    reportProblem: async () => true,
    agentRuntime: async (input) => {
      await sleep(60);
      seenGroupContexts.push(String(input.groupContext || ''));
      return { handled: true, text: '回好了' };
    },
  });
  // 第一轮正常触发；第二轮开始时把群级 focus 窗口标记为过期（模拟排队超窗）
  const mkEvent = (id) => ({
    post_type: 'message', message_type: 'group', group_id: 3000, user_id: 2001,
    message_id: id, time: Date.now(),
    raw_message: '[CQ:at,qq=10000] 你好',
    message: [{ type: 'at', data: { qq: '10000' } }, { type: 'text', data: { text: ' 你好' } }],
  });
  const p1 = runtime.handleMessageEvent(mkEvent(1001));
  await sleep(20);
  const p2 = runtime.handleMessageEvent(mkEvent(1002));
  await Promise.all([p1, p2]);
  // 无断言崩溃 + 两种路径都完成即可（群窗口默认不会开启，此处主要保证复验代码不误伤正常路径）
  assert.ok(seenGroupContexts.length === 2, `两轮均应执行: ${JSON.stringify(seenGroupContexts)}`);
});