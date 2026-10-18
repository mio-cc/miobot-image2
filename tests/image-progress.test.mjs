import test from 'node:test';
import assert from 'node:assert/strict';

import { createImageProgress, formatImageEta } from '../dist/apps/bot/src/main.js';

test('image progress: eta range comes from historical average', () => {
  assert.equal(formatImageEta(undefined), '');
  assert.equal(formatImageEta(1000), '');
  assert.match(formatImageEta(30000), /通常约 21-41 秒/);
});

test('image progress: sends initial message and one long-running reminder unless done', async () => {
  const sent = [];
  const progress = createImageProgress({
    kind: 'image.generate',
    averageMs: 30000,
    reminderAfterMs: 20,
    send: (text) => { sent.push(text); },
  });
  await new Promise((resolve) => setTimeout(resolve, 55));
  progress.done();
  assert.equal(sent.length, 2);
  assert.match(sent[0], /收到，正在图片生成/);
  assert.match(sent[1], /已等待/);

  const sent2 = [];
  const progress2 = createImageProgress({
    kind: 'image.edit',
    reminderAfterMs: 20,
    send: (text) => { sent2.push(text); },
  });
  progress2.done();
  await new Promise((resolve) => setTimeout(resolve, 45));
  assert.equal(sent2.length, 1);
});