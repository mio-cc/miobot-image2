import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * 复现与回归：合并转发消息在链路上的读取。
 * 方案：转发像普通消息一样入记忆（观察闸门异步展开 → 原文 +【合并转发内容】聚合入库），
 * 之后靠记忆检索（loadMemoryContext → memoryService.retrieve）自然命中；不再依赖暂存键。
 * 场景矩阵：
 *   A 群纯转发（未触发）        → 不回复；内容异步展开入记忆（可检索）
 *   B 群 @bot + 转发            → 即时富化进 agent + 异步入记忆（双路径）
 *   C 私聊纯转发                → 同 B
 *   D/E get_forward_msg 失败/未注入 → 即时链路回罐头话；记忆侧降级占位入库
 *   F 转发图片全挂但文本在      → 即时链路不整条丢弃；记忆侧照常入库
 *   G 未触发转发入记忆          → 观察记录含【合并转发内容】+ 原消息元数据
 *   H 展开失败降级占位          → '[合并转发内容不可读]' 仍入库（不丢观察记录）
 *   I 展开超时降级占位          → 超时后占位入库（测试注入短超时）
 *   J 群历史上下文 forward 占位  → 纯转发历史消息不再被静默过滤
 */
import {
  createBotMessageRuntime,
  extractForwardIds,
  normalizeForwardPayload,
  formatForwardMessages,
} from '../dist/apps/bot/src/main.js';
import { formatHistoryMessageText, buildGroupContext } from '../dist/apps/bot/src/group-context.js';
import { NapcatAdapter, NAPCAT_READY_STATE } from '../dist/packages/napcat/src/index.js';
import { createDefaultConfig } from '../dist/packages/config/src/index.js';

const BOT_QQ = '10000';
const USER_A = 2000;
const GROUP_ID = 700;
const FWD_ID = 'FWD-abc-123';

/** 等待 fire-and-forget 的观察任务跑完（微任务多轮 flush）。 */
const flushAsync = async () => {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve));
};

function makeModelClient() {
  return {
    can: () => true,
    chat: async () => ({ text: 'CHAT', raw: {} }),
    vision: async () => ({ text: 'VISION', raw: {} }),
    generateImages: async () => ({ images: [], raw: {} }),
    editImage: async () => ({ images: [], raw: {} }),
    interrogate: async () => ({ text: '', raw: {} }),
    generateVideo: async () => ({ videos: [], pending: false, raw: {} }),
  };
}

function makeReply() {
  const sent = [];
  const ok = () => ({ success: true, messageId: 1 });
  return {
    sent,
    sendGroupText: async (g, t) => { sent.push(['groupText', g, t]); return ok(); },
    sendPrivateText: async (u, t) => { sent.push(['privateText', u, t]); return ok(); },
    sendGroupImage: async (g, f) => { sent.push(['groupImage', g, f]); return ok(); },
    sendPrivateImage: async (u, f) => { sent.push(['privateImage', u, f]); return ok(); },
    sendGroupVideo: async (g, f) => { sent.push(['groupVideo', g, f]); return ok(); },
    sendPrivateVideo: async (u, f) => { sent.push(['privateVideo', u, f]); return ok(); },
  };
}

/** 与用户线上配置同构：freeMode 开、chat 开、agent enforce。 */
function makeConfig() {
  const cfg = createDefaultConfig();
  cfg.bot.botQqId = BOT_QQ;
  cfg.freeMode.enabled = true;
  cfg.llm.chatEnabled = true;
  cfg.agent.enabled = true;
  cfg.agent.mode = 'enforce';
  return cfg;
}

let messageSeq = 0;

/** Napcat QQNT 合并转发事件（message 段 + raw_message CQ 串，与线上日志同构）。 */
function forwardEvent({ private: isPrivate = false, withAt = false, userId = USER_A, fwdId = FWD_ID, text = '' } = {}) {
  const message = [];
  const rawParts = [];
  if (withAt) {
    message.push({ type: 'at', data: { qq: BOT_QQ } });
    rawParts.push(`[CQ:at,qq=${BOT_QQ}]`);
  }
  if (text) {
    message.push({ type: 'text', data: { text } });
    rawParts.push(text);
  }
  message.push({ type: 'forward', data: { id: fwdId } });
  rawParts.push(`[CQ:forward,id=${fwdId}]`);
  return {
    post_type: 'message',
    message_type: isPrivate ? 'private' : 'group',
    sub_type: isPrivate ? 'friend' : 'normal',
    self_id: Number(BOT_QQ),
    time: Math.floor(Date.now() / 1000),
    message_id: ++messageSeq,
    user_id: userId,
    ...(isPrivate ? {} : { group_id: GROUP_ID }),
    message,
    raw_message: rawParts.join(''),
    sender: { user_id: userId, nickname: `用户${userId}`, card: `用户${userId}` },
  };
}

/** Napcat get_forward_msg 返回（适配器已剥掉外层 data 后的载荷）：3 条子消息。 */
function forwardPayload({ qqImage = false } = {}) {
  return {
    message_id: 'outer',
    messages: [
      {
        time: 1730000001,
        message_id: 'n1',
        real_id: 1,
        sender: { user_id: 3000, nickname: '张三' },
        message: [{ type: 'text', data: { text: '第一条子消息内容' } }],
        raw_message: '第一条子消息内容',
      },
      {
        time: 1730000002,
        message_id: 'n2',
        real_id: 2,
        sender: { user_id: 4000, nickname: '李四' },
        message: [
          { type: 'text', data: { text: '第二条：看这张图' } },
          { type: 'image', data: { url: qqImage ? 'https://multimedia.nt.qq.com.cn/download?appid=140&spec=0&fileid=abc' : 'data:image/png;base64,iVBORw0KGgo=' } },
        ],
        raw_message: '第二条：看这张图[CQ:image,file=2.png]',
      },
      {
        time: 1730000003,
        message_id: 'n3',
        real_id: 3,
        sender: { user_id: 3000, nickname: '张三' },
        message: [{ type: 'text', data: { text: '第三条子消息内容' } }],
        raw_message: '第三条子消息内容',
      },
    ],
  };
}

/**
 * fetchForward: 'ok' 正常展开 / 'fail' 返回 null / 'hang' 永不 resolve / undefined 未注入。
 */
function setup({ fetchForward, forwardResults, expandTimeoutMs } = {}) {
  const client = makeModelClient();
  const reply = makeReply();
  const getConfig = () => makeConfig();
  const app = { client, sessions: new Map(), engine: { handleExplicit: async () => null } };
  const agentCalls = [];
  const fetchCalls = [];
  const observed = [];
  const logs = [];
  const testLog = {
    info: (m, d) => logs.push(['info', m, d]),
    warn: (m, d) => logs.push(['warn', m, d]),
    error: (m, d) => logs.push(['error', m, d]),
  };
  const rt = createBotMessageRuntime({
    app,
    reply,
    getConfig,
    botName: 'Mio',
    logger: testLog,
    selfId: () => BOT_QQ,
    observeMemory: (input) => { observed.push(input); },
    ...(expandTimeoutMs ? { forwardMemoryExpandTimeoutMs: expandTimeoutMs } : {}),
    agentRuntime: async (input) => {
      agentCalls.push(input);
      return { handled: true, text: 'AGENT_OK', reason: 'repro-spy' };
    },
    fetchForwardMessage: fetchForward === undefined
      ? undefined
      : fetchForward === 'hang'
        ? (forwardId) => { fetchCalls.push(forwardId); return new Promise(() => {}); }
        : async (forwardId) => {
          fetchCalls.push(forwardId);
          if (fetchForward === 'fail') return null;
          const payload = typeof forwardResults === 'function' ? forwardResults(forwardId) : forwardPayload();
          return normalizeForwardPayload(payload);
        },
  });
  return { rt, reply, agentCalls, fetchCalls, observed, logs };
}

const hasLog = (logs, fragment) => logs.some(([, msg]) => String(msg).includes(fragment));

// ── 单元层：转发 ID 提取 ────────────────────────────────────────────────

test('extractForwardIds: forward 段(data.id) / CQ 码 / json 卡片顶层 forward_id 均可提取', () => {
  assert.deepEqual(extractForwardIds({ message: [{ type: 'forward', data: { id: FWD_ID } }] }), [FWD_ID]);
  assert.deepEqual(extractForwardIds({ raw_message: `[CQ:forward,id=${FWD_ID}]` }), [FWD_ID]);
  const jsonCard = {
    message: [{
      type: 'json',
      data: { data: JSON.stringify({ app: 'com.tencent.multimsg', forward_id: 'RES-777' }) },
    }],
  };
  assert.deepEqual(extractForwardIds(jsonCard), ['RES-777']);
});

test('extractForwardIds: 旧版 json 卡片 resid 嵌在 meta.detail 下也能提取（盲区已修复）', () => {
  const legacyCard = {
    message: [{
      type: 'json',
      data: { data: JSON.stringify({ app: 'com.tencent.multimsg', meta: { detail: { resid: 'RES-777' } } }) },
    }],
  };
  assert.deepEqual(extractForwardIds(legacyCard), ['RES-777']);
});

test('extractForwardIds: 日志同构——事件对象整体传入（message 段 + raw_message CQ）去重后只出一个 id', () => {
  const event = forwardEvent({ private: true });
  assert.deepEqual(extractForwardIds(event), [FWD_ID]);
  assert.deepEqual(extractForwardIds({ raw_message: `[CQ:forward,id=${FWD_ID}]`, message: '' }), [FWD_ID]);
});

// ── 单元层：get_forward_msg 载荷归一化 ──────────────────────────────────

test('normalizeForwardPayload: messages 数组 / 裸数组 / node 包裹 均可归一化', () => {
  const nodes = normalizeForwardPayload(forwardPayload());
  assert.equal(nodes.length, 3);
  const text = formatForwardMessages(nodes);
  assert.match(text, /第一条子消息内容/);
  assert.match(text, /第二条：看这张图/);
  assert.match(text, /张三/);
  assert.match(text, /李四/);

  const bare = normalizeForwardPayload(forwardPayload().messages);
  assert.equal(bare.length, 3);

  const nodeWrapped = normalizeForwardPayload({
    content: forwardPayload().messages.map((m) => ({ type: 'node', data: { ...m } })),
  });
  assert.equal(nodeWrapped.length, 3);
});

// ── 适配层：get_forward_msg 参数兼容 ────────────────────────────────────

class FakeSocket {
  constructor() {
    this.readyState = NAPCAT_READY_STATE.CONNECTING;
    this.sent = [];
    this.handlers = new Map();
  }
  on(event, handler) {
    const list = this.handlers.get(event) || [];
    list.push(handler);
    this.handlers.set(event, list);
  }
  send(data, callback) {
    this.sent.push(JSON.parse(data));
    callback?.();
  }
  close() { this.readyState = NAPCAT_READY_STATE.CLOSED; }
  emit(event, ...args) { for (const h of this.handlers.get(event) || []) h(...args); }
  open() { this.readyState = NAPCAT_READY_STATE.OPEN; this.emit('open'); }
  message(payload) { this.emit('message', JSON.stringify(payload)); }
}

test('适配层: get_forward_msg 同时上送 id 与 message_id（OneBot 11 参数名兼容）', async () => {
  const sockets = [];
  const adapter = new NapcatAdapter({
    wsUrl: 'ws://localhost:3001',
    actionTimeoutMs: 50,
    reconnectDelayMs: 5,
    requestIdFactory: (action) => `echo_${action}`,
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });
  adapter.connect();
  sockets[0].open();

  const pending = adapter.getForwardMessage(FWD_ID);
  assert.equal(sockets[0].sent[0].action, 'get_forward_msg');
  assert.deepEqual(sockets[0].sent[0].params, { id: FWD_ID, message_id: FWD_ID });
  sockets[0].message({ echo: 'echo_get_forward_msg', status: 'ok', retcode: 0, data: { messages: [{ message_id: 'n1', sender: { user_id: 1, nickname: 'x' }, message: [] }] } });
  const data = await pending;
  assert.equal(data.messages.length, 1);
});

// ── 记忆链路：转发像普通消息一样入记忆 ──────────────────────────────────

test('场景A：群里发纯转发（未触发）→ 不回复，内容异步展开入记忆（可检索）', async () => {
  const { rt, agentCalls, fetchCalls, reply, observed, logs } = setup({ fetchForward: 'ok' });
  const event = forwardEvent({ userId: USER_A });
  const result = await rt.handleMessageEvent(event);
  assert.equal(result.handled, false);
  assert.equal(result.reason, 'group-not-triggered');
  assert.equal(reply.sent.length, 0, '机器人完全沉默');
  await flushAsync();
  assert.equal(fetchCalls.length, 1, '观察侧拉取一次 get_forward_msg');
  assert.equal(observed.length, 1, '观察记录恰好一条（一条消息一条记录）');
  assert.match(observed[0].text, /【合并转发内容】/);
  assert.match(observed[0].text, /第一条子消息内容/);
  assert.match(observed[0].text, /第三条子消息内容/);
  assert.equal(observed[0].messageId, event.message_id, 'messageId 原样保留（供记忆去重键）');
  assert.equal(observed[0].chatType, 'group');
  assert.equal(observed[0].groupId, GROUP_ID);
  assert.equal(agentCalls.length, 0);
  assert.ok(hasLog(logs, '合并转发内容已入记忆'), '入库可观测（日志）');
});

test('场景B：群里 @bot + 转发 → 即时富化进 agent + 异步入记忆（双路径）', async () => {
  const { rt, agentCalls, fetchCalls, observed } = setup({ fetchForward: 'ok' });
  const result = await rt.handleMessageEvent(forwardEvent({ withAt: true, text: '看看这个' }));
  assert.equal(result.handled, true);
  assert.equal(agentCalls.length, 1);
  assert.match(agentCalls[0].forwardText, /第一条子消息内容/);
  assert.match(agentCalls[0].text, /^看看这个$/);
  await flushAsync();
  assert.equal(fetchCalls.length, 2, '即时富化一次 + 记忆入库一次（同 ID 双拉，成本可控）');
  const userObservation = observed.find((o) => o.role === 'user');
  assert.ok(userObservation, '用户转发消息的观察记录存在');
  assert.match(userObservation.text, /看看这个/);
  assert.match(userObservation.text, /【合并转发内容】/);
  assert.ok(observed.some((o) => o.role === 'assistant' && o.text === 'AGENT_OK'), 'bot 回复照常入观察（既有行为）');
});

test('场景C：私聊发纯转发 → 即时富化 + 入记忆', async () => {
  const { rt, agentCalls, observed } = setup({ fetchForward: 'ok' });
  const result = await rt.handleMessageEvent(forwardEvent({ private: true }));
  assert.equal(result.handled, true);
  assert.equal(agentCalls.length, 1);
  assert.match(agentCalls[0].forwardText, /第一条子消息内容/);
  await flushAsync();
  const userObservation = observed.find((o) => o.role === 'user');
  assert.ok(userObservation);
  assert.match(userObservation.text, /【合并转发内容】/);
  assert.equal(userObservation.chatType, 'private');
});

test('场景D：get_forward_msg 拉取失败 → 即时链路回罐头话；记忆侧降级占位仍入库', async () => {
  const { rt, agentCalls, reply, observed } = setup({ fetchForward: 'fail' });
  const result = await rt.handleMessageEvent(forwardEvent({ private: true }));
  assert.equal(result.handled, true);
  assert.equal(result.kind, 'empty-mention');
  assert.equal(agentCalls.length, 0);
  assert.ok(reply.sent.some(([, , text]) => text.includes('我在。直接说需求')));
  await flushAsync();
  assert.equal(observed.length, 1, '失败不丢观察记录');
  assert.match(observed[0].text, /\[合并转发内容不可读\]/);
});

test('场景E：未注入 fetchForwardMessage → 记忆侧直接占位入库', async () => {
  const { rt, reply, observed } = setup({ fetchForward: undefined });
  const result = await rt.handleMessageEvent(forwardEvent({ private: true }));
  assert.equal(result.kind, 'empty-mention');
  assert.ok(reply.sent.some(([, , text]) => text.includes('我在。直接说需求')));
  await flushAsync();
  assert.equal(observed.length, 1);
  assert.match(observed[0].text, /\[合并转发内容不可读\]/);
});

test('场景F：转发图片全部不可读（QQ 图床 URL 被净化）但 forwardText 在 → 不整条丢弃', async () => {
  const { rt, agentCalls, reply } = setup({ fetchForward: 'ok', forwardResults: () => forwardPayload({ qqImage: true }) });
  const result = await rt.handleMessageEvent(forwardEvent({ private: true }));
  assert.notEqual(result.kind, 'image-input-failed', '图片全挂不再把整条消息丢掉');
  assert.equal(result.handled, true);
  assert.equal(agentCalls.length, 1, '保留转发文本继续走 agent 文本链路');
  assert.match(agentCalls[0].forwardText, /第一条子消息内容/);
  assert.deepEqual(agentCalls[0].images, [], '图片降级为不可用');
  assert.ok(reply.sent.some(([, , text]) => text === 'AGENT_OK'));
});

test('场景G：带原文的转发入记忆 → 原文与转发内容合成一条记录', async () => {
  const { rt, observed } = setup({ fetchForward: 'ok' });
  await rt.handleMessageEvent(forwardEvent({ userId: USER_A, text: '吃瓜群众请查收' }));
  await flushAsync();
  assert.equal(observed.length, 1);
  assert.match(observed[0].text, /^吃瓜群众请查收/);
  assert.match(observed[0].text, /【合并转发内容】\n/);
});

test('场景H：展开超时 → 占位入库，不阻塞也不丢记录', async () => {
  // 注入 100ms 短超时（生产默认 15s），fetch 永挂 → race 判负 → 占位入库
  const { rt, observed, fetchCalls } = setup({ fetchForward: 'hang', expandTimeoutMs: 100 });
  const result = await rt.handleMessageEvent(forwardEvent({ userId: USER_A }));
  assert.equal(result.reason, 'group-not-triggered', '主链路不被后台展开阻塞');
  await flushAsync();
  assert.equal(observed.length, 0, '展开在途，尚未入库');
  await new Promise((resolve) => setTimeout(resolve, 300));
  await flushAsync();
  assert.equal(fetchCalls.length, 1);
  assert.equal(observed.length, 1, '超时后仍有一条观察记录');
  assert.match(observed[0].text, /\[合并转发内容不可读\]/);
});

// ── 群历史上下文：转发消息占位 ──────────────────────────────────────────

test('场景J：群历史里的纯转发消息 → 留 [合并转发] 占位，不再被静默过滤', () => {
  const forwardOnly = {
    message_id: 1,
    user_id: 2000,
    sender: { user_id: 2000, nickname: '张三' },
    message: [{ type: 'forward', data: { id: 'F1' } }],
    raw_message: '[CQ:forward,id=F1]',
  };
  assert.equal(formatHistoryMessageText(forwardOnly, { includeImages: false }), '[合并转发]');
  // skipForward=false（用户配置迁移值）：占位行保留；skipForward=true：整条跳过
  const ctxKept = buildGroupContext({
    messages: [forwardOnly],
    options: { messageCount: 10, skipForward: false, includeImages: false, maxChars: 4000 },
  });
  assert.match(ctxKept.context, /\[合并转发\]/);
  const ctxSkipped = buildGroupContext({
    messages: [forwardOnly],
    options: { messageCount: 10, skipForward: true, includeImages: false, maxChars: 4000 },
  });
  assert.equal(ctxSkipped.context, '');
});
