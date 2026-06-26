import test from 'node:test';
import assert from 'node:assert/strict';

import { parseOwnerCommand, isOwner } from '../dist/apps/bot/src/main.js';

test('isOwner: 匹配 ownerQQs', () => {
  assert.equal(isOwner('123', ['123', '456']), true);
  assert.equal(isOwner(123, ['123']), true);
  assert.equal(isOwner('999', ['123']), false);
  assert.equal(isOwner(undefined, ['123']), false);
  assert.equal(isOwner('123', []), false);
});

test('parseOwnerCommand: 私聊各命令', () => {
  const p = (text) => parseOwnerCommand(text, { chatType: 'private' });
  assert.deepEqual(p('/模型'), { command: 'modelList' });
  assert.deepEqual(p('/models'), { command: 'modelList' });
  assert.deepEqual(p('/切换 gpt-4o'), { command: 'switchModel', code: 'gpt-4o' });
  assert.deepEqual(p('/q gpt_image_2'), { command: 'switchModel', code: 'gpt.image.2' });
  assert.deepEqual(p('/ttsk'), { command: 'ttsOn' });
  assert.deepEqual(p('/ttsg'), { command: 'ttsOff' });
  assert.deepEqual(p('/tts.2'), { command: 'switchTtsVoice', index: 2 });
  assert.deepEqual(p('/撤回 3'), { command: 'recall', count: 3 });
  assert.deepEqual(p('/撤回'), { command: 'recall', count: 1 });
  assert.equal(p('随便聊聊'), undefined);
});

test('parseOwnerCommand: 群里拉黑/拉白取被 @ 的目标(无需 @bot)', () => {
  const r = parseOwnerCommand('/拉黑', { chatType: 'group', mentions: ['10000', '777'], botId: '10000' });
  assert.deepEqual(r, { command: 'blacklist', targetUserId: '777' });
  const w = parseOwnerCommand('/拉白', { chatType: 'group', mentions: ['888'], botId: '10000' });
  assert.deepEqual(w, { command: 'whitelist', targetUserId: '888' });
});

test('parseOwnerCommand: 群里普通命令需点名 bot', () => {
  assert.equal(parseOwnerCommand('/模型', { chatType: 'group', mentions: [], botId: '10000' }), undefined);
  assert.deepEqual(parseOwnerCommand('/模型', { chatType: 'group', mentions: ['10000'], botId: '10000' }), { command: 'modelList' });
});
