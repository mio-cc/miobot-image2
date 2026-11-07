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
import { buildSunoComposerPrompt } from '../dist/apps/bot/src/suno-composer.js';
import { SUNO_LYRICS_STRUCTURE_RULE_25, SUNO_LYRICS_STRUCTURE_RULE_26, SUNO_LYRICS_TITLE_RULE_41 } from '../dist/apps/bot/src/suno-lyrics-spec.js';

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
