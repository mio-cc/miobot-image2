import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ToolJobRuntime } from '../dist/apps/bot/src/tool-job-runtime.js';
import { createCapabilityToolBinding } from '../dist/apps/bot/src/capability-tool-adapter.js';
import { reportExternalTaskFromHandler } from '../dist/packages/orchestration/src/index.js';
import { createAgentHost } from '../dist/apps/bot/src/agent-host.js';
import { createDefaultConfig } from '../dist/packages/config/src/index.js';
import {
  normalizeToolSpec,
  toolPending,
  toolSuccess,
} from '../dist/packages/tool-runtime/src/index.js';

test('tool-job R5.5: runtime persists external task ids and marks interrupted jobs on restart', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'miobot-tool-job-'));
  const file = path.join(dir, 'jobs.json');
  const first = new ToolJobRuntime({ filePath: file });
  const job = first.create({ toolName: 'video.generate', callId: 'call-1', sessionKey: 'private:1' });
  first.recordExternalTask(job.jobId, 'remote-task-1');
  const restarted = new ToolJobRuntime({ filePath: file });
  const recovered = restarted.get(job.jobId);
  assert.equal(recovered.status, 'failed');
  assert.equal(recovered.error.code, 'tool_job_interrupted');
  assert.deepEqual(recovered.externalTaskIds, ['remote-task-1']);
  await fs.rm(dir, { recursive: true, force: true });
});

test('tool-job R5.5: background completion stores the final ToolResult and notifies once', async () => {
  const jobs = new ToolJobRuntime();
  const completed = [];
  const withCallback = new ToolJobRuntime({ onComplete: (job) => completed.push(job) });
  const job = withCallback.create({ toolName: 'image.generate', callId: 'call-img', sessionKey: 'private:2' });
  const result = toolSuccess('call-img', 'image.generate', {
    outputs: [{ kind: 'image', url: 'https://example.test/cat.png' }],
  });
  await withCallback.run(job.jobId, Promise.resolve(result));
  const record = withCallback.get(job.jobId);
  assert.equal(record.status, 'succeeded');
  assert.equal(record.result.outputs[0].url, 'https://example.test/cat.png');
  assert.equal(completed.length, 1);
  assert.equal(completed[0].jobId, job.jobId);
  assert.equal(jobs.snapshot().length, 0);
});

test('agent-job R5.5: pending job suspends, then resumes with the completed artifact once', async () => {
  const cfg = createDefaultConfig();
  cfg.agent.enabled = true;
  cfg.agent.mode = 'enforce';
  cfg.agent.mainModel = 'gpt-4o-mini';
  cfg.freeMode.enabled = false;
  const spec = normalizeToolSpec({
    name: 'image.generate',
    title: '图片生成',
    description: '生成图片',
    inputSchema: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'], additionalProperties: false },
    riskLevel: 'medium',
    sideEffects: ['creates_artifact'],
    queue: 'image',
    idempotency: 'turn',
    exposure: 'core',
  });
  const requests = [];
  let modelCalls = 0;
  let handlerCalls = 0;
  let jobState = { status: 'running' };
  const client = {
    async chat(_nodeIndex, request) {
      requests.push(request);
      modelCalls += 1;
      if (modelCalls === 1) {
        return {
          text: '',
          raw: {},
          toolCalls: [{ id: 'img_call', name: 'image.generate', arguments: { prompt: '猫' } }],
          finishReason: 'tool_calls',
        };
      }
      return { text: '图片已生成。', raw: {} };
    },
  };
  const host = createAgentHost({
    getConfig: () => cfg,
    client,
    toolBindings: () => [{
      spec,
      handler: async (call) => {
        handlerCalls += 1;
        return toolPending(call.id, 'job-image-1', { toolName: call.name, content: '子任务已提交' });
      },
    }],
    preflightToolCall: () => ({ allowed: true }),
    resolveJob: (record) => ({
      jobId: record.jobId,
      status: jobState.status,
      ...(jobState.result ? { result: jobState.result } : {}),
    }),
  });
  const first = await host({ text: '画一只猫', chatType: 'private', userId: '1', sessionId: 'private:async-job' });
  assert.equal(handlerCalls, 1);
  assert.equal(first.status, 'suspended');
  assert.equal(first.handled, true);
  assert.equal(first.terminal, true);
  assert.equal(first.reason, 'agent_job_pending');
  assert.match(first.text, /任务已提交/);

  jobState = {
    status: 'succeeded',
    result: toolSuccess('img_call', 'image.generate', {
      jobId: 'job-image-1',
      outputs: [{ kind: 'image', url: 'https://example.test/async-cat.png', priority: 20 }],
    }),
  };
  const second = await host({ text: '任务好了吗？', chatType: 'private', userId: '1', sessionId: 'private:async-job' });
  assert.equal(handlerCalls, 1);
  assert.equal(second.status, 'completed');
  assert.equal(second.text, '图片已生成。');
  assert.equal(second.handled, true);
  const toolMessage = requests[1].messages.find((message) => message.role === 'tool' && message.toolCallId === 'img_call');
  assert.ok(toolMessage);
  assert.match(toolMessage.content, /async-cat\.png/);
  const planned = (second.replyPlan?.groups || []).flatMap((group) => group.outputs || []);
  assert.ok(planned.some((output) => output.kind === 'image' && output.url === 'https://example.test/async-cat.png'));
});

test('agent-job R5.5: deep capability handlers can report external task ids through tool context', async () => {
  const reported = [];
  const descriptor = {
    id: 'video.generate',
    version: '1.0.0',
    name: '视频生成',
    provider: 'model',
    enabled: true,
    mode: 'async_job',
    effect: 'generate',
    riskLevel: 'high',
    inputSchema: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'], additionalProperties: false },
    outputKinds: ['video'],
  };
  const binding = createCapabilityToolBinding(descriptor, {
    async execute(invocation) {
      reportExternalTaskFromHandler('remote-video-1');
      return { jobId: invocation.plan.planId, status: 'success', outputs: [{ kind: 'video', url: 'https://example.test/v.mp4' }] };
    },
  });
  const result = await binding.handler(
    { id: 'video_call', name: 'video.generate', arguments: { prompt: '猫' } },
    binding.spec,
    {
      turnId: 't1',
      sessionKey: 'private:1',
      reportExternalTask: (taskId) => reported.push(taskId),
      metadata: { chatType: 'private', userId: '1', userRole: 'user', userText: '生成视频' },
    },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(reported, ['remote-video-1']);
});