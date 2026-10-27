import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryAgentSessionManager } from '../dist/packages/agent-runtime/src/index.js';

function state(key, messages) {
  return {
    sessionKey: key,
    turnId: 't1',
    messages,
    pinnedFacts: {},
    artifacts: [],
    configRevision: 'rev',
    runtimeVersion: 'r9',
    createdAt: '2026-10-26T12:00:00.000Z',
    updatedAt: '2026-10-26T12:00:00.000Z',
  };
}

function msg(text, role = 'user') {
  return { role, content: text };
}

test('agent-session R9 BUG-2: message count and character caps are enforced', () => {
  const manager = new InMemoryAgentSessionManager({
    maxMessagesPerSession: 3,
    maxCharsPerSession: 12,
  });
  manager.save(state('private:1', [msg('one'), msg('two'), msg('three'), msg('four'), msg('five')]));
  const saved = manager.load('private:1');
  assert.deepEqual(saved.messages.map((item) => item.content), ['four', 'five']);
});

test('agent-session R9 BUG-2: session count and TTL caps protect pending work', () => {
  let now = new Date('2026-10-26T12:00:00.000Z');
  const manager = new InMemoryAgentSessionManager({
    clock: () => now,
    maxSessions: 2,
    maxMessagesPerSession: 10,
    maxCharsPerSession: 1000,
    ttlMs: 1_000,
  });
  manager.save(state('private:a', [msg('a')]));
  now = new Date('2026-10-26T12:00:01.000Z');
  manager.save(state('private:b', [msg('b')]));
  now = new Date('2026-10-26T12:00:02.000Z');
  manager.save({ ...state('private:c', [msg('c')]), pendingQuestion: { question: '文件？' } });
  const keys = manager.listSessionKeys();
  assert.equal(keys.length, 2);
  assert.ok(keys.includes('private:c'));

  now = new Date('2026-10-26T12:00:10.000Z');
  assert.equal(manager.load('private:b'), undefined);
  const pending = manager.load('private:c');
  assert.ok(pending);
  assert.equal(pending.pendingQuestion.question, '文件？');
});
