import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createBotApp,
  createBotMessageRuntime,
} from '../dist/apps/bot/src/main.js';
import { createAgentHost } from '../dist/apps/bot/src/agent-host.js';
import { createAgentModelPort } from '../dist/apps/bot/src/agent-model-port.js';
import { createDefaultConfig } from '../dist/packages/config/src/index.js';
import { normalizeToolSpec } from '../dist/packages/tool-runtime/src/index.js';

const echoSpec = normalizeToolSpec({
  name: 'echo',
  title: 'Echo',
  description: 'Echo a value',
  inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false },
  riskLevel: 'low',
  outputKinds: ['text'],
  exposure: 'core',
});

test('agent-model-port R4: maps provider-neutral messages/tools to ModelClient and normalizes circular tool calls', async () => {
  const requests = [];
  const client = {
    async chat(nodeIndex, request) {
      requests.push({ nodeIndex, request });
      return {
        text: '',
        raw: { ok: true },
        toolCalls: [{ id: 'call_1', name: 'echo', arguments: { value: 'x' } }],
        finishReason: 'tool_calls',
        usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
      };
    },
  };
  const port = createAgentModelPort(client, { defaultNodeIndex: 2, timeoutMs: 1234, reasoningEffort: 'high' });
  const response = await port.chat({
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'call_0', name: 'echo', arguments: { value: 'a' } }] },
      { role: 'tool', toolCallId: 'call_0', name: 'echo', content: '{"ok":true}', isError: false },
    ],
    tools: [echoSpec],
    toolChoice: 'required',
    maxTokens: 100,
    temperature: 0.1,
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].nodeIndex, 2);
  assert.equal(requests[0].request.model, 'gpt-4o');
  assert.equal(requests[0].request.toolSpecs[0].name, 'echo');
  assert.equal(requests[0].request.toolProtocol, 'auto');
  assert.equal(requests[0].request.toolChoice, 'required');
  assert.equal(requests[0].request.timeoutMs, 1234);
  assert.equal(requests[0].request.reasoningEffort, 'high');
  assert.equal(requests[0].request.messages[2].toolCalls[0].id, 'call_0');
  assert.equal(requests[0].request.messages[3].toolCallId, 'call_0');
  assert.equal(response.assistant.toolCalls[0].name, 'echo');
  assert.equal(response.finishReason, 'tool_calls');
  assert.equal(response.usage.totalTokens, 5);
  assert.equal(response.toolCallIssues, undefined);
});

test('agent-model-port R4: missing ids become non-executable protocol issues', async () => {
  const client = {
    async chat() {
      return {
        text: '',
        raw: {},
        toolCalls: [{ name: 'echo', arguments: { value: 'x' } }],
      };
    },
  };
  const port = createAgentModelPort(client);
  const response = await port.chat({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [echoSpec],
    toolChoice: 'auto',
  });
  assert.match(response.assistant.toolCalls[0].id, /^model_call_/);
  assert.ok(response.toolCallIssues.some((issue) => issue.code === 'missing_tool_call_id'));
});

test('agent-host R4: enforce mode returns pure text but shadow mode never hands off', async () => {
  const cfg = createDefaultConfig();
  cfg.agent.enabled = true;
  cfg.agent.mode = 'enforce';
  cfg.agent.mainModel = 'gpt-4o-mini';
  cfg.agent.toolChoice = 'none';
  cfg.freeMode.enabled = false;
  const requests = [];
  const client = {
    async chat(_nodeIndex, request) {
      requests.push(request);
      return { text: 'HOST_TEXT', raw: {}, usage: { completionTokens: 2 } };
    },
  };
  const host = createAgentHost({ getConfig: () => cfg, client });
  const enforced = await host({ text: '你好', chatType: 'private', userId: '1', sessionId: 'private:1' });
  assert.equal(enforced.mode, 'enforce');
  assert.equal(enforced.status, 'completed');
  assert.equal(enforced.handled, true);
  assert.equal(enforced.text, 'HOST_TEXT');
  assert.equal(requests.length, 1);
  assert.ok(requests[0].toolSpecs.some((tool) => tool.name === 'ask_user'));
  assert.equal(requests[0].toolChoice, 'none');

  cfg.agent.mode = 'shadow';
  const shadow = await host({ text: '你好', chatType: 'private', userId: '1', sessionId: 'private:2' });
  assert.equal(shadow.mode, 'shadow');
  assert.equal(shadow.status, 'completed');
  assert.equal(shadow.handled, false);
  assert.equal(shadow.turn.meta?.shadow, undefined);
});

test('agent-host R4: disabled flag does not call the model', async () => {
  const cfg = createDefaultConfig();
  cfg.agent.enabled = false;
  let calls = 0;
  const host = createAgentHost({
    getConfig: () => cfg,
    client: { async chat() { calls += 1; return { text: 'x', raw: {} }; } },
  });
  const outcome = await host({ text: '你好', chatType: 'private', userId: '1' });
  assert.equal(outcome.status, 'disabled');
  assert.equal(outcome.handled, false);
  assert.equal(calls, 0);
});

function makeReply() {
  const sent = [];
  const ok = () => ({ success: true, messageId: 1 });
  return {
    sent,
    sendGroupText: async (g, t) => { sent.push(['groupText', String(t)]); return ok(); },
    sendPrivateText: async (u, t) => { sent.push(['privateText', String(t)]); return ok(); },
  };
}

function makeModelClient(text) {
  return {
    async chat() { return { text, raw: {} }; },
    can: () => true,
    async vision() { return { text, raw: {} }; },
    async generateImages() { return { images: [], raw: {} }; },
    async editImage() { return { images: [], raw: {} }; },
    async interrogate() { return { text, raw: {} }; },
    async generateVideo() { return { videos: [], raw: {}, pending: false }; },
  };
}

function setupRuntime(agentMode, agentOutcome, engineText = 'OLD_ENGINE') {
  const cfg = createDefaultConfig();
  cfg.bot.botQqId = '10000';
  cfg.bot.whitelistPrivate = ['2000'];
  cfg.bot.replyStrategies.text = 'plain';
  cfg.freeMode.enabled = false;
  cfg.orchestration.enabled = false;
  cfg.agent.enabled = agentMode !== 'off';
  cfg.agent.mode = agentMode === 'off' ? 'off' : agentMode;
  const client = makeModelClient(engineText);
  const reply = makeReply();
  const app = createBotApp({ getConfig: () => cfg, client });
  let engineCalls = 0;
  const originalHandle = app.handle.bind(app);
  app.handle = async (input) => {
    engineCalls += 1;
    return originalHandle(input);
  };
  let agentCalls = 0;
  const rt = createBotMessageRuntime({
    app,
    reply,
    getConfig: () => cfg,
    botName: 'Mio',
    agentRuntime: async () => {
      agentCalls += 1;
      return agentOutcome;
    },
    reportProblem: async () => {},
  });
  return {
    rt, reply, cfg,
    get engineCalls() { return engineCalls; },
    get agentCalls() { return agentCalls; },
  };
}

function privateEvent(messageId = 1) {
  return {
    post_type: 'message',
    message_type: 'private',
    user_id: 2000,
    message_id: messageId,
    raw_message: '你好',
    sender: { user_id: 2000, nickname: '用户' },
  };
}

test('agent-runtime R4: enforce handoff makes AgentRuntime the only owner for pure-text chat', async () => {
  const h = setupRuntime('enforce', { handled: true, text: 'AGENT_TEXT' });
  const result = await h.rt.handleMessageEvent(privateEvent());
  assert.equal(result.handled, true);
  assert.equal(result.kind, 'chat');
  assert.equal(h.agentCalls, 1);
  assert.equal(h.engineCalls, 0);
  assert.ok(h.reply.sent.some(([kind, text]) => kind === 'privateText' && text.includes('AGENT_TEXT')));
  assert.ok(!h.reply.sent.some(([, text]) => text.includes('OLD_ENGINE')));
});

test('agent-runtime R9: shadow never sends anything after old-chain deletion', async () => {
  const h = setupRuntime('shadow', { handled: true, text: 'SHADOW_MUST_NOT_SEND' });
  const result = await h.rt.handleMessageEvent(privateEvent(2));
  // P0-1 修复后：shadow 静默（不发固定配置提示、不发 Agent 产物），消息未处理返回。
  assert.equal(result.handled, false);
  assert.equal(result.reason, 'agent-shadow');
  assert.equal(h.agentCalls, 1);
  assert.equal(h.engineCalls, 0);
  assert.equal(h.reply.sent.length, 0);
});


test('agent-runtime R9: agent off falls back to the legacy engine without config notices', async () => {
  const h = setupRuntime('off', { handled: true, text: 'SHOULD_NOT_RUN' });
  const result = await h.rt.handleMessageEvent(privateEvent(3));
  // P0-1 方式二：off 回退旧引擎;Agent 不被调用;用户不会收到配置提示。
  assert.equal(h.agentCalls, 0);
  assert.ok(!h.reply.sent.some(([, text]) => String(text).includes('未启用 Agent') || String(text).includes('shadow 模式')));
  assert.notEqual(result.reason, 'agent-off');
});

test('agent-model-port R9: fallback model retries after primary failure', async () => {
  const calls = [];
  const client = {
    async chat(nodeIndex, request) {
      calls.push({ nodeIndex, model: request.model, timeoutMs: request.timeoutMs });
      if (calls.length === 1) throw new Error('primary_failed');
      return { text: 'fallback ok', raw: {} };
    },
  };
  const port = createAgentModelPort(client, {
    defaultNodeIndex: 0,
    fallbackNodeIndex: 3,
    fallbackModel: 'fallback-model',
    timeoutMs: 777,
  });
  const response = await port.chat({
    model: 'primary-model',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [echoSpec],
    toolChoice: 'auto',
  });
  assert.equal(response.assistant.text, 'fallback ok');
  assert.deepEqual(calls, [
    { nodeIndex: 0, model: 'primary-model', timeoutMs: 777 },
    { nodeIndex: 3, model: 'fallback-model', timeoutMs: 777 },
  ]);
});
