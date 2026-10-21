import test from 'node:test';
import assert from 'node:assert/strict';

import { createImageProgress, formatImageEta, renderImageProgressText, imageProgressTextForKind, imageProgressAverageKey } from '../dist/apps/bot/src/main.js';

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
test('image progress: empty eta removes dangling 大概/placeholder and audio kind has full sentence', () => {
  const text = renderImageProgressText('大概{eta}', 'image.generate', undefined);
  assert.doesNotMatch(text, /大概/);
  assert.doesNotMatch(text, /\{eta\}/);
  assert.match(text, /图片生成/);
  assert.match(text, /请稍候/);
  const audio = renderImageProgressText('收到，正在生成音乐{eta}，请稍候…', 'audio.music.generate', undefined);
  assert.equal(audio, '收到，正在生成音乐，请稍候…');
  const withEta = renderImageProgressText('收到，正在生成音乐{eta}，请稍候…', 'audio.music.generate', 30000);
  assert.match(withEta, /通常约 21-41 秒/);
});
test('image progress: audio generation uses audioText and audio ETA bucket', () => {
  const config = {
    enabled: true, showEta: true,
    imageText: '图片{eta}', editText: '改图{eta}', interrogateText: '反推{eta}',
    videoText: '视频{eta}', audioText: '音乐{eta}',
  };
  assert.equal(imageProgressTextForKind('audio.music.generate', config), '音乐{eta}');
  assert.equal(imageProgressAverageKey('audio.music.generate'), 'audio');
  assert.equal(imageProgressAverageKey('video.generate'), 'video');
  assert.equal(imageProgressAverageKey('image.generate'), 'image');
});