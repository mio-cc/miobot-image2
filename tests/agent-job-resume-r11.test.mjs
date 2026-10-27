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

test('resume: artifact tool result never becomes visible text fallback', async () => {
  const cfg = createDefaultConfig();
  cfg.agent.enabled = true;
  cfg.agent.mode = 'enforce';
  cfg.agent.mainModel = 'gpt-4o-mini';
  const spec = normalizeToolSpec({
    name: 'image.generate', title: '图片生成', description: '生成图片',
    inputSchema: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'], additionalProperties: false },
    riskLevel: 'medium', sideEffects: ['creates_artifact'], queue: 'image', idempotency: 'turn', exposure: 'core',
  });
  let modelCalls = 0;
  let jobStatus = 'running';
  const client = { async chat() {
    modelCalls += 1;
    if (modelCalls === 1) return { text: '', raw: {}, toolCalls: [{ id: 'img_call', name: 'image.generate', arguments: { prompt: '猫' } }], finishReason: 'tool_calls' };
    throw new Error('model unavailable after image');
  } };
  const host = createAgentHost({
    getConfig: () => cfg,
    client,
    toolBindings: () => [{ spec, handler: async (call) => toolPending(call.id, 'job-img-text', { toolName: call.name, content: '子任务已提交' }) }],
    preflightToolCall: () => ({ allowed: true }),
    resolveJob: (record) => ({
      jobId: record.jobId,
      status: jobStatus,
      ...(jobStatus === 'succeeded' ? { result: toolSuccess('img_call', 'image.generate', {
        content: '[image.generate] {\"status\":\"success\",\"outputs\":[{\"kind\":\"image\",\"url\":\"data:image/png;base64,AAAA\"}]}',
        outputs: [{ kind: 'image', url: 'data:image/png;base64,AAAA' }],
      }) } : {}),
    }),
  });
  await host({ text: '画一只猫', chatType: 'private', userId: '1', sessionId: 'private:artifact-text-fallback' });
  jobStatus = 'succeeded';
  const second = await host({ text: '画一只猫', resumeJob: true, availableToolNames: [], chatType: 'private', userId: '1', sessionId: 'private:artifact-text-fallback' });
  const planned = (second.replyPlan?.groups || []).flatMap((group) => group.outputs || []);
  assert.equal(second.handled, true);
  assert.ok(planned.some((output) => output.kind === 'image'));
  assert.equal(planned.some((output) => output.kind === 'text'), false, JSON.stringify(planned));
  const visibleText = planned.filter((output) => output.kind === 'text').map((output) => String(output.text || '')).join('\\n');
  assert.equal(visibleText.includes('image.generate'), false);
  assert.equal(visibleText.includes('图片数据已省略'), false);
});
test('resume only one pending job at a time and keep the other job', async () => {
  const cfg = createDefaultConfig();
  cfg.agent.enabled = true;
  cfg.agent.mode = 'enforce';
  cfg.agent.mainModel = 'mock';
  const imageSpec = normalizeToolSpec({
    name: 'image.generate', title: '图片生成', description: '生成图片',
    inputSchema: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'], additionalProperties: false },
    riskLevel: 'medium', sideEffects: ['creates_artifact'], queue: 'image', idempotency: 'turn', exposure: 'core',
  });
  const audioSpec = normalizeToolSpec({
    name: 'audio.music.generate', title: '音乐生成', description: '生成音乐',
    inputSchema: { type: 'object', properties: { request: { type: 'string' } }, required: ['request'], additionalProperties: false },
    riskLevel: 'medium', sideEffects: ['creates_artifact'], queue: 'audio', idempotency: 'turn', exposure: 'core',
  });
  const jobStates = new Map([
    ['job-a', 'running'],
    ['job-b', 'running'],
  ]);
  let modelCalls = 0;
  const client = { async chat() {
    modelCalls += 1;
    if (modelCalls === 1) return { text: '', raw: {}, toolCalls: [{ id: 'img-a', name: 'image.generate', arguments: { prompt: '猫' } }], finishReason: 'tool_calls' };
    if (modelCalls === 2) return { text: '', raw: {}, toolCalls: [{ id: 'audio-b', name: 'audio.music.generate', arguments: { request: '歌' } }], finishReason: 'tool_calls' };
    if (modelCalls === 3) return { text: '图好了。', raw: {}, finishReason: 'stop' };
    return { text: '歌好了。', raw: {}, finishReason: 'stop' };
  } };
  const host = createAgentHost({
    getConfig: () => cfg,
    client,
    toolBindings: () => [
      { spec: imageSpec, handler: async (call) => toolPending(call.id, 'job-a', { toolName: call.name }) },
      { spec: audioSpec, handler: async (call) => toolPending(call.id, 'job-b', { toolName: call.name }) },
    ],
    preflightToolCall: () => ({ allowed: true }),
    resolveJob: (record) => ({
      jobId: record.jobId,
      status: jobStates.get(record.jobId) || 'running',
      ...(jobStates.get(record.jobId) === 'succeeded' ? { result: toolSuccess(
        record.jobId === 'job-a' ? 'img-a' : 'audio-b',
        record.toolName,
        { outputs: record.jobId === 'job-a'
          ? [{ kind: 'image', url: 'https://example.test/a.png' }]
          : [{ kind: 'audio', url: 'https://example.test/b.mp3' }] },
      ) } : {}),
    }),
  });
  const first = await host({ text: '画猫', chatType: 'private', userId: '1', sessionId: 'private:two-jobs' });
  assert.equal(first.status, 'suspended');
  const second = await host({ text: '再来首歌', chatType: 'private', userId: '1', sessionId: 'private:two-jobs' });
  assert.equal(second.status, 'suspended');

  jobStates.set('job-a', 'succeeded');
  const resumeA = await host({ text: '继续', resumeJob: true, resumeJobId: 'job-a', availableToolNames: [], chatType: 'private', userId: '1', sessionId: 'private:two-jobs' });
  assert.equal(resumeA.status, 'completed');
  assert.equal(resumeA.text, '图好了。');
  const planA = (resumeA.replyPlan?.groups || []).flatMap((group) => group.outputs || []);
  assert.ok(planA.some((output) => output.kind === 'image' && output.url?.includes('a.png')));
  assert.equal(planA.some((output) => output.kind === 'audio'), false);

  jobStates.set('job-b', 'succeeded');
  const resumeB = await host({ text: '继续', resumeJob: true, resumeJobId: 'job-b', availableToolNames: [], chatType: 'private', userId: '1', sessionId: 'private:two-jobs' });
  assert.equal(resumeB.status, 'completed');
  assert.equal(resumeB.text, '歌好了。');
  const planB = (resumeB.replyPlan?.groups || []).flatMap((group) => group.outputs || []);
  assert.ok(planB.some((output) => output.kind === 'audio' && output.url?.includes('b.mp3')));
  assert.equal(planB.some((output) => output.kind === 'image'), false, 'resume audio must not carry the old image result');
});