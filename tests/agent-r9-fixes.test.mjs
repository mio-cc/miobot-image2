import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';

import { NapcatAdapter } from '../dist/packages/napcat/src/index.js';
import { createBotMessageRuntime } from '../dist/apps/bot/src/main.js';
import { createBotApp } from '../dist/apps/bot/src/app.js';
import { createDefaultConfig, normalizeConfig } from '../dist/packages/config/src/index.js';
import { ApprovalRuntime } from '../dist/apps/bot/src/approval-runtime.js';
import { createAgentHost } from '../dist/apps/bot/src/agent-host.js';
import { createAgentToolPreflight } from '../dist/apps/bot/src/agent-tool-policy.js';
import { ReplyPreferenceStore } from '../dist/apps/bot/src/reply-preference-store.js';
import { InMemoryToolIdempotencyStore } from '../dist/packages/tool-runtime/src/index.js';
import { InMemoryAgentSessionManager } from '../dist/packages/agent-runtime/src/index.js';
import { resolveReplyPolicy } from '../dist/packages/orchestration/src/index.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitUntil(predicate, timeoutMs = 5000, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(10);
  }
  throw new Error('timeout waiting for ' + label);
}

// ── P0-1 迁移语义 ──
test('P0-1: legacy config without agent sections migrates to enforce/enabled (usable chat)', () => {
  const legacy = normalizeConfig({ panel: { port: 3018, passwordSeed: 'seed' }, bot: { botQqId: '10000' } });
  assert.equal(legacy.agent.enabled, true);
  assert.equal(legacy.agent.mode, 'enforce');
  assert.equal(legacy.toolRegistry.enabled, true);
  assert.equal(legacy.replyPolicy.enabled, true);
  assert.equal(legacy.replyPolicy.audioDirectOnly, true);
  assert.equal(legacy.replyPolicy.fileDirectOnly, true);
});

test('P0-1: explicit agent.enabled=false is preserved (operator intent)', () => {
  const off = normalizeConfig({ agent: { enabled: false, mode: 'off' } });
  assert.equal(off.agent.enabled, false);
  assert.equal(off.agent.mode, 'off');
});

test('P0-3: forced forward ignores mode=direct/plain once text exceeds threshold', () => {
  const base = {
    replyPolicy: {
      enabled: true,
      allowModelOverride: true,
      allowSessionPreferences: true,
      allowUserPreferences: true,
      defaultVoice: 'auto',
      forcedForwardThreshold: 100,
      hardMaxChars: 20000,
      hardMaxMessages: 12,
      sessionPreferenceTtlMs: 86400000,
      userPreferenceTtlMs: 2592000000,
    },
    orchestration: {
      reply: {
        maxMessages: 3,
        maxResultItems: 9,
        preferNestedForward: true,
        includeTruncationNotice: true,
        nestedMaxNodes: 40,
        nestedMaxDepth: 3,
        overflowPolicy: 'truncate',
        textFallback: 'always',
      },
    },
    bot: { textReply: { maxChars: 20000, splitDelayMs: 300, showPartPrefix: true } },
  };
  const longText = '长'.repeat(500);
  const outputs = [{ kind: 'text', text: longText }];
  const textChars = outputs.reduce((sum, o) => sum + (o.kind === 'text' ? String(o.text || '').length : 0), 0);
  for (const mode of ['auto', 'direct', 'plain', 'forward']) {
    const resolved = resolveReplyPolicy({ config: base, textChars, turnPreference: { mode } });
    assert.equal(resolved.policy.forcedForward, true, `mode=${mode} must force forward`);
    assert.equal(resolved.options.preferNestedForward, true, `mode=${mode} must prefer nested forward`);
    assert.equal(resolved.options.textFallback, 'off', `mode=${mode} forward must not fall back to split text`);
  }
  // 低于阈值:direct 仍尊重模型
  const short = resolveReplyPolicy({ config: base, textChars: 10, turnPreference: { mode: 'direct' } });
  assert.equal(short.policy.forcedForward, false);
  assert.equal(short.options.preferNestedForward, false);
  // voice=off 不改变文本 forward 语义
  const voiceOff = resolveReplyPolicy({ config: base, textChars, turnPreference: { mode: 'direct', voice: 'off' } });
  assert.equal(voiceOff.policy.forcedForward, true);
  assert.equal(voiceOff.policy.voice, 'off');
});

// ── P0-2 presentation 工具: scope 持久化 + ReplyPolicy 生效 ──
test('P0-2: reply.presentation tool spec is a builtin low-risk core tool', async () => {
  const { REPLY_PRESENTATION_TOOL_NAME, REPLY_PRESENTATION_TOOL_SPEC, parseReplyPresentationArguments } = await import('../dist/packages/agent-runtime/src/index.js');
  assert.equal(REPLY_PRESENTATION_TOOL_NAME, 'reply.presentation');
  assert.equal(REPLY_PRESENTATION_TOOL_SPEC.riskLevel, 'low');
  assert.equal(REPLY_PRESENTATION_TOOL_SPEC.exposure, 'core');
  assert.deepEqual(
    parseReplyPresentationArguments({ voice: 'off', scope: 'session' }),
    { voice: 'off', scope: 'session' },
  );
  assert.equal(parseReplyPresentationArguments({}), undefined);
  assert.equal(parseReplyPresentationArguments({ mode: 'nonsense' }), undefined);
});

test('P0-2: agent host persists session/user scope presentation and applies it to reply plan', async () => {
  const cfg = createDefaultConfig();
  cfg.bot.botQqId = '10000';
  cfg.bot.ownerQQs = ['1'];
  cfg.agent.enabled = true;
  cfg.agent.mode = 'enforce';
  cfg.toolRegistry.enabled = true;
  cfg.replyPolicy.enabled = true;

  const store = new ReplyPreferenceStore({ maxRecords: 100 });
  const sessions = new InMemoryAgentSessionManager({});
  const client = {
    calls: 0,
    async chat() {
      this.calls += 1;
      if (this.calls === 1) {
        return {
          text: '',
          raw: {},
          toolCalls: [{ id: 'c1', name: 'reply.presentation', arguments: { voice: 'off', scope: 'session' } }],
          toolCallIssues: [],
          finishReason: 'tool_calls',
        };
      }
      return { text: '好的，之后都用文字回复你。', raw: {}, finishReason: 'stop' };
    },
    can: () => true,
    async vision() { return { text: '', raw: {} }; },
  };
  const host = createAgentHost({
    getConfig: () => cfg,
    client,
    sessions,
    replyPreferenceStore: store,
    idempotencyStore: new InMemoryToolIdempotencyStore(),
    toolBindings: () => [],
    preflightToolCall: createAgentToolPreflight({
      getConfig: () => cfg,
      resolveRole: () => 'user',
      approvalRuntime: new ApprovalRuntime({
        adminQqIds: () => ['900'], ownerQqIds: () => ['1'],
        allowGroupReply: () => true, allowedGroupIds: () => [],
        sendPrivate: async () => ({ success: true, messageId: 1 }),
        sendGroup: async () => ({ success: true, messageId: 1 }),
        maxPendingPerUser: () => 3, maxPendingGlobal: () => 50,
        resendIntervalMs: () => 0, maxResend: () => 0,
        onDecision: () => {}, audit: () => {}, persist: () => {},
      }),
      approvalMode: 'suspend',
    }),
  });

  // 第一轮:模型调用 presentation 工具 + 最终文本
  const outcome1 = await host({ text: '现在不方便听语音，之后都用文字', chatType: 'private', userId: '7', sessionId: 'private:7', userRole: 'user' });
  assert.equal(outcome1.status, 'completed');
  assert.equal(outcome1.handled, true);
  assert.ok(outcome1.text.includes('文字'));
  // presentation 已写入 store(session scope)
  const stored = store.get('session', 'private:7');
  assert.equal(stored?.voice, 'off');
  assert.equal(stored?.scope, 'session');
  // turn 级 preference 回传
  assert.equal(outcome1.turn?.replyPreference?.voice, 'off');

  // 第二轮(新 turn): 无工具调用, session 偏好应从 store 恢复并进入 replyPlan policy
  const outcome2 = await host({ text: '再聊一句', chatType: 'private', userId: '7', sessionId: 'private:7', userRole: 'user' });
  assert.equal(outcome2.status, 'completed');
  assert.equal(outcome2.replyPlan?.policy?.voice, 'off', 'session voice=off 必须在下一 turn 的 reply plan policy 里生效');
});

// ── P0-4 视觉输入 ──
test('P0-4: context builder puts images into imageRefs (real vision input), not text suffix', async () => {
  const { createContextBuilder } = await import('../dist/packages/agent-runtime/src/index.js');
  const session = {
    sessionKey: 'private:7', turnId: 't', messages: [], pinnedFacts: {}, artifacts: [],
    configRevision: 'r', runtimeVersion: 'v',
  };
  const built = createContextBuilder().build({
    session,
    userText: '这张图是什么',
    attachments: [
      { kind: 'image', ref: 'https://example.test/a.png' },
      { kind: 'file', ref: 'https://example.test/d.txt', name: 'd.txt' },
    ],
  });
  const last = built.messages.at(-1);
  assert.equal(last.role, 'user');
  assert.deepEqual(last.imageRefs, ['https://example.test/a.png']);
  // 非图片附件仍是文本清单; 图片不再出现在文本里
  assert.doesNotMatch(last.content, /a\.png/);
  assert.match(last.content, /d\.txt/);
});

test('P0-4: agent model port converts imageRefs user message to provider content array', async () => {
  const { createAgentModelPort } = await import('../dist/apps/bot/src/agent-model-port.js');
  const seen = [];
  const client = {
    async chat(_node, request) {
      seen.push(request.messages);
      return { text: '是一张猫', raw: {} };
    },
    can: () => true,
  };
  const port = createAgentModelPort(client);
  await port.chat({
    model: 'vision-model',
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '这张图是什么', imageRefs: ['https://example.test/cat.png'] },
    ],
    tools: [],
    toolChoice: 'none',
  });
  const userMessage = seen[0].find((m) => m.role === 'user');
  assert.ok(Array.isArray(userMessage.content), 'user content must be a provider content array when imageRefs present');
  assert.deepEqual(userMessage.content, [
    { type: 'text', text: '这张图是什么' },
    { type: 'image_url', image_url: { url: 'https://example.test/cat.png' } },
  ]);
});

// ── P0-5 媒体后处理 ──
test('P0-5: sendResult post-processes reply plan image outputs through gallery/compress/materialize', async () => {
  const { sendResult } = await import('../dist/apps/bot/src/runtime.js');
  const { createReplyStrategyEngine } = await import('../dist/packages/reply/src/index.js');
  const calls = [];
  const sent = [];
  // ReplyClient 接口:sendPrivateImage(userId, fileUrl)
  const engine = createReplyStrategyEngine({
    sendGroupText: async () => ({ success: true }),
    sendPrivateText: async () => ({ success: true }),
    sendGroupImage: async (g, url) => { sent.push(['groupImage', url]); return { success: true }; },
    sendPrivateImage: async (u, url) => { sent.push(['privateImage', url]); return { success: true }; },
    sendGroupRecord: async () => ({ success: true }),
    sendPrivateRecord: async () => ({ success: true }),
    sendGroupFile: async () => ({ success: true }),
    sendPrivateFile: async () => ({ success: true }),
  }, { text: 'plain', image: 'plain', multiImage: 'plain', video: 'plain', file: 'plain', multiFile: 'plain', mixed: 'plain' });
  const plan = {
    policy: { enabled: true, maxMessages: 12, maxChars: 20000, mode: 'auto', voice: 'auto', reference: 'auto', forcedForward: false },
    groups: [{
      kind: 'image',
      outputs: [{ kind: 'image', url: 'https://example.test/gen.png', meta: { sourcePrompt: '一只猫' } }],
    }],
  };
  const gallery = async (input) => { calls.push(['gallery', input.prompt]); return [`https://canvas.local/${input.prompt}.png`]; };
  const compress = async (images) => { calls.push(['compress', images]); return images.map((u) => u + '?compressed'); };
  const materialize = async (images) => { calls.push(['materialize', images]); return images.map((u) => 'file:///share/' + u.split('/').pop()); };
  const materializeAudio = async (audios) => { calls.push(['materializeAudio', audios]); return audios; };
  const result = await sendResult(engine, { chatType: 'private', userId: '7', botName: 'Mio' }, { kind: 'chat', handled: true, replyPlan: plan }, undefined, undefined, { sendGroupText: async () => ({ success: true }), sendPrivateText: async () => ({ success: true }), sendGroupImage: async (g, u) => { sent.push(['groupImage', u]); return { success: true }; }, sendPrivateImage: async (u2, u3) => { sent.push(['privateImage', u3]); return { success: true }; } }, async () => {}, 12, undefined, {
    syncImagesToGallery: gallery,
    compressImages: compress,
    materializeImages: materialize,
    materializeAudio,
  });
  assert.ok(result, 'plan must dispatch');
  assert.deepEqual(calls.map((c) => c[0]), ['gallery', 'compress', 'materialize'], 'plan image outputs must traverse gallery→compress→materialize');
  // 发送的是物化后的 URL
  const imageSent = sent.find((s) => s[0] === 'privateImage' || s[0] === 'groupImage');
  assert.ok(String(imageSent?.[1] || '').startsWith('file:///share/'), `materialized url expected, got ${imageSent?.[1]}`);
});

// ── P1-7 副作用串行 ──
test('P1-7: side-effect tools execute serially while read-only tools may batch', async () => {
  const { AgentRuntime, InMemoryAgentSessionManager: SM } = await import('../dist/packages/agent-runtime/src/index.js');
  const { ToolRegistry, ToolExecutor } = await import('../dist/packages/tool-runtime/src/index.js');
  const marks = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const registry = new ToolRegistry();
  registry.register({
    name: 'web.search', title: 't', description: 'd', exposure: 'core', riskLevel: 'low',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
  });
  registry.register({
    name: 'file.delete', title: 't', description: 'd', exposure: 'core', riskLevel: 'high',
    sideEffects: ['deletes_data'],
    inputSchema: { type: 'object', properties: { fileName: { type: 'string' } }, additionalProperties: true },
  });
  registry.register({
    name: 'owner.recall', title: 't', description: 'd', exposure: 'core', riskLevel: 'high',
    sideEffects: ['modifies_state'],
    inputSchema: { type: 'object', properties: {}, additionalProperties: true },
  });
  const executor = new ToolExecutor({ registry });
  executor.registerHandler('web.search', async () => { marks.push('search.start'); await sleep(40); marks.push('search.end'); return { ok: true, content: 'found', outputs: [] }; });
  executor.registerHandler('file.delete', async () => { marks.push('delete.start'); await sleep(60); marks.push('delete.end'); return { ok: true, content: 'deleted', outputs: [] }; });
  executor.registerHandler('owner.recall', async () => { marks.push('recall.start'); await sleep(20); marks.push('recall.end'); return { ok: true, content: 'recalled', outputs: [] }; });
  const sessions = new SM({});
  let round = 0;
  const client = {
    async chat() {
      round += 1;
      if (round === 1) {
        return {
          text: '', raw: {},
          toolCalls: [
            { id: 'c1', name: 'web.search', arguments: { query: 'x' } },
            { id: 'c2', name: 'file.delete', arguments: { fileName: 'a.log' } },
            { id: 'c3', name: 'owner.recall', arguments: {} },
          ],
          toolCallIssues: [], finishReason: 'tool_calls',
        };
      }
      return { text: 'done', raw: {} };
    },
    can: () => true,
  };
  const { createAgentModelPort } = await import('../dist/apps/bot/src/agent-model-port.js');
  const runtime = new AgentRuntime({
    model: createAgentModelPort(client), sessions, mainModel: 'm',
    featureFlag: { enabled: true, mode: 'enforce' },
    toolRegistry: registry, toolExecutor: executor,
  });
  const turn = await runtime.runTurn({ sessionKey: 'private:9', turnId: 't', userText: 'do it', configRevision: 'r', runtimeVersion: 'v' });
  assert.equal(turn.status, 'completed');
  // 副作用工具必须串行: delete.end 在 recall.start 之前
  const deleteEnd = marks.indexOf('delete.end');
  const recallStart = marks.indexOf('recall.start');
  assert.ok(deleteEnd >= 0 && recallStart >= 0, JSON.stringify(marks));
  assert.ok(deleteEnd < recallStart, `side effects must not interleave: ${marks.join(',')}`);
  // 只读工具与副作用可同轮执行(先并行只读再串行副作用)
  assert.ok(marks.includes('search.start') && marks.includes('search.end'), JSON.stringify(marks));
});

// ── P1-6 动态工具:全部能力可见(无白名单) ──
test('P1-6: agent tool bindings expose every registered capability (no static whitelist)', async () => {
  // 用 start.ts 同源的 createCapabilityToolBinding 语义: capability-tool-adapter 无过滤;
  // 这里直接验证 web.search/file.delete/session.clear 之外的动态 id 也能生成 ToolSpec。
  const { toolSpecFromCapabilityDescriptor } = await import('../dist/packages/tool-runtime/src/index.js');
  for (const id of ['mcp.joke.random', 'plugin.weather.today', 'session.clear']) {
    // 未显式声明:名字保留（动态 id 一律成 spec；敏感前缀默认推导为 hidden 是白名单外的安全缺省，
    // 装配侧(start.ts)对这些工具显式传 exposure）
    const spec = toolSpecFromCapabilityDescriptor({
      id,
      name: id,
      description: 'dynamic tool ' + id,
      inputSchema: { type: 'object', properties: {}, additionalProperties: true },
    });
    assert.equal(spec.name, id, `dynamic capability ${id} must produce a ToolSpec (no whitelist rejection)`);
    // 显式 exposure 可把敏感前缀工具开放进 loadout
    const exposed = toolSpecFromCapabilityDescriptor({
      id,
      name: id,
      description: 'dynamic tool ' + id,
      inputSchema: { type: 'object', properties: {}, additionalProperties: true },
    }, { exposure: 'core' });
    assert.equal(exposed.exposure, 'core');
    assert.notEqual(exposed.enabled, false);
  }
});

// ── BUG-1: preflight metadata ──
test('BUG-1: agent loop passes metadata to preflight so admin/owner keep their roles', async () => {
  const { AgentRuntime, InMemoryAgentSessionManager: SM } = await import('../dist/packages/agent-runtime/src/index.js');
  const { ToolRegistry, ToolExecutor } = await import('../dist/packages/tool-runtime/src/index.js');
  const { createAgentToolPreflight } = await import('../dist/apps/bot/src/agent-tool-policy.js');
  const cfg = createDefaultConfig();
  cfg.bot.ownerQQs = ['1'];
  cfg.orchestration.approval.adminQqIds = ['900', '1'];
  cfg.orchestration.approval.enabled = true;
  const preflightInputs = [];
  const preflight = async (input) => {
    preflightInputs.push(input);
    return { allowed: true };
  };
  const registry = new ToolRegistry();
  registry.register({
    name: 'file.delete', title: 't', description: 'd', exposure: 'core', riskLevel: 'high',
    inputSchema: { type: 'object', properties: { fileName: { type: 'string' } }, additionalProperties: true },
  });
  const executor = new ToolExecutor({ registry });
  executor.registerHandler('file.delete', async () => ({ ok: true, content: 'deleted', outputs: [] }));
  const sessions = new SM({});
  let round = 0;
  const client = {
    async chat() {
      round += 1;
      if (round === 1) return { text: '', raw: {}, toolCalls: [{ id: 'c1', name: 'file.delete', arguments: { fileName: 'x' } }], toolCallIssues: [], finishReason: 'tool_calls' };
      return { text: 'ok', raw: {} };
    },
    can: () => true,
  };
  const { createAgentModelPort } = await import('../dist/apps/bot/src/agent-model-port.js');
  const runtime = new AgentRuntime({
    model: createAgentModelPort(client), sessions, mainModel: 'm',
    featureFlag: { enabled: true, mode: 'enforce' },
    toolRegistry: registry, toolExecutor: executor,
    preflightToolCall: preflight,
  });
  const turn = await runtime.runTurn({
    sessionKey: 'group:3000:900', turnId: 't', userText: '删掉它', configRevision: 'r', runtimeVersion: 'v',
    metadata: { chatType: 'group', groupId: 3000, userId: 900, userRole: 'admin', requestId: 'req-1' },
  });
  assert.equal(turn.status, 'completed');
  assert.equal(preflightInputs.length, 1);
  // 关键断言: metadata 必须传给 preflight(修复前为 undefined)
  assert.ok(preflightInputs[0].metadata, 'preflight must receive turn metadata');
  assert.equal(preflightInputs[0].metadata.userRole, 'admin');
  assert.equal(String(preflightInputs[0].metadata.userId), '900');
});

// ── Napcat 端到端: P0-1 默认配置下普通聊天可用 ──
async function createFakeNapcat() {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(wss, 'listening');
  const port = wss.address().port;
  const actions = [];
  let nextId = 9000;
  let peer = null;
  wss.on('connection', (socket) => {
    peer = socket;
    socket.on('message', (raw) => {
      let action;
      try { action = JSON.parse(String(raw)); } catch { return; }
      actions.push(action);
      socket.send(JSON.stringify({ echo: action.echo, self_id: 10000, status: 'ok', retcode: 0, data: { message_id: nextId++, forward_id: 'fwd-' + nextId } }));
    });
  });
  const adapter = new NapcatAdapter({
    wsUrl: 'ws://127.0.0.1:' + port, token: 'sim-token',
    actionTimeoutMs: 2000, textSendTimeoutMs: 2000, imageSendTimeoutMs: 2000,
    forwardSendTimeoutMs: 2000, fileSendTimeoutMs: 2000, getMessageTimeoutMs: 2000, autoReconnect: false,
  });
  adapter.connect();
  await waitUntil(() => Boolean(peer), 2000, 'ws peer');
  return {
    adapter, actions,
    async qq(event) { peer.send(JSON.stringify({ self_id: 10000, ...event })); },
    textOf: (a) => (a.params?.message || []).filter((s) => s.type === 'text').map((s) => s.data?.text || '').join(''),
    async close() { adapter.disconnect(); for (const c of wss.clients) c.terminate(); await new Promise((r) => wss.close(r)); },
  };
}

test('e2e P0-1: fresh normalized config (no agent section) keeps plain chat usable through real napcat', async () => {
  const sim = await createFakeNapcat();
  try {
    // 旧配置缺 agent 分区 → normalize 后 enforce/enabled
    const cfg = normalizeConfig({
      panel: { passwordSeed: 'x' },
      bot: { botQqId: '10000', whitelistPrivate: ['2000'] },
      llm: { chatModel: 'm', apiKeys: [{ name: 'n', baseUrl: 'http://x', key: 'k', enabled: true, kind: 'llm', models: [] }] },
    });
    cfg.bot.triggerModes = { mention: true, replyToBot: true };
    assert.equal(cfg.agent.mode, 'enforce');
    const client = {
      async chat() { return { text: '当然可以，随便聊。', raw: {} }; },
      can: () => true,
      async vision() { return { text: '', raw: {} }; },
      async generateImages() { return { images: [], raw: {} }; },
      async editImage() { return { images: [], raw: {} }; },
      async interrogate() { return { text: '', raw: {} }; },
      async generateVideo() { return { videos: [], raw: {}, pending: true }; },
    };
    const app = createBotApp({ getConfig: () => cfg, client });
    const store = new InMemoryAgentSessionManager({});
    const host = createAgentHost({
      getConfig: () => cfg, client, sessions: store,
      replyPreferenceStore: new ReplyPreferenceStore({ maxRecords: 100 }),
      idempotencyStore: new InMemoryToolIdempotencyStore(),
      toolBindings: () => [],
      preflightToolCall: createAgentToolPreflight({
        getConfig: () => cfg, resolveRole: () => 'user',
        approvalRuntime: new ApprovalRuntime({
          adminQqIds: () => ['900'], ownerQqIds: () => ['1'],
          allowGroupReply: () => true, allowedGroupIds: () => [],
          sendPrivate: async () => ({ success: true, messageId: 1 }),
          sendGroup: async () => ({ success: true, messageId: 1 }),
          maxPendingPerUser: () => 3, maxPendingGlobal: () => 50,
          resendIntervalMs: () => 0, maxResend: () => 0,
          onDecision: () => {}, audit: () => {}, persist: () => {},
        }),
        approvalMode: 'suspend',
      }),
    });
    const runtime = createBotMessageRuntime({
      app,
      reply: sim.adapter,
      getConfig: () => cfg,
      selfId: () => '10000',
      botName: 'Mio',
      fetchGroupHistory: async () => [],
      reportProblem: async () => true,
      agentRuntime: async (input) => {
        const outcome = await host({ ...input, userRole: 'user' });
        return {
          handled: outcome.handled,
          ...(outcome.text ? { text: outcome.text } : {}),
          ...(outcome.replyPlan ? { replyPlan: outcome.replyPlan } : {}),
          ...(outcome.reason ? { reason: outcome.reason } : {}),
        };
      },
    });
    runtime.attach(sim.adapter);
    // 从 WS 服务端推送 QQ 事件（与真实 Napcat 相同路径）
    await sim.qq({
      post_type: 'message', message_type: 'private', user_id: 2000, message_id: 61,
      sender: { nickname: 'u' },
      raw_message: '你好呀',
      message: [{ type: 'text', data: { text: '你好呀' } }],
    });
    // 默认 replyStrategies.text=forward:普通聊天走合并转发(send_private_forward_msg),内容含模型回复。
    await waitUntil(() => sim.actions.some((a) => a.action === 'send_private_msg' || a.action === 'send_private_forward_msg'), 5000, 'chat reply');
    const reply = sim.actions.find((a) => a.action === 'send_private_msg' || a.action === 'send_private_forward_msg');
    const replyPayload = JSON.stringify(reply.params || {});
    assert.ok(replyPayload.includes('当然可以，随便聊。'), `chat text must reach the user, payload=${replyPayload.slice(0, 120)}`);
  } finally {
    await sim.close();
  }
});