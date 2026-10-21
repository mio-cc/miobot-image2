import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildReplyPlan,
  buildPlannerPrompt,
  applyCapabilityOverrides,
  builtinCapabilityDescriptors,
  applyRuntimeCapabilityGates,
  CapabilityRegistry,
  defaultOrchestrationConfig,
  normalizeOrchestrationConfig,
  evaluatePromptPromotion,
  selectConfiguredPromptVersion,
  diffPromptText,
  isCanarySelected,
  validateCapabilityArgs,
  normalizeCapabilityArgs,
  validationQuestion,
  buildCommandIntentPlan,
  listCommandMappings,
  ApprovalBroker,
  SunoClient,
  CapabilityDispatcher,
  executeIntentPlan,
  parseApprovalReply,
  planWithModel,
  matchExactCommand,
  validateIntentPlan,
  createApproval,
  createDefaultPermissionPolicy,
  createPermissionPolicyFromDefaults,
  decideApproval,
  expireApproval,
  resolvePermission,
} from '../dist/packages/orchestration/src/index.js';
import { ApprovalRuntime } from '../dist/apps/bot/src/approval-runtime.js';
import { createReplyStrategyEngine } from '../dist/packages/reply/src/index.js';
import { SunoCapabilityHandler } from '../dist/apps/bot/src/capability-suno.js';
import { OrchestrationEnforcer } from '../dist/apps/bot/src/orchestration-enforce.js';
import { PendingJobStore } from '../dist/apps/bot/src/pending-job-store.js';
import { JobRecoveryService } from '../dist/apps/bot/src/job-recovery.js';
import { SunoPromptComposer, buildSunoComposerPrompt } from '../dist/apps/bot/src/suno-composer.js';
import { createDefaultConfig } from '../dist/packages/config/src/index.js';

function request(overrides = {}) {
  return {
    capability: 'image.generate',
    provider: 'comfyui',
    riskLevel: 'high',
    user: { qq: '100', role: 'user' },
    chat: { type: 'group', groupId: '200' },
    ...overrides,
  };
}

test('orchestration: three-state permission defaults and hard deny', () => {
  const policy = createDefaultPermissionPolicy();
  assert.equal(resolvePermission(request(), policy).decision, 'deny');
  assert.equal(resolvePermission(request({ user: { qq: '1', role: 'owner' } }), policy).decision, 'allow');
  assert.equal(resolvePermission(request({ user: { qq: '2', role: 'admin' } }), policy).decision, 'ask_admin');

  const hard = {
    ...policy,
    rules: [...policy.rules, { id: 'hard-secret', scope: 'capability', capability: 'secrets.read', mode: 'deny', hard: true }],
  };
  const denied = resolvePermission(request({ capability: 'secrets.read', user: { qq: '1', role: 'owner' } }), hard);
  assert.equal(denied.decision, 'deny');
  assert.equal(denied.hardDenied, true);
});

test('orchestration: approval quorum, reject wins and payload binding', () => {
  const approval = createApproval({
    requestId: 'r1', jobId: 'j1', stepId: 's1',
    payload: { file: 'a' }, capability: 'file.delete', riskLevel: 'high',
    requesterQq: '100', groupId: '200', adminQqIds: ['900', '901'], quorum: 'all',
    now: new Date('2026-01-01T00:00:00Z'), ttlMs: 60000,
  });
  const first = decideApproval(approval, { adminQq: '900', decision: 'approve', at: '2026-01-01T00:00:01Z' }, undefined, new Date('2026-01-01T00:00:01Z'));
  assert.equal(first.status, 'pending');
  const second = decideApproval(first, { adminQq: '901', decision: 'approve', at: '2026-01-01T00:00:02Z' }, undefined, new Date('2026-01-01T00:00:02Z'));
  assert.equal(second.status, 'approved');

  const rejected = decideApproval(approval, { adminQq: '900', decision: 'reject', at: '2026-01-01T00:00:03Z' }, undefined, new Date('2026-01-01T00:00:03Z'));
  assert.equal(rejected.status, 'rejected');
  assert.throws(() => decideApproval(approval, { adminQq: '900', decision: 'approve', at: '2026-01-01T00:00:04Z' }, 'wrong', new Date('2026-01-01T00:00:04Z')), /payload_changed/);
  assert.equal(expireApproval(approval, new Date('2026-01-01T00:02:00Z')).status, 'expired');
});

test('orchestration: capability registry rejects duplicates', () => {
  const registry = new CapabilityRegistry();
  registry.register({ id: 'image.generate', version: '1', name: '生成', provider: 'comfyui', enabled: true });
  assert.equal(registry.get('image.generate')?.enabled, true);
  assert.throws(() => registry.register({ id: 'image.generate', version: '2', name: '重复', provider: 'comfyui', enabled: true }), /duplicate/);
});

test('orchestration: reply plan nests mergeable outputs and truncates low priority', () => {
  const outputs = [
    { id: 'img1', kind: 'image', url: 'u1', priority: 10 },
    { id: 'img2', kind: 'image', url: 'u2', priority: 9 },
    { id: 'audio1', kind: 'audio', url: 'a1', priority: 8 },
    { id: 'file1', kind: 'file', url: 'f1', priority: 7 },
    { id: 'low1', kind: 'image', url: 'low', priority: 1 },
  ];
  const plan = buildReplyPlan(outputs, { maxMessages: 3, maxResultItems: 4 });
  assert.equal(plan.messageCount, 3);
  assert.equal(plan.groups[0].mode, 'nested_forward');
  assert.equal(plan.groups[0].outputs.length, 2);
  assert.equal(plan.groups[1].mode, 'direct');
  assert.equal(plan.groups[2].mode, 'direct');
  assert.ok(plan.truncated.length >= 1);
  assert.ok(plan.warnings.length >= 1);
});

test('orchestration: intent plan validates dependencies and rejects cycles', () => {
  const plan = {
    planId: 'p1', requestId: 'r1', goal: 'test', steps: [
      { id: 'a', capability: 'web.search', args: {} },
      { id: 'b', capability: 'image.generate', args: {}, dependsOn: ['a'] },
    ],
  };
  const valid = validateIntentPlan(plan, { maxSteps: 5 });
  assert.equal(valid.ok, true);
  assert.deepEqual(valid.order, ['a', 'b']);
  const cyclic = { ...plan, steps: [
    { id: 'a', capability: 'x', args: {}, dependsOn: ['b'] },
    { id: 'b', capability: 'y', args: {}, dependsOn: ['a'] },
  ] };
  const bad = validateIntentPlan(cyclic, { maxSteps: 5 });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((item) => item.includes('cycle')));
});

test('orchestration: exact commands never scan inside ordinary sentences', () => {
  const commands = [{ id: 'recall', aliases: ['ch', '撤回'], capability: 'owner.recall' }];
  assert.deepEqual(matchExactCommand('ch 3', commands), {
    id: 'recall', capability: 'owner.recall', alias: 'ch', args: '3',
  });
  assert.equal(matchExactCommand('帮我 ch 一下', commands), null);
  assert.equal(matchExactCommand('ch帮我', commands), null);
});

test('orchestration: planner parses model JSON and repair loop handles bad output', async () => {
  const request = {
    requestId: 'r1',
    chat: { type: 'group', groupId: '200' },
    user: { qq: '100', role: 'user' },
    text: '画一个竖版动漫少女',
  };
  const catalog = [{ id: 'image.generate', version: '1', name: '生图', provider: 'comfyui', enabled: true }];
  const responses = [
    '不是 JSON',
    JSON.stringify({
      planId: 'plan1', requestId: 'evil-model-id', goal: '生成图片',
      steps: [{ id: 's1', capability: 'image.generate', args: { aspectRatio: '9:16' } }],
      confidence: 0.9,
    }),
  ];
  const client = {
    async chat() { return { text: responses.shift() || '' }; },
  };
  const plan = await planWithModel(client, request, { nodeIndex: 1, model: 'test', capabilityCatalog: catalog, maxRepairAttempts: 1 });
  assert.equal(plan.steps[0].capability, 'image.generate');
  assert.equal(plan.requestId, 'r1');
  assert.equal(plan.steps[0].args.aspectRatio, '9:16');
});

test('orchestration: default config has safe operational budgets', () => {
  const cfg = defaultOrchestrationConfig();
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.mode, 'shadow');
  assert.equal(cfg.execution.maxSteps, 20);
  assert.equal(cfg.execution.maxDepth, 10);
  assert.equal(cfg.reply.maxMessages, 3);
  assert.equal(cfg.reply.overflowPolicy, 'truncate');
  assert.equal(cfg.suno.provider, 'suno-official');
});

test('orchestration: builtin capability catalogue includes required high-risk entries', () => {
  const items = builtinCapabilityDescriptors();
  const ids = new Set(items.map((item) => item.id));
  for (const id of ['image.generate', 'video.generate', 'audio.music.generate', 'file.delete', 'config.update', 'permission.update', 'chat.reply']) {
    assert.ok(ids.has(id), id);
  }
  assert.equal(items.find((item) => item.id === 'audio.music.generate')?.provider, 'suno-official');
  assert.equal(items.find((item) => item.id === 'file.delete')?.approvalRequired, true);
});

test('orchestration: dispatcher and executor enforce permission and dependency order', async () => {
  const registry = new CapabilityRegistry();
  registry.register({ id: 'web.search', version: '1', name: '搜索', provider: 'search', enabled: true, riskLevel: 'low' });
  registry.register({ id: 'image.generate', version: '1', name: '生图', provider: 'comfyui', enabled: true, riskLevel: 'medium' });
  const dispatcher = new CapabilityDispatcher(registry, createDefaultPermissionPolicy());
  const calls = [];
  dispatcher.registerHandler('web.search', { async execute({ step }) { calls.push(step.id); return { jobId: 'j', stepId: step.id, status: 'success', outputs: [{ kind: 'text', text: 'result' }] }; } });
  dispatcher.registerHandler('image.generate', { async execute({ step, dependencyResults }) { calls.push(step.id); return { jobId: 'j', stepId: step.id, status: 'success', outputs: [{ kind: 'image', url: 'img' }], diagnostics: { dep: Boolean(dependencyResults.s1) } }; } });
  const request = { requestId: 'r', chat: { type: 'group', groupId: 'g' }, user: { qq: 'u', role: 'user' }, text: 'x' };
  const plan = {
    planId: 'p', requestId: 'r', goal: 'x', steps: [
      { id: 's1', capability: 'web.search', args: {} },
      { id: 's2', capability: 'image.generate', args: {}, dependsOn: ['s1'] },
    ],
  };
  const out = await executeIntentPlan(request, plan, { dispatcher, maxSteps: 10 });
  assert.equal(out.status, 'success');
  assert.deepEqual(calls, ['s1', 's2']);
  assert.equal(out.outputs.length, 2);
});

test('orchestration: approval message parser accepts admin replies and rejects plain chat', () => {
  assert.deepEqual(parseApprovalReply('同意 A7K2Q9'), { decision: 'approve', code: 'A7K2Q9' });
  assert.deepEqual(parseApprovalReply('拒绝 a7k2q9'), { decision: 'reject', code: 'A7K2Q9' });
  assert.deepEqual(parseApprovalReply('取消 A7K2Q9'), { decision: 'cancel', code: 'A7K2Q9' });
  assert.equal(parseApprovalReply('同意'), null);
  assert.equal(parseApprovalReply('帮我同意 A7K2Q9'), null);
});

test('orchestration: config normalization clamps unsafe values', () => {
  const cfg = normalizeOrchestrationConfig({
    mode: 'enforce',
    execution: { maxSteps: 99999, maxDurationMs: -1 },
    reply: { maxMessages: 999, overflowPolicy: 'truncate' },
    approval: { allowGroupReply: true, adminQqIds: ['900'] },
    suno: { provider: 'suno-official', maxDurationSeconds: 9999 },
  });
  assert.equal(cfg.mode, 'enforce');
  assert.equal(cfg.execution.maxSteps, 1000);
  assert.equal(cfg.execution.maxDurationMs, 1000);
  assert.equal(cfg.reply.maxMessages, 20);
  assert.equal(cfg.approval.allowGroupReply, true);
  assert.deepEqual(cfg.approval.adminQqIds, ['900']);
  assert.equal(cfg.suno.maxDurationSeconds, 900);
});

test('orchestration: approval broker resolves by code and keeps terminal state', () => {
  const broker = new ApprovalBroker();
  const approval = broker.create({
    requestId: 'r', jobId: 'j', payload: { x: 1 }, capability: 'config.update',
    riskLevel: 'critical', requesterQq: 'u', adminQqIds: ['900'], quorum: 'any',
    now: new Date('2026-01-01T00:00:00Z'), ttlMs: 60000,
  });
  const byCode = broker.getByCode(approval.code);
  assert.equal(byCode?.approvalId, approval.approvalId);
  const approved = broker.decideByCode(approval.code, { adminQq: '900', decision: 'approve', at: '2026-01-01T00:00:01Z' }, undefined, new Date('2026-01-01T00:00:01Z'));
  assert.equal(approved.status, 'approved');
  assert.equal(broker.decideByCode(approval.code, { adminQq: '900', decision: 'reject', at: '2026-01-01T00:00:02Z' }, undefined, new Date('2026-01-01T00:00:02Z')).status, 'approved');
});

test('orchestration: approval runtime sends prompt and resumes on admin reply', async () => {
  const delivered = [];
  const runtime = new ApprovalRuntime({
    adminQqIds: () => ['900'],
    allowGroupReply: () => true,
    allowedGroupIds: () => ['200'],
    sendPrivate: async (qq, text) => { delivered.push({ qq, text }); return { success: true }; },
    sendGroup: async () => ({ success: true }),
  });
  const pending = runtime.request({
    requestId: 'r1', jobId: 'j1', capability: 'config.update', riskLevel: 'critical',
    requesterQq: '100', groupId: '200', payload: { a: 1 }, ttlMs: 60000,
  });
  assert.equal(delivered.length, 1);
  const current = runtime.getBroker().list('pending')[0];
  const handled = await runtime.handleReply({ text: `同意 ${current.code}`, userId: '900', groupId: '200', chatType: 'group' });
  assert.equal(handled.handled, true);
  const outcome = await pending;
  assert.equal(outcome.status, 'approved');
});

test('orchestration: Suno client creates and polls an official-style task', async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method });
    if (String(url).endsWith('/generate') && init?.method === 'POST') {
      return new Response(JSON.stringify({ id: 'task-1' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ status: 'completed', data: { audio_url: 'https://cdn.example/song.mp3', title: 'song' } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const client = new SunoClient({ baseUrl: 'https://suno.example/v1', apiKey: 'secret', requestMode: 'legacy', createPath: '/generate', statusPath: '/generate/{id}', fetchImpl: fakeFetch, pollIntervalMs: 1 });
  const created = await client.create({ prompt: 'upbeat pop' });
  assert.equal(created.id, 'task-1');
  const done = await client.wait(created.id);
  assert.equal(done.status, 'success');
  assert.equal(done.outputs[0].url, 'https://cdn.example/song.mp3');
  assert.ok(calls.some((call) => call.url.includes('/generate/task-1')));
});

test('orchestration: Suno capability handler returns audio and cover outputs', async () => {
  const handler = new SunoCapabilityHandler({
    getConfig: () => ({ orchestration: { suno: { enabled: true } } }),
    createClient: () => ({
      async create() { return { id: 'task-1', raw: {} }; },
      async wait() { return { id: 'task-1', status: 'success', raw: {}, outputs: [{ url: 'https://cdn/song.mp3', coverUrl: 'https://cdn/cover.jpg', title: 'song' }] }; },
    }),
  });
  const result = await handler.execute({
    request: { requestId: 'r', chat: { type: 'private' }, user: { qq: '1', role: 'user' }, text: 'song' },
    plan: { planId: 'p', requestId: 'r', goal: 'music', steps: [] },
    step: { id: 's1', capability: 'audio.music.generate', args: { prompt: 'upbeat' } },
    dependencyResults: {},
  });
  assert.equal(result.status, 'success');
  assert.equal(result.outputs[0].kind, 'audio');
  assert.equal(result.outputs[1].kind, 'image');
});

test('orchestration: enforce path plans and executes image capability through legacy adapter', async () => {
  const cfg = createDefaultConfig();
  cfg.orchestration.enabled = true;
  cfg.orchestration.mode = 'enforce';
  cfg.orchestration.planner.enabled = true;
  cfg.orchestration.planner.nodeIndex = 1;
  cfg.orchestration.planner.model = 'planner-test';
  const fakeApp = {
    handle: async () => ({ kind: 'chat', handled: true, text: 'chat', decision: { kind: 'chat', source: 'fallback', confidence: 1, reason: '', params: { prompt: '', tokens: [] }, usedPlanner: false } }),
    engine: {
      handleExplicit: async () => ({ kind: 'image.generate', handled: true, images: ['data:image/png;base64,AA'], decision: { kind: 'image.generate', source: 'signal', confidence: 1, reason: '', params: { prompt: 'cat', tokens: [] }, usedPlanner: false } }),
    },
    sessions: { clear() {} },
    registry: () => ({}),
    client: {},
  };
  const fakeClient = {
    async chat() {
      return { text: JSON.stringify({ planId: 'p1', requestId: 'r1', goal: 'generate', steps: [{ id: 's1', capability: 'image.generate', args: { prompt: 'cat' } }], confidence: 0.9 }) };
    },
  };
  const enforcer = new OrchestrationEnforcer({ getConfig: () => cfg, app: fakeApp, client: fakeClient });
  const result = await enforcer.handle({ text: '画一只猫', chatType: 'private', userId: '1' });
  assert.equal(result.handled, true);
  assert.equal(result.result.images[0], 'data:image/png;base64,AA');
  assert.ok(result.result.replyPlan);
  assert.equal(result.result.replyPlan.messageCount, 1);
});

test('orchestration: capability overrides change enabled and approval flags', () => {
  const items = applyCapabilityOverrides(builtinCapabilityDescriptors(), {
    'image.generate': { enabled: false },
    'audio.music.generate': { enabled: true, approvalRequired: true },
  });
  assert.equal(items.find((item) => item.id === 'image.generate')?.enabled, false);
  assert.equal(items.find((item) => item.id === 'audio.music.generate')?.approvalRequired, true);
});

test('orchestration: prompt promotion policy and canary selection are deterministic', () => {
  const policy = { minSamples: 50, minSuccessRate: 0.9, minAverageScore: 0.8, maxSafetyFailures: 0, canaryPercent: 10, requireOwnerApproval: true };
  assert.equal(evaluatePromptPromotion({ samples: 60, successRate: 0.95, averageScore: 0.9, safetyFailures: 0 }, policy).promote, false);
  assert.equal(evaluatePromptPromotion({ samples: 60, successRate: 0.95, averageScore: 0.9, safetyFailures: 0 }, policy, true).promote, true);
  assert.equal(isCanarySelected('fixed-key', 0), false);
  assert.equal(isCanarySelected('fixed-key', 100), true);
  assert.equal(isCanarySelected('fixed-key', 10), isCanarySelected('fixed-key', 10));
});

test('orchestration: approval broker snapshot restores pending approval', () => {
  const broker = new ApprovalBroker();
  const created = broker.create({
    requestId: 'r1', jobId: 'j1', capability: 'config.update', riskLevel: 'critical',
    requesterQq: '1', adminQqIds: ['9'], quorum: 'any', payload: { x: 1 }, ttlMs: 60000,
  });
  const restored = new ApprovalBroker();
  restored.restore(broker.snapshot());
  assert.equal(restored.getByCode(created.code)?.approvalId, created.approvalId);
});

test('orchestration: enforcer returns partial result instead of dangerous legacy fallback', async () => {
  const cfg = createDefaultConfig();
  cfg.orchestration.enabled = true;
  cfg.orchestration.mode = 'enforce';
  cfg.orchestration.planner.enabled = true;
  cfg.orchestration.planner.nodeIndex = 1;
  cfg.orchestration.planner.model = 'planner-test';
  const fakeApp = {
    handle: async () => ({ kind: 'chat', handled: true, text: 'chat' }),
    engine: { handleExplicit: async () => ({ kind: 'image.generate', handled: true, images: ['img-1'], decision: { kind: 'image.generate', source: 'signal', confidence: 1, reason: '', params: { prompt: 'cat', tokens: [] }, usedPlanner: false } }) },
    sessions: { clear() {} },
    registry: () => ({}),
    client: {},
  };
  const fakeClient = {
    async chat() {
      return { text: JSON.stringify({ planId: 'p2', requestId: 'r2', goal: 'two steps', steps: [
        { id: 's1', capability: 'image.generate', args: { prompt: 'cat' } },
        { id: 's2', capability: 'file.read', args: {}, dependsOn: ['s1'] },
      ], confidence: 0.9 }) };
    },
  };
  const enforcer = new OrchestrationEnforcer({ getConfig: () => cfg, app: fakeApp, client: fakeClient });
  const result = await enforcer.handle({ text: '先画图再读文件', chatType: 'private', userId: '1' });
  assert.equal(result.handled, true);
  assert.equal(result.result.images[0], 'img-1');
  assert.equal(result.problem.kind, 'capability_failed');
});

test('orchestration: pending clarification resumes with next user message', async () => {
  const cfg = createDefaultConfig();
  cfg.orchestration.enabled = true;
  cfg.orchestration.mode = 'enforce';
  cfg.orchestration.planner.enabled = true;
  cfg.orchestration.planner.nodeIndex = 1;
  cfg.orchestration.planner.model = 'planner-test';
  const fakeApp = {
    handle: async () => ({ kind: 'chat', handled: true, text: 'chat' }),
    engine: { handleExplicit: async () => ({ kind: 'image.generate', handled: true, images: ['img-resume'], decision: { kind: 'image.generate', source: 'signal', confidence: 1, reason: '', params: { prompt: 'cat', tokens: [] }, usedPlanner: false } }) },
    sessions: { clear() {} }, registry: () => ({}), client: {},
  };
  let call = 0;
  const fakeClient = {
    async chat() {
      call += 1;
      return { text: call === 1
        ? JSON.stringify({ planId: 'p3', requestId: 'r3', goal: 'need', steps: [], needsClarification: true, clarificationQuestion: '什么风格？', confidence: 0.5 })
        : JSON.stringify({ planId: 'p4', requestId: 'r4', goal: 'generate', steps: [{ id: 's1', capability: 'image.generate', args: { prompt: 'cat' } }], confidence: 0.9 }) };
    },
  };
  const store = new PendingJobStore();
  const enforcer = new OrchestrationEnforcer({ getConfig: () => cfg, app: fakeApp, client: fakeClient, pendingJobs: store });
  const first = await enforcer.handle({ text: '画猫', chatType: 'private', userId: '1' });
  assert.equal(first.result.text, '什么风格？');
  const second = await enforcer.handle({ text: '水彩', chatType: 'private', userId: '1' });
  assert.equal(second.result.images[0], 'img-resume');
  assert.equal(store.list().length, 0);
});

test('orchestration: capability argument schema validation produces clarification issues', () => {
  const schema = {
    type: 'object', required: ['prompt'],
    properties: { prompt: { type: 'string', minLength: 1 }, count: { type: 'number', minimum: 1, maximum: 4 } },
  };
  assert.equal(validateCapabilityArgs(schema, { prompt: 'cat', count: 2 }).ok, true);
  const missing = validateCapabilityArgs(schema, { count: 2 });
  assert.equal(missing.ok, false);
  assert.ok(missing.issues.some((item) => item.code === 'required'));
  const bad = validateCapabilityArgs(schema, { prompt: 'cat', count: 9 });
  assert.ok(bad.issues.some((item) => item.code === 'maximum'));
  assert.ok(validationQuestion(bad.issues).includes('count'));
});

test('orchestration: exact command builds IntentPlan without model planning', () => {
  const plan = buildCommandIntentPlan({ requestId: 'r', command: 'genImage', args: '一只猫' });
  assert.equal(plan.source, 'command');
  assert.equal(plan.steps[0].capability, 'image.generate');
  assert.equal(plan.steps[0].args.prompt, '一只猫');
  assert.equal(buildCommandIntentPlan({ requestId: 'r', command: 'unknown' }), null);
});

test('orchestration: hard deny overrides owner allow for configured capability', () => {
  const policy = createPermissionPolicyFromDefaults({
    low: 'allow', medium: 'allow', high: 'ask_admin', critical: 'deny',
    hardDenyEnabled: true, hardDenyCapabilities: ['config.update'],
  });
  const decision = resolvePermission({
    capability: 'config.update', provider: 'admin', riskLevel: 'critical',
    user: { qq: '1', role: 'owner' }, chat: { type: 'private' },
  }, policy);
  assert.equal(decision.decision, 'deny');
  assert.equal(decision.hardDenied, true);
});

test('orchestration: command plan covers every runtime-mappable exact command', () => {
  const mappings = new Map(listCommandMappings().map((item) => [item.command, item.capability]));
  const expected = {
    genImage: 'image.generate',
    img2Img: 'image.edit',
    editImage: 'image.edit',
    interrogate: 'image.interrogate',
    fileList: 'file.list',
    fileRead: 'file.read',
    fileGenerate: 'file.generate',
    webSearch: 'web.search',
    codeRender: 'code.render',
    webScreenshot: 'browser.render',
    templateLibrary: 'template.list',
    help: 'help',
    clear: 'session.clear',
    ownerRecall: 'owner.recall',
  };
  for (const [command, capability] of Object.entries(expected)) {
    assert.equal(mappings.get(command), capability, command);
    assert.equal(buildCommandIntentPlan({ requestId: 'r', command, args: 'x' })?.source, 'command');
  }
  const recall = buildCommandIntentPlan({ requestId: 'r', command: 'ownerRecall', args: '7' });
  assert.deepEqual(recall.steps[0].args, { count: 7 });
  assert.equal(buildCommandIntentPlan({ requestId: 'r', command: 'originalImage' }), null);
});

test('orchestration: clear exact command executes through dispatcher without planner', async () => {
  const cfg = createDefaultConfig();
  cfg.orchestration.enabled = true;
  cfg.orchestration.mode = 'enforce';
  let plannerCalls = 0;
  let cleared = '';
  const fakeApp = {
    handle: async () => ({ kind: 'chat', handled: true, text: 'unexpected' }),
    engine: { handleExplicit: async () => ({ kind: 'chat', handled: true, text: 'unexpected' }) },
    sessions: { clear: (key) => { cleared = key; return true; } },
    registry: () => ({}),
    client: {},
  };
  const fakeClient = { async chat() { plannerCalls += 1; return { text: '{}' }; } };
  const plan = buildCommandIntentPlan({ requestId: 'r-clear', command: 'clear' });
  const enforcer = new OrchestrationEnforcer({ getConfig: () => cfg, app: fakeApp, client: fakeClient });
  const result = await enforcer.handle({ text: '', chatType: 'private', userId: '100', plan });
  assert.equal(result.handled, true);
  assert.match(result.result.text, /新对话/);
  assert.equal(cleared, 'private:100');
  assert.equal(plannerCalls, 0);
});
test('orchestration: executor limits DAG layer parallelism', async () => {
  const registry = new CapabilityRegistry();
  for (const id of ['job.a', 'job.b', 'job.c', 'job.d']) {
    registry.register({ id, version: '1', name: id, provider: 'test', enabled: true, riskLevel: 'low' });
  }
  const dispatcher = new CapabilityDispatcher(registry, createDefaultPermissionPolicy());
  let active = 0;
  let maxActive = 0;
  const calls = [];
  for (const id of ['job.a', 'job.b', 'job.c', 'job.d']) {
    dispatcher.registerHandler(id, {
      async execute({ step }) {
        calls.push(step.id);
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
        return { jobId: 'j', stepId: step.id, status: 'success', outputs: [{ kind: 'text', text: step.id }] };
      },
    });
  }
  const request = { requestId: 'r', chat: { type: 'private' }, user: { qq: 'u', role: 'user' }, text: 'x' };
  const plan = {
    planId: 'p-parallel', requestId: 'r', goal: 'parallel', steps: [
      { id: 'a', capability: 'job.a', args: {} },
      { id: 'b', capability: 'job.b', args: {} },
      { id: 'c', capability: 'job.c', args: {} },
      { id: 'd', capability: 'job.d', args: {} },
    ],
  };
  const result = await executeIntentPlan(request, plan, { dispatcher, maxParallelSteps: 2 });
  assert.equal(result.status, 'success');
  assert.equal(calls.length, 4);
  assert.equal(maxActive, 2);
  assert.equal(result.usage.maxParallelObserved, 2);
});

test('orchestration: executor enforces maxCost and resumes without rerunning successful steps', async () => {
  const registry = new CapabilityRegistry();
  registry.register({ id: 'cost.a', version: '1', name: 'a', provider: 'test', enabled: true, riskLevel: 'low', estimatedCost: 1 });
  registry.register({ id: 'cost.b', version: '1', name: 'b', provider: 'test', enabled: true, riskLevel: 'low', estimatedCost: 1 });
  const dispatcher = new CapabilityDispatcher(registry, createDefaultPermissionPolicy());
  const calls = [];
  dispatcher.registerHandler('cost.a', { async execute({ step }) { calls.push('a'); return { jobId: 'j', stepId: step.id, status: 'success', outputs: [{ kind: 'text', text: 'a' }] }; } });
  dispatcher.registerHandler('cost.b', { async execute({ step }) { calls.push('b'); return { jobId: 'j', stepId: step.id, status: 'success', outputs: [{ kind: 'text', text: 'b' }] }; } });
  const request = { requestId: 'r', chat: { type: 'private' }, user: { qq: 'u', role: 'user' }, text: 'x' };
  const plan = {
    planId: 'p-cost', requestId: 'r', goal: 'budget', steps: [
      { id: 'a', capability: 'cost.a', args: {} },
      { id: 'b', capability: 'cost.b', args: {} },
    ],
  };
  const first = await executeIntentPlan(request, plan, { dispatcher, maxParallelSteps: 1, maxCost: 1 });
  assert.equal(first.status, 'partial');
  assert.deepEqual(calls, ['a']);
  assert.equal(first.results.b.error, 'max_cost_exceeded');
  assert.equal(first.usage.cost, 1);

  const resumed = await executeIntentPlan(request, plan, {
    dispatcher, maxParallelSteps: 1, maxCost: 2, initialResults: first.results,
  });
  assert.equal(resumed.status, 'success');
  assert.deepEqual(calls, ['a', 'b']);
});

test('orchestration: executor enforces model round budget before dispatch', async () => {
  const registry = new CapabilityRegistry();
  registry.register({ id: 'model.a', version: '1', name: 'a', provider: 'model', enabled: true, riskLevel: 'low' });
  registry.register({ id: 'model.b', version: '1', name: 'b', provider: 'model', enabled: true, riskLevel: 'low' });
  const dispatcher = new CapabilityDispatcher(registry, createDefaultPermissionPolicy());
  const calls = [];
  dispatcher.registerHandler('model.a', { async execute({ step }) { calls.push('a'); return { jobId: 'j', stepId: step.id, status: 'success', outputs: [], modelRounds: 1 }; } });
  dispatcher.registerHandler('model.b', { async execute({ step }) { calls.push('b'); return { jobId: 'j', stepId: step.id, status: 'success', outputs: [], modelRounds: 1 }; } });
  const request = { requestId: 'r', chat: { type: 'private' }, user: { qq: 'u', role: 'user' }, text: 'x' };
  const plan = {
    planId: 'p-rounds', requestId: 'r', goal: 'rounds', steps: [
      { id: 'a', capability: 'model.a', args: {} },
      { id: 'b', capability: 'model.b', args: {} },
    ],
  };
  const result = await executeIntentPlan(request, plan, { dispatcher, maxParallelSteps: 1, maxModelRounds: 1 });
  assert.equal(result.status, 'partial');
  assert.deepEqual(calls, ['a']);
  assert.equal(result.results.b.error, 'max_model_rounds_exceeded');
  assert.equal(result.usage.modelRounds, 1);
});

test('orchestration: planner obeys maxModelRounds and executor retries are bounded', async () => {
  const request = {
    requestId: 'r', chat: { type: 'private' }, user: { qq: 'u', role: 'user' }, text: 'draw',
  };
  let plannerCalls = 0;
  await assert.rejects(() => planWithModel({
    async chat() { plannerCalls += 1; return { text: 'not-json' }; },
  }, request, {
    nodeIndex: 0, model: 'm', capabilityCatalog: [], maxRepairAttempts: 9, maxModelRounds: 2,
  }), /planner_failed/);
  assert.equal(plannerCalls, 2);

  const registry = new CapabilityRegistry();
  registry.register({ id: 'retry.a', version: '1', name: 'a', provider: 'test', enabled: true, riskLevel: 'low', maxRetries: 3 });
  const dispatcher = new CapabilityDispatcher(registry, createDefaultPermissionPolicy());
  let retryCalls = 0;
  dispatcher.registerHandler('retry.a', {
    async execute({ step }) {
      retryCalls += 1;
      return { jobId: 'j', stepId: step.id, status: 'failed', outputs: [], error: 'same_error', retryable: true };
    },
  });
  const plan = { planId: 'p-retry', requestId: 'r', goal: 'retry', steps: [{ id: 'a', capability: 'retry.a', args: {} }] };
  const result = await executeIntentPlan(request, plan, { dispatcher, loopDetection: true });
  assert.equal(result.status, 'failed');
  assert.equal(retryCalls, 2);
  assert.equal(result.results.a.diagnostics.loopDetected, true);
});

test('orchestration: executor step timeout suppresses text fallback and duplicate retry', async () => {
  const registry = new CapabilityRegistry();
  registry.register({ id: 'slow.a', version: '1', name: 'slow', provider: 'test', enabled: true, riskLevel: 'low', timeoutMs: 25, maxRetries: 3 });
  const dispatcher = new CapabilityDispatcher(registry, createDefaultPermissionPolicy());
  let calls = 0;
  dispatcher.registerHandler('slow.a', {
    async execute({ step }) {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 80));
      return { jobId: 'j', stepId: step.id, status: 'success', outputs: [{ kind: 'text', text: 'late' }] };
    },
  });
  const request = { requestId: 'r', chat: { type: 'private' }, user: { qq: 'u', role: 'user' }, text: 'x' };
  const plan = { planId: 'p-timeout', requestId: 'r', goal: 'timeout', steps: [{ id: 'a', capability: 'slow.a', args: {} }] };
  const result = await executeIntentPlan(request, plan, { dispatcher });
  assert.equal(result.status, 'failed');
  assert.equal(result.results.a.error, 'step_timeout');
  assert.equal(calls, 1);
  assert.equal(result.outputs.length, 0);
});
test('orchestration: reply plan preserves a high-priority direct main result and embeds truncation notice', () => {
  const plan = buildReplyPlan([
    { id: 'file-main', kind: 'file', url: 'main.zip', priority: 10, mergeable: false },
    { id: 'image-1', kind: 'image', url: 'img.png', priority: 9, mergeable: true },
    { id: 'audio-1', kind: 'audio', url: 'voice.mp3', priority: 8, mergeable: false },
  ], {
    maxMessages: 2,
    maxResultItems: 20,
    preferNestedForward: true,
    includeTruncationNotice: true,
  });
  assert.equal(plan.messageCount, 2);
  assert.equal(plan.groups[0].mode, 'direct');
  assert.equal(plan.groups[0].outputs[0].id, 'file-main');
  assert.ok(plan.truncated.some((item) => item.id === 'audio-1'));
  assert.equal(plan.noticeIncluded, true);
  const nested = plan.groups.find((group) => group.mode === 'nested_forward');
  assert.ok(nested.outputs.some((item) => item.id === 'reply-truncation-notice'));
});

test('orchestration: final ReplyPlan sender enforces maxMessages and keeps files direct', async () => {
  const sent = [];
  let nextId = 1;
  const ok = () => ({ success: true, messageId: nextId++ });
  const fakeReply = {
    sendPrivateText: async (userId, text) => { sent.push(['text', text]); return ok(); },
    sendPrivateImage: async (userId, image) => { sent.push(['image', image]); return ok(); },
    sendPrivateNestedMixedForward: async (userId, groups) => { sent.push(['nested', groups]); return ok(); },
    sendPrivateMixedForward: async (userId, items) => { sent.push(['flat', items]); return ok(); },
    sendPrivateFile: async (userId, file, name) => { sent.push(['file', file, name]); return ok(); },
    sendPrivateRecord: async (userId, file) => { sent.push(['record', file]); return ok(); },
  };
  const engine = createReplyStrategyEngine(fakeReply, {
    text: 'plain', image: 'plain', multiImage: 'plain', video: 'plain', multiVideo: 'plain',
    file: 'forward', multiFile: 'forward', mixed: 'forward',
  });
  const plan = {
    groups: [
      { mode: 'nested_forward', outputs: [
        { id: 't', kind: 'text', text: '结果', priority: 10 },
        { id: 'i', kind: 'image', url: 'img.png', priority: 9 },
      ], messageCount: 1 },
      { mode: 'direct', outputs: [{ id: 'f', kind: 'file', url: 'main.zip', priority: 8, mergeable: false, meta: { name: 'main.zip' } }], messageCount: 1 },
      { mode: 'direct', outputs: [{ id: 'a', kind: 'audio', url: 'voice.mp3', priority: 7, mergeable: false }], messageCount: 1 },
    ],
    messageCount: 3,
    truncated: [],
    warnings: [],
    maxMessages: 2,
  };
  const result = await engine.replyPlan({ chatType: 'private', userId: '100' }, plan, { maxMessages: 2 });
  assert.equal(result.sentCount, 2);
  assert.equal(result.budgetEnforced, true);
  assert.equal(result.truncatedCount, 1);
  assert.deepEqual(sent.map((item) => item[0]), ['nested', 'file']);
  assert.equal(sent[1][1], 'main.zip');
  assert.equal(result.success, true);
});
test('orchestration: ReplyPlan sender preserves configured text reply strategy', async () => {
  const sent = [];
  const fakeReply = {
    sendGroupText: async (groupId, text, replyTo) => { sent.push(['groupText', text, replyTo]); return { success: true, messageId: 1 }; },
    sendGroupNestedTextForward: async () => { sent.push(['nestedText']); return { success: true, messageId: 2 }; },
    sendPrivateText: async (userId, text) => { sent.push(['privateText', text]); return { success: true, messageId: 3 }; },
    sendGroupImage: async () => ({ success: true }),
    sendPrivateImage: async () => ({ success: true }),
  };
  const engine = createReplyStrategyEngine(fakeReply, { text: 'quote' });
  const plan = {
    groups: [{ mode: 'nested_forward', outputs: [{ id: 't', kind: 'text', text: '原样文本' }], messageCount: 1 }],
    messageCount: 1,
    truncated: [],
    warnings: [],
    maxMessages: 1,
  };
  const result = await engine.replyPlan({
    chatType: 'group', groupId: '9', userId: '5', senderId: '5', replyToMessageId: '77', botName: 'Mio',
  }, plan, { maxMessages: 1 });
  assert.equal(result.success, true);
  assert.deepEqual(sent[0], ['groupText', '原样文本', '77']);
});
test('orchestration: permission matrix normalizes all supported scopes and filters bad rules', () => {
  const cfg = normalizeOrchestrationConfig({
    permissions: {
      rules: [
        { id: 'u1', scope: 'user', mode: 'deny', qq: '100', priority: 50, hard: true },
        { id: 'u1', scope: 'group', mode: 'ask_admin', groupId: '200' },
        { id: 'bad', scope: 'user', mode: 'explode' },
        { id: 'role', scope: 'role', mode: 'allow', roles: ['admin', 'bad-role'], riskLevels: ['high', 'nope'] },
        { id: 'cap', scope: 'capability', mode: 'deny', capability: 'file.delete' },
        { id: 'provider', scope: 'provider', mode: 'allow', provider: 'comfyui' },
      ],
    },
  });
  assert.equal(cfg.permissions.rules.length, 5);
  assert.deepEqual(cfg.permissions.rules.map((rule) => rule.id), ['u1', 'u1_2', 'role', 'cap', 'provider']);
  assert.deepEqual(cfg.permissions.rules[2].roles, ['admin']);
  assert.deepEqual(cfg.permissions.rules[2].riskLevels, ['high']);
  assert.equal(cfg.permissions.rules[0].hard, true);
});

test('orchestration: permission matrix respects precedence and hard deny overrides owner allow', () => {
  const defaults = {
    low: 'allow', medium: 'allow', high: 'ask_admin', critical: 'deny',
    hardDenyEnabled: true,
    rules: [
      { id: 'owner-image-deny', scope: 'user', mode: 'deny', qq: '1' },
      { id: 'admin-group-ask', scope: 'group', mode: 'ask_admin', groupId: '200' },
      { id: 'provider-medium-allow', scope: 'provider', mode: 'allow', provider: 'custom-provider' },
      { id: 'hard-config', scope: 'capability', mode: 'deny', capability: 'config.update', hard: true },
    ],
  };
  const policy = createPermissionPolicyFromDefaults(defaults);

  const userRule = resolvePermission({
    capability: 'image.generate', provider: 'comfyui', riskLevel: 'low',
    user: { qq: '1', role: 'owner' }, chat: { type: 'private' },
  }, policy);
  assert.equal(userRule.decision, 'deny');
  assert.equal(userRule.matchedRule, 'matrix:owner-image-deny');

  const groupRule = resolvePermission({
    capability: 'image.generate', provider: 'comfyui', riskLevel: 'medium',
    user: { qq: '2', role: 'admin' }, chat: { type: 'group', groupId: '200' },
  }, policy);
  assert.equal(groupRule.decision, 'ask_admin');
  assert.equal(groupRule.matchedRule, 'matrix:admin-group-ask');

  const providerRule = resolvePermission({
    capability: 'web.search', provider: 'custom-provider', riskLevel: 'medium',
    user: { qq: '3', role: 'user' }, chat: { type: 'private' },
  }, policy);
  assert.equal(providerRule.decision, 'allow');
  assert.equal(providerRule.matchedRule, 'matrix:provider-medium-allow');

  const hardRule = resolvePermission({
    capability: 'config.update', provider: 'admin', riskLevel: 'critical',
    user: { qq: '1', role: 'owner' }, chat: { type: 'private' },
  }, policy);
  assert.equal(hardRule.decision, 'deny');
  assert.equal(hardRule.hardDenied, true);
  assert.equal(hardRule.matchedRule, 'matrix:hard-config');

  const disabledPolicy = createPermissionPolicyFromDefaults({ ...defaults, hardDenyEnabled: false });
  const ownerStillAllowed = resolvePermission({
    capability: 'config.update', provider: 'admin', riskLevel: 'critical',
    user: { qq: '9', role: 'owner' }, chat: { type: 'private' },
  }, disabledPolicy);
  assert.equal(ownerStillAllowed.decision, 'allow');
  assert.equal(ownerStillAllowed.hardDenied, false);
});
test('orchestration: ReplyPlan final sender counts long-text split messages against maxMessages', async () => {
  const sent = [];
  const fakeReply = {
    sendPrivateText: async (userId, text) => { sent.push(['text', text]); return { success: true, messageId: sent.length }; },
    sendPrivateImage: async (userId, image) => { sent.push(['image', image]); return { success: true, messageId: sent.length }; },
  };
  const engine = createReplyStrategyEngine(fakeReply, {
    text: 'plain',
    textReply: { maxChars: 12, splitDelayMs: 0, showPartPrefix: false },
  });
  const plan = {
    groups: [
      { mode: 'direct', outputs: [{ id: 't', kind: 'text', text: '这是一段很长的文本内容，用于验证最终发送层的消息预算真的生效。' }], messageCount: 1 },
      { mode: 'direct', outputs: [{ id: 'i', kind: 'image', url: 'should-not-send.png' }], messageCount: 1 },
    ],
    messageCount: 2,
    truncated: [],
    warnings: [],
    maxMessages: 2,
  };
  const result = await engine.replyPlan({ chatType: 'private', userId: '100' }, plan, { maxMessages: 2 });
  assert.equal(sent.length, 2);
  assert.equal(sent[0][0], 'text');
  assert.equal(sent[1][0], 'text');
  assert.match(sent[1][1], /截断/);
  assert.equal(result.sentCount, 2);
  assert.equal(result.budgetEnforced, true);
  assert.equal(result.truncatedCount, 1);
});
test('orchestration: scoped permission rules without a target are rejected during normalization', () => {
  const cfg = normalizeOrchestrationConfig({
    permissions: {
      rules: [
        { id: 'bad-user', scope: 'user', mode: 'deny' },
        { id: 'bad-group', scope: 'group', mode: 'deny' },
        { id: 'bad-role', scope: 'role', mode: 'deny', roles: [] },
        { id: 'bad-cap', scope: 'capability', mode: 'deny' },
        { id: 'bad-provider', scope: 'provider', mode: 'deny' },
        { id: 'good-global', scope: 'global', mode: 'deny' },
      ],
    },
  });
  assert.deepEqual(cfg.permissions.rules.map((rule) => rule.id), ['good-global']);
});

test('orchestration: approvalRequired upgrades medium risk for non-owner roles', async () => {
  const registry = new CapabilityRegistry();
  registry.register({ id: 'approval.medium', version: '1', name: 'approval', provider: 'test', enabled: true, riskLevel: 'medium', approvalRequired: true });
  const dispatcher = new CapabilityDispatcher(registry, createDefaultPermissionPolicy());
  let calls = 0;
  dispatcher.registerHandler('approval.medium', { async execute({ step }) { calls += 1; return { jobId: 'j', stepId: step.id, status: 'success', outputs: [] }; } });
  const plan = { planId: 'p-approval', requestId: 'r', goal: 'approval', steps: [{ id: 's', capability: 'approval.medium', args: {} }] };
  const admin = await dispatcher.dispatch({ requestId: 'r', chat: { type: 'private' }, user: { qq: '2', role: 'admin' }, text: 'x' }, plan, plan.steps[0]);
  assert.equal(admin.result.status, 'waiting_approval');
  assert.equal(admin.permission.decision, 'ask_admin');
  const user = await dispatcher.dispatch({ requestId: 'r', chat: { type: 'private' }, user: { qq: '3', role: 'user' }, text: 'x' }, plan, plan.steps[0]);
  assert.equal(user.result.status, 'denied');
  const owner = await dispatcher.dispatch({ requestId: 'r', chat: { type: 'private' }, user: { qq: '1', role: 'owner' }, text: 'x' }, plan, plan.steps[0]);
  assert.equal(owner.result.status, 'success');
  assert.equal(calls, 1);
});

test('orchestration: Suno capability is disabled by runtime gate until enabled', () => {
  const disabled = applyRuntimeCapabilityGates(builtinCapabilityDescriptors(), { sunoEnabled: false });
  const enabled = applyRuntimeCapabilityGates(builtinCapabilityDescriptors(), { sunoEnabled: true, externalEnabled: true, allowlist: ['suno-official'] });
  assert.equal(disabled.find((item) => item.id === 'audio.music.generate')?.enabled, false);
  assert.equal(enabled.find((item) => item.id === 'audio.music.generate')?.enabled, true);
  const providerDenied = applyRuntimeCapabilityGates(builtinCapabilityDescriptors(), { sunoEnabled: true, externalEnabled: true, allowlist: ['other-provider'] });
  assert.equal(providerDenied.find((item) => item.id === 'audio.music.generate')?.enabled, false);
});

test('orchestration: owner config command cannot bypass hard deny', async () => {
  const cfg = createDefaultConfig();
  cfg.orchestration.enabled = true;
  cfg.orchestration.mode = 'enforce';
  cfg.bot.ownerQQs = ['1'];
  cfg.orchestration.permissions.hardDenyEnabled = true;
  cfg.orchestration.permissions.hardDenyCapabilities = ['config.update'];
  let ownerHandlerCalls = 0;
  const handlers = new Map([['config.update', {
    async execute({ step }) {
      ownerHandlerCalls += 1;
      return { jobId: 'j', stepId: step.id, status: 'success', outputs: [{ kind: 'text', text: 'changed' }] };
    },
  }]]);
  const enforcer = new OrchestrationEnforcer({
    getConfig: () => cfg,
    app: { sessions: { clear() {} }, engine: {}, handle: async () => ({}), registry: () => ({}), client: {} },
    client: { async chat() { throw new Error('planner_must_not_run'); } },
    handlers,
  });
  const plan = buildCommandIntentPlan({ requestId: 'r-owner', command: 'ownerSwitchModel', args: 'gpt-4o' });
  const result = await enforcer.handle({ text: 'gpt-4o', chatType: 'private', userId: '1', plan });
  assert.equal(result.handled, true);
  assert.equal(result.problem.kind, 'permission_denied');
  assert.equal(ownerHandlerCalls, 0);
});
test('orchestration: executor enforces maximum DAG depth', async () => {
  const registry = new CapabilityRegistry();
  for (const id of ['depth.a', 'depth.b', 'depth.c']) {
    registry.register({ id, version: '1', name: id, provider: 'test', enabled: true, riskLevel: 'low' });
  }
  const dispatcher = new CapabilityDispatcher(registry, createDefaultPermissionPolicy());
  for (const id of ['depth.a', 'depth.b', 'depth.c']) {
    dispatcher.registerHandler(id, { async execute({ step }) { return { jobId: 'j', stepId: step.id, status: 'success', outputs: [] }; } });
  }
  const request = { requestId: 'r', chat: { type: 'private' }, user: { qq: 'u', role: 'user' }, text: 'x' };
  const plan = { planId: 'p-depth', requestId: 'r', goal: 'depth', steps: [
    { id: 'a', capability: 'depth.a', args: {} },
    { id: 'b', capability: 'depth.b', args: {}, dependsOn: ['a'] },
    { id: 'c', capability: 'depth.c', args: {}, dependsOn: ['b'] },
  ] };
  const result = await executeIntentPlan(request, plan, { dispatcher, maxDepth: 2 });
  assert.equal(result.status, 'failed');
  assert.equal(result.error, 'max_depth_exceeded');
});
test('orchestration: owner quorum only accepts owner and fails closed without owners', () => {
  const approval = createApproval({
    requestId: 'r-owner-q', jobId: 'j', capability: 'config.update', riskLevel: 'critical',
    requesterQq: '5', adminQqIds: ['900'], ownerQqIds: ['1'], quorum: 'owner',
    payload: { a: 1 }, ttlMs: 60000,
  });
  assert.throws(() => decideApproval(approval, { adminQq: '900', decision: 'approve', at: new Date().toISOString() }), /approval_admin_not_allowed/);
  const approved = decideApproval(approval, { adminQq: '1', decision: 'approve', at: new Date().toISOString() });
  assert.equal(approved.status, 'approved');

  const noOwner = createApproval({
    requestId: 'r-owner-empty', jobId: 'j', capability: 'config.update', riskLevel: 'critical',
    requesterQq: '5', adminQqIds: ['900'], ownerQqIds: [], quorum: 'owner',
    payload: { a: 1 }, ttlMs: 60000,
  });
  assert.throws(() => decideApproval(noOwner, { adminQq: '900', decision: 'approve', at: new Date().toISOString() }), /approval_admin_not_allowed/);
});

test('orchestration: approval runtime refuses requester self-approval and panel action still works', async () => {
  const delivered = [];
  const runtime = new ApprovalRuntime({
    adminQqIds: () => ['100', '900'],
    ownerQqIds: () => ['1'],
    allowGroupReply: () => false,
    sendPrivate: async (qq, text) => { delivered.push({ qq, text }); return { success: true }; },
  });
  const pending = runtime.request({
    requestId: 'r-self', jobId: 'j-self', capability: 'config.update', riskLevel: 'critical',
    requesterQq: '100', payload: { a: 1 }, quorum: 'any', ttlMs: 60000,
  });
  const current = runtime.getBroker().list('pending')[0];
  const self = await runtime.handleReply({ text: '同意 ' + current.code, userId: '100', chatType: 'private' });
  assert.equal(self.handled, true);
  assert.equal(self.reason, 'requester_cannot_approve');
  runtime.decideFromPanel(current.code, 'approve', 'panel-test');
  const outcome = await pending;
  assert.equal(outcome.status, 'approved');
  assert.ok(delivered.some((item) => item.qq === '900'));
  assert.equal(delivered.some((item) => item.qq === '100'), false);
});

test('orchestration: owner quorum approval prompt is delivered to owner recipients', async () => {
  const delivered = [];
  const runtime = new ApprovalRuntime({
    adminQqIds: () => ['900'],
    ownerQqIds: () => ['1'],
    allowGroupReply: () => false,
    sendPrivate: async (qq, text) => { delivered.push({ qq, text }); return { success: true }; },
  });
  const pending = runtime.request({
    requestId: 'r-owner-delivery', jobId: 'j-owner-delivery', capability: 'config.update', riskLevel: 'critical',
    requesterQq: '5', payload: { a: 1 }, quorum: 'owner', ttlMs: 60000,
  });
  const current = runtime.getBroker().list('pending')[0];
  assert.deepEqual(delivered.map((item) => item.qq), ['1']);
  await runtime.handleReply({ text: '同意 ' + current.code, userId: '1', chatType: 'private' });
  const outcome = await pending;
  assert.equal(outcome.status, 'approved');
});
test('orchestration: low-confidence plan asks clarification instead of executing', async () => {
  const cfg = createDefaultConfig();
  cfg.orchestration.enabled = true;
  cfg.orchestration.mode = 'enforce';
  cfg.orchestration.planner.enabled = true;
  cfg.orchestration.planner.minConfidence = 0.8;
  let capabilityCalls = 0;
  const handlers = new Map([['image.generate', {
    async execute({ step }) {
      capabilityCalls += 1;
      return { jobId: 'j', stepId: step.id, status: 'success', outputs: [{ kind: 'image', url: 'should-not-run.png' }] };
    },
  }]]);
  const enforcer = new OrchestrationEnforcer({
    getConfig: () => cfg,
    app: { sessions: { clear() {} }, engine: {}, handle: async () => ({}), registry: () => ({}), client: {} },
    client: {
      async chat() {
        return { text: JSON.stringify({
          planId: 'low-confidence', requestId: 'ignored', goal: 'generate',
          steps: [{ id: 's1', capability: 'image.generate', args: { prompt: 'cat' } }],
          confidence: 0.2,
        }) };
      },
    },
    handlers,
  });
  const result = await enforcer.handle({ text: '画猫', chatType: 'private', userId: '1' });
  assert.equal(result.handled, true);
  assert.match(result.result.text, /补充/);
  assert.equal(capabilityCalls, 0);
});
test('orchestration: disabled planner falls back without calling model', async () => {
  const cfg = createDefaultConfig();
  cfg.orchestration.enabled = true;
  cfg.orchestration.mode = 'enforce';
  cfg.orchestration.planner.enabled = false;
  let modelCalls = 0;
  const enforcer = new OrchestrationEnforcer({
    getConfig: () => cfg,
    app: { sessions: { clear() {} }, engine: {}, handle: async () => ({}), registry: () => ({}), client: {} },
    client: { async chat() { modelCalls += 1; return { text: '{}' }; } },
  });
  const result = await enforcer.handle({ text: '画猫', chatType: 'private', userId: '1' });
  assert.equal(result.handled, false);
  assert.equal(result.reason, 'planner_disabled');
  assert.equal(modelCalls, 0);
});
test('orchestration: approval-shaped messages are consumed even for non-admin senders', async () => {
  const runtime = new ApprovalRuntime({
    adminQqIds: () => ['900'],
    ownerQqIds: () => ['1'],
    allowGroupReply: () => false,
    sendPrivate: async () => ({ success: true }),
  });
  const result = await runtime.handleReply({ text: '同意 A7K2Q9', userId: '777', chatType: 'private' });
  assert.equal(result.handled, true);
  assert.equal(result.reason, 'not_an_approval_admin');
});
test('orchestration: approval cannot be reused after step arguments change', async () => {
  const cfg = createDefaultConfig();
  cfg.orchestration.enabled = true;
  cfg.orchestration.mode = 'enforce';
  cfg.orchestration.approval.enabled = true;
  cfg.orchestration.approval.adminQqIds = ['2'];
  let handlerCalls = 0;
  const handlers = new Map([['config.update', {
    async execute({ step }) {
      handlerCalls += 1;
      return { jobId: 'j', stepId: step.id, status: 'success', outputs: [] };
    },
  }]]);
  const enforcer = new OrchestrationEnforcer({
    getConfig: () => cfg,
    app: { sessions: { clear() {} }, engine: {}, handle: async () => ({}), registry: () => ({}), client: {} },
    client: { async chat() { throw new Error('no planner'); } },
    handlers,
    approvalRuntime: {
      async request() {
        return { status: 'approved', approval: { payloadHash: 'stale-hash' } };
      },
    },
  });
  const plan = {
    planId: 'p-payload', requestId: 'r-payload', goal: 'update', source: 'command',
    steps: [{ id: 's1', capability: 'config.update', args: { ownerAction: 'ttsOn' } }],
  };
  const result = await enforcer.handle({ text: 'tts on', chatType: 'private', userId: '2', plan });
  assert.equal(result.handled, true);
  assert.equal(result.problem.kind, 'approval_payload_changed');
  assert.equal(handlerCalls, 0);
});
test('orchestration: capability role allowlist cannot be bypassed by permission allow', async () => {
  const registry = new CapabilityRegistry();
  registry.register({
    id: 'owner.only', version: '1', name: 'owner only', provider: 'builtin',
    enabled: true, riskLevel: 'low', permissions: ['owner'],
  });
  const dispatcher = new CapabilityDispatcher(registry, createDefaultPermissionPolicy());
  let calls = 0;
  dispatcher.registerHandler('owner.only', { async execute({ step }) { calls += 1; return { jobId: 'j', stepId: step.id, status: 'success', outputs: [] }; } });
  const plan = { planId: 'p-owner-only', requestId: 'r', goal: 'owner', steps: [{ id: 's', capability: 'owner.only', args: {} }] };
  const user = await dispatcher.dispatch({ requestId: 'r', chat: { type: 'private' }, user: { qq: '2', role: 'user' }, text: 'x' }, plan, plan.steps[0]);
  assert.equal(user.result.status, 'denied');
  assert.equal(user.permission.matchedRule, 'capability.permissions');
  assert.equal(calls, 0);
  const owner = await dispatcher.dispatch({ requestId: 'r', chat: { type: 'private' }, user: { qq: '1', role: 'owner' }, text: 'x' }, plan, plan.steps[0]);
  assert.equal(owner.result.status, 'success');
  assert.equal(calls, 1);
});
test('orchestration: ReplyPlan never nests files or audio even if output is mislabeled mergeable', () => {
  const plan = buildReplyPlan([
    { id: 't', kind: 'text', text: 'summary', priority: 10, mergeable: true },
    { id: 'a', kind: 'audio', url: 'voice.mp3', priority: 9, mergeable: true },
    { id: 'f', kind: 'file', url: 'file.zip', priority: 8, mergeable: true },
  ], { maxMessages: 3, includeTruncationNotice: true });
  const nested = plan.groups.find((group) => group.mode === 'nested_forward');
  assert.deepEqual(nested.outputs.map((item) => item.kind), ['text']);
  assert.equal(plan.groups.filter((group) => group.mode === 'direct').length, 2);
});
test('orchestration: conditional steps are skipped safely and do not execute handlers', async () => {
  const registry = new CapabilityRegistry();
  registry.register({ id: 'cond.gate', version: '1', name: 'gate', provider: 'test', enabled: true, riskLevel: 'low' });
  registry.register({ id: 'cond.next', version: '1', name: 'next', provider: 'test', enabled: true, riskLevel: 'low' });
  const dispatcher = new CapabilityDispatcher(registry, createDefaultPermissionPolicy());
  const calls = [];
  dispatcher.registerHandler('cond.gate', { async execute({ step }) { calls.push('gate'); return { jobId: 'j', stepId: step.id, status: 'success', outputs: [] }; } });
  dispatcher.registerHandler('cond.next', { async execute({ step }) { calls.push('next'); return { jobId: 'j', stepId: step.id, status: 'success', outputs: [] }; } });
  const request = { requestId: 'r', chat: { type: 'private' }, user: { qq: 'u', role: 'user' }, text: 'x' };
  const plan = { planId: 'p-condition', requestId: 'r', goal: 'condition', steps: [
    { id: 'gate', capability: 'cond.gate', args: {}, condition: 'missing.status == "success"' },
    { id: 'next', capability: 'cond.next', args: {}, dependsOn: ['gate'], condition: 'gate.status == "success"' },
  ] };
  const result = await executeIntentPlan(request, plan, { dispatcher, maxParallelSteps: 2 });
  assert.equal(result.status, 'success');
  assert.deepEqual(calls, ['next']);
  assert.equal(result.results.gate.diagnostics.skipped, true);
});

test('orchestration: failurePolicy ask returns needs_input instead of retrying or hiding failure', async () => {
  const registry = new CapabilityRegistry();
  registry.register({ id: 'ask.fail', version: '1', name: 'ask', provider: 'test', enabled: true, riskLevel: 'low' });
  const dispatcher = new CapabilityDispatcher(registry, createDefaultPermissionPolicy());
  let calls = 0;
  dispatcher.registerHandler('ask.fail', { async execute({ step }) { calls += 1; return { jobId: 'j', stepId: step.id, status: 'failed', outputs: [], error: 'temporary', retryable: false }; } });
  const request = { requestId: 'r', chat: { type: 'private' }, user: { qq: 'u', role: 'user' }, text: 'x' };
  const plan = { planId: 'p-ask', requestId: 'r', goal: 'ask', steps: [{ id: 's', capability: 'ask.fail', args: {} }] };
  const result = await executeIntentPlan(request, plan, { dispatcher, failurePolicy: 'ask' });
  assert.equal(result.status, 'needs_input');
  assert.equal(calls, 1);
  assert.equal(result.results.s.status, 'needs_input');
  assert.match(result.results.s.diagnostics.question, /补充信息/);
});

test('orchestration: layer approval preflight blocks sibling side effects', async () => {
  const registry = new CapabilityRegistry();
  registry.register({ id: 'preflight.safe', version: '1', name: 'safe', provider: 'test', enabled: true, riskLevel: 'low' });
  registry.register({ id: 'preflight.high', version: '1', name: 'high', provider: 'test', enabled: true, riskLevel: 'high' });
  const dispatcher = new CapabilityDispatcher(registry, createDefaultPermissionPolicy());
  const calls = [];
  dispatcher.registerHandler('preflight.safe', { async execute({ step }) { calls.push('safe'); return { jobId: 'j', stepId: step.id, status: 'success', outputs: [] }; } });
  dispatcher.registerHandler('preflight.high', { async execute({ step }) { calls.push('high'); return { jobId: 'j', stepId: step.id, status: 'success', outputs: [] }; } });
  const request = { requestId: 'r', chat: { type: 'private' }, user: { qq: '2', role: 'admin' }, text: 'x' };
  const plan = { planId: 'p-preflight', requestId: 'r', goal: 'preflight', steps: [
    { id: 'safe', capability: 'preflight.safe', args: {} },
    { id: 'high', capability: 'preflight.high', args: {} },
  ] };
  const result = await executeIntentPlan(request, plan, { dispatcher, maxParallelSteps: 2 });
  assert.equal(result.status, 'waiting_approval');
  assert.deepEqual(calls, []);
  assert.equal(result.results.high.status, 'waiting_approval');
});
test('orchestration: argument normalization clamps ranges and rejects unknown properties', () => {
  const schema = {
    type: 'object',
    required: ['prompt'],
    additionalProperties: false,
    properties: {
      prompt: { type: 'string', minLength: 1 },
      count: { type: 'number', minimum: 1, maximum: 4 },
    },
  };
  const normalized = normalizeCapabilityArgs(schema, { prompt: 'cat', count: 99 });
  assert.equal(normalized.ok, true);
  assert.equal(normalized.args.count, 4);
  assert.equal(normalized.warnings.length, 1);
  const unknown = normalizeCapabilityArgs(schema, { prompt: 'cat', extra: true });
  assert.equal(unknown.ok, false);
  assert.ok(unknown.issues.some((item) => item.code === 'additional'));
  assert.ok(validateCapabilityArgs(schema, { prompt: 'cat', extra: true }).issues.some((item) => item.code === 'additional'));
});

test('orchestration: dispatcher executes with normalized args and exposes validation warnings', async () => {
  const registry = new CapabilityRegistry();
  registry.register({
    id: 'args.normalize', version: '1', name: 'normalize', provider: 'test', enabled: true, riskLevel: 'low',
    inputSchema: { type: 'object', properties: { count: { type: 'number', minimum: 1, maximum: 3 } } },
  });
  const dispatcher = new CapabilityDispatcher(registry, createDefaultPermissionPolicy());
  let observed = null;
  dispatcher.registerHandler('args.normalize', {
    async execute({ step }) {
      observed = step.args.count;
      return { jobId: 'j', stepId: step.id, status: 'success', outputs: [] };
    },
  });
  const request = { requestId: 'r', chat: { type: 'private' }, user: { qq: 'u', role: 'user' }, text: 'x' };
  const plan = { planId: 'p-args', requestId: 'r', goal: 'args', steps: [{ id: 's', capability: 'args.normalize', args: { count: 9 } }] };
  const result = await dispatcher.dispatch(request, plan, plan.steps[0]);
  assert.equal(result.result.status, 'success');
  assert.equal(observed, 3);
  assert.equal(result.result.diagnostics.validationWarnings.length, 1);
});
test('orchestration: ReplyPlan nested node/depth limits and overflow policies are enforced', () => {
  const images = Array.from({ length: 4 }, (_, index) => ({ id: 'img' + index, kind: 'image', url: 'https://cdn/' + index + '.png', priority: 10 - index, mergeable: true }));
  const limited = buildReplyPlan(images, {
    maxMessages: 3, maxResultItems: 20, includeTruncationNotice: true,
    nestedMaxNodes: 2, nestedMaxDepth: 2,
  });
  const nested = limited.groups.find((group) => group.mode === 'nested_forward');
  assert.equal(nested.outputs.filter((item) => item.kind === 'image').length, 2);
  assert.ok(limited.truncated.length >= 2);

  const flat = buildReplyPlan(images, { maxMessages: 3, maxResultItems: 20, nestedMaxDepth: 1 });
  assert.equal(flat.groups[0].mode, 'flat_forward');

  const rejected = buildReplyPlan(images, {
    maxMessages: 2, maxResultItems: 2, overflowPolicy: 'reject', includeTruncationNotice: true,
  });
  assert.equal(rejected.messageCount, 1);
  assert.equal(rejected.groups[0].mode, 'direct');
  assert.match(rejected.groups[0].outputs[0].text, /拒绝策略/);

  const linked = buildReplyPlan(images, {
    maxMessages: 2, maxResultItems: 2, overflowPolicy: 'link', includeTruncationNotice: true,
  });
  const linkedText = linked.groups.flatMap((group) => group.outputs).map((item) => item.text || '').join('\n');
  assert.match(linkedText, /https:\/\/cdn\//);
});
test('orchestration: approval requests resend up to maxResend and stop after resolution', async () => {
  let delivered = 0;
  const runtime = new ApprovalRuntime({
    adminQqIds: () => ['900'],
    ownerQqIds: () => ['1'],
    allowGroupReply: () => false,
    resendIntervalMs: 20,
    maxResend: 2,
    sendPrivate: async () => { delivered += 1; return { success: true }; },
  });
  const pending = runtime.request({
    requestId: 'r-resend', jobId: 'j-resend', capability: 'config.update', riskLevel: 'critical',
    requesterQq: '5', payload: { a: 1 }, quorum: 'any', ttlMs: 60000,
  });
  const current = runtime.getBroker().list('pending')[0];
  await new Promise((resolve) => setTimeout(resolve, 110));
  assert.ok(delivered >= 3, 'expected initial delivery plus two resends, got ' + delivered);
  runtime.decideFromPanel(current.code, 'approve', 'panel-test');
  const outcome = await pending;
  assert.equal(outcome.status, 'approved');
  const atResolution = delivered;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(delivered, atResolution);
});
function sunoInvocation(userQq = 'u1', args = { prompt: 'song' }) {
  return {
    request: { requestId: 'r-suno', chat: { type: 'private' }, user: { qq: userQq, role: 'user' }, text: 'song' },
    plan: { planId: 'p-suno', requestId: 'r-suno', goal: 'music', steps: [] },
    step: { id: 's1', capability: 'audio.music.generate', args },
    dependencyResults: {},
  };
}

test('orchestration: Suno quota and duration limit are enforced per user', async () => {
  const durations = [];
  const cfg = {
    orchestration: {
      suno: {
        enabled: true, quotaPerUserPerDay: 1, maxConcurrent: 2, maxQueue: 2,
        maxRetries: 0, maxDurationSeconds: 30, format: 'mp3',
      },
    },
  };
  const handler = new SunoCapabilityHandler({
    getConfig: () => cfg,
    createClient: () => ({
      async create(input) { durations.push(input.duration); return { id: 'task', raw: {} }; },
      async wait() { return { id: 'task', status: 'success', raw: {}, outputs: [{ url: 'https://cdn/song.mp3' }] }; },
    }),
  });
  const first = await handler.execute(sunoInvocation('u1', { prompt: 'song', duration: 999 }));
  assert.equal(first.status, 'success');
  assert.equal(durations[0], 30);
  const second = await handler.execute(sunoInvocation('u1', { prompt: 'song' }));
  assert.equal(second.status, 'failed');
  assert.equal(second.error, 'suno_quota_exceeded');
});
test('orchestration: Suno queue limit rejects excess work and runs queued task', async () => {
  const cfg = {
    orchestration: {
      suno: {
        enabled: true, quotaPerUserPerDay: 0, maxConcurrent: 1, maxQueue: 1,
        maxRetries: 0, maxDurationSeconds: 300, format: 'mp3',
      },
    },
  };
  const releases = [];
  const handler = new SunoCapabilityHandler({
    getConfig: () => cfg,
    createClient: () => ({
      async create() { return { id: 'task', raw: {} }; },
      async wait() {
        await new Promise((resolve) => releases.push(resolve));
        return { id: 'task', status: 'success', raw: {}, outputs: [{ url: 'https://cdn/song.mp3' }] };
      },
    }),
  });
  const waitUntil = async (predicate) => { for (let i = 0; i < 100 && !predicate(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5)); };
  const first = handler.execute(sunoInvocation('u1'));
  await waitUntil(() => releases.length === 1);
  const second = handler.execute(sunoInvocation('u2'));
  await new Promise((resolve) => setTimeout(resolve, 10));
  const third = await handler.execute(sunoInvocation('u3'));
  assert.equal(third.status, 'failed');
  assert.equal(third.error, 'suno_queue_full');
  releases.shift()();
  const a = await first;
  await waitUntil(() => releases.length === 1);
  releases.shift()();
  const b = await second;
  assert.equal(a.status, 'success');
  assert.equal(b.status, 'success');
});
test('orchestration: retriever/specialist/critic/safety/composer roles participate at runtime', async () => {
  const cfg = createDefaultConfig();
  cfg.orchestration.enabled = true;
  cfg.orchestration.mode = 'enforce';
  cfg.orchestration.planner.enabled = true;
  cfg.orchestration.planner.minConfidence = 0;
  cfg.orchestration.execution.maxModelRounds = 10;
  cfg.bot.ownerQQs = ['1'];
  for (const role of ['retriever', 'specialist', 'critic', 'safety', 'composer']) {
    cfg.orchestration.roles[role].enabled = true;
  }
  let handlerArgs = null;
  let handlerApprovalRequired = null;
  const handlers = new Map([['image.generate', {
    async execute({ step }) {
      handlerArgs = step.args;
      handlerApprovalRequired = step.approvalRequired;
      return { jobId: 'j', stepId: step.id, status: 'success', outputs: [{ kind: 'image', url: 'img.png', priority: 9, mergeable: true }] };
    },
  }]]);
  const calls = [];
  const fakeClient = {
    async chat(nodeIndex, request) {
      calls.push(request.messages.map((item) => item.content).join('\n'));
      const plan = (prompt) => JSON.stringify({
        planId: 'role-plan', requestId: 'ignored', goal: 'generate image',
        steps: [{ id: 's1', capability: 'image.generate', args: { prompt } }], confidence: 0.9,
      });
      if (calls.length === 1) return { text: JSON.stringify({ capabilityIds: ['image.generate'] }) };
      if (calls.length === 2) return { text: plan('cat') };
      if (calls.length === 3) return { text: plan('cat refined') };
      if (calls.length === 4) return { text: plan('cat refined') };
      if (calls.length === 5) return { text: JSON.stringify({ riskLevel: 'high', reason: 'sensitive' }) };
      return { text: '这是最终结果摘要。' };
    },
  };
  const enforcer = new OrchestrationEnforcer({
    getConfig: () => cfg,
    app: { sessions: { clear() {} }, engine: {}, handle: async () => ({}), registry: () => ({}), client: {} },
    client: fakeClient,
    handlers,
  });
  const result = await enforcer.handle({ text: '画一只猫', chatType: 'private', userId: '1' });
  assert.equal(result.handled, true);
  assert.equal(calls.length, 6);
  assert.equal(handlerArgs.prompt, 'cat refined');
  assert.equal(handlerApprovalRequired, true);
  assert.equal(result.result.images[0], 'img.png');
  assert.match(result.result.text, /最终结果摘要/);
});
test('orchestration: configured prompt versions support active/canary selection and diff', () => {
  const versions = [
    { id: 'v1', name: 'stable', content: 'stable prompt\nline', status: 'active', createdAt: '2026-01-01' },
    { id: 'v2', name: 'candidate', content: 'canary prompt\nline', status: 'canary', createdAt: '2026-01-02' },
  ];
  assert.equal(selectConfiguredPromptVersion(versions, 'v1', 'v2', 'req-1', 100).id, 'v2');
  assert.equal(selectConfiguredPromptVersion(versions, 'v1', 'v2', 'req-1', 0).id, 'v1');
  const diff = diffPromptText(versions[0].content, versions[1].content);
  assert.ok(diff.some((line) => line.type === 'remove' && line.text.includes('stable')));
  assert.ok(diff.some((line) => line.type === 'add' && line.text.includes('canary')));
});

test('orchestration: planner uses selected prompt version system content', async () => {
  const cfg = createDefaultConfig();
  cfg.orchestration.enabled = true;
  cfg.orchestration.mode = 'enforce';
  cfg.orchestration.planner.enabled = true;
  cfg.orchestration.promptOptimization.enabled = true;
  cfg.orchestration.promptOptimization.canaryPercent = 100;
  cfg.orchestration.promptOptimization.activeVersionId = 'v1';
  cfg.orchestration.promptOptimization.canaryVersionId = 'v2';
  cfg.orchestration.promptOptimization.versions = [
    { id: 'v1', name: 'stable', content: 'STABLE_PROMPT', status: 'active', createdAt: '2026-01-01' },
    { id: 'v2', name: 'canary', content: 'CANARY_PROMPT', status: 'canary', createdAt: '2026-01-02' },
  ];
  let systemPrompt = '';
  const enforcer = new OrchestrationEnforcer({
    getConfig: () => cfg,
    app: { sessions: { clear() {} }, engine: {}, handle: async () => ({}), registry: () => ({}), client: {} },
    client: {
      async chat(nodeIndex, request) {
        systemPrompt = request.messages.find((item) => item.role === 'system')?.content || '';
        return { text: JSON.stringify({
          planId: 'prompt-plan', requestId: 'ignored', goal: 'generate',
          steps: [{ id: 's1', capability: 'image.generate', args: { prompt: 'cat' } }], confidence: 0.9,
        }) };
      },
    },
    handlers: new Map([['image.generate', {
      async execute({ step }) { return { jobId: 'j', stepId: step.id, status: 'success', outputs: [{ kind: 'image', url: 'img.png' }] }; },
    }]]),
  });
  const result = await enforcer.handle({ text: '画猫', chatType: 'private', userId: '1' });
  assert.equal(result.handled, true);
  assert.match(systemPrompt, /CANARY_PROMPT/);
});
test('orchestration: planner prompt includes group history identity context', () => {
  const prompt = buildPlannerPrompt({
    requestId: 'r', chat: { type: 'group', groupId: '9' }, user: { qq: '1', role: 'user' }, text: '他们说了什么',
    history: [{ role: 'system', content: '同名 [QQ:101]: 甲；同名 [QQ:202]: 乙' }],
  }, []);
  assert.ok(prompt.includes('同名 [QQ:101]'));
  assert.ok(prompt.includes('历史上下文'));
});

test('orchestration: explicit truncation notice disable suppresses user warning', () => {
  const plan = buildReplyPlan([
    { kind: 'text', text: '主结果', priority: 10, mergeable: true },
    { kind: 'text', text: '低优先结果', priority: 1, mergeable: true },
  ], { maxMessages: 2, maxResultItems: 1, includeTruncationNotice: false });
  assert.equal(plan.truncated.length, 1);
  assert.equal(plan.noticeSuppressed, true);
  assert.equal(plan.noticeIncluded, false);
});

test('orchestration: approval runtime keeps waiting until quorum all completes', async () => {
  const delivered = [];
  const runtime = new ApprovalRuntime({
    adminQqIds: () => ['900', '901'],
    allowGroupReply: () => false,
    sendPrivate: async (qq, text) => { delivered.push({ qq, text }); return { success: true }; },
  });
  const pending = runtime.request({
    requestId: 'r-all', jobId: 'j-all', capability: 'config.update', riskLevel: 'critical',
    requesterQq: '100', payload: { a: 1 }, quorum: 'all', ttlMs: 60000,
  });
  await new Promise((resolve) => setImmediate(resolve));
  const current = runtime.getBroker().list('pending')[0];
  await runtime.handleReply({ text: '同意 ' + current.code, userId: '900', chatType: 'private' });
  assert.equal(runtime.getBroker().get(current.approvalId)?.status, 'pending');
  await runtime.handleReply({ text: '同意 ' + current.code, userId: '901', chatType: 'private' });
  const outcome = await pending;
  assert.equal(outcome.status, 'approved');
  assert.ok(delivered.some((item) => item.qq === '900'));
  assert.ok(delivered.some((item) => item.qq === '901'));
});

test('orchestration: clarification is hard-capped at one question per job', async () => {
  const cfg = createDefaultConfig();
  cfg.orchestration.enabled = true;
  cfg.orchestration.mode = 'enforce';
  cfg.orchestration.planner.enabled = true;
  cfg.orchestration.planner.model = 'planner-test';
  cfg.orchestration.planner.maxClarifications = 1;
  cfg.orchestration.roles.planner.model = 'planner-test';
  cfg.orchestration.roles.planner.fallbackModel = 'planner-test';
  cfg.llm.chatModel = 'planner-test';
  let calls = 0;
  const store = new PendingJobStore();
  const enforcer = new OrchestrationEnforcer({
    getConfig: () => cfg,
    app: { handle: async () => ({}), engine: {}, sessions: { clear() {} }, registry: () => ({}), client: {} },
    client: {
      async chat() {
        calls += 1;
        return { text: JSON.stringify({ planId: 'ask-again', requestId: 'ignored', goal: 'need', steps: [], needsClarification: true, clarificationQuestion: '请再说具体一点？', confidence: 0.2 }) };
      },
    },
    pendingJobs: store,
  });
  const first = await enforcer.handle({ text: '帮我弄一下', chatType: 'private', userId: '7' });
  assert.ok(first.result.text.includes('请再说具体一点'));
  const second = await enforcer.handle({ text: '就是那个', chatType: 'private', userId: '7' });
  assert.ok(second.result.text.includes('信息仍然不足'));
  assert.equal(store.list().length, 0);
  assert.equal(calls, 2);
});

test('orchestration: execution clarification resumes the same DAG and does not rerun completed steps', async () => {
  const cfg = createDefaultConfig();
  cfg.orchestration.enabled = true;
  cfg.orchestration.mode = 'enforce';
  cfg.orchestration.planner.enabled = true;
  cfg.orchestration.planner.model = 'planner-test';
  cfg.orchestration.roles.planner.model = 'planner-test';
  cfg.orchestration.roles.planner.fallbackModel = 'planner-test';
  cfg.llm.chatModel = 'planner-test';
  const plan = {
    planId: 'resume-dag',
    requestId: 'ignored',
    goal: 'generate and export',
    steps: [
      { id: 's1', capability: 'image.generate', args: { prompt: 'cat' } },
      { id: 's2', capability: 'file.generate', args: {}, dependsOn: ['s1'] },
    ],
    confidence: 0.9,
  };
  let plannerCalls = 0;
  let imageCalls = 0;
  let fileCalls = 0;
  const handlers = new Map([
    ['image.generate', {
      async execute({ step }) {
        imageCalls += 1;
        return { jobId: 'j', stepId: step.id, status: 'success', outputs: [{ kind: 'image', url: 'cat.png' }] };
      },
    }],
    ['file.generate', {
      async execute({ step }) {
        fileCalls += 1;
        if (fileCalls === 1) {
          return { jobId: 'j', stepId: step.id, status: 'needs_input', outputs: [], diagnostics: { question: '要生成什么格式？' } };
        }
        return { jobId: 'j', stepId: step.id, status: 'success', outputs: [{ kind: 'file', url: 'report.docx', meta: { name: 'report.docx' } }] };
      },
    }],
  ]);
  const store = new PendingJobStore();
  const enforcer = new OrchestrationEnforcer({
    getConfig: () => cfg,
    app: { handle: async () => ({}), engine: {}, sessions: { clear() {} }, registry: () => ({}), client: {} },
    client: {
      async chat() {
        plannerCalls += 1;
        if (plannerCalls === 1) return { text: JSON.stringify(plan) };
        return { text: JSON.stringify({ ...plan, steps: [plan.steps[0], { ...plan.steps[1], args: { format: 'docx' } }] }) };
      },
    },
    handlers,
    pendingJobs: store,
  });
  const first = await enforcer.handle({ text: '先画猫再导出文件', chatType: 'private', userId: '8' });
  assert.ok(first.result.text.includes('要生成什么格式'));
  const checkpoint = store.get('private:8');
  assert.equal(checkpoint.status, 'clarifying');
  assert.equal(checkpoint.pendingStepId, 's2');
  assert.equal(checkpoint.results.s1.status, 'success');
  assert.equal(imageCalls, 1);
  const second = await enforcer.handle({ text: 'docx', chatType: 'private', userId: '8' });
  assert.equal(second.handled, true);
  assert.equal(second.result.files[0].file, 'report.docx');
  assert.equal(imageCalls, 1);
  assert.equal(fileCalls, 2);
  assert.equal(store.list().length, 0);
});

test('orchestration: approval timeout uses configured fallback cancel', async () => {
  const cfg = createDefaultConfig();
  cfg.orchestration.enabled = true;
  cfg.orchestration.mode = 'enforce';
  cfg.orchestration.planner.enabled = true;
  cfg.orchestration.planner.model = 'planner-test';
  cfg.orchestration.roles.planner.model = 'planner-test';
  cfg.orchestration.roles.planner.fallbackModel = 'planner-test';
  cfg.llm.chatModel = 'planner-test';
  cfg.orchestration.approval.timeoutMs = 1000;
  cfg.orchestration.approval.fallback = 'cancel';
  cfg.orchestration.approval.enabled = true;
  cfg.orchestration.permissions.rules = [{ id: 'test-ask-delete', scope: 'user', qq: '9', capability: 'file.delete', mode: 'ask_admin', priority: 100, reason: 'test' }];
  cfg.orchestration.approval.adminQqIds = ['900'];
  const store = new PendingJobStore();
  const approvalRuntime = new ApprovalRuntime({
    adminQqIds: () => ['900'],
    sendPrivate: async () => ({ success: true, messageId: 'approval-timeout' }),
  });
  const enforcer = new OrchestrationEnforcer({
    getConfig: () => cfg,
    approvalRuntime,
    pendingJobs: store,
    app: { handle: async () => ({}), engine: {}, sessions: { clear() {} }, registry: () => ({}), client: {} },
    client: {
      async chat() {
        return { text: JSON.stringify({ planId: 'timeout-plan', requestId: 'ignored', goal: 'delete', steps: [{ id: 's1', capability: 'file.delete', args: { artifactId: 'a' } }], confidence: 0.9 }) };
      },
    },
  });
  const result = await enforcer.handle({ text: '删除文件', chatType: 'private', userId: '9' });
  assert.equal(result.problem.kind, 'approval_timeout_cancelled');
  assert.equal(store.list().length, 0);
});

test('orchestration: approval after bot restart resumes the persisted DAG', async () => {
  const cfg = createDefaultConfig();
  cfg.orchestration.enabled = true;
  cfg.orchestration.mode = 'enforce';
  cfg.orchestration.planner.enabled = true;
  cfg.orchestration.approval.adminQqIds = ['900'];
  cfg.orchestration.permissions.rules = [{ id: 'test-ask-delete', scope: 'user', qq: '5', capability: 'file.delete', mode: 'ask_admin', priority: 100, reason: 'test' }];
  const approval = createApproval({
    requestId: 'restart-req', jobId: 'restart-job', stepId: 's1',
    payload: { artifactId: 'a' }, capability: 'file.delete', riskLevel: 'high',
    requesterQq: '5', adminQqIds: ['900'], quorum: 'any', ttlMs: 60000,
  });
  const plan = {
    planId: 'restart-plan', requestId: 'restart-req', goal: 'delete', confidence: 1, source: 'model',
    steps: [{ id: 's1', capability: 'file.delete', args: { artifactId: 'a' }, approvalRequired: true }],
  };
  const store = new PendingJobStore();
  store.set({
    key: 'private:5', originalText: '删除文件', question: '', attempts: 0,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    schemaVersion: 2, jobId: 'restart-job', requestId: 'restart-req', status: 'waiting_approval',
    originalRequest: {
      requestId: 'restart-req', chat: { type: 'private', userId: '5' }, user: { qq: '5', role: 'user' },
      text: '删除文件', receivedAt: new Date().toISOString(),
    },
    plan, order: ['s1'], results: { s1: { jobId: 'restart-plan', stepId: 's1', status: 'waiting_approval', outputs: [] } },
    approvedStepIds: [], pendingStepId: 's1', approvalId: approval.approvalId,
    approvalPayloadHash: approval.payloadHash, startedAt: Date.now(),
  });
  let deleteCalls = 0;
  let recovered;
  let service;
  const broker = new ApprovalBroker();
  broker.restore([approval]);
  const approvalRuntime = new ApprovalRuntime({
    broker,
    adminQqIds: () => ['900'],
    sendPrivate: async () => ({ success: true, messageId: 'restart-approval' }),
    onDecision: (item) => service?.onDecision(item),
  });
  const enforcer = new OrchestrationEnforcer({
    getConfig: () => cfg,
    approvalRuntime,
    pendingJobs: store,
    app: { handle: async () => ({}), engine: {}, sessions: { clear() {} }, registry: () => ({}), client: {} },
    client: { async chat() { throw new Error('planner must not run during approval recovery'); } },
    handlers: new Map([['file.delete', {
      async execute({ step }) {
        deleteCalls += 1;
        return { jobId: 'restart-plan', stepId: step.id, status: 'success', outputs: [{ kind: 'text', text: '文件已删除' }] };
      },
    }]]),
  });
  service = new JobRecoveryService({
    jobs: store,
    approvals: approvalRuntime,
    resume: async (job) => {
      recovered = await enforcer.handle({ text: '继续', chatType: job.originalRequest.chat.type, userId: job.originalRequest.chat.userId });
    },
  });
  await approvalRuntime.handleReply({ text: '同意 ' + approval.code, userId: '900', chatType: 'private' });
  for (let i = 0; i < 100 && !recovered; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(recovered);
  assert.equal(recovered.handled, true);
  assert.equal(recovered.result.text, '文件已删除');
  assert.equal(deleteCalls, 1);
  assert.equal(store.list().length, 0);
});
test('orchestration: approval timeout uses configured fallback deny', async () => {
  const cfg = createDefaultConfig();
  cfg.orchestration.enabled = true;
  cfg.orchestration.mode = 'enforce';
  cfg.orchestration.planner.enabled = true;
  cfg.orchestration.planner.model = 'planner-test';
  cfg.orchestration.roles.planner.model = 'planner-test';
  cfg.orchestration.roles.planner.fallbackModel = 'planner-test';
  cfg.llm.chatModel = 'planner-test';
  cfg.orchestration.approval.enabled = true;
  cfg.orchestration.approval.timeoutMs = 1000;
  cfg.orchestration.approval.fallback = 'deny';
  cfg.orchestration.approval.adminQqIds = ['900'];
  cfg.orchestration.permissions.rules = [{ id: 'test-ask-delete-deny', scope: 'user', qq: '10', capability: 'file.delete', mode: 'ask_admin', priority: 100, reason: 'test' }];
  const store = new PendingJobStore();
  const approvalRuntime = new ApprovalRuntime({
    adminQqIds: () => ['900'],
    sendPrivate: async () => ({ success: true, messageId: 'approval-timeout-deny' }),
  });
  const enforcer = new OrchestrationEnforcer({
    getConfig: () => cfg,
    approvalRuntime,
    pendingJobs: store,
    app: { handle: async () => ({}), engine: {}, sessions: { clear() {} }, registry: () => ({}), client: {} },
    client: {
      async chat() {
        return { text: JSON.stringify({ planId: 'timeout-deny', requestId: 'ignored', goal: 'delete', steps: [{ id: 's1', capability: 'file.delete', args: { artifactId: 'a' } }], confidence: 0.9 }) };
      },
    },
  });
  const result = await enforcer.handle({ text: '删除文件', chatType: 'private', userId: '10' });
  assert.equal(result.problem.kind, 'approval_timeout_denied');
  // 审批拒绝/超时只上报管理员，不应向用户发错误文本。
  assert.equal(result.result.text, undefined);
  assert.equal(result.result.replyPlan.groups.length, 0);
  assert.equal(store.list().length, 0);
});
test('orchestration: capability test validate/dry-run/live uses real dispatcher without QQ reply', async () => {
  const cfg = createDefaultConfig();
  cfg.orchestration.enabled = true;
  cfg.orchestration.mode = 'enforce';
  cfg.bot.ownerQQs = ['1'];
  let calls = 0;
  const enforcer = new OrchestrationEnforcer({
    getConfig: () => cfg,
    app: { handle: async () => ({}), engine: {}, sessions: { clear() {} }, registry: () => ({}), client: {} },
    client: { async chat() { throw new Error('planner not expected'); } },
    handlers: new Map([['file.generate', {
      async execute({ step }) {
        calls += 1;
        return { jobId: 'cap-test', stepId: step.id, status: 'success', outputs: [{ kind: 'text', text: 'handler-ran' }] };
      },
    }]]),
  });
  const validate = await enforcer.testCapability({ capability: 'file.generate', mode: 'validate', requesterQq: '1' });
  assert.equal(validate.ok, true);
  assert.equal(validate.handlerRegistered, true);
  assert.equal(calls, 0);
  const dry = await enforcer.testCapability({ capability: 'file.generate', mode: 'dry_run', requesterQq: '1' });
  assert.equal(dry.ok, true);
  assert.equal(calls, 0);
  const unconfirmed = await enforcer.testCapability({ capability: 'file.generate', mode: 'live', requesterQq: '1' });
  assert.equal(unconfirmed.ok, false);
  assert.equal(unconfirmed.error, 'live_confirmation_required');
  assert.equal(calls, 0);
  const live = await enforcer.testCapability({ capability: 'file.generate', mode: 'live', requesterQq: '1', allowLive: true });
  assert.equal(live.ok, true);
  assert.equal(live.result.outputs[0].text, 'handler-ran');
  assert.equal(calls, 1);
});

test('orchestration: executor aborts capability signal when a step times out', async () => {
  const registry = new CapabilityRegistry();
  registry.register({ id: 'slow.effect', version: '1', name: '慢任务', provider: 'builtin', enabled: true, riskLevel: 'low', mode: 'sync' });
  const dispatcher = new CapabilityDispatcher(registry, createPermissionPolicyFromDefaults({ low: 'allow', medium: 'allow', high: 'ask_admin', critical: 'deny' }));
  let signalAborted = false;
  dispatcher.registerHandler('slow.effect', {
    async execute({ signal }) {
      await new Promise((resolve) => {
        if (signal?.aborted) return resolve();
        signal?.addEventListener('abort', resolve, { once: true });
      });
      signalAborted = Boolean(signal?.aborted);
      throw new Error('aborted by executor');
    },
  });
  const userRequest = {
    requestId: 'abort-test', chat: { type: 'private', userId: '1' }, user: { qq: '1', role: 'user' },
    text: 'run slow effect', attachments: [], receivedAt: new Date().toISOString(),
  };
  const plan = {
    planId: 'abort-plan', requestId: 'abort-test', goal: 'abort', confidence: 1,
    steps: [{ id: 's1', capability: 'slow.effect', args: {}, timeoutMs: 40 }],
  };
  const result = await executeIntentPlan(userRequest, plan, { dispatcher, stepTimeoutMs: 40 });
  assert.equal(result.status, 'failed');
  assert.equal(result.results.s1.error, 'step_timeout');
  assert.equal(signalAborted, true);
});
test('orchestration: Suno composer turns natural language into V6 mode-specific fields', async () => {
  const cfg = createDefaultConfig();
  cfg.orchestration.suno.model = 'V6';
  const prompt = buildSunoComposerPrompt({ request: '来一首适合深夜开车的温柔日语女声歌曲' }, {
    requestId: 'suno-compose', chat: { type: 'private', userId: '1' }, user: { qq: '1', role: 'user' },
    text: '来一首适合深夜开车的温柔日语女声歌曲', attachments: [], receivedAt: new Date().toISOString(),
  }, cfg);
  assert.ok(prompt.includes('customMode=false'));
  assert.ok(prompt.includes('普通点歌请求一律 customMode=false'));
  assert.ok(prompt.includes('副歌必须有一个短、可重复、易记的核心 hook'));
  assert.ok(prompt.includes('用户提供的歌词必须逐字保留'));
  assert.ok(prompt.includes('style'));
  const composer = new SunoPromptComposer({
    async chat() {
      return { text: JSON.stringify({
        customMode: false, instrumental: false, title: null,
        musicBrief: '温柔日语女声，深夜城市驾驶，温暖合成器与舒缓鼓点',
        style: 'japanese city pop, warm synth, mellow, female vocal, 92 BPM',
        lyrics: null, negativeTags: null, vocalGender: null, duration: null,
        styleWeight: null, weirdnessConstraint: null, audioWeight: null, variety: null, model: 'V6',
      }) };
    },
  }, () => cfg);
  const result = await composer.compose({ request: '来一首适合深夜开车的温柔日语女声歌曲' }, {
    requestId: 'suno-compose', chat: { type: 'private', userId: '1' }, user: { qq: '1', role: 'user' },
    text: '来一首适合深夜开车的温柔日语女声歌曲', attachments: [], receivedAt: new Date().toISOString(),
  });
  assert.equal(result.customMode, false);
  assert.ok(result.musicBrief.includes('深夜'));
  assert.ok(result.style.includes('city pop'));
  assert.equal(result.title, undefined);
  assert.equal(result.duration, undefined);
});

test('orchestration: Suno V6 client distinguishes custom and non-custom payloads', async () => {
  const bodies = [];
  const fakeFetch = async (url, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (body) bodies.push(body);
    return new Response(JSON.stringify({ code: 200, data: { taskId: 'suno-v6-task' } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const client = new SunoClient({ baseUrl: 'https://apibox.example', apiKey: 'secret', model: 'V6', callbackUrl: 'https://bot.example/suno-callback', fetchImpl: fakeFetch });
  await client.create({ customMode: false, instrumental: false, prompt: 'warm city pop night drive', style: 'city pop, warm', title: 'ignored', duration: 99 });
  assert.equal(bodies[0].customMode, false);
  assert.equal(bodies[0].callBackUrl, 'https://bot.example/suno-callback');
  assert.equal(bodies[0].title, undefined);
  assert.equal(bodies[0].duration, undefined);
  await client.create({ customMode: true, instrumental: false, prompt: '', lyrics: '[Verse] hello', style: 'pop, warm', title: 'Night', duration: 60, vocalGender: 'f', variety: 1 });
  assert.equal(bodies[1].customMode, true);
  assert.equal(bodies[1].lyrics, '[Verse] hello');
  assert.equal(bodies[1].title, 'Night');
  assert.equal(bodies[1].duration, 60);
  assert.equal(bodies[1].vocalGender, 'f');
});

test('orchestration: Suno handler consumes composer result instead of raw user sentence', async () => {
  let createdInput;
  const handler = new SunoCapabilityHandler({
    getConfig: () => ({ orchestration: { suno: { enabled: true, model: 'V6', requestMode: 'v6', maxDurationSeconds: 300, format: 'mp3', callbackUrl: 'https://bot.example/callback', quotaPerUserPerDay: 0, maxConcurrent: 1, maxQueue: 1, maxRetries: 0 } } }),
    compose: async () => ({
      customMode: false, instrumental: false, title: undefined,
      musicBrief: '温暖日语女声，深夜城市驾驶，复古合成器，92 BPM',
      style: 'japanese city pop, warm synth, mellow, female vocal',
      model: 'V6',
    }),
    createClient: () => ({
      async create(input) { createdInput = input; return { id: 'task-compose', raw: {} }; },
      async wait() { return { id: 'task-compose', status: 'success', raw: {}, outputs: [{ url: 'https://cdn/song.mp3' }] }; },
    }),
  });
  const result = await handler.execute(sunoInvocation('u1', { request: '来一首适合深夜开车的温柔日语女声歌曲' }));
  assert.equal(result.status, 'success');
  assert.equal(createdInput.customMode, false);
  assert.ok(createdInput.prompt.includes('温暖日语女声'));
  assert.ok(createdInput.style.includes('city pop'));
  assert.equal(createdInput.prompt.includes('来一首适合'), false);
});
test('orchestration: Suno composer keeps unspecified null controls absent', async () => {
  const cfg = createDefaultConfig();
  cfg.orchestration.suno.model = 'V6';
  const composer = new SunoPromptComposer({
    async chat() {
      return { text: JSON.stringify({
        customMode: true, instrumental: false, title: 'Test', musicBrief: null,
        style: 'pop, warm', lyrics: '[Verse] test', negativeTags: null, vocalGender: null,
        duration: null, styleWeight: null, weirdnessConstraint: null, audioWeight: null, variety: null, model: 'V6',
      }) };
    },
  }, () => cfg);
  const result = await composer.compose({ request: '写一首 test' }, {
    requestId: 'suno-null', chat: { type: 'private', userId: '1' }, user: { qq: '1', role: 'user' },
    text: '写一首 test', attachments: [], receivedAt: new Date().toISOString(),
  });
  assert.equal(result.duration, undefined);
  assert.equal(result.styleWeight, undefined);
  assert.equal(result.weirdnessConstraint, undefined);
  assert.equal(result.audioWeight, undefined);
  assert.equal(result.variety, undefined);
});