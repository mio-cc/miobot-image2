import test from 'node:test';
import assert from 'node:assert/strict';

import { createSessionStore, SessionStore } from '../dist/packages/core/src/index.js';
import { createModelBackedDeps } from '../dist/apps/bot/src/main.js';

test('SessionStore: append accumulates rounds and get returns a copy', () => {
  const s = createSessionStore({ maxRounds: 8, maxChars: 100000 });
  s.append('k', { role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' });
  s.append('k', { role: 'user', content: 'how' }, { role: 'assistant', content: 'fine' });
  const h = s.get('k');
  assert.equal(h.length, 4);
  assert.deepEqual(h.map((m) => m.content), ['hi', 'yo', 'how', 'fine']);
  h.push({ role: 'user', content: 'mutate' });
  assert.equal(s.get('k').length, 4); // get 返回副本，不被外部改动影响
});

test('SessionStore: prunes by maxRounds', () => {
  const s = createSessionStore({ maxRounds: 1, maxChars: 100000 });
  s.append('k', { role: 'user', content: 'a' }, { role: 'assistant', content: 'b' });
  s.append('k', { role: 'user', content: 'c' }, { role: 'assistant', content: 'd' });
  assert.deepEqual(s.get('k').map((m) => m.content), ['c', 'd']); // 只留最近 1 轮
});

test('SessionStore: prunes by maxChars from the oldest', () => {
  const s = createSessionStore({ maxRounds: 50, maxChars: 1000 });
  for (let i = 0; i < 40; i += 1) {
    s.append('k', { role: 'user', content: 'x'.repeat(40) }, { role: 'assistant', content: 'y'.repeat(40) });
  }
  assert.ok(JSON.stringify(s.get('k')).length <= 1000);
});

test('SessionStore: clear removes a session', () => {
  const s = new SessionStore();
  s.append('k', { role: 'user', content: 'a' }, { role: 'assistant', content: 'b' });
  assert.equal(s.clear('k'), true);
  assert.equal(s.get('k').length, 0);
});

test('deps.chat: with sessions carries history + system prompt across turns', async () => {
  const sessions = createSessionStore({ maxRounds: 8, maxChars: 100000 });
  const captured = [];
  const client = {
    can: () => false,
    chat: async (_i, r) => { captured.push(r.messages); return { text: `A${captured.length}`, raw: {} }; },
    vision: async () => ({ text: 'V', raw: {} }),
    generateImages: async () => ({ images: [], raw: {} }),
    editImage: async () => ({ images: [], raw: {} }),
    interrogate: async () => ({ text: '', raw: {} }),
  };
  const deps = createModelBackedDeps({
    client,
    getRouting: () => ({ chatNodeIndex: 0, imageNodeIndex: 0, editNodeIndex: 0, interrogateNodeIndex: 0, freeModeNodeIndex: 0 }),
    sessions,
    chatSystemPrompt: 'SYS',
  });

  const r1 = await deps.chat({ model: 'm', text: 'hi', sessionId: 's1' });
  assert.equal(r1.text, 'A1');
  assert.deepEqual(captured[0], [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'hi' }]);

  const r2 = await deps.chat({ model: 'm', text: 'again', sessionId: 's1' });
  assert.equal(r2.text, 'A2');
  assert.deepEqual(captured[1], [
    { role: 'system', content: 'SYS' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'A1' },
    { role: 'user', content: 'again' },
  ]);
});

test('deps.chat: without sessions sends a single user message (no system)', async () => {
  const captured = [];
  const client = {
    can: () => false,
    chat: async (_i, r) => { captured.push(r.messages); return { text: 'X', raw: {} }; },
    vision: async () => ({ text: 'V', raw: {} }),
    generateImages: async () => ({ images: [], raw: {} }),
    editImage: async () => ({ images: [], raw: {} }),
    interrogate: async () => ({ text: '', raw: {} }),
  };
  const deps = createModelBackedDeps({ client, getRouting: () => ({ chatNodeIndex: 0, imageNodeIndex: 0, editNodeIndex: 0, interrogateNodeIndex: 0, freeModeNodeIndex: 0 }) });
  await deps.chat({ model: 'm', text: 'solo' });
  assert.deepEqual(captured[0], [{ role: 'user', content: 'solo' }]);
});
