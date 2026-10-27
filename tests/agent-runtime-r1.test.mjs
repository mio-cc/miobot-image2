import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_AGENT_FEATURE_FLAG,
  InMemoryAgentSessionManager,
  PromptRegistry,
  createAgentSessionManager,
  createContextBuilder,
  isAgentRuntimeEnabled,
  normalizeReplyPreference,
  resolveAgentRuntimeMode,
  resolveReplyPreference,
} from '../dist/packages/agent-runtime/src/index.js';

test('agent-runtime R1: feature gate defaults off and never activates without explicit shadow/enforce', () => {
  assert.equal(DEFAULT_AGENT_FEATURE_FLAG.enabled, false);
  assert.equal(DEFAULT_AGENT_FEATURE_FLAG.mode, 'off');
  assert.equal(isAgentRuntimeEnabled(DEFAULT_AGENT_FEATURE_FLAG), false);
  assert.equal(isAgentRuntimeEnabled({ enabled: true, mode: 'off' }), false);
  assert.equal(isAgentRuntimeEnabled({ enabled: false, mode: 'enforce' }), false);
  assert.equal(isAgentRuntimeEnabled({ enabled: true, mode: 'shadow' }), true);
  assert.equal(isAgentRuntimeEnabled({ enabled: true, mode: 'enforce' }), true);
  assert.equal(resolveAgentRuntimeMode({ enabled: false, mode: 'enforce' }), 'off');
  assert.equal(resolveAgentRuntimeMode({ enabled: true, mode: 'shadow' }), 'shadow');
});

test('agent-runtime R1: session manager isolates keys and returns defensive copies', () => {
  const manager = new InMemoryAgentSessionManager({ clock: () => new Date('2026-10-26T10:00:00.000Z') });
  const first = manager.loadOrCreate({ sessionKey: 'private:1', turnId: 't1', configRevision: 'rev-1', runtimeVersion: 'r1' });
  assert.deepEqual(first.messages, []);
  manager.appendMessages('private:1', [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' },
  ]);
  const loaded = manager.load('private:1');
  assert.equal(loaded.messages.length, 2);
  loaded.messages.push({ role: 'user', content: 'mutated outside' });
  assert.equal(manager.load('private:1').messages.length, 2);
  manager.loadOrCreate({ sessionKey: 'private:2', turnId: 't2', configRevision: 'rev-1', runtimeVersion: 'r1' });
  assert.deepEqual(manager.listSessionKeys().sort(), ['private:1', 'private:2']);
  assert.equal(manager.delete('private:2'), true);
  assert.equal(manager.load('private:2'), undefined);
});

test('agent-runtime R1: prompt registry builds ordered active sections only', () => {
  const registry = new PromptRegistry();
  registry.register({ id: 'identity', title: 'Identity', content: 'identity', version: '1', status: 'active', order: 10 });
  registry.register({ id: 'behavior', title: 'Behavior', content: 'behavior', version: '1', status: 'canary', order: 20 });
  registry.register({ id: 'safety', title: 'Safety', content: 'safety', version: '1', status: 'active', order: 30 });
  const active = registry.build();
  assert.deepEqual(active.sections.map((section) => section.id), ['identity', 'safety']);
  assert.match(active.content, /identity/);
  assert.doesNotMatch(active.content, /behavior/);
  const canary = registry.build({ includeCanary: true });
  assert.deepEqual(canary.sections.map((section) => section.id), ['identity', 'behavior', 'safety']);
});

test('agent-runtime R1: context builder preserves system/session/user order and attachment labels', () => {
  const session = {
    sessionKey: 'group:9:1',
    turnId: 't1',
    messages: [
      { role: 'user', content: 'previous question' },
      { role: 'assistant', content: 'previous answer' },
    ],
    pinnedFacts: {},
    artifacts: [],
    configRevision: 'rev',
    runtimeVersion: 'r1',
  };
  const built = createContextBuilder().build({
    session,
    userText: 'current question',
    attachments: [{ kind: 'image', ref: 'data:image/png;base64,AAAA', name: 'image.png' }],
    systemSections: ['be concise'],
    memoryContext: 'user likes tea',
    groupContext: 'group history',
  });
  assert.equal(built.messages[0].role, 'system');
  assert.match(built.messages[0].content, /be concise/);
  assert.equal(built.messages[1].role, 'user');
  assert.equal(built.messages[1].content, 'previous question');
  assert.equal(built.messages.at(-1).role, 'user');
  assert.match(built.messages.at(-1).content, /current question/);
  // P0-4 修复后：图片附件进入 imageRefs（真实视觉输入），正文不再出现附件文本清单；
  // 也不把 base64 数据混进文本。
  assert.deepEqual(built.messages.at(-1).imageRefs, ['data:image/png;base64,AAAA']);
  assert.doesNotMatch(built.messages.at(-1).content, /Attachments/);
  assert.doesNotMatch(built.messages.at(-1).content, /base64/);
});

test('agent-runtime R1: reply preference precedence is turn > session > user > defaults', () => {
  const resolved = resolveReplyPreference({
    defaults: { mode: 'quote', forwardStyle: 'flat', voice: 'auto', reference: 'quote' },
    user: { voice: 'off', reference: 'none' },
    session: { mode: 'forward', voice: 'on' },
    turn: { mode: 'direct' },
  });
  assert.deepEqual(resolved, { mode: 'direct', forwardStyle: 'flat', voice: 'on', reference: 'none' });
  assert.deepEqual(normalizeReplyPreference({ mode: 'direct', voice: 'off', scope: 'turn' }), { mode: 'direct', voice: 'off', scope: 'turn' });
  assert.equal(normalizeReplyPreference({ mode: 'nonsense' }), undefined);
});
