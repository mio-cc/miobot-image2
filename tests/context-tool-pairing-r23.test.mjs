import test from 'node:test';
import assert from 'node:assert/strict';

const { sanitizeToolMessagePairs } = await import('../dist/packages/agent-runtime/src/context-builder.js');

test('R23 context builder removes orphan tool messages before provider call', () => {
  const messages = [
    { role: 'user', content: '查一下' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'web.search', arguments: { query: 'x' } }] },
    { role: 'tool', toolCallId: 'call-1', name: 'web.search', content: '{"ok":true}' },
    { role: 'user', content: '继续' },
    { role: 'tool', toolCallId: 'orphan-2', name: 'web.search', content: '{"ok":true}' },
    { role: 'assistant', content: '结果' },
  ];
  const cleaned = sanitizeToolMessagePairs(messages);
  assert.deepEqual(cleaned.map((message) => `${message.role}:${message.toolCallId || ''}`), [
    'user:',
    'assistant:',
    'tool:call-1',
    'user:',
    'assistant:',
  ]);
});
