// 图片未能读取时必须显式告诉模型（2026-11-19）。
// 线上症状：改图其实成功并已发出，但回复文字说"看不到图"——因为模型拿到的是
// 被丢弃图片后的纯文本，只能自己猜。这里锁住三件事：
//   1) 丢弃时有结构化日志，能分清丢的是当前图还是引用图
//   2) 丢弃时注入 system 事实，明确"不要描述/不要声称看到"
//   3) 系统事实走 metadata.notices → system 段，不污染用户原话
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const runtimeSrc = fs.readFileSync('apps/bot/src/runtime.ts', 'utf8');
const loopSrc = fs.readFileSync('packages/agent-runtime/src/agent-loop.ts', 'utf8');
const hostSrc = fs.readFileSync('apps/bot/src/agent-host.ts', 'utf8');

test('runtime：图片丢弃日志拆开来源（当前图 / 引用图）', () => {
  assert.match(runtimeSrc, /droppedQuotedImages/);
  assert.match(runtimeSrc, /droppedBaseImages/);
  assert.match(runtimeSrc, /hasReferencedImage/);
});

test('runtime：丢弃时注入系统事实，禁止模型声称看到图', () => {
  assert.match(runtimeSrc, /systemNotices\.push\(/);
  assert.match(runtimeSrc, /不要声称你看到了它们/);
  assert.match(runtimeSrc, /未能读取/);
});

test('systemNotices 全链路打通：runtime → agent-host → agent-loop → systemSections', () => {
  assert.match(runtimeSrc, /\.\.\.\(systemNotices\.length \? \{ systemNotices \} : \{\}\)/);
  assert.match(hostSrc, /systemNotices\?: string\[\]/);
  assert.match(hostSrc, /\.\.\.\(input\.systemNotices\?\.length \? \{ notices: input\.systemNotices \}/);
  assert.match(loopSrc, /const noticeSections = Array\.isArray\(input\.metadata\?\.notices\)/);
  assert.match(loopSrc, /\[prompt\?\.content, preferenceSection, \.\.\.noticeSections\]/);
});

test('系统事实不会被写成用户原话（不在 userText 里拼接）', () => {
  // agent-host 的 userText 只由 text/referencedText/forwardText 组成
  assert.match(hostSrc, /userText: \[input\.text, input\.referencedText/);
  assert.doesNotMatch(hostSrc, /userText: \[[^\]]*systemNotices/);
});

test('图片全部不可读时仍保留原有硬失败链路（不静默降级）', () => {
  assert.match(runtimeSrc, /image-input-failed/);
  assert.match(runtimeSrc, /if \(!forwardText\) return \{ handled: true, kind: 'image-input-failed' \}/);
});