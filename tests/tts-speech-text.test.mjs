// TTS 前的文本闸（2026-11-19）：语音只念「能听的内容」。
// 线上现象：回复夹着 https 链接 / markdown 表格 / 代码围栏 / [图片] 占位符，
// 而 voice() 里是 `let speakText = text`，原文直送合成。
import test from 'node:test';
import assert from 'node:assert/strict';
import { toSpeechText } from '../dist/apps/bot/src/tts.js';

test('裸链接不念出来，但句子其余部分保留', () => {
  const out = toSpeechText('这首歌在这里 https://suno.com/song/3ff9dd5a-cb40-4ede-b051-426ee09114db 你听听');
  assert.equal(out.includes('http'), false, '不能出现 http');
  assert.equal(out.includes('suno.com'), false, '不能出现域名');
  assert.match(out, /这首歌在这里/);
  assert.match(out, /你听听/);
});

test('markdown 链接只念文字', () => {
  const out = toSpeechText('看这个[官方文档](https://example.com/a/b?c=1)就行');
  assert.equal(out, '看这个官方文档就行');
});

test('图片语法与内部占位符整条丢弃', () => {
  const out = toSpeechText('![封面](https://cdn.test/a.png) 图在这 [图片] [CQ:image,file=abc.jpg]');
  assert.equal(out.includes('cdn.test'), false);
  assert.equal(out.includes('[图片]'), false);
  assert.equal(out.includes('CQ:'), false);
  assert.match(out, /图在这/);
});

test('代码围栏整段丢弃，行内代码保留内容', () => {
  const out = toSpeechText('看这段：\n```js\nconst a = 1;\n```\n还有 `npm test` 也要跑');
  assert.equal(out.includes('const a'), false);
  assert.equal(out.includes('```'), false);
  assert.match(out, /还有 npm test 也要跑/);
});

test('markdown 表格分隔行丢弃、数据行读成停顿', () => {
  const out = toSpeechText('| 服务 | 状态 |\n|---|---|\n| 生图 | 403 |');
  assert.equal(out.includes('|'), false);
  assert.equal(out.includes('---'), false);
  assert.match(out, /服务，状态/);
  assert.match(out, /生图，403/);
});

test('标题/引用/列表/加粗标记被清掉，文字保留', () => {
  const out = toSpeechText('# 标题\n> 引用一句\n- 第一项\n1. 第二项\n**加粗**和*斜体*');
  assert.equal(/^#/m.test(out), false);
  assert.equal(out.includes('**'), false);
  assert.equal(out.includes('>'), false);
  assert.match(out, /标题/);
  assert.match(out, /引用一句/);
  assert.match(out, /第一项/);
  assert.match(out, /加粗和斜体/);
});

test('只剩链接时返回空串（无可念内容）', () => {
  assert.equal(toSpeechText('https://example.com/only-link'), '');
  assert.equal(toSpeechText('   '), '');
});

test('正常中文口语一字不改', () => {
  const said = '今天的月亮好圆呀，我们一起去看吧。';
  assert.equal(toSpeechText(said), said);
});

test('折叠多余空行与空白', () => {
  const out = toSpeechText('第一行   \n\n\n\n第二行');
  assert.equal(out, '第一行\n第二行');
});
test('链接被摘掉后只剩「标签：」的孤儿行整行丢弃', () => {
  const out = toSpeechText('1. 水星记\n🔗 网易云：https://music.163.com/x\n🔗 YouTube：https://youtube.com/y\n梦幻流行，适合深夜。');
  assert.equal(out.includes('网易云'), false, '孤儿标签不该被念出来');
  assert.equal(out.includes('YouTube'), false);
  assert.match(out, /水星记/);
  assert.match(out, /梦幻流行/);
});

test('URL 里的单引号不会把尾巴截成碎片', () => {
  const out = toSpeechText("看这里 https://music.163.com/#/search/m/?s=Don't Know Why 就行了");
  assert.equal(out.includes('http'), false);
  assert.equal(out.includes("'t"), false, "不能残留 't 这种碎片");
  assert.match(out, /看这里/);
  assert.match(out, /就行了/);
});

test('emoji 不进语音', () => {
  const out = toSpeechText('状态图出来了🐋🔗 你看看');
  assert.equal(/[\u{1f000}-\u{1faff}]/u.test(out), false);
  assert.match(out, /状态图出来了/);
});

test('代码块换成可听占位，不留半句断线', () => {
  const fence = String.fromCharCode(96).repeat(3);
  const out = toSpeechText('配置如下：\n\n' + fence + 'json\n{"a":1}\n' + fence + '\n\n然后跑 npm test');
  assert.equal(out.includes('{"a"'), false);
  assert.match(out, /示例代码见文字回复/);
  assert.match(out, /然后跑 npm test/);
});

test('有序列表编号保留，不做一半有一半无', () => {
  const out = toSpeechText('1.《水星记》\n2. 陈鸿宇');
  assert.match(out, /1\.《水星记》/);
  assert.match(out, /2\. 陈鸿宇/);
});

test('裸域名不念，但 Node.js / package.json 这类不能误删', () => {
  const out = toSpeechText('推荐 IT之家 — ithome.com 和 Hacker News — news.ycombinator.com；代码用 Node.js 跑，配置在 package.json 里');
  assert.equal(out.includes('ithome'), false, '裸域名要摘掉');
  assert.equal(out.includes('ycombinator'), false);
  assert.match(out, /IT之家/);
  assert.match(out, /Node\.js/, 'Node.js 不是域名，必须保留');
  assert.match(out, /package\.json/, 'package.json 必须保留');
});

test('孤儿标签行即使带空格也丢弃（The Verge： / Ars Technica：）', () => {
  const out = toSpeechText('来源如下：\nThe Verge：\nArs Technica：\n其余内容正常。');
  assert.equal(out.includes('The Verge'), false);
  assert.equal(out.includes('Ars Technica'), false);
  assert.match(out, /其余内容正常/);
});
