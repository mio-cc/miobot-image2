import test from 'node:test';
import assert from 'node:assert/strict';

const { SunoPromptComposer, buildSunoComposerPrompt } = await import('../dist/apps/bot/src/suno-composer.js');
const { createDefaultConfig } = await import('../dist/packages/config/src/index.js');

const cfg = createDefaultConfig();
const composer = new SunoPromptComposer(
  { chat: async () => ({ text: 'ok', raw: {} }) },
  () => cfg,
  undefined,
);

test('suno/歌名原创1: 提示词含歌名原创最高优先级契约（prompt-completeness 锚）', () => {
  const prompt = buildSunoComposerPrompt(
    { request: '来一首欢快的歌' }, { text: '来一首欢快的歌' }, cfg,
  );
  assert.ok(String(prompt).includes('【歌名原创（最高优先级）】'), 'override 段必须含歌名原创契约');
  assert.ok(String(prompt).includes('不得照搬、复用或近似引用'), '不得照搬原歌名的措辞必须在');
  assert.ok(String(prompt).includes('41.'), '第 41 条规则应重写为歌名原创要求');
});

test('suno/歌名原创2: 模型沿用原歌名时被强制改为新歌名（代码级保险）', async () => {
  // 模拟"基于《晴天》换词"场景：模型仍输出 title=晴天
  const output = await runComposerWithFakeModel({
    customMode: true,
    instrumental: false,
    title: '晴天',
    lyrics: '[Verse 1]\n新写的词第一段\n[Chorus]\n把回忆折成纸飞机',
    style: 'pop',
  }, '用《晴天》的曲 换词重做一首');
  assert.notEqual(output.title, '晴天', '原歌名必须被强制换掉');
  assert.ok(output.title, '必须给出新的原创歌名');
  assert.ok(String(output.title).includes('把回忆折成纸飞机'), '新歌名应取自新副歌核心行');
});

test('suno/歌名原创3: 无引用原歌时 title 原样保留', async () => {
  const output = await runComposerWithFakeModel({
    customMode: true,
    instrumental: false,
    title: '全新的原创名字',
    lyrics: '[Verse]\n随便写的词\n[Chorus]\n崭新的副歌',
    style: 'rock',
  }, '来一首崭新的歌');
  assert.equal(output.title, '全新的原创名字');
});

async function runComposerWithFakeModel(fakeJson, requestText) {
  const { SunoPromptComposer, buildSunoComposerPrompt } = await import('../dist/apps/bot/src/suno-composer.js');
  const composer = new SunoPromptComposer(
    { chat: async () => ({ text: JSON.stringify(fakeJson), raw: {} }) },
    () => cfg,
    undefined,
  );
  return composer.compose({ request: requestText }, { text: requestText });
}

test('suno/歌名原创4: 能力描述符含 title 原创规则（catalog 可见）', async () => {
  const { builtinCapabilityDescriptors } = await import('../dist/packages/orchestration/src/builtin-capabilities.js');
  const descriptor = builtinCapabilityDescriptors().find((item) => item.id === 'audio.music.generate');
  assert.ok(descriptor, '描述符应存在');
  assert.ok(String(descriptor.description).includes('title'), 'description 应提示 title 规则');
});