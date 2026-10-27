import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';

import { NapcatAdapter } from '../dist/packages/napcat/src/index.js';
import { createBotMessageRuntime, extractImages, extractVideos, extractFiles, extractAudios } from '../dist/apps/bot/src/runtime.js';
import { createDefaultConfig } from '../dist/packages/config/src/index.js';
import { formatHistoryMessageText, buildGroupContext } from '../dist/apps/bot/src/group-context.js';
import {
  extractForwardIds,
  normalizeForwardPayload,
  extractImagesFromForwardNodes,
  formatForwardMessages,
} from '../dist/apps/bot/src/message-enrichment.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitUntil(predicate, timeoutMs = 4000, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(10);
  }
  throw new Error('timeout waiting for ' + label);
}

async function createNapcatSimulation() {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(wss, 'listening');
  const port = wss.address().port;
  const actions = [];
  let peer = null;
  let mid = 5000;
  wss.on('connection', (socket) => {
    peer = socket;
    socket.on('message', (raw) => {
      let action;
      try { action = JSON.parse(String(raw)); } catch { return; }
      actions.push(action);
      socket.send(JSON.stringify({ echo: action.echo, self_id: 10000, status: 'ok', retcode: 0, data: { message_id: mid++, forward_id: 'f-' + mid } }));
    });
  });
  const adapter = new NapcatAdapter({
    wsUrl: 'ws://127.0.0.1:' + port,
    token: 'sim-token',
    actionTimeoutMs: 3000,
    textSendTimeoutMs: 3000,
    imageSendTimeoutMs: 3000,
    forwardSendTimeoutMs: 3000,
    fileSendTimeoutMs: 3000,
    autoReconnect: false,
  });
  await new Promise((resolve) => {
    const off = adapter.on('open', () => { off(); resolve(); });
    adapter.connect();
  });
  await waitUntil(() => Boolean(peer), 2000, 'napcat peer');
  return {
    adapter,
    actions,
    sendEvent(event) { peer.send(JSON.stringify({ self_id: 10000, ...event })); },
    async close() {
      adapter.disconnect();
      for (const client of wss.clients) client.terminate();
      await new Promise((resolve) => wss.close(resolve));
    },
  };
}

function sentText(action) {
  return (action.params?.message || []).filter((segment) => segment.type === 'text').map((segment) => segment.data?.text || '').join('');
}
function makeApp(fallbackCalls) {
  return {
    handle: async (input) => { fallbackCalls.push(input); throw new Error('legacy path must not run'); },
    engine: { handleExplicit: async () => { throw new Error('legacy path must not run'); } },
    sessions: { clear() { return true; } },
    registry: () => ({}),
    client: {},
  };
}
async function createHarness(options = {}) {
  const sim = await createNapcatSimulation();
  const cfg = createDefaultConfig();
  cfg.bot.botQqId = '10000';
  cfg.bot.ownerQQs = ['1'];
  cfg.bot.triggerModes = { mention: true, replyToBot: true };
  cfg.bot.groupContext.enabled = true;
  cfg.bot.groupContext.messageCount = 10;
  cfg.bot.replyStrategies.text = 'plain';
  cfg.bot.replyStrategies.image = 'plain';
  cfg.bot.replyStrategies.multiImage = 'plain';
  cfg.bot.replyStrategies.mixed = 'plain';
  cfg.agent.enabled = true;
  cfg.agent.mode = 'enforce';
  cfg.agent.mainModel = 'mock-main';
  cfg.agent.mainNodeIndex = 0;
  cfg.replyPolicy.enabled = true;
  cfg.replyPolicy.defaultVoice = 'off';
  cfg.freeMode.enabled = false;
  cfg.agent.maxModelRounds = 8;
  cfg.agent.maxToolRounds = 8;
  for (const [key, value] of Object.entries(options.config || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value) && cfg[key] && typeof cfg[key] === 'object') Object.assign(cfg[key], value);
    else cfg[key] = value;
  }
  const inputs = [];
  const preparedImages = [];
  const preparedVideos = [];
  const preparedAudios = [];
  const fallbackCalls = [];
  const problems = [];
  const runtime = createBotMessageRuntime({
    app: makeApp(fallbackCalls),
    reply: sim.adapter,
    getConfig: () => cfg,
    selfId: () => '10000',
    botName: 'Mio',
    agentRuntime: async (input) => {
      inputs.push(input);
      return options.agent ? options.agent(input) : { handled: true, text: 'matrix-ok' };
    },
    prepareInputImages: async (images) => {
      preparedImages.push([...images]);
      return images.map((_, index) => `data:image/png;base64,AAAA${index}`);
    },
    fetchReferencedMessage: options.fetchReferencedMessage,
    fetchForwardMessage: options.fetchForwardMessage,
    fetchGroupHistory: options.fetchGroupHistory,
    loadMemoryContext: options.loadMemoryContext,
    triggerIntentChecker: options.triggerIntentChecker,
    hasPendingClarification: options.hasPendingClarification,
    reportProblem: async (problem) => { problems.push(problem); },
  });
  runtime.attach(sim.adapter);
  return { sim, cfg, runtime, inputs, preparedImages, preparedVideos, preparedAudios, fallbackCalls, problems };
}

test('QQ message matrix: text, image, video, file, record, quote, at and face semantics', () => {
  const msg = {
    message: [
      { type: 'reply', data: { id: '9001' } },
      { type: 'at', data: { qq: '10000' } },
      { type: 'text', data: { text: '请看这个' } },
      { type: 'image', data: { url: 'https://example.test/a.png' } },
      { type: 'video', data: { url: 'https://example.test/a.mp4' } },
      { type: 'file', data: { file: 'a.pdf', name: 'a.pdf', size: 12 } },
      { type: 'record', data: { file: 'a.amr' } },
      { type: 'face', data: { id: '1' } },
    ],
  };
  const text = formatHistoryMessageText(msg, { includeImages: true });
  assert.match(text, /请看这个/);
  assert.ok(text.includes('请看这个'));
  assert.ok(text.includes('[图片:https://example.test/a.png]'));
  assert.ok(text.includes('[视频]'));
  assert.ok(text.includes('[文件:a.pdf]'));
  assert.ok(text.includes('[语音]'));
  assert.ok(text.includes('[@10000]'));
  assert.ok(text.includes('[表情]'));
  assert.equal(extractImages(msg)[0], 'https://example.test/a.png');
  assert.equal(extractVideos(msg)[0], 'https://example.test/a.mp4');
  assert.equal(extractFiles(msg)[0].name, 'a.pdf');
  assert.equal(extractAudios(msg)[0], 'a.amr');
});

test('QQ message matrix: forward ids, nested forward payload and visible forward images', () => {
  const nested = {
    messages: [
      { sender: { nickname: '甲' }, message: [{ type: 'text', data: { text: '外层文本' } }] },
      { sender: { nickname: '乙' }, message: [{ type: 'forward', data: { id: 'inner-forward' } }] },
    ],
  };
  const nodes = normalizeForwardPayload(nested);
  assert.equal(nodes.length, 2);
  assert.deepEqual(extractForwardIds(nodes[1]), ['inner-forward']);
  assert.match(formatForwardMessages(nodes), /外层文本/);
  const inner = normalizeForwardPayload({ messages: [{ sender: { nickname: '丙' }, message: [{ type: 'text', data: { text: '内层文本' } }, { type: 'image', data: { url: 'https://example.test/inner.png' } }] }] });
  assert.deepEqual(extractImagesFromForwardNodes(inner), ['https://example.test/inner.png']);
});

test('QQ message matrix: group context keeps identities, media placeholders and skips forwards/self', () => {
  const ctx = buildGroupContext({
    messages: [
      { message_id: 1, user_id: 111, sender: { nickname: '同名' }, message: [{ type: 'text', data: { text: '甲说的话' } }] },
      { message_id: 2, user_id: 222, sender: { nickname: '同名' }, message: [{ type: 'image', data: { url: 'https://example.test/g.png' } }] },
      { message_id: 3, user_id: 333, sender: { nickname: '乙' }, message: [{ type: 'record', data: { file: 'v.amr' } }] },
      { message_id: 4, user_id: 10000, sender: { nickname: 'bot' }, message: [{ type: 'text', data: { text: 'bot 自己' } }] },
      { message_id: 5, user_id: 444, sender: { nickname: '丙' }, message: [{ type: 'forward', data: { id: 'f' } }] },
    ],
    selfId: '10000',
    options: { messageCount: 10, skipForward: true, includeImages: true, maxChars: 2000 },
  });
  assert.ok(ctx.includes('同名 [QQ:111]: 甲说的话'));
  assert.ok(ctx.includes('同名 [QQ:222]: [图片:https://example.test/g.png]'));
  assert.ok(ctx.includes('乙 [QQ:333]: [语音]'));
  assert.equal(ctx.includes('bot 自己'), false);
  assert.equal(ctx.includes('[CQ:forward'), false);
});

test('QQ matrix integration: quote + at + text + image + video + file + voice + nested forward reaches Agent', async () => {
  const h = await createHarness({
    fetchReferencedMessage: async (id) => id === '9001' ? {
      message_id: 9001, user_id: 2002, sender: { nickname: '引用者' },
      message: [
        { type: 'text', data: { text: '引用正文' } },
        { type: 'image', data: { url: 'https://example.test/quote.png' } },
        { type: 'video', data: { url: 'https://example.test/quote.mp4' } },
      ],
    } : null,
    fetchForwardMessage: async (id) => id === 'outer' ? [
      { message_id: 1, user_id: 2101, sender: { nickname: '甲' }, message: [{ type: 'text', data: { text: '外层文本' } }] },
      { message_id: 2, user_id: 2102, sender: { nickname: '乙' }, message: [{ type: 'forward', data: { id: 'inner' } }] },
    ] : id === 'inner' ? [
      { message_id: 3, user_id: 2103, sender: { nickname: '丙' }, message: [
        { type: 'text', data: { text: '内层文本' } },
        { type: 'image', data: { url: 'https://example.test/inner.png' } },
      ] },
    ] : null,
    agent: async (input) => ({ handled: true, text: '收到完整组合消息' }),
  });
  try {
    await h.sim.sendEvent({
      post_type: 'message', message_type: 'group', group_id: 6001, user_id: 2201, message_id: 8101,
      sender: { nickname: '测试用户' },
      raw_message: '[CQ:reply,id=9001][CQ:at,qq=10000] 组合消息',
      message: [
        { type: 'reply', data: { id: '9001' } },
        { type: 'at', data: { qq: '10000' } },
        { type: 'text', data: { text: ' 组合消息 ' } },
        { type: 'image', data: { url: 'https://example.test/event.png' } },
        { type: 'video', data: { url: 'https://example.test/event.mp4' } },
        { type: 'file', data: { file: 'report.pdf', name: 'report.pdf', size: 12 } },
        { type: 'record', data: { file: 'voice.amr' } },
        { type: 'forward', data: { id: 'outer' } },
      ],
    });
    await waitUntil(() => h.sim.actions.some((action) => action.action === 'send_group_msg'), 4000, 'combined reply');
    assert.equal(h.inputs.length, 1);
    const input = h.inputs[0];
    assert.match(String(input.text), /组合消息/);
    assert.match(String(input.referencedText || ''), /引用正文/);
    assert.match(String(input.forwardText || ''), /外层文本/);
    assert.match(String(input.forwardText || ''), /内层文本/);
    assert.ok(h.preparedImages[0].some((url) => url.includes('quote.png')));
    assert.ok(h.preparedImages[0].some((url) => url.includes('inner.png')));
    assert.ok(input.videos.includes('https://example.test/quote.mp4'));
    assert.ok(input.videos.includes('https://example.test/event.mp4'));
    assert.equal(input.files[0].name, 'report.pdf');
    assert.ok(input.audios.includes('voice.amr'));
    const reply = h.sim.actions.find((action) => action.action === 'send_group_msg');
    assert.match(sentText(reply), /收到完整组合消息/);
    assert.equal(h.fallbackCalls.length, 0);
  } finally {
    await h.sim.close();
  }
});

test('QQ matrix: auto-continue catches a no-mention follow-up once and then stops at maxRounds', async () => {
  const h = await createHarness({
    config: {
      bot: { autoContinue: { enabled: true, windowMs: 60000, maxRounds: 1, cooldownMs: 5000, requireModelCheck: false } },
    },
    triggerIntentChecker: { async checkContinueIntent() { return true; } },
    agent: async (input) => ({ handled: true, text: '自动续话：' + input.text }),
  });
  try {
    await h.sim.sendEvent({
      post_type: 'message', message_type: 'group', group_id: 6002, user_id: 2202, message_id: 8201, sender: { nickname: '续话用户' },
      raw_message: '[CQ:at,qq=10000] 先说一句',
      message: [{ type: 'at', data: { qq: '10000' } }, { type: 'text', data: { text: ' 先说一句' } }],
    });
    await waitUntil(() => h.sim.actions.some((action) => action.action === 'send_group_msg'), 8000, 'first group reply');
    await h.sim.sendEvent({
      post_type: 'message', message_type: 'group', group_id: 6002, user_id: 2202, message_id: 8202, sender: { nickname: '续话用户' },
      raw_message: '接着补充', message: [{ type: 'text', data: { text: '接着补充' } }],
    });
    await waitUntil(() => h.sim.actions.filter((action) => action.action === 'send_group_msg').length >= 2, 8000, 'auto continue reply');
    assert.equal(h.inputs.length, 2);
    assert.match(String(h.inputs[1].text), /接着补充/);
    await h.sim.sendEvent({
      post_type: 'message', message_type: 'group', group_id: 6002, user_id: 2202, message_id: 8203, sender: { nickname: '续话用户' },
      raw_message: '再补充', message: [{ type: 'text', data: { text: '再补充' } }],
    });
    await sleep(180);
    assert.equal(h.inputs.length, 2);
    assert.equal(h.sim.actions.filter((action) => action.action === 'send_group_msg').length, 2);
    assert.equal(h.fallbackCalls.length, 0);
  } finally {
    await h.sim.close();
  }
});

test('QQ matrix: consecutive messages keep latest reply and do not double-send first response', async () => {
  let count = 0;
  const h = await createHarness({
    agent: async (input) => {
      count += 1;
      const current = count;
      if (current === 1) await sleep(220);
      return { handled: true, text: 'reply-' + current + ':' + input.text };
    },
  });
  try {
    const base = { post_type: 'message', message_type: 'private', user_id: 2301, sender: { nickname: '连续用户' } };
    await h.sim.sendEvent({ ...base, message_id: 8301, raw_message: '第一条', message: [{ type: 'text', data: { text: '第一条' } }] });
    await h.sim.sendEvent({ ...base, message_id: 8302, raw_message: '第二条', message: [{ type: 'text', data: { text: '第二条' } }] });
    await waitUntil(() => h.sim.actions.some((action) => action.action === 'send_private_msg'), 3000, 'latest private reply');
    await sleep(350);
    assert.equal(h.sim.actions.filter((action) => action.action === 'send_private_msg').length, 1);
    const reply = h.sim.actions.find((action) => action.action === 'send_private_msg');
    assert.match(sentText(reply), /reply-2:第二条/);
    assert.equal(h.fallbackCalls.length, 0);
  } finally {
    await h.sim.close();
  }
});

test('QQ matrix: replying to the bot in a group is a valid user reply trigger without @', async () => {
  const h = await createHarness({
    fetchReferencedMessage: async () => ({
      message_id: 9101, user_id: 10000, sender: { nickname: 'Mio' },
      message: [{ type: 'text', data: { text: '机器人上一句' } }],
    }),
    agent: async (input) => ({ handled: true, text: '引用回复已处理' }),
  });
  try {
    await h.sim.sendEvent({
      post_type: 'message', message_type: 'group', group_id: 6003, user_id: 2203, message_id: 8301, sender: { nickname: '引用用户' },
      raw_message: '那我继续说',
      message: [{ type: 'reply', data: { id: '9101' } }, { type: 'text', data: { text: ' 那我继续说' } }],
    });
    await waitUntil(() => h.sim.actions.some((action) => action.action === 'send_group_msg'), 3000, 'quote-to-bot trigger');
    assert.equal(h.inputs.length, 1);
    assert.match(String(h.inputs[0].referencedText || ''), /机器人上一句/);
    assert.equal(h.fallbackCalls.length, 0);
  } finally {
    await h.sim.close();
  }
});

test('QQ matrix: duplicate message id is handled once', async () => {
  const h = await createHarness({ agent: async () => ({ handled: true, text: '只处理一次' }) });
  try {
    const event = { post_type: 'message', message_type: 'private', user_id: 2401, message_id: 8401, raw_message: '你好', message: [{ type: 'text', data: { text: '你好' } }] };
    await h.sim.sendEvent(event);
    await h.sim.sendEvent(event);
    await waitUntil(() => h.sim.actions.some((action) => action.action === 'send_private_msg'), 3000, 'duplicate first reply');
    await sleep(100);
    assert.equal(h.sim.actions.filter((action) => action.action === 'send_private_msg').length, 1);
    assert.equal(h.inputs.length, 1);
  } finally {
    await h.sim.close();
  }
});

test('QQ matrix: long text reply respects textReply maxChars and sends bounded parts', async () => {
  const h = await createHarness({
    config: { bot: { textReply: { maxChars: 12, splitDelayMs: 0, showPartPrefix: false } } },
    agent: async () => ({ handled: true, text: '第一段内容第二段内容第三段内容第四段内容' }),
  });
  try {
    await h.sim.sendEvent({
      post_type: 'message', message_type: 'private', user_id: 2501, message_id: 8501,
      raw_message: '长回复', message: [{ type: 'text', data: { text: '长回复' } }],
    });
    await waitUntil(() => h.sim.actions.some((action) => action.action === 'send_private_msg'), 3000, 'long reply first part');
    await sleep(100);
    const parts = h.sim.actions.filter((action) => action.action === 'send_private_msg').map(sentText).filter(Boolean);
    assert.ok(parts.length >= 2, '长文本应拆成多段，实际=' + parts.length);
    assert.match(parts.join(''), /第一段内容/);
    assert.match(parts.join(''), /第四段内容/);
    assert.equal(h.fallbackCalls.length, 0);
  } finally {
    await h.sim.close();
  }
});

test('QQ matrix: auto-continue checker can reject a follow-up and clear state', async () => {
  let checks = 0;
  const h = await createHarness({
    config: { bot: { autoContinue: { enabled: true, windowMs: 60000, maxRounds: 3, cooldownMs: 5000 } } },
    triggerIntentChecker: { async checkContinueIntent() { checks += 1; return false; } },
    agent: async () => ({ handled: true, text: '首次回复' }),
  });
  try {
    await h.sim.sendEvent({
      post_type: 'message', message_type: 'group', group_id: 6004, user_id: 2204, message_id: 8601, sender: { nickname: '拒绝续话' },
      raw_message: '[CQ:at,qq=10000] 第一次',
      message: [{ type: 'at', data: { qq: '10000' } }, { type: 'text', data: { text: ' 第一次' } }],
    });
    await waitUntil(() => h.sim.actions.some((action) => action.action === 'send_group_msg'), 8000, 'first reply before reject');
    await h.sim.sendEvent({
      post_type: 'message', message_type: 'group', group_id: 6004, user_id: 2204, message_id: 8602, sender: { nickname: '拒绝续话' },
      raw_message: '不相关的话', message: [{ type: 'text', data: { text: '不相关的话' } }],
    });
    await sleep(220);
    assert.equal(checks, 1);
    assert.equal(h.inputs.length, 1);
    assert.equal(h.sim.actions.filter((action) => action.action === 'send_group_msg').length, 1);
  } finally {
    await h.sim.close();
  }
});

test('QQ matrix: forward ids also come from raw CQ and JSON-card-like structures', () => {
  assert.deepEqual(extractForwardIds({ message: '[CQ:forward,id=raw-forward]' }), ['raw-forward']);
  assert.deepEqual(extractForwardIds({ message: [{ type: 'json', data: { data: JSON.stringify({ forward_id: 'json-forward' }) } }] }), ['json-forward']);
});

test('QQ matrix: nested forward cycle is bounded and still produces a reply', async () => {
  const h = await createHarness({
    fetchForwardMessage: async (id) => id === 'cycle-a' ? [
      { message_id: 1, user_id: 1, sender: { nickname: '甲' }, message: [{ type: 'text', data: { text: '循环外层' } }, { type: 'forward', data: { id: 'cycle-b' } }] },
    ] : id === 'cycle-b' ? [
      { message_id: 2, user_id: 2, sender: { nickname: '乙' }, message: [{ type: 'forward', data: { id: 'cycle-a' } }] },
    ] : null,
    agent: async () => ({ handled: true, text: '循环转发已安全处理' }),
  });
  try {
    await h.sim.sendEvent({
      post_type: 'message', message_type: 'group', group_id: 6005, user_id: 2205, message_id: 8701, sender: { nickname: '循环用户' },
      raw_message: '[CQ:at,qq=10000] 看转发',
      message: [{ type: 'at', data: { qq: '10000' } }, { type: 'text', data: { text: ' 看转发' } }, { type: 'forward', data: { id: 'cycle-a' } }],
    });
    await waitUntil(() => h.sim.actions.some((action) => action.action === 'send_group_msg'), 5000, 'cycle reply');
    assert.equal(h.inputs.length, 1);
    assert.match(String(h.inputs[0].forwardText || ''), /循环外层/);
    assert.match(sentText(h.sim.actions.find((action) => action.action === 'send_group_msg')), /安全处理/);
  } finally {
    await h.sim.close();
  }
});

test('QQ matrix: raw CQ media and nonstandard forward node content are extractable', () => {
  const raw = { raw_message: '[CQ:image,file=https://example.test/cq.png][CQ:video,file=https://example.test/cq.mp4][CQ:file,file=a.pdf,name=a.pdf][CQ:record,file=cq.amr]' };
  assert.deepEqual(extractImages(raw), ['https://example.test/cq.png']);
  assert.deepEqual(extractVideos(raw), ['https://example.test/cq.mp4']);
  assert.equal(extractFiles(raw)[0].name, 'a.pdf');
  assert.deepEqual(extractAudios(raw), ['cq.amr']);
  const nodes = normalizeForwardPayload({ messages: [{ sender: { nickname: '转发者' }, content: '[CQ:image,file=https://example.test/forward-cq.png]' }] });
  assert.deepEqual(extractImagesFromForwardNodes(nodes), ['https://example.test/forward-cq.png']);
});
