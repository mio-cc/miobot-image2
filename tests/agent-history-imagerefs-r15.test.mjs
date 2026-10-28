import test from 'node:test';
import assert from 'node:assert/strict';

const { AgentRuntime } = await import('../dist/packages/agent-runtime/src/agent-loop.js');
const { InMemoryAgentSessionManager } = await import('../dist/packages/agent-runtime/src/session-manager.js');
const { PromptRegistry } = await import('../dist/packages/agent-runtime/src/prompt-registry.js');
const { ToolRegistry } = await import('../dist/packages/tool-runtime/src/tool-registry.js');
const { ToolExecutor } = await import('../dist/packages/tool-runtime/src/tool-executor.js');
const { createAgentModelPort } = await import('../dist/apps/bot/src/agent-model-port.js');

const seenByTurn = { rounds: [] };
test('R15/V-1: history imageRefs stripped to URL placeholders in persisted session; current turn keeps vision', async () => {
  const roundTexts = ['第一轮回复。', '第二轮回复。'];
  let chatCalls = 0;
  const client = {
    async chat() {
      chatCalls += 1;
      return { text: roundTexts[chatCalls - 1] || '好的。', raw: {}, finishReason: 'stop' };
    },
    can: () => true,
    async vision() { return { text: '', raw: {} }; },
    async generateImages() { return { images: [], raw: {} }; },
    async editImage() { return { images: [], raw: {} }; },
    async interrogate() { return { text: '', raw: {} }; },
    async generateVideo() { return { videos: [], raw: {}, pending: true }; },
  };
  const sessions = new InMemoryAgentSessionManager({});
  const promptRegistry = new PromptRegistry();
  promptRegistry.register({ id: 'base', title: 'base', content: '你是 Miobot。', version: '1', status: 'active', order: 10 });
  const registry = new ToolRegistry();
  const runtime = new AgentRuntime({
    model: createAgentModelPort(client),
    sessions,
    promptRegistry,
    toolRegistry: registry,
    toolExecutor: new ToolExecutor({ registry }),
    mainModel: 'test-model',
    featureFlag: { enabled: true, mode: 'enforce' },
    contextBuilder: { build: (input) => {
      const messages = (input.session.messages || []).map((m) => ({ ...m }));
      const currentRefs = (input.attachments || []).filter((a) => a.kind === 'image' && a.ref).map((a) => String(a.ref));
      const historyRefs = messages
        .filter((m) => m.role === 'user')
        .reduce((n, m) => n + (Array.isArray(m.imageRefs) ? m.imageRefs.length : 0), 0);
      const msgs = [...messages];
      if (String(input.userText || '').trim() || currentRefs.length) {
        msgs.push({
          role: 'user',
          content: String(input.userText || '').trim(),
          ...(currentRefs.length ? { imageRefs: currentRefs } : {}),
        });
      }
      // 暴露给断言：本轮模型可见的 vision 图数（当前轮 + 未剥离的历史）
      seenByTurn.rounds.push(currentRefs.length + historyRefs);
      return { messages: msgs, includedSections: [], estimatedChars: 0 };
    } },
  });
  const sessionId = 'group:3000:2001';
  const r1 = await runtime.runTurn({
    sessionKey: sessionId, turnId: 't1', userText: '看这张图',
    configRevision: 'r', runtimeVersion: 'v', userRole: 'user',
    attachments: [{ kind: 'image', ref: 'https://example.test/a.png' }],
  });
  const r2 = await runtime.runTurn({
    sessionKey: sessionId, turnId: 't2', userText: '继续',
    configRevision: 'r', runtimeVersion: 'v', userRole: 'user',
    attachments: [],
  });
  const session = sessions.load(sessionId);
  const userMsgs = (session.messages || []).filter((m) => m.role === 'user');
  const firstUser = userMsgs.find((m) => String(m.content || '').includes('看这张图'));
  assert.ok(firstUser, '首轮 user 消息应持久化');
  assert.equal(seenByTurn.rounds[1], 0, `第二轮模型可见 vision 图应为 0（实际 ${JSON.stringify(seenByTurn)}）——历史图不得重发`);
  assert.ok(!Array.isArray(firstUser.imageRefs) || firstUser.imageRefs.length === 0, '持久化后的历史 user 消息不应再带 imageRefs');
  assert.ok(String(firstUser.content || '').includes('https://example.test/a.png'), 'URL 占位必须保留在文本中（F-1：供下轮 image.edit 引用）');
});