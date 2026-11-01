import test from 'node:test';
import assert from 'node:assert/strict';

const { createAgentHost } = await import('../dist/apps/bot/src/agent-host.js');
const { createDefaultConfig } = await import('../dist/packages/config/src/index.js');
const { InMemoryAgentSessionManager } = await import('../dist/packages/agent-runtime/src/index.js');

test('R25 image-only group input reaches the Agent model instead of failing empty_user_input', async () => {
  const cfg = createDefaultConfig();
  cfg.agent.enabled = true;
  cfg.agent.mode = 'enforce';
  cfg.agent.maxModelRounds = 2;
  cfg.freeMode.enabled = false;
  cfg.toolRegistry.enabled = true;
  let captured;
  const host = createAgentHost({
    getConfig: () => cfg,
    client: {
      async chat(_nodeIndex, request) {
        captured = request;
        return { text: '图片收到了。', raw: {}, finishReason: 'stop' };
      },
      can: () => true,
    },
    sessions: new InMemoryAgentSessionManager({}),
    toolBindings: () => [],
    preflightToolCall: () => ({ allowed: true }),
  });
  const outcome = await host({
    text: '',
    images: ['data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='],
    chatType: 'group',
    groupId: '112516775',
    userId: '1354762633',
    sessionId: 'group:112516775:1354762633',
  });
  assert.equal(outcome.handled, true);
  assert.equal(outcome.status, 'completed');
  assert.equal(outcome.text, '图片收到了。');
  assert.ok(captured, 'model must be called');
  const user = (captured.messages || []).find((message) => message.role === 'user');
  assert.ok(user, 'user message must exist');
  assert.ok(Array.isArray(user.content), 'image-only user content must use provider multimodal parts');
  assert.ok(user.content.some((part) => part.type === 'image_url'), 'image part must be present');
});
