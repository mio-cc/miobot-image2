import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';

import { NapcatAdapter } from '../dist/packages/napcat/src/index.js';
import { createBotMessageRuntime } from '../dist/apps/bot/src/main.js';
import { createDefaultConfig } from '../dist/packages/config/src/index.js';
import { ApprovalRuntime } from '../dist/apps/bot/src/approval-runtime.js';
import { OrchestrationEnforcer } from '../dist/apps/bot/src/orchestration-enforce.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate, timeoutMs = 4000, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(10);
  }
  throw new Error('timeout waiting for ' + label);
}

async function createNapcatSimulation(options = {}) {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(wss, 'listening');
  const port = wss.address().port;
  const actions = [];
  const events = [];
  let peer = null;
  let authorization = '';
  let nextMessageId = 1000;

  wss.on('connection', (socket, request) => {
    peer = socket;
    authorization = String(request.headers.authorization || '');
    socket.on('message', (raw) => {
      let action;
      try { action = JSON.parse(String(raw)); } catch { return; }
      actions.push(action);
      const custom = options.responder?.(action);
      if (custom === false) return;
      const response = custom || {
        status: 'ok',
        retcode: 0,
        data: { message_id: nextMessageId++, forward_id: 'forward-' + nextMessageId },
      };
      socket.send(JSON.stringify({ echo: action.echo, self_id: 10000, ...response }));
    });
  });

  const adapter = new NapcatAdapter({
    wsUrl: 'ws://127.0.0.1:' + port,
    token: 'sim-token',
    actionTimeoutMs: 1000,
    textSendTimeoutMs: 1000,
    imageSendTimeoutMs: 1000,
    forwardSendTimeoutMs: 1000,
    fileSendTimeoutMs: 1000,
    autoReconnect: false,
  });
  const opened = new Promise((resolve) => {
    const off = adapter.on('open', () => { off(); resolve(); });
  });
  adapter.connect();
  await opened;
  await waitUntil(() => Boolean(peer), 2000, 'websocket peer');

  return {
    adapter,
    actions,
    events,
    get authorization() { return authorization; },
    get peer() { return peer; },
    async sendQqEvent(event) {
      events.push(event);
      peer.send(JSON.stringify({ self_id: 10000, ...event }));
    },
    async close() {
      adapter.disconnect();
      for (const client of wss.clients) client.terminate();
      await new Promise((resolve) => wss.close(resolve));
    },
  };
}

function makeConfig() {
  const cfg = createDefaultConfig();
  cfg.bot.botQqId = '10000';
  cfg.bot.ownerQQs = ['1'];
  cfg.orchestration.approval.adminQqIds = ['900'];
  cfg.orchestration.approval.allowGroupReply = true;
  cfg.orchestration.approval.allowedGroupIds = ['3000'];
  cfg.bot.triggerModes = { mention: true, replyToBot: true };
  cfg.llm.chatEnabled = true;
  cfg.freeMode.enabled = false;
  cfg.bot.replyStrategies.text = 'plain';
  cfg.bot.replyStrategies.image = 'plain';
  cfg.bot.replyStrategies.multiImage = 'plain';
  cfg.bot.replyStrategies.mixed = 'plain';
  return cfg;
}

function makeApp(handler) {
  return {
    handle: handler,
    engine: {
      async handleExplicit(kind, input) {
        return handler({ ...input, text: input.text || '' });
      },
    },
    sessions: { clear() { return true; } },
    registry: () => ({}),
    client: {},
  };
}

function sentText(action) {
  return (action.params?.message || []).filter((segment) => segment.type === 'text').map((segment) => segment.data?.text || '').join('');
}
test('local simulation: private/group QQ events traverse real Napcat WebSocket and duplicate events are ignored', async () => {
  const sim = await createNapcatSimulation();
  const cfg = makeConfig();
  const seen = [];
  const app = makeApp(async (input) => {
    seen.push(input.text);
    return { kind: 'chat', handled: true, text: 'ECHO:' + input.text, decision: { kind: 'chat', params: {} } };
  });
  const runtime = createBotMessageRuntime({
    app,
    reply: sim.adapter,
    getConfig: () => cfg,
    selfId: () => sim.adapter.selfQqId || '10000',
    botName: 'Mio',
    reportProblem: async () => true,
  });
  runtime.attach(sim.adapter);
  try {
    assert.equal(sim.authorization, 'Bearer sim-token');
    const privateEvent = {
      post_type: 'message', message_type: 'private', user_id: 2000, message_id: 5001,
      raw_message: '你好', message: [{ type: 'text', data: { text: '你好' } }],
    };
    await sim.sendQqEvent(privateEvent);
    await waitUntil(() => sim.actions.some((action) => action.action === 'send_private_msg' && String(action.params?.user_id) === '2000'), 3000, 'private reply');
    const privateReply = sim.actions.find((action) => action.action === 'send_private_msg' && String(action.params?.user_id) === '2000');
    assert.equal(sentText(privateReply), 'ECHO:你好');

    await sim.sendQqEvent({
      post_type: 'message', message_type: 'group', group_id: 3000, user_id: 2001, message_id: 5002,
      raw_message: '[CQ:at,qq=10000] 群聊消息',
      message: [{ type: 'at', data: { qq: '10000' } }, { type: 'text', data: { text: ' 群聊消息' } }],
    });
    await waitUntil(() => sim.actions.some((action) => action.action === 'send_group_msg' && action.params?.group_id === 3000), 3000, 'group reply');
    const groupReply = sim.actions.find((action) => action.action === 'send_group_msg' && action.params?.group_id === 3000);
    assert.equal(sentText(groupReply), 'ECHO:群聊消息');

    await sim.sendQqEvent(privateEvent);
    await sleep(120);
    const privateReplyCount = sim.actions.filter((action) => action.action === 'send_private_msg' && String(action.params?.user_id) === '2000').length;
    assert.equal(privateReplyCount, 1);
    assert.equal(seen.filter((text) => text === '你好').length, 1);
  } finally {
    await sim.close();
  }
});

test('local simulation: group same-name members stay distinct by QQ id through real Napcat events', async () => {
  const sim = await createNapcatSimulation();
  const cfg = makeConfig();
  cfg.bot.groupContext.enabled = true;
  let capturedContext = '';
  const app = makeApp(async (input) => {
    capturedContext = String(input.context || '');
    return { kind: 'chat', handled: true, text: 'ok', decision: { kind: 'chat', params: {} } };
  });
  const runtime = createBotMessageRuntime({
    app,
    reply: sim.adapter,
    getConfig: () => cfg,
    selfId: () => sim.adapter.selfQqId || '10000',
    botName: 'Mio',
    reportProblem: async () => true,
    fetchGroupHistory: async () => [
      { message_id: 1, user_id: 111, sender: { nickname: '同名' }, raw_message: '甲说的话', message: [{ type: 'text', data: { text: '甲说的话' } }] },
      { message_id: 2, user_id: 222, sender: { nickname: '同名' }, raw_message: '乙说的话', message: [{ type: 'text', data: { text: '乙说的话' } }] },
    ],
  });
  runtime.attach(sim.adapter);
  try {
    await sim.sendQqEvent({
      post_type: 'message', message_type: 'group', group_id: 3000, user_id: 333, message_id: 5101,
      sender: { nickname: '同名' },
      raw_message: '[CQ:at,qq=10000] 继续',
      message: [{ type: 'at', data: { qq: '10000' } }, { type: 'text', data: { text: ' 继续' } }],
    });
    await waitUntil(() => Boolean(capturedContext), 3000, 'group context');
    assert.match(capturedContext, /同名 \[QQ:111\]/);
    assert.match(capturedContext, /同名 \[QQ:222\]/);
    assert.match(capturedContext, /当前提问用户.*\[QQ:333\]/);
  } finally {
    await sim.close();
  }
});

test('local simulation: admin group approval reply is consumed before QQ routing and resumes approval', async () => {
  const sim = await createNapcatSimulation();
  const cfg = makeConfig();
  let routedChats = 0;
  const app = makeApp(async () => {
    routedChats += 1;
    return { kind: 'chat', handled: true, text: 'SHOULD_NOT_ROUTE', decision: { kind: 'chat', params: {} } };
  });
  const approvalRuntime = new ApprovalRuntime({
    adminQqIds: () => ['900'],
    ownerQqIds: () => ['1'],
    allowGroupReply: () => true,
    allowedGroupIds: () => ['3000'],
    sendPrivate: async (qq, text) => {
      const result = await sim.adapter.sendPrivateText(qq, text);
      return { success: result.success, messageId: result.messageId, uncertain: result.uncertain, error: result.error };
    },
    sendGroup: async (groupId, text) => {
      const result = await sim.adapter.sendGroupText(groupId, text);
      return { success: result.success, messageId: result.messageId, uncertain: result.uncertain, error: result.error };
    },
  });
  const runtime = createBotMessageRuntime({
    app,
    reply: sim.adapter,
    getConfig: () => cfg,
    selfId: () => sim.adapter.selfQqId || '10000',
    botName: 'Mio',
    reportProblem: async () => true,
    handleApprovalReply: (input) => approvalRuntime.handleReply(input),
  });
  runtime.attach(sim.adapter);
  try {
    const pending = approvalRuntime.request({
      requestId: 'r-sim', jobId: 'j-sim', stepId: 's1', capability: 'config.update', riskLevel: 'critical',
      requesterQq: '2000', groupId: '3000', payload: { a: 1 }, ttlMs: 5000,
    });
    await waitUntil(() => sim.actions.some((action) => action.action === 'send_private_msg' && String(action.params?.user_id) === '900'), 3000, 'approval prompt');
    const promptAction = sim.actions.find((action) => action.action === 'send_private_msg' && String(action.params?.user_id) === '900');
    const prompt = sentText(promptAction);
    const code = prompt.match(/审批码：([A-Z0-9]+)/)?.[1];
    assert.ok(code, prompt);

    await sim.sendQqEvent({
      post_type: 'message', message_type: 'group', group_id: 3000, user_id: 900, message_id: 5201,
      raw_message: '同意 ' + code,
      message: [{ type: 'text', data: { text: '同意 ' + code } }],
    });
    const outcome = await Promise.race([
      pending,
      sleep(3000).then(() => ({ status: 'timeout' })),
    ]);
    assert.equal(outcome.status, 'approved');
    assert.equal(routedChats, 0);
    await waitUntil(() => sim.actions.some((action) => action.action === 'send_group_msg' && String(sentText(action)).includes('已批准')), 3000, 'approval confirmation');
  } finally {
    await sim.close();
  }
});

test('local simulation: runtime failures are reported privately to admin and not sent to QQ user', async () => {
  const sim = await createNapcatSimulation();
  const cfg = makeConfig();
  const app = makeApp(async () => { throw new Error('simulated upstream failure'); });
  const reports = [];
  const runtime = createBotMessageRuntime({
    app,
    reply: sim.adapter,
    getConfig: () => cfg,
    selfId: () => sim.adapter.selfQqId || '10000',
    botName: 'Mio',
    reportProblem: async (input) => {
      reports.push(input);
      await sim.adapter.sendPrivateText('900', 'ERROR ' + input.kind);
      return true;
    },
  });
  runtime.attach(sim.adapter);
  try {
    await sim.sendQqEvent({
      post_type: 'message', message_type: 'private', user_id: 2000, message_id: 5301,
      raw_message: '触发故障', message: [{ type: 'text', data: { text: '触发故障' } }],
    });
    await waitUntil(() => sim.actions.some((action) => action.action === 'send_private_msg' && String(action.params?.user_id) === '900'), 3000, 'admin error report');
    await sleep(100);
    assert.ok(reports.some((item) => item.kind === 'engine-error'));
    assert.equal(sim.actions.some((action) => action.action === 'send_private_msg' && String(action.params?.user_id) === '2000'), false);
  } finally {
    await sim.close();
  }
});

test('local simulation: retcode 1200 record uncertainty does not trigger text fallback', async () => {
  const sim = await createNapcatSimulation({
    responder: (action) => {
      if (action.action === 'send_private_msg' && (action.params?.message || []).some((segment) => segment.type === 'record')) {
        return { status: 'failed', retcode: 1200, wording: 'send timeout but may be delivered' };
      }
      return { status: 'ok', retcode: 0, data: { message_id: 5400 } };
    },
  });
  const cfg = makeConfig();
  const reports = [];
  const app = makeApp(async () => ({ kind: 'chat', handled: true, text: '语音内容', decision: { kind: 'chat', params: {} } }));
  const runtime = createBotMessageRuntime({
    app,
    reply: sim.adapter,
    getConfig: () => cfg,
    selfId: () => sim.adapter.selfQqId || '10000',
    botName: 'Mio',
    voice: async () => 'base64://VOICE',
    reportProblem: async (input) => { reports.push(input); return true; },
  });
  runtime.attach(sim.adapter);
  try {
    await sim.sendQqEvent({
      post_type: 'message', message_type: 'private', user_id: 2000, message_id: 5501,
      raw_message: '语音回复', message: [{ type: 'text', data: { text: '语音回复' } }],
    });
    await waitUntil(() => sim.actions.some((action) => action.action === 'send_private_msg' && (action.params?.message || []).some((segment) => segment.type === 'record')), 3000, 'record action');
    await sleep(150);
    const userActions = sim.actions.filter((action) => action.action === 'send_private_msg' && String(action.params?.user_id) === '2000');
    assert.equal(userActions.length, 1);
    assert.equal(userActions[0].params.message[0].type, 'record');
    assert.equal(userActions.some((action) => sentText(action).includes('语音内容')), false);
  } finally {
    await sim.close();
  }
});
test('local simulation: exact QQ command bypasses model and sends image through Napcat action', async () => {
  const sim = await createNapcatSimulation();
  const cfg = makeConfig();
  cfg.orchestration.enabled = true;
  cfg.orchestration.mode = 'enforce';
  let appCalls = 0;
  const app = makeApp(async () => {
    appCalls += 1;
    return { kind: 'chat', handled: true, text: 'LEGACY', decision: { kind: 'chat', params: {} } };
  });
  const commands = [];
  const runtime = createBotMessageRuntime({
    app,
    reply: sim.adapter,
    getConfig: () => cfg,
    selfId: () => sim.adapter.selfQqId || '10000',
    botName: 'Mio',
    reportProblem: async () => true,
    commandOrchestration: async (input) => {
      commands.push(input);
      return {
        handled: true,
        result: {
          kind: 'image.generate', handled: true,
          images: ['https://example.test/cat.png'],
          decision: { kind: 'image.generate', source: 'command', confidence: 1, reason: 'command', params: { prompt: '猫' }, usedPlanner: false },
        },
      };
    },
  });
  runtime.attach(sim.adapter);
  try {
    await sim.sendQqEvent({
      post_type: 'message', message_type: 'private', user_id: 2000, message_id: 5601,
      raw_message: '生图 猫', message: [{ type: 'text', data: { text: '生图 猫' } }],
    });
    await waitUntil(() => sim.actions.some((action) => action.action === 'send_private_msg' && (action.params?.message || []).some((segment) => segment.type === 'image')), 3000, 'command image reply');
    const action = sim.actions.find((item) => item.action === 'send_private_msg' && (item.params?.message || []).some((segment) => segment.type === 'image'));
    assert.equal(commands.length, 1);
    assert.equal(commands[0].command, 'genImage');
    assert.equal(action.params.message.find((segment) => segment.type === 'image').data.file, 'https://example.test/cat.png');
    assert.equal(appCalls, 0);
  } finally {
    await sim.close();
  }
});

test('local simulation: natural language enters OrchestrationEnforcer and ReplyPlan sends image through Napcat action', async () => {
  const sim = await createNapcatSimulation();
  const cfg = makeConfig();
  cfg.orchestration.enabled = true;
  cfg.orchestration.mode = 'enforce';
  cfg.orchestration.planner.enabled = true;
  cfg.orchestration.planner.minConfidence = 0;
  let fallbackAppCalls = 0;
  const app = makeApp(async () => {
    fallbackAppCalls += 1;
    return { kind: 'chat', handled: true, text: 'LEGACY', decision: { kind: 'chat', params: {} } };
  });
  const enforcer = new OrchestrationEnforcer({
    getConfig: () => cfg,
    app,
    client: {
      async chat() {
        return { text: JSON.stringify({
          planId: 'sim-plan', requestId: 'ignored', goal: 'generate image',
          steps: [{ id: 's1', capability: 'image.generate', args: { prompt: 'cat' } }],
          confidence: 0.95,
        }) };
      },
    },
    handlers: new Map([['image.generate', {
      async execute({ step }) {
        return { jobId: 'job-sim', stepId: step.id, status: 'success', outputs: [{ kind: 'image', url: 'https://example.test/orchestrated.png', priority: 9, mergeable: true }] };
      },
    }]]),
  });
  const runtime = createBotMessageRuntime({
    app,
    reply: sim.adapter,
    getConfig: () => cfg,
    selfId: () => sim.adapter.selfQqId || '10000',
    botName: 'Mio',
    reportProblem: async () => true,
    enforceOrchestration: (input) => enforcer.handle(input),
  });
  runtime.attach(sim.adapter);
  try {
    await sim.sendQqEvent({
      post_type: 'message', message_type: 'private', user_id: 2000, message_id: 5701,
      raw_message: '请帮我生成一只猫的图片', message: [{ type: 'text', data: { text: '请帮我生成一只猫的图片' } }],
    });
    await waitUntil(() => sim.actions.some((action) => action.action === 'send_private_msg' && (action.params?.message || []).some((segment) => segment.type === 'image')), 3000, 'orchestrated image reply');
    const action = sim.actions.find((item) => item.action === 'send_private_msg' && (item.params?.message || []).some((segment) => segment.type === 'image'));
    assert.equal(action.params.message.find((segment) => segment.type === 'image').data.file, 'https://example.test/orchestrated.png');
    assert.equal(fallbackAppCalls, 0);
  } finally {
    await sim.close();
  }
});
test('local simulation: ReplyPlan enforces QQ maxMessages while keeping files/audio non-nested', async () => {
  const sim = await createNapcatSimulation();
  const cfg = makeConfig();
  cfg.orchestration.enabled = true;
  cfg.orchestration.mode = 'enforce';
  cfg.orchestration.planner.enabled = true;
  cfg.orchestration.planner.minConfidence = 0;
  cfg.orchestration.reply.maxMessages = 3;
  cfg.orchestration.reply.includeTruncationNotice = true;
  let fallbackAppCalls = 0;
  const app = makeApp(async () => {
    fallbackAppCalls += 1;
    return { kind: 'chat', handled: true, text: 'LEGACY', decision: { kind: 'chat', params: {} } };
  });
  const enforcer = new OrchestrationEnforcer({
    getConfig: () => cfg,
    app,
    client: {
      async chat() {
        return { text: JSON.stringify({
          planId: 'multi-plan', requestId: 'ignored', goal: 'multi result',
          steps: [{ id: 's1', capability: 'image.generate', args: { prompt: 'cat' } }],
          confidence: 0.95,
        }) };
      },
    },
    handlers: new Map([['image.generate', {
      async execute({ step }) {
        return {
          jobId: 'job-multi', stepId: step.id, status: 'success', outputs: [
            { kind: 'text', text: '结果摘要', priority: 10, mergeable: true },
            { kind: 'image', url: 'https://example.test/result.png', priority: 9, mergeable: true },
            { kind: 'file', url: 'https://example.test/a.zip', priority: 8, mergeable: false, meta: { name: 'a.zip' } },
            { kind: 'file', url: 'https://example.test/b.zip', priority: 7, mergeable: false, meta: { name: 'b.zip' } },
            { kind: 'audio', url: 'base64://VOICE', priority: 6, mergeable: false },
          ],
        };
      },
    }]]),
  });
  const runtime = createBotMessageRuntime({
    app,
    reply: sim.adapter,
    getConfig: () => cfg,
    selfId: () => sim.adapter.selfQqId || '10000',
    botName: 'Mio',
    reportProblem: async () => true,
    enforceOrchestration: (input) => enforcer.handle(input),
  });
  runtime.attach(sim.adapter);
  try {
    await sim.sendQqEvent({
      post_type: 'message', message_type: 'private', user_id: 2000, message_id: 5801,
      raw_message: '请生成多个结果', message: [{ type: 'text', data: { text: '请生成多个结果' } }],
    });
    await waitUntil(() => sim.actions.filter((action) => String(action.action).startsWith('send_')).length >= 3, 3000, 'five-result reply');
    await sleep(120);
    const replies = sim.actions.filter((action) => String(action.action).startsWith('send_'));
    assert.equal(replies.length, 3);
    assert.equal(replies.some((action) => (action.params?.message || []).some((segment) => segment.type === 'record')), false);
    const forward = replies.find((action) => action.action === 'send_private_forward_msg');
    assert.ok(forward);
    assert.match(JSON.stringify(forward.params.messages), /截断/);
    assert.equal(fallbackAppCalls, 0);
  } finally {
    await sim.close();
  }
});