// 方案 B（2026-11-07）：composer 提示词黄金快照——规则 25/26/41 抽为共享常量
// （apps/bot/src/suno-lyrics-spec.ts，与 MCP 根注入同源）后，渲染结果必须**逐字节不变**。
// 黄金文件生成于重构前（dist 旧构建），sha256 ce7b000fe9acdbaa99bd09420ee8aa81e8cac537071f6430ed076163a91fa51e。
// 快照输入固定（cfg/args/request），任何字节差异即测试失败——这是「旧 SunoAPI 链零改动」的机器证明。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { buildSunoComposerPrompt, SunoPromptComposer } from '../dist/apps/bot/src/suno-composer.js';
import { SUNO_LYRICS_STRUCTURE_RULE_25, SUNO_LYRICS_STRUCTURE_RULE_26, SUNO_LYRICS_TITLE_RULE_41 } from '../dist/apps/bot/src/suno-lyrics-spec.js';
import { createDefaultConfig } from '../dist/packages/config/src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const golden = fs.readFileSync(path.join(__dirname, 'fixtures', 'suno-composer-prompt.golden.txt'), 'utf8');

const cfg = { orchestration: { suno: { model: 'V6', defaultVocalGender: 'auto', defaultLanguage: '', composerPromptTemplate: '' } } };
const args = { request: '来一首适合雨夜散步的日语女声歌曲', style: 'city pop', duration: 120 };
const request = { text: '来一首适合雨夜散步的日语女声歌曲', user: { qq: '10001', role: 'user' }, chat: { type: 'private', userId: '10001' } };

test('suno composer: 提示词黄金快照——规则常量化后渲染逐字节不变', () => {
  const prompt = buildSunoComposerPrompt(args, request, cfg);
  assert.equal(prompt, golden, '渲染结果必须与重构前逐字节一致（旧 SunoAPI 链零改动）');
  assert.equal(createHash('sha256').update(prompt).digest('hex'), 'ce7b000fe9acdbaa99bd09420ee8aa81e8cac537071f6430ed076163a91fa51e');
});

test('suno composer: 规范常量与 MCP 注入同源——快照含规则 25/26/41 全文', () => {
  const prompt = buildSunoComposerPrompt(args, request, cfg);
  assert.ok(prompt.includes(SUNO_LYRICS_STRUCTURE_RULE_25), '规则 25 全文在场（来自共享常量）');
  assert.ok(prompt.includes(SUNO_LYRICS_STRUCTURE_RULE_26), '规则 26 全文在场');
  assert.ok(prompt.includes(SUNO_LYRICS_TITLE_RULE_41), '规则 41 全文在场');
});

test('suno composer: 歌词换行保留——结构标记独占一行（2026-11-07 修复）', async () => {
  // 模型产出的多行歌词（含 \r\n、行内连续空格、换行两侧空格——清洗后应规范为纯 \n + 行内单空格）。
  const modelLyrics = '[Intro]\r\n[Verse 1]\r\n夜色  漫过后视镜 \r\n 雨点替我数着心情\r\n[Pre-Chorus]\r\n风把街灯揉成星\r\n[Chorus]\r\n把心事留给雨夜慢慢听\r\n[Bridge]\r\n桥段的转弯\r\n[Outro]\r\n尾声';
  const expected = '[Intro]\n[Verse 1]\n夜色 漫过后视镜\n雨点替我数着心情\n[Pre-Chorus]\n风把街灯揉成星\n[Chorus]\n把心事留给雨夜慢慢听\n[Bridge]\n桥段的转弯\n[Outro]\n尾声';
  const fullCfg = createDefaultConfig();
  fullCfg.orchestration.suno.model = 'V6';
  const composer = new SunoPromptComposer({
    chat: async () => ({ text: JSON.stringify({
      customMode: true, instrumental: false, title: '雨夜慢听',
      musicBrief: 'japanese  city  pop,  rainy  night', style: 'city  pop,  warm  synth,  female  vocal',
      lyrics: modelLyrics, vocalGender: 'f', language: '中文',
    }) }),
  }, () => fullCfg);
  const invocation = { requestId: 't1', chat: { type: 'private', userId: '1' }, user: { qq: '1', role: 'user' }, text: '来一首雨夜歌曲', attachments: [] };
  const result = await composer.compose({ request: '来一首雨夜歌曲' }, invocation);
  // 换行保留：结构标记独占一行（规范 25），行内连续空格压缩、\r\n 规范为 \n。
  assert.equal(result.lyrics, expected, '歌词清洗保留换行，只压行内空格');
  const lines = result.lyrics.split('\n');
  for (const line of lines) {
    if (/^\[/.test(line)) assert.ok(/^\[[^\]]+\]$/.test(line), `结构标记行必须独占一行：${JSON.stringify(line)}`);
  }
  assert.equal(lines.filter((line) => /^\[(Intro|Verse 1|Pre-Chorus|Chorus|Bridge|Outro)\]$/.test(line)).length, 6, '六个标记全部独占一行');
  // 其他字段清洗行为不变（连续空格仍被压平为单空格）。
  assert.equal(result.style, 'city pop, warm synth, female vocal', 'style 仍走通用清洗（拍平空格）');
  assert.equal(result.musicBrief, 'japanese city pop, rainy night', 'musicBrief 仍走通用清洗');
  // safe fallback 同一修复：用户直传歌词同样保留换行。
  const fallback = composer.composeSafeFallback({ lyrics: modelLyrics, style: 'city  pop' }, invocation);
  assert.equal(fallback.lyrics, expected, 'safe fallback 歌词同样保留换行');
  assert.equal(fallback.style, 'city pop', 'fallback style 仍通用清洗');
});

test('suno composer: deriveOriginalTitle 在多行歌词下行为不变（副歌行提取）', () => {
  // enforceOriginalTitle 触发链内部使用 deriveOriginalTitle——经 compose 验证（不直接导出）：
  // 歌名沿用原歌名时从新歌词副歌行重写。多行保留后 [Chorus] 后取下一行，与拍平时代一致。
  const fullCfg = createDefaultConfig();
  const composer = new SunoPromptComposer({
    chat: async () => ({ text: JSON.stringify({
      customMode: true, instrumental: false,
      title: '青花瓷', lyrics: '[Verse 1]\n新写的词\n[Chorus]\n雨夜慢听新副歌\n[Outro]\n尾声', style: 'pop',
    }) }),
  }, () => fullCfg);
  const invocation = { requestId: 't2', chat: { type: 'private', userId: '1' }, user: { qq: '1', role: 'user' }, text: '用《青花瓷》的歌词重新填词', attachments: [] };
  return composer.compose({ request: '用《青花瓷》的歌词重新填词' }, invocation).then((result) => {
    assert.equal(result.title, '雨夜慢听新副歌', '原歌名被替换为新歌词副歌行（多行下行为不变）');
  });
});

// ── 优化版模板（2026-11-07 注册表切换）：生产提示词 = 自定义模板渲染产物 ──
// 模板夹具 = Desktop\Suno-composer-提示词模板-优化版-2026-11-07.txt 的逐字节副本；
// 渲染黄金快照锚定生产提示词（与内置默认 golden.txt 并存：后者证明默认路径稳定）。
// 注意：composerPromptTemplate 是 buildSunoComposerPrompt 的第 4 参（调用方从 cfg 取出传入），
// 不能塞进 cfg——塞 cfg 会静默走默认路径（首跑踩坑实录）。
const optimizedTemplate = fs.readFileSync(path.join(__dirname, 'fixtures', 'suno-composer-template-optimized.txt'), 'utf8');
const renderedGoldenPath = path.join(__dirname, 'fixtures', 'suno-composer-template-optimized.rendered.golden.txt');

test('suno composer: 优化版模板渲染——占位符全部替换、无残留、override 恒尾', () => {
  const prompt = buildSunoComposerPrompt(args, request, cfg, optimizedTemplate);
  // 六个占位符全部被渲染值替换，输出不允许残留任何 {{token}}。
  assert.equal([...prompt.matchAll(/\{\{\w+\}\}/g)].length, 0, '无未替换占位符');
  assert.ok(prompt.includes('"customMode":true'), '{{schema}} 已替换为 JSON schema 示例');
  assert.ok(prompt.includes('默认 V6'), '{{model}} 已替换');
  assert.ok(prompt.includes('后台默认人声性别：auto'), '{{defaultVocalGender}} 已替换');
  assert.ok(prompt.includes('后台默认歌词语言：auto'), '{{defaultLanguage}} 已替换');
  assert.ok(prompt.includes('用户原始请求：来一首适合雨夜散步的日语女声歌曲'), '{{userText}} 已替换');
  assert.ok(prompt.includes('用户提供的结构化线索：'), '{{supplied}} 已替换');
  // 三处自动补落点占位符均在模板内 → 不触发重复追加（userText/supplied/schema 各只出现一次语义段）。
  assert.equal((prompt.match(/用户原始请求：/g) || []).length, 1, 'userText 不重复追加');
  assert.equal((prompt.match(/用户提供的结构化线索：/g) || []).length, 1, 'supplied 不重复追加');
  // 最高优先级覆盖恒尾（歌词恒由我方写 + 人设隔离 + 歌名原创）——自定义模板不可绕过。
  assert.ok(prompt.includes('【最高优先级覆盖】'), 'SUNO_COMPOSER_OVERRIDE 恒尾在场');
  assert.ok(prompt.includes('【人设隔离】'), '人设隔离在场');
  assert.ok(prompt.includes('【歌名原创（最高优先级）】'), '歌名原创在场');
  // 换行保留语义与新清洗层咬合（模板 8.6 明示「换行会被下游清洗层保留」）。
  assert.ok(prompt.includes('换行会被下游清洗层保留'), '模板与 lyricsClip 修复语义一致');
});

test('suno composer: 优化版模板渲染黄金快照——生产提示词字节稳定', () => {
  const prompt = buildSunoComposerPrompt(args, request, cfg, optimizedTemplate);
  const renderedGolden = fs.readFileSync(renderedGoldenPath, 'utf8');
  assert.equal(prompt, renderedGolden, '生产提示词渲染结果必须与快照逐字节一致');
});
