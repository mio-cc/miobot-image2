import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildReplyPlan,
  CapabilityRegistry,
  matchExactCommand,
  validateIntentPlan,
  createApproval,
  createDefaultPermissionPolicy,
  decideApproval,
  expireApproval,
  resolvePermission,
} from '../dist/packages/orchestration/src/index.js';

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
