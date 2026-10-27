import test from 'node:test';
import assert from 'node:assert/strict';

import { createDefaultConfig } from '../dist/packages/config/src/index.js';
import { buildAgentSystemPrompt } from '../dist/apps/bot/src/agent-host.js';
import { buildSunoComposerPrompt, SunoPromptComposer } from '../dist/apps/bot/src/suno-composer.js';
import { SunoClient } from '../dist/packages/orchestration/src/index.js';
import { createImagePromptPipeline } from '../dist/apps/bot/src/image-pipeline.js';
import { ImageModule } from '../dist/packages/image/src/index.js';
import { renderTtsPreprocessPrompt } from '../dist/apps/bot/src/tts.js';
import { PromptRegistry } from '../dist/packages/agent-runtime/src/index.js';

function request(text) {
  return {
    requestId: 'prompt-r11', chat: { type: 'private', userId: '1' },
    user: { qq: '1', role: 'user' }, text, attachments: [], receivedAt: new Date().toISOString(),
  };
}

test('prompt audit: Agent persona and generic tool topology are injected', () => {
  const cfg = createDefaultConfig();
  cfg.bot.persona = { enabled: true, name: '测试人格', systemPrompt: 'PERSONA_SENTINEL_唯一行为' };
  const prompt = buildAgentSystemPrompt(cfg);
  assert.match(prompt, /测试人格/);
  assert.match(prompt, /PERSONA_SENTINEL_唯一行为/);
  assert.match(prompt, /工具可以组合使用/);
  assert.match(prompt, /tool result 回填/);
  assert.match(prompt, /外部事实/);
});

test('prompt audit: prompt registry only emits active sections in order', () => {
  const registry = new PromptRegistry();
  registry.register({ id: 'a', title: 'A', content: 'ACTIVE_A', version: '1', status: 'active', order: 2 });
  registry.register({ id: 'b', title: 'B', content: 'DRAFT_B', version: '1', status: 'draft', order: 1 });
  registry.register({ id: 'c', title: 'C', content: 'ACTIVE_C', version: '1', status: 'active', order: 1 });
  const built = registry.build();
  assert.equal(built.content, 'ACTIVE_C\n\n---\n\nACTIVE_A');
  assert.equal(built.sections.length, 2);
});

test('prompt audit: custom Suno composer template is rendered and delivered to model request', async () => {
  const cfg = createDefaultConfig();
  cfg.orchestration.suno.composerPromptTemplate = 'CUSTOM_START user={{userText}} schema={{schema}} END';
  cfg.orchestration.suno.defaultVocalGender = 'f';
  cfg.orchestration.suno.defaultLanguage = '日语';
  let captured;
  const composer = new SunoPromptComposer({
    async chat(_node, payload) {
      captured = payload;
      return { text: JSON.stringify({
        customMode: true, instrumental: false, title: '模板测试',
        musicBrief: '日语女声，温暖城市流行，夜晚氛围',
        style: 'japanese city pop, warm, female vocal, 90 BPM',
        lyrics: '[Verse]\n夜を越えて\n[Chorus]\n君を待つ',
        negativeTags: null, vocalGender: 'f', language: '日语', duration: 60,
        styleWeight: 0.6, weirdnessConstraint: 0.2, audioWeight: null, variety: 1, model: 'V6',
      }) };
    },
  }, () => cfg);
  const spec = await composer.compose({ request: '来一首日语女声歌曲' }, request('来一首日语女声歌曲'));
  assert.ok(captured);
  const sent = String(captured.messages?.[1]?.content || '');
  assert.match(sent, /CUSTOM_START/);
  assert.match(sent, /来一首日语女声歌曲/);
  assert.doesNotMatch(sent, /\{\{userText\}\}/);
  assert.match(sent, /最高优先级覆盖/);
  assert.equal(spec.customMode, true);
  assert.equal(spec.instrumental, false);
  assert.equal(spec.vocalGender, 'f');
  assert.equal(spec.language, '日语');
  assert.match(spec.lyrics, /夜を越えて/);
  assert.equal(spec.duration, 60);
});

test('prompt audit: custom Suno prompt can be built directly with schema and supplied fields', () => {
  const cfg = createDefaultConfig();
  const prompt = buildSunoComposerPrompt(
    { request: '测试', style: 'pop', lyrics: '[Verse] x' },
    request('测试'),
    cfg,
    'CUSTOM={{userText}} STYLE={{supplied}} SCHEMA={{schema}}',
  );
  assert.match(prompt, /CUSTOM=测试/);
  assert.match(prompt, /STYLE=/);
  assert.match(prompt, /"customMode":true/);
  assert.match(prompt, /最高优先级覆盖/);
  assert.doesNotMatch(prompt, /\{\{userText\}\}|\{\{schema\}\}/);
});

test('prompt audit: Suno V6 API body contains composer lyrics/style and omits invalid custom fields', async () => {
  const bodies = [];
  const client = new SunoClient({
    baseUrl: 'https://suno.test', apiKey: 'test-key', model: 'V6', callbackUrl: 'https://bot.test/callback',
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ code: 200, data: { taskId: 'task-' + bodies.length } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    },
  });
  await client.create({ customMode: true, instrumental: false, title: '青花瓷', style: 'chinese pop', lyrics: '[Verse] 天青色等烟雨', vocalGender: 'm', duration: 240, variety: 1 });
  const vocal = bodies[0];
  assert.equal(vocal.customMode, true);
  assert.equal(vocal.instrumental, false);
  assert.equal(vocal.lyrics, '[Verse] 天青色等烟雨');
  assert.equal(vocal.style, 'chinese pop');
  assert.equal(vocal.title, '青花瓷');
  assert.equal(vocal.prompt, undefined);
  assert.equal(vocal.callBackUrl, 'https://bot.test/callback');

  await client.create({ customMode: true, instrumental: true, style: 'ambient', prompt: 'ambient', vocalGender: 'm', lyrics: 'must-not-send', audioWeight: 0.5 });
  const instrumental = bodies[1];
  assert.equal(instrumental.instrumental, true);
  assert.equal(instrumental.lyrics, undefined);
  assert.equal(instrumental.vocalGender, undefined);
  assert.equal(instrumental.audioWeight, undefined);
});

test('prompt audit: image enhancement template is rendered into the model request', async () => {
  const cfg = createDefaultConfig();
  cfg.llm.enhanceEnabled = true;
  cfg.llm.enhanceNodeIndex = 0;
  cfg.llm.enhanceModel = 'mock-enhance';
  cfg.llm.enhancePromptTemplate = 'ENHANCE raw={{rawPrompt}} prompt={{prompt}}';
  let captured;
  const pipeline = createImagePromptPipeline({
    async chat(_node, payload) { captured = payload; return { text: 'ENHANCED_RESULT' }; },
  }, () => cfg);
  const output = await pipeline.prepare({ prompt: '一只猫' });
  assert.equal(output, 'ENHANCED_RESULT');
  assert.match(String(captured.messages?.[0]?.content || ''), /ENHANCE raw=一只猫 prompt=一只猫/);
});

test('prompt audit: image interrogation template placeholders are rendered', async () => {
  let captured;
  const module = new ImageModule({
    llm: {
      async createVision(req) { captured = req; return { text: '反推结果', raw: {} }; },
    },
    imageModel: 'mock-image',
    interrogatePromptTemplate: 'INTERROGATE image={{imageUrl}}',
  });
  const result = await module.interrogate({ imageUrl: 'https://example.test/view.png' });
  assert.equal(result.text, '反推结果');
  assert.equal(captured.prompt, 'INTERROGATE image=https://example.test/view.png');
});

test('prompt audit: TTS preprocess template only replaces {{text}}', () => {
  assert.equal(renderTtsPreprocessPrompt('SPEAK {{text}} / keep {{other}}', '你好'), 'SPEAK 你好 / keep {{other}}');
});

test('prompt audit: image safe rewrite template is rendered and used', async () => {
  const cfg = createDefaultConfig();
  cfg.llm.safeRewriteOnFailure = true;
  cfg.llm.enhanceNodeIndex = 0;
  cfg.llm.enhanceModel = 'mock-safety';
  cfg.llm.safeRewritePromptTemplate = 'SAFE raw={{rawPrompt}} prompt={{prompt}}';
  let captured;
  const pipeline = createImagePromptPipeline({
    async chat(_node, payload) { captured = payload; return { text: 'SAFE_RESULT' }; },
  }, () => cfg);
  const output = await pipeline.safeRewrite('危险的猫图');
  assert.equal(output, 'SAFE_RESULT');
  assert.match(String(captured.messages?.[0]?.content || ''), /SAFE raw=危险的猫图 prompt=危险的猫图/);
});

test('prompt audit: Suno composer retries invalid JSON and then accepts valid JSON', async () => {
  const cfg = createDefaultConfig();
  let calls = 0;
  const composer = new SunoPromptComposer({
    async chat() {
      calls += 1;
      if (calls === 1) return { text: '这不是 JSON' };
      return { text: JSON.stringify({
        customMode: true, instrumental: false, title: '重试成功',
        musicBrief: '温柔女声', style: 'pop, warm, female vocal',
        lyrics: '[Verse]\\n重试后的歌词', model: 'V6',
      }) };
    },
  }, () => cfg);
  const spec = await composer.compose({ request: '写一首歌' }, request('写一首歌'));
  assert.equal(calls, 2);
  assert.equal(spec.customMode, true);
  assert.match(spec.lyrics, /重试后的歌词/);
});

test('prompt audit: image safe rewrite failure returns undefined without breaking pipeline', async () => {
  const cfg = createDefaultConfig();
  cfg.llm.safeRewriteOnFailure = true;
  cfg.llm.enhanceNodeIndex = 0;
  cfg.llm.enhanceModel = 'mock-safety';
  cfg.llm.safeRewritePromptTemplate = 'SAFE {{rawPrompt}}';
  const pipeline = createImagePromptPipeline({
    async chat() { throw new Error('safety model down'); },
  }, () => cfg);
  const output = await pipeline.safeRewrite('危险图');
  assert.equal(output, undefined);
});
