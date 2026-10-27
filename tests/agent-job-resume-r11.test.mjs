import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentHost } from '../dist/apps/bot/src/agent-host.js';
import { createDefaultConfig } from '../dist/packages/config/src/index.js';
import { normalizeToolSpec, toolPending, toolSuccess } from '../dist/packages/tool-runtime/src/index.js';

test('async job resume keeps original user text and does not re-inject the resume notice', async () => {
  const cfg = createDefaultConfig();
  cfg.agent.enabled = true;
  cfg.agent.mode = 'enforce';
  cfg.agent.mainModel = 'gpt-4o-mini';
  const spec = normalizeToolSpec({
    name: 'image.generate', title: '图片生成', description: '生成图片',
    inputSchema: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'], additionalProperties: false },
    riskLevel: 'medium', sideEffects: ['creates_artifact'], queue: 'image', idempotency: 'turn', exposure: 'core',
  });
  const requests = [];
  let modelCalls = 0;
  const client = { async chat(_nodeIndex, request) {
    requests.push(request);
    modelCalls += 1;
    if (modelCalls === 1) return { text: '', raw: {}, toolCalls: [{ id: 'img_call', name: 'image.generate', arguments: { prompt: '猫' } }], finishReason: 'tool_calls' };
    return { text: '画好了。', raw: {} };
  } };
  let jobStatus = 'running';
  const host = createAgentHost({
    getConfig: () => cfg,
    client,
    toolBindings: () => [{ spec, handler: async (call) => toolPending(call.id, 'job-1', { toolName: call.name, content: '子任务已提交' }) }],
    preflightToolCall: () => ({ allowed: true }),
    resolveJob: (record) => ({
      jobId: record.jobId,
      status: jobStatus,
      ...(jobStatus === 'succeeded' ? { result: toolSuccess('img_call', 'image.generate', { outputs: [{ kind: 'image', url: 'https://example.test/art.png' }] }) } : {}),
    }),
  });
  const first = await host({ text: '画一只猫', chatType: 'private', userId: '1', sessionId: 'private:resume-r11' });
  assert.equal(first.status, 'suspended');
  jobStatus = 'succeeded';
  const second = await host({ text: '画一只猫', resumeJob: true, availableToolNames: [], chatType: 'private', userId: '1', sessionId: 'private:resume-r11' });
  assert.equal(second.status, 'completed');
  const userMessages = requests[1].messages.filter((message) => message.role === 'user');
  assert.equal(userMessages.length, 1);
  assert.equal(userMessages[0].content, '画一只猫');
  assert.ok(!JSON.stringify(requests[1].messages).includes('异步任务结果已就绪'));
  assert.ok(requests[1].messages.some((message) => message.role === 'tool' && /art\.png/.test(message.content)));
  const planned = (second.replyPlan?.groups || []).flatMap((group) => group.outputs || []);
  assert.ok(planned.some((output) => output.kind === 'image' && output.url === 'https://example.test/art.png'));
});
