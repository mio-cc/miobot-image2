import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * 用途级备用绑定的 normalize 契约（方案 6-P2，11 用途）。
 * 口径对齐既有 fallback 语义：model 空串/缺键剔除不落盘（= 关闭备用）；
 * 有 model 才写 nodeIndex（缺省 0）；老配置缺键 → 不新增任何键。
 * 计数侧反例（跨用途不继承/独立计数/main 等价）在 model-fallback.test.mjs（test 16-22）。
 */

const { createDefaultConfig, normalizeConfig } = await import('../dist/packages/config/src/index.js');

/** 11 用途 → [section 获取器, nodeField, modelField]（与 MODEL_BINDING_PURPOSES 的落点一致）。 */
const SITES = [
  ['llm.enhance', (c) => c.llm, 'fallbackEnhanceNodeIndex', 'fallbackEnhanceModel'],
  ['llm.image', (c) => c.llm, 'fallbackImageNodeIndex', 'fallbackImageModel'],
  ['llm.edit', (c) => c.llm, 'fallbackEditNodeIndex', 'fallbackEditModel'],
  ['llm.interrogate', (c) => c.llm, 'fallbackInterrogateNodeIndex', 'fallbackInterrogateModel'],
  ['llm.video', (c) => c.llm, 'fallbackVideoNodeIndex', 'fallbackVideoModel'],
  ['codeRender', (c) => c.codeRender, 'fallbackNodeIndex', 'fallbackModel'],
  ['comfyuiTransform', (c) => c.comfyuiTransform, 'fallbackNodeIndex', 'fallbackModel'],
  ['bot.tts.preprocess', (c) => c.bot.tts.preprocess, 'fallbackNodeIndex', 'fallbackModel'],
  ['bot.keywordTrigger', (c) => c.bot.keywordTrigger, 'fallbackIntentNodeIndex', 'fallbackIntentModel'],
  ['orchestration.suno', (c) => c.orchestration.suno, 'fallbackComposerNodeIndex', 'fallbackComposerModel'],
  ['orchestration.memory', (c) => c.orchestration.memory, 'fallbackEmbeddingNodeIndex', 'fallbackEmbeddingModel'],
];

test('purpose fallback schema: defaults carry no fallback keys (old configs stay untouched)', () => {
  const cfg = normalizeConfig(createDefaultConfig());
  for (const [name, container, nodeField, modelField] of SITES) {
    const obj = container(cfg);
    assert.equal(modelField in obj, false, `${name}.${modelField} 缺键时不得新增`);
    assert.equal(nodeField in obj, false, `${name}.${nodeField} 缺键时不得新增`);
  }
});

test('purpose fallback schema: empty model drops the key, nodeIndex resets to 0 when present', () => {
  const base = createDefaultConfig();
  const input = {
    ...base,
    llm: { ...base.llm, fallbackImageModel: '', fallbackImageNodeIndex: 3 },
    codeRender: { ...base.codeRender, fallbackModel: '  ', fallbackNodeIndex: 2 },
    bot: { ...base.bot, tts: { ...base.bot.tts, preprocess: { ...base.bot.tts.preprocess, fallbackModel: '', fallbackNodeIndex: 1 } } },
  };
  const cfg = normalizeConfig(input);
  assert.equal('fallbackImageModel' in cfg.llm, false, 'llm 空串 model 必须剔除');
  assert.equal(cfg.llm.fallbackImageNodeIndex, 0, 'model 为空时 nodeIndex 归零（不残留旧节点）');
  assert.equal('fallbackModel' in cfg.codeRender, false, '纯空白 model 同样剔除');
  assert.equal(cfg.codeRender.fallbackNodeIndex, 0);
  assert.equal('fallbackModel' in cfg.bot.tts.preprocess, false);
  assert.equal(cfg.bot.tts.preprocess.fallbackNodeIndex, 0);
});

test('purpose fallback schema: filled model persists with clamped nodeIndex and 200-char cap', () => {
  const base = createDefaultConfig();
  const longName = 'm'.repeat(250);
  const input = {
    ...base,
    llm: { ...base.llm, fallbackImageModel: longName, fallbackImageNodeIndex: 999 },
    orchestration: {
      ...base.orchestration,
      suno: { ...base.orchestration.suno, fallbackComposerModel: 'fb-suno', fallbackComposerNodeIndex: 99999 },
      memory: { ...base.orchestration.memory, fallbackEmbeddingModel: '  fb-mem  ', fallbackEmbeddingNodeIndex: -5 },
    },
    bot: { ...base.bot, keywordTrigger: { ...base.bot.keywordTrigger, fallbackIntentModel: 'fb-trig', fallbackIntentNodeIndex: 5 } },
  };
  const cfg = normalizeConfig(input);
  // llm 容器：nodeIndex 由 clampNode 钳到节点数-1（默认配置 1 个节点 → 0）。
  assert.equal(cfg.llm.fallbackImageModel.length, 200, 'model 名 200 字截断');
  assert.equal(cfg.llm.fallbackImageNodeIndex, 0);
  // orchestration 容器：numberIn 钳 0-10000。
  assert.equal(cfg.orchestration.suno.fallbackComposerNodeIndex, 10000);
  assert.equal(cfg.orchestration.memory.fallbackEmbeddingModel, 'fb-mem', 'trim 保留');
  assert.equal(cfg.orchestration.memory.fallbackEmbeddingNodeIndex, 0);
  // keywordTrigger：clamp 0-999。
  assert.equal(cfg.bot.keywordTrigger.fallbackIntentModel, 'fb-trig');
  assert.equal(cfg.bot.keywordTrigger.fallbackIntentNodeIndex, 5);
});

test('purpose fallback schema: model-only input defaults nodeIndex to 0; round-trip is idempotent', () => {
  const base = createDefaultConfig();
  const input = { ...base, llm: { ...base.llm, fallbackVideoModel: 'fb-vid' } };
  const once = normalizeConfig(input);
  assert.equal(once.llm.fallbackVideoModel, 'fb-vid');
  assert.equal('fallbackVideoNodeIndex' in once.llm, false, '只填 model → 不新增 nodeIndex 键（状态机读作 0）');
  const twice = normalizeConfig(once);
  assert.equal(twice.llm.fallbackVideoModel, 'fb-vid');
  assert.equal('fallbackVideoNodeIndex' in twice.llm, false, '导出再导入幂等，不凭空长键');
});
