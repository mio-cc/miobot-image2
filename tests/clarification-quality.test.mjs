import test from 'node:test';
import assert from 'node:assert/strict';
import { generateClarificationWithModel } from '../dist/packages/orchestration/src/index.js';
import { OrchestrationEnforcer } from '../dist/apps/bot/src/orchestration-enforce.js';
import { PendingJobStore } from '../dist/apps/bot/src/pending-job-store.js';
import { createDefaultConfig } from '../dist/packages/config/src/index.js';
import { builtinCapabilityDescriptors } from '../dist/packages/orchestration/src/index.js';

const request = {
  requestId: 'r', text: '我的两个老婆',
  chat: { type: 'private', userId: '1' },
  user: { qq: '1', role: 'user' },
  attachments: [], history: [],
};
const plan = {
  planId: 'p', requestId: 'r', goal: '回应聊天', confidence: 0.2, source: 'model',
  understanding: { goal: '回应聊天', desiredOutcome: 'answer', constraints: [], missingInformation: [], confidence: 0.2 },
  steps: [],
  needsClarification: true,
  clarificationQuestion: '',
};

test('clarification prompt forbids capability questionnaires and examples', async () => {
  let userPrompt = '';
  const client = {
    async chat(_nodeIndex, input) {
      userPrompt = String(input?.messages?.find((message) => message.role === 'user')?.content || '');
      return { text: JSON.stringify({ question: '你想聊什么？', missingInformation: [] }) };
    },
  };
  const result = await generateClarificationWithModel(
    client,
    request,
    plan,
    builtinCapabilityDescriptors(),
    [{ code: 'needs_input', message: '用户没有说明具体任务' }],
    { nodeIndex: 0, model: 'test', timeoutMs: 1000, maxTokens: 1000 },
  );
  assert.equal(result.value.question, '你想聊什么？');
  assert.match(userPrompt, /不要把普通聊天/);
  assert.match(userPrompt, /严禁向用户列举/);
  assert.doesNotMatch(userPrompt, /写歌、画图/);
  assert.doesNotMatch(userPrompt, /能力清单/);
});

test('clarification resolution failure falls back to normal chat instead of a fixed image instruction', async () => {
  const cfg = createDefaultConfig();
  cfg.orchestration.enabled = true;
  cfg.orchestration.mode = 'enforce';
  cfg.orchestration.planner.enabled = true;
  cfg.orchestration.roles.planner.enabled = true;
  const store = new PendingJobStore();
  store.set({
    key: 'private:1', originalText: '我的两个老婆', question: '你指的是谁？', attempts: 1,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60000).toISOString(), schemaVersion: 2,
    jobId: 'job-clarify', requestId: 'r', status: 'clarifying', originalRequest: request,
    plan: { ...plan, steps: [{ id: 'chat', capability: 'chat.reply', args: { prompt: '我的两个老婆' } }] },
    order: ['chat'], results: {}, approvedStepIds: [], pendingStepId: undefined,
    clarificationUsed: true, clarificationCount: 1, startedAt: Date.now(),
  });
  const enforcer = new OrchestrationEnforcer({
    getConfig: () => cfg,
    pendingJobs: store,
    app: { handle: async () => ({ kind: 'chat', handled: true, text: '正常聊天' }), engine: {}, sessions: { clear() {} } },
    client: { async chat() { return { text: JSON.stringify({ resolved: false, reason: 'clarification_unresolved' }) }; } },
  });
  const result = await enforcer.handle({ text: '滚滚滚滚滚滚', chatType: 'private', userId: '1' });
  assert.equal(result.handled, false);
  assert.equal(result.result, undefined);
  assert.equal(result.reason, 'clarification_resolution_failed');
  assert.equal(store.list().length, 0);
  assert.equal(result.problem, undefined);
});