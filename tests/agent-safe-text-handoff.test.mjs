// safe-text 兜底必须能真正送达用户（线上时测 2026-11-18）：
//   agent-host 旧逻辑把 meta.safeTextFallback 当成「接管失败」，把兜底产出的真实回答丢掉，
//   用户收到的是一句「可能没通过内容校验」。
// 契约：工具轮预算耗尽但模型用已有结果产出了文本时，文本要正常交付。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultConfig } from '../dist/packages/config/src/index.js';
import { createAgentHost } from '../dist/apps/bot/src/agent-host.js';
import { InMemoryToolIdempotencyStore, normalizeToolSpec } from '../dist/packages/tool-runtime/src/index.js';
import { InMemoryAgentSessionManager } from '../dist/packages/agent-runtime/src/index.js';

function baseConfig() {
  const cfg = createDefaultConfig();
  cfg.bot.botQqId = '10000';
  cfg.agent.enabled = true;
  cfg.agent.mode = 'enforce';
  cfg.toolRegistry.enabled = true;
  cfg.agent.maxModelRounds = 20;
  cfg.agent.maxToolRounds = 4;
  return cfg;
}

test('工具轮耗尽时，safe-text 兜底的回答必须交付给用户', async () => {
  const cfg = baseConfig();
  const sessions = new InMemoryAgentSessionManager({});
  const spec = normalizeToolSpec({
    name: 'novel.platform',
    title: 'novel.platform',
    description: 'news platform',
    inputSchema: { type: 'object', properties: { rank: { type: 'string' } }, additionalProperties: true },
    riskLevel: 'low',
    outputKinds: ['text'],
    exposure: 'core',
  });
  let round = 0;
  const client = {
    async chat(_nodeIndex, request) {
      round += 1;
      // 前 5 次不断要工具（第 5 次会超预算 → 触发 safe-text）
      if (round <= 5) {
        return { text: '', raw: {}, toolCalls: [{ id: 'c' + round, name: 'novel.platform', arguments: { rank: 'r' + round } }], finishReason: 'tool_calls' };
      }
      // safe-text 那次：只依据已有事实作答
      return { text: '已拿到 4 个榜单，月票数据还需要再查。', raw: {}, finishReason: 'stop', messages: request?.messages };
    },
    can: () => true,
  };
  const host = createAgentHost({
    getConfig: () => cfg,
    client,
    sessions,
    idempotencyStore: new InMemoryToolIdempotencyStore(),
    toolBindings: () => [{
      spec,
      handler: async (call) => ({ ok: true, callId: call.id, toolName: 'novel.platform', content: 'snapshot:' + JSON.stringify(call.arguments) }),
    }],
    preflightToolCall: () => ({ allowed: true }),
    isReadOnlyTool: () => true,
    isMigratedTool: () => true,
  });
  const outcome = await host({
    text: '拉本周三江每本书的月票数据',
    chatType: 'group', groupId: '709088381', userId: '2238639363',
    sessionId: 'group:709088381:2238639363', userRole: 'user',
  });
  assert.equal(outcome.turn?.status, 'completed');
  assert.equal(outcome.turn?.meta?.safeTextFallback, true, '这一轮确实走的是兜底路径');
  assert.equal(outcome.handled, true, '兜底轮必须被视为已接管，而不是「接管失败」');
  assert.equal(outcome.text, '已拿到 4 个榜单，月票数据还需要再查。');
});