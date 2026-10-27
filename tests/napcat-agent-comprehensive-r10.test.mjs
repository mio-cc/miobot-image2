import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';

import { NapcatAdapter } from '../dist/packages/napcat/src/index.js';
import { createBotMessageRuntime } from '../dist/apps/bot/src/main.js';
import { createDefaultConfig } from '../dist/packages/config/src/index.js';
import { createAgentHost } from '../dist/apps/bot/src/agent-host.js';
import { InMemoryAgentSessionManager } from '../dist/packages/agent-runtime/src/index.js';
import { normalizeToolSpec } from '../dist/packages/tool-runtime/src/index.js';

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
  let mid = 1000;
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
    autoReconnect: false,
  });
  await new Promise((resolve) => {
    const off = adapter.on('open', () => { off(); resolve(); });
    adapter.connect();
  });
  await waitUntil(() => Boolean(peer), 2000, 'napcat peer');
  return {
    adapter, actions,
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
function sentImages(action) {
  return (action.params?.message || []).filter((segment) => segment.type === 'image').map((segment) => segment.data?.file || segment.data?.url || '');
}
function makeConfig() {
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
  cfg.agent.maxModelRounds = 8;
  cfg.agent.maxToolRounds = 8;
  cfg.toolRegistry.enabled = true;
  cfg.replyPolicy.enabled = true;
  cfg.replyPolicy.defaultVoice = 'off';
  cfg.freeMode.enabled = false;
  return cfg;
}
function makeSpec(name, description, properties, required = []) {
  return normalizeToolSpec({
    name, title: name, description,
    inputSchema: { type: 'object', properties, required, additionalProperties: false },
    outputKinds: ['text'], riskLevel: 'low', exposure: 'core',
  });
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
function scriptedClient(scripts, requests) {
  return {
    async chat(_nodeIndex, request) {
      requests.push(request);
      const next = scripts.shift();
      if (!next) throw new Error('unexpected model call');
      return { raw: {}, ...(typeof next === 'function' ? next(request) : next) };
    },
  };
}
async function setup(options) {
  const sim = await createNapcatSimulation();
  const cfg = makeConfig();
  Object.assign(cfg, options.config || {});
  const agentInputs = [];
  const preparedImages = [];
  const fallbackCalls = [];
  const toolCalls = [];
  const specs = options.specs || [];
  const handlers = options.handlers || {};
  const host = createAgentHost({
    getConfig: () => cfg,
    client: options.client,
    sessions: new InMemoryAgentSessionManager(),
    toolBindings: () => specs.map((spec) => ({
      spec,
      handler: async (call) => {
        toolCalls.push({ name: call.name, arguments: call.arguments });
        const result = handlers[call.name]?.(call);
        if (result) return result;
        return { ok: true, content: call.name + ':ok', outputs: [{ kind: 'text', text: call.name + ':ok' }] };
      },
    })),
    preflightToolCall: () => ({ allowed: true }),
    isReadOnlyTool: () => true,
  });
  const runtime = createBotMessageRuntime({
    app: makeApp(fallbackCalls),
    reply: sim.adapter,
    getConfig: () => cfg,
    selfId: () => '10000',
    botName: 'Mio',
    agentRuntime: async (input) => {
      agentInputs.push(input);
      return host({ ...input, userRole: 'user' });
    },
    prepareInputImages: async (images) => {
      preparedImages.push([...images]);
      // 真实 start.ts 会把 QQ 远程图片下载成 data URL；测试模拟同一可被视觉协议接受的输入。
      return images.map((_, index) => `data:image/png;base64,AAAA${index}`);
    },
    loadMemoryContext: options.loadMemoryContext,
    fetchGroupHistory: options.fetchGroupHistory,
    reportProblem: async (problem) => { (options.problems ||= []).push(problem); },
  });
  runtime.attach(sim.adapter);
  return { sim, cfg, runtime, host, agentInputs, preparedImages, fallbackCalls, toolCalls, options };
}

test('Napcat comprehensive: group history + vector memory + ambiguous follow-up reaches Agent', async () => {
  const requests = [];
  const scripts = [
    { text: '我记得你喜欢青花瓷，我们可以继续聊。', finishReason: 'stop' },
    { text: '当然记得，你刚才说的是青花瓷。', finishReason: 'stop' },
  ];
  const s = await setup({
    client: scriptedClient(scripts, requests),
    fetchGroupHistory: async () => [
      { user_id: 2001, sender: { nickname: '阿青' }, raw_message: '我最近一直在听青花瓷' },
      { user_id: 2002, sender: { nickname: '阿蓝' }, raw_message: '那首歌不错' },
    ],
    loadMemoryContext: async () => '用户喜欢周杰伦的《青花瓷》。',
  });
  try {
    await s.sim.sendEvent({
      post_type: 'message', message_type: 'group', group_id: 3000, user_id: 2001, message_id: 7001,
      sender: { nickname: '阿青' },
      raw_message: '[CQ:at,qq=10000] 你觉得那个东西怎么样',
      message: [{ type: 'at', data: { qq: '10000' } }, { type: 'text', data: { text: ' 你觉得那个东西怎么样' } }],
    });
    await waitUntil(() => s.sim.actions.some((action) => action.action === 'send_group_msg'), 3000, 'ambiguous group reply');
    assert.equal(s.agentInputs.length, 1);
    assert.match(String(s.agentInputs[0].groupContext || ''), /青花瓷/);
    assert.match(String(s.agentInputs[0].groupContext || ''), /相关记忆/);
    const firstAction = s.sim.actions.find((action) => action.action === 'send_group_msg');
    assert.match(sentText(firstAction), /记得你喜欢青花瓷/);

    await s.sim.sendEvent({
      post_type: 'message', message_type: 'group', group_id: 3000, user_id: 2001, message_id: 7002,
      sender: { nickname: '阿青' },
      raw_message: '[CQ:at,qq=10000] 那你还记得吗',
      message: [{ type: 'at', data: { qq: '10000' } }, { type: 'text', data: { text: ' 那你还记得吗' } }],
    });
    await waitUntil(() => s.sim.actions.filter((action) => action.action === 'send_group_msg').length >= 2, 3000, 'follow-up reply');
    assert.match(sentText(s.sim.actions.filter((action) => action.action === 'send_group_msg')[1]), /当然记得/);
    // 第二轮模型输入必须能看到前一轮的会话 history，而不是每次从零开始。
    assert.ok(requests[1].messages.some((message) => String(message.content || '').includes('青花瓷')));
    assert.equal(s.fallbackCalls.length, 0);
  } finally {
    await s.sim.close();
  }
});

test('Napcat comprehensive: image-first then @ merges recent image; @ and image in one message both reach Agent', async () => {
  const requests = [];
  const scripts = [
    { text: '我看到了，是一只猫。', finishReason: 'stop' },
    { text: '这张图也看到了。', finishReason: 'stop' },
    { text: '图在前的这张也看到了。', finishReason: 'stop' },
  ];
  const s = await setup({ client: scriptedClient(scripts, requests) });
  try {
    // 先发图，不 @：Napcat 事件本身应被忽略，但图片要进入短期最近图记忆。
    await s.sim.sendEvent({
      post_type: 'message', message_type: 'group', group_id: 3001, user_id: 2101, message_id: 7101,
      raw_message: '[CQ:image,file=cat.png]',
      message: [{ type: 'image', data: { file: 'cat.png', url: 'https://example.test/cat.png' } }],
    });
    await sleep(100);
    assert.equal(s.sim.actions.filter((action) => action.action === 'send_group_msg').length, 0);
    // 再 @ 提问：应把刚发的图并入 Agent 输入。
    await s.sim.sendEvent({
      post_type: 'message', message_type: 'group', group_id: 3001, user_id: 2101, message_id: 7102,
      raw_message: '[CQ:at,qq=10000] 这张图是什么',
      message: [{ type: 'at', data: { qq: '10000' } }, { type: 'text', data: { text: ' 这张图是什么' } }],
    });
    await waitUntil(() => s.sim.actions.some((action) => action.action === 'send_group_msg'), 3000, 'image follow-up reply');
    assert.equal(s.preparedImages.length, 1);
    assert.ok(s.preparedImages[0].some((image) => /cat\.png/.test(String(image))));
    assert.equal(s.agentInputs[0].images.length, 1);
    assert.match(String(s.agentInputs[0].images[0]), /^data:image\/png/);
    assert.match(sentText(s.sim.actions.find((action) => action.action === 'send_group_msg')), /猫/);

    // @ 和图片在同一事件：直接进入 Agent，不依赖短期记忆。
    await s.sim.sendEvent({
      post_type: 'message', message_type: 'group', group_id: 3001, user_id: 2101, message_id: 7103,
      raw_message: '[CQ:at,qq=10000] 再看这张 [CQ:image,file=cat2.png]',
      message: [
        { type: 'at', data: { qq: '10000' } },
        { type: 'text', data: { text: ' 再看这张 ' } },
        { type: 'image', data: { file: 'cat2.png', url: 'https://example.test/cat2.png' } },
      ],
    });
    await waitUntil(() => s.sim.actions.filter((action) => action.action === 'send_group_msg').length >= 2, 3000, 'at then image reply');
    assert.equal(s.agentInputs[1].images.length, 1);
    assert.match(String(s.agentInputs[1].images[0]), /^data:image\/png/);

    // 图片排在 @ 前面、同一事件：验证分段顺序不影响视觉输入。
    await s.sim.sendEvent({
      post_type: 'message', message_type: 'group', group_id: 3001, user_id: 2101, message_id: 7104,
      raw_message: '[CQ:image,file=cat3.png] [CQ:at,qq=10000] 图在前的这张呢',
      message: [
        { type: 'image', data: { file: 'cat3.png', url: 'https://example.test/cat3.png' } },
        { type: 'at', data: { qq: '10000' } },
        { type: 'text', data: { text: ' 图在前的这张呢' } },
      ],
    });
    await waitUntil(() => s.sim.actions.filter((action) => action.action === 'send_group_msg').length >= 3, 3000, 'image before at reply');
    assert.equal(s.agentInputs[2].images.length, 1);
    assert.match(String(s.agentInputs[2].images[0]), /^data:image\/png/);
    assert.equal(s.fallbackCalls.length, 0);
  } finally {
    await s.sim.close();
  }
});

test('Napcat comprehensive: multi-tool collaboration returns both tool results to the same Agent turn', async () => {
  const requests = [];
  const scripts = [
    { text: '', finishReason: 'tool_calls', toolCalls: [
      { id: 'search-1', name: 'web.search', arguments: { query: '青花瓷 周杰伦' } },
      { id: 'lyrics-1', name: 'audio.music.lyrics', arguments: { title: '青花瓷' } },
    ] },
    { text: '我查了资料，也找到了歌词，可以继续生成。', finishReason: 'stop' },
  ];
  const specs = [
    makeSpec('web.search', '网页搜索', { query: { type: 'string' } }, ['query']),
    makeSpec('audio.music.lyrics', '歌词检索', { title: { type: 'string' } }, ['title']),
  ];
  const s = await setup({
    client: scriptedClient(scripts, requests), specs,
    handlers: {
      'web.search': () => ({ ok: true, content: '搜索：青花瓷是周杰伦的歌', outputs: [{ kind: 'text', text: '搜索：青花瓷是周杰伦的歌' }] }),
      'audio.music.lyrics': () => ({ ok: true, content: '歌词：天青色等烟雨', outputs: [{ kind: 'text', text: '歌词：天青色等烟雨' }] }),
    },
  });
  try {
    await s.sim.sendEvent({
      post_type: 'message', message_type: 'private', user_id: 2201, message_id: 7201,
      raw_message: '帮我查一下青花瓷，顺便找歌词',
      message: [{ type: 'text', data: { text: '帮我查一下青花瓷，顺便找歌词' } }],
    });
    await waitUntil(() => s.sim.actions.some((action) => action.action === 'send_private_msg'), 3000, 'multi-tool reply');
    assert.equal(s.toolCalls.length, 2);
    assert.deepEqual(new Set(s.toolCalls.map((call) => call.name)), new Set(['web.search', 'audio.music.lyrics']));
    assert.equal(requests.length, 2);
    assert.ok(requests[1].messages.some((message) => message.role === 'tool'));
    assert.match(sentText(s.sim.actions.find((action) => action.action === 'send_private_msg')), /查了资料/);
    assert.equal(s.fallbackCalls.length, 0);
  } finally {
    await s.sim.close();
  }
});

test('Napcat comprehensive harness: search result can be reused by Suno in a later tool round', async () => {
  const requests = [];
  const searchText = '《青花瓷》歌词：\n天青色等烟雨，而我在等你\n炊烟袅袅升起，隔江千万里';
  const scripts = [
    { text: '', finishReason: 'tool_calls', toolCalls: [
      { id: 'search-lyrics-1', name: 'web.search', arguments: { query: '青花瓷 周杰伦 歌词' } },
    ] },
    (request) => {
      const toolMessage = (request.messages || []).find((message) => message.role === 'tool');
      assert.ok(toolMessage, 'second model round must receive the search tool result');
      assert.match(String(toolMessage.content || ''), /天青色等烟雨/);
      return { text: '', finishReason: 'tool_calls', toolCalls: [
        { id: 'song-1', name: 'audio.music.generate', arguments: {
          prompt: '用搜索到的《青花瓷》歌词生成一首歌', title: '青花瓷', lyrics: searchText,
        } },
      ] };
    },
    { text: '已用联网搜索到的《青花瓷》歌词提交歌曲生成。', finishReason: 'stop' },
  ];
  const specs = [
    makeSpec('web.search', '联网搜索', { query: { type: 'string' } }, ['query']),
    makeSpec('audio.music.generate', '生成歌曲', {
      prompt: { type: 'string' }, title: { type: 'string' }, lyrics: { type: 'string' },
    }, ['prompt']),
  ];
  const s = await setup({
    client: scriptedClient(scripts, requests), specs,
    handlers: {
      'web.search': () => ({
        ok: true, content: searchText,
        outputs: [{ kind: 'text', text: searchText }],
      }),
      'audio.music.generate': (call) => ({
        ok: true,
        content: '歌曲任务已提交：' + call.arguments.title,
        outputs: [{ kind: 'text', text: '歌曲任务已提交：' + call.arguments.title }],
      }),
    },
  });
  try {
    await s.sim.sendEvent({
      post_type: 'message', message_type: 'private', user_id: 2301, message_id: 7301,
      raw_message: '用青花瓷这个歌词来生成歌',
      message: [{ type: 'text', data: { text: '用青花瓷这个歌词来生成歌' } }],
    });
    await waitUntil(() => s.sim.actions.some((action) => action.action === 'send_private_msg'), 3000, 'song reply');
    assert.deepEqual(s.toolCalls.map((call) => call.name), ['web.search', 'audio.music.generate']);
    assert.match(String(s.toolCalls[0].arguments.query), /青花瓷/);
    assert.match(String(s.toolCalls[1].arguments.lyrics), /天青色等烟雨/);
    assert.ok(requests[1].messages.some((message) => message.role === 'tool'));
    assert.equal(requests.length, 3);
    assert.match(sentText(s.sim.actions.find((action) => action.action === 'send_private_msg')), /联网搜索/);
    assert.equal(s.fallbackCalls.length, 0);
  } finally {
    await s.sim.close();
  }
});

test('Napcat comprehensive: duplicate events and legacy fallback are not used on Agent failure', async () => {
  const requests = [];
  const scripts = [{ text: '只处理一次', finishReason: 'stop' }];
  const s = await setup({ client: scriptedClient(scripts, requests) });
  try {
    const event = {
      post_type: 'message', message_type: 'private', user_id: 2401, message_id: 7401,
      raw_message: '你好', message: [{ type: 'text', data: { text: '你好' } }],
    };
    await s.sim.sendEvent(event);
    await s.sim.sendEvent(event);
    await waitUntil(() => s.sim.actions.some((action) => action.action === 'send_private_msg'), 3000, 'duplicate first reply');
    await sleep(120);
    assert.equal(s.sim.actions.filter((action) => action.action === 'send_private_msg').length, 1);
    assert.equal(requests.length, 1);
    assert.equal(s.fallbackCalls.length, 0);
  } finally {
    await s.sim.close();
  }
});
