import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CONFIG_MIGRATION_TABLE,
  LEGACY_FREE_MODE_PROMPT_V1,
  LEGACY_NATURAL_INTENT_PROMPT_V1,
  CONFIG_PACKAGE,
  CONFIG_SCHEMA_VERSION,
  createDefaultConfig,
  exportConfig,
  getDefaultPrompts,
  importConfig,
  normalizeConfig,
} from '../dist/packages/config/src/index.js';

const legacyNodeA = { name: 'Legacy A', baseUrl: 'http://localhost:8317/v1', key: 'test-key-a', enabled: true, models: ['gpt-4o-mini'], modelsFetchedAt: '' };
const legacyNodeB = { name: 'Legacy B', baseUrl: 'http://localhost:8318/v1', key: 'test-key-b', enabled: true, models: ['gpt-image-2'], modelsFetchedAt: '' };

function legacyConfigExampleLike() {
  return {
    version: 1,
    exportedAt: '2026-05-28T00:00:00.000Z',
    config: {
      panel: { port: '3018', password: 'legacy-test-password' },
      napcat: { websocketUrl: 'ws://localhost:3001', token: 'token', mountOutputDir: '  C:/miobot/output  ' },
      promptsChat: { searchType: 'text', requestTimeoutMs: '2500', smartNodeIndex: 20 },
      llm: {
        nodes: [legacyNodeA, legacyNodeB],
        activeNodeIndex: 1,
        chatNodeIndex: 0,
        chatModel: 'gpt-4o-mini',
        imageNodeIndex: 1,
        imageModel: 'legacy-image-model',
        imageCount: 4,
        imageTimeoutMs: 180000,
        imageRetryCount: 2,
        imageRetryDelayMs: 1500,
        editNodeIndex: 1,
        editModel: 'legacy-edit-model',
        imageEditRequestMode: 'json-image',
        interrogateNodeIndex: 0,
        interrogateModel: 'legacy-vision-model',
        interrogateTimeoutMs: 90000,
      },
      bot: {
        replyFormat: 'quote',
        groupWhitelist: '1000, 2000, 1000',
        privateWhitelist: ['3000', ' 4000 '],
        blacklistUsers: ['1000:5000', '*:6000'],
        commands: { draw: ['画图', 'draw'] },
        promptTemplates: [{ id: 'legacy_tpl', title: 'Legacy', prompt: 'render {{prompt}}' }],
      },
    },
  };
}

test('config regression: package marker and migration table include P12 image backfill', () => {
  assert.equal(CONFIG_PACKAGE.phase, 'P12-config-regression');
  const ids = new Set(CONFIG_MIGRATION_TABLE.map((item) => item.id));
  assert.ok(ids.has('llm.image-to-canvas.image'));
  assert.ok(ids.has('llm.interrogate-to-canvas.interrogate'));
  assert.ok(ids.has('bot.replyFormat-to-replyStrategies'));
});

test('config regression: prompt rewrite defaults preserve the user language', () => {
  const defaults = createDefaultConfig();
  assert.match(defaults.llm.enhancePromptTemplate, /保留用户原始语言/);
  assert.match(defaults.llm.enhancePromptTemplate, /不要翻译成英文/);
  assert.match(defaults.promptsChat.smartPromptTemplate, /must not be translated into English/);
  assert.match(defaults.freeMode.plannerPromptTemplate, /"action":"video"/);
  assert.match(defaults.freeMode.plannerPromptTemplate, /"images":\[/);
  assert.match(defaults.freeMode.plannerPromptTemplate, /must not be translated into English/);
});

test('config regression: old example-like export imports with all required v2 sections', () => {
  const result = importConfig(legacyConfigExampleLike());
  assert.equal(result.sourceFormat, 'export-wrapper-v1');
  assert.equal(result.config.panel.passwordSeed, 'legacy-test-password');
  assert.equal(result.config.napcat.wsUrl, 'ws://localhost:3001');
  // mountOutputDir 现在恢复为 Napcat 共享目录映射，旧配置值应保留并 trim。
  assert.equal(result.config.napcat.mountOutputDir, 'C:/miobot/output');
  assert.equal(result.config.napcat.mountOutputContainerDir, '');
  assert.equal(result.config.freeMode.enabled, false);
  assert.equal(result.config.freeMode.model, 'gpt-4o-mini');
  assert.deepEqual(result.config.bot.replyStrategies, { text: 'quote', image: 'quote', multiImage: 'quote', video: 'plain', multiVideo: 'forward', file: 'forward', multiFile: 'forward', mixed: 'forward' });
  assert.deepEqual(result.config.bot.whitelistGroups, ['1000', '2000']);
  assert.deepEqual(result.config.bot.whitelistPrivate, ['3000', '4000']);
  assert.deepEqual(result.config.bot.blacklistGroupUsers, ['1000:5000', '*:6000']);
  assert.equal(result.config.bot.promptTemplates[0].id, 'legacy_tpl');
});

test('config regression: missing canvas backfills image and edit settings from legacy llm fields', () => {
  const result = importConfig(legacyConfigExampleLike());
  assert.equal(result.config.canvas.imageNodeIndex, 1);
  assert.equal(result.config.canvas.imageModel, 'legacy-image-model');
  assert.equal(result.config.canvas.editNodeIndex, 1);
  assert.equal(result.config.canvas.editModel, 'legacy-edit-model');
  assert.equal(result.config.canvas.imageEditRequestMode, 'json-image');
  assert.equal(result.config.canvas.imageTimeoutMs, 180000);
  assert.equal(result.config.canvas.imageRetryCount, 2);
  assert.equal(result.config.canvas.imageRetryDelayMs, 1500);
  assert.equal(result.config.canvas.defaultCount, 4);
  assert.ok(result.migrations.some((item) => item.id === 'llm.image-to-canvas.image'));
});

test('config regression: missing canvas backfills interrogate settings from legacy llm fields', () => {
  const result = importConfig(legacyConfigExampleLike());
  assert.equal(result.config.canvas.interrogateNodeIndex, 0);
  assert.equal(result.config.canvas.interrogateModel, 'legacy-vision-model');
  assert.equal(result.config.canvas.interrogateTimeoutMs, 90000);
  assert.equal(result.config.canvas.interrogateTemplateTimeoutMs, 90000);
  assert.ok(result.migrations.some((item) => item.id === 'llm.interrogate-to-canvas.interrogate'));
});

test('config regression: enum, timeout, node index, and canvas path normalization are stable', () => {
  const result = importConfig({
    llm: { apiKeys: [legacyNodeA, legacyNodeB], activeNodeIndex: 99, chatNodeIndex: 99 },
    promptsChat: { searchType: 'image', requestTimeoutMs: 1, smartNodeIndex: 99 },
    canvas: { defaultQuality: 'hd', defaultOutputFormat: 'gif', maxHistory: 9999, dataDir: '  D:/canvas-data  ', imageNodeIndex: 99 },
    freeMode: { nodeIndex: 99, timeoutMs: 1 },
  });
  assert.equal(result.config.llm.activeNodeIndex, 1);
  assert.equal(result.config.llm.chatNodeIndex, 1);
  assert.equal(result.config.promptsChat.searchType, 'IMAGE');
  assert.equal(result.config.promptsChat.requestTimeoutMs, 5000);
  assert.equal(result.config.promptsChat.smartNodeIndex, 1);
  assert.equal(result.config.canvas.defaultQuality, 'high');
  assert.equal(result.config.canvas.defaultOutputFormat, 'png');
  assert.equal(result.config.canvas.maxHistory, 500);
  assert.equal(result.config.canvas.dataDir, undefined, 'canvas.dataDir 已删除，画布实际用 DATA_DIR 环境变量');
  assert.equal(result.config.canvas.imageNodeIndex, 1);
  assert.equal(result.config.freeMode.nodeIndex, 1);
  assert.equal(result.config.freeMode.timeoutMs, 30000);
});

test('config regression: empty apiKeys falls back to default node with warning', () => {
  const result = importConfig({ llm: { apiKeys: [] } });
  assert.equal(result.config.llm.apiKeys.length, 1);
  assert.equal(result.config.llm.apiKeys[0].baseUrl, createDefaultConfig().llm.apiKeys[0].baseUrl);
  assert.ok(result.warnings.some((item) => item.includes('llm.apiKeys')));
});

test('config regression: export then import is idempotent for normalized config', () => {
  const normalized = normalizeConfig(legacyConfigExampleLike());
  const exported = exportConfig(normalized, { exportedAt: '2026-05-28T01:00:00.000Z' });
  assert.equal(exported.version, CONFIG_SCHEMA_VERSION);
  const roundTrip = importConfig(exported);
  assert.equal(roundTrip.sourceFormat, 'export-wrapper-v2');
  assert.deepEqual(roundTrip.config, normalized);
  assert.deepEqual(exportConfig(roundTrip.config, { exportedAt: '2026-05-28T01:00:00.000Z' }), exported);
});

test('config regression: invalid payload is safe and returns default config with warning', () => {
  const result = importConfig('not json object');
  const defaults = createDefaultConfig();
  assert.equal(result.sourceFormat, 'invalid');
  assert.equal(result.config.panel.port, defaults.panel.port);
  assert.equal(result.config.bot.commands.help, defaults.bot.commands.help);
  assert.ok(result.warnings.length >= 1);
});

test('config regression: 视频默认字段与 normalize clamp', () => {
  const defaults = createDefaultConfig();
  assert.equal(defaults.llm.videoModel, 'grok-imagine-video');
  assert.equal(defaults.llm.videoEnabled, true);
  assert.equal(defaults.llm.videoNodeIndex, 0);
  assert.equal(defaults.llm.videoTimeoutMs, 120000);
  assert.equal(defaults.llm.videoPollTimeoutMs, 600000);
  assert.equal(defaults.llm.videoPollIntervalMs, 5000);
  // 旧配置无视频字段 → 补默认
  const bare = normalizeConfig({ llm: { chatModel: 'gpt-4o-mini', apiKeys: [{ name: 'n', baseUrl: 'http://x', key: 'k', enabled: true, models: [] }] } });
  assert.equal(bare.llm.videoModel, 'grok-imagine-video');
  assert.equal(bare.llm.videoEnabled, true);
  // capabilityOverrides 允许 video.generate
  const withOverride = normalizeConfig({
    llm: {
      capabilityOverrides: [{ model: 'my-vid', operations: ['video.generate', 'hack'] }],
    },
  });
  assert.deepEqual(withOverride.llm.capabilityOverrides[0].operations, ['video.generate']);
  // poll interval clamp
  const clamped = normalizeConfig({ llm: { videoPollIntervalMs: 10 } });
  assert.equal(clamped.llm.videoPollIntervalMs, 200);
});

test('config regression: aliases from arrays are deduped and keep default fallbacks', () => {
  const result = importConfig({ bot: { commands: { genImage: ['draw', 'Draw', '画图'] } } });
  assert.equal(result.config.bot.commands.genImage, 'draw, 画图, 生图, 画');
  assert.match(result.config.bot.commands.help, /\/help/);
});

test('config regression: 退役字段不会从旧 config.json 里漏回来', () => {
  // llm / canvas / bot 是 { ...默认值, ...用户对象 } 展开的，未知键本来会原样穿过去
  // 再被写回磁盘——只删接口声明是拦不住的。
  const result = importConfig({
    napcat: { mountOutputDir: '/root/Napcat-OmniBot/output', mountOutputContainerDir: '/app/napcat/output' },
    canvas: { dataDir: 'D:/canvas-data' },
    freeMode: { maxReferencedMessages: 33 },
    promptsChat: { translateSearchQuery: true, translateResults: true },
    llm: {
      autoNewConversation: false,
      templateConvertNodeIndex: 2, templateConvertModel: 'x',
      templatePromptTemplate: 'a', templateConvertPromptTemplate: 'b', templateTitlePromptTemplate: 'c',
      referencedTemplatePromptTemplate: 'd', referencedTemplateTimeoutMs: 999999,
      translationPromptTemplate: 'e',
    },
    bot: { imageCompression: { mergedPreviewEnabled: true, mergedPreviewScale: 0.9, mergedPreviewQuality: 90, mergedPreviewMaxWidth: 2000 } },
    huggingFace: { filters: { includePrivate: true } },
  });
  const cfg = result.config;
  const retired = [
    ['canvas.dataDir', cfg.canvas.dataDir],
    ['freeMode.maxReferencedMessages', cfg.freeMode.maxReferencedMessages],
    ['promptsChat.translateSearchQuery', cfg.promptsChat.translateSearchQuery],
    ['promptsChat.translateResults', cfg.promptsChat.translateResults],
    ['llm.autoNewConversation', cfg.llm.autoNewConversation],
    ['llm.templateConvertNodeIndex', cfg.llm.templateConvertNodeIndex],
    ['llm.templateConvertModel', cfg.llm.templateConvertModel],
    ['llm.templatePromptTemplate', cfg.llm.templatePromptTemplate],
    ['llm.templateConvertPromptTemplate', cfg.llm.templateConvertPromptTemplate],
    ['llm.templateTitlePromptTemplate', cfg.llm.templateTitlePromptTemplate],
    ['llm.referencedTemplatePromptTemplate', cfg.llm.referencedTemplatePromptTemplate],
    ['llm.referencedTemplateTimeoutMs', cfg.llm.referencedTemplateTimeoutMs],
    ['llm.translationPromptTemplate', cfg.llm.translationPromptTemplate],
    ['bot.imageCompression.mergedPreviewEnabled', cfg.bot.imageCompression.mergedPreviewEnabled],
    ['bot.imageCompression.mergedPreviewScale', cfg.bot.imageCompression.mergedPreviewScale],
    ['bot.imageCompression.mergedPreviewQuality', cfg.bot.imageCompression.mergedPreviewQuality],
    ['bot.imageCompression.mergedPreviewMaxWidth', cfg.bot.imageCompression.mergedPreviewMaxWidth],
    ['huggingFace.filters.includePrivate', cfg.huggingFace.filters.includePrivate],
  ];
  for (const [path, value] of retired) assert.equal(value, undefined, `${path} 不该复活`);
  assert.equal(cfg.napcat.mountOutputDir, '/root/Napcat-OmniBot/output');
  assert.equal(cfg.napcat.mountOutputContainerDir, '/app/napcat/output');

  // 同段里活着的字段不能被误伤
  assert.equal(cfg.bot.imageCompression.enabled, true);
  assert.equal(typeof cfg.bot.imageCompression.scale, 'number');
  assert.equal(typeof cfg.freeMode.maxInputImages, 'number');
  assert.equal(typeof cfg.llm.templateNodeIndex, 'number');
  assert.equal(typeof cfg.huggingFace.filters.limit, 'number');
});

test('config regression: getDefaultPrompts 只吐还能编辑的提示词', () => {
  // 面板的「恢复默认」按钮按 key 取值；配置里已经没有的键继续吐出来只会让人以为还能改。
  const prompts = getDefaultPrompts();
  for (const gone of ['templatePromptTemplate', 'templateConvertPromptTemplate', 'templateTitlePromptTemplate',
    'referencedTemplatePromptTemplate', 'translationPromptTemplate'])
    assert.equal(prompts[gone], undefined, `${gone} 已退役`);
  for (const alive of ['enhancePromptTemplate', 'interrogatePromptTemplate', 'safeRewritePromptTemplate', 'freeModePromptTemplate'])
    assert.equal(typeof prompts[alive], 'string', `${alive} 还在用`);
});

test('config regression: v3 orchestration settings survive export/import', () => {
  const cfg = createDefaultConfig();
  cfg.orchestration.enabled = true;
  cfg.orchestration.mode = 'enforce';
  cfg.orchestration.externalProviders.enabled = true;
  cfg.orchestration.externalProviders.allowlist = ['suno-official'];
  cfg.orchestration.voice.enabled = true;
  cfg.orchestration.voice.allowedScopes = 'group';
  cfg.orchestration.voice.userCanChange = false;
  cfg.orchestration.memory.enabled = true;
  cfg.orchestration.memory.dataDir = '/var/lib/miobot-v2/memory';
  cfg.orchestration.memory.embeddingModel = 'text-embedding-3-small';
  cfg.orchestration.memory.embeddingDimensions = 1024;
  cfg.orchestration.memory.userGlobalProfileEnabled = true;
  cfg.orchestration.suno.enabled = true;
  cfg.orchestration.suno.requestMode = 'v6';
  cfg.orchestration.suno.baseUrl = 'https://api.suno.example';
  cfg.orchestration.suno.apiKey = 'suno-secret-key';
  cfg.orchestration.suno.callbackUrl = 'https://bot.example/api/orchestration/suno/callback/callback-secret';
  cfg.orchestration.suno.callbackSecret = 'callback-secret';
  cfg.orchestration.suno.maxConcurrent = 2;
  cfg.orchestration.suno.quotaPerUserPerDay = 4;
  cfg.orchestration.permissions.hardDenyEnabled = true;
  cfg.orchestration.permissions.hardDenyCapabilities = ['file.delete'];
  cfg.orchestration.audit.enabled = true;
  cfg.orchestration.audit.retentionDays = 90;

  const normalized = normalizeConfig(cfg);
  const roundTrip = importConfig(exportConfig(normalized, { exportedAt: '2026-05-28T02:00:00.000Z' }));
  assert.equal(roundTrip.sourceFormat, 'export-wrapper-v2');
  assert.deepEqual(roundTrip.config.orchestration, normalized.orchestration);
  assert.equal(roundTrip.config.orchestration.suno.apiKey, 'suno-secret-key');
  assert.equal(roundTrip.config.orchestration.suno.callbackSecret, 'callback-secret');
  assert.equal(roundTrip.config.orchestration.memory.userGlobalProfileEnabled, true);
  assert.equal(roundTrip.config.orchestration.permissions.hardDenyCapabilities[0], 'file.delete');
});

test('config migration: known legacy intent and freeMode prompts upgrade to effect semantics', () => {
  const cfg = createDefaultConfig();
  cfg.intentRecognition.promptTemplate = LEGACY_NATURAL_INTENT_PROMPT_V1;
  cfg.freeMode.plannerPromptTemplate = LEGACY_FREE_MODE_PROMPT_V1;
  const normalized = normalizeConfig(cfg);
  assert.match(normalized.intentRecognition.promptTemplate, /effect/);
  assert.match(normalized.intentRecognition.promptTemplate, /话题词/);
  assert.match(normalized.freeMode.plannerPromptTemplate, /outcome effect/);
  const custom = createDefaultConfig();
  custom.intentRecognition.promptTemplate = 'MY CUSTOM INTENT';
  custom.freeMode.plannerPromptTemplate = 'MY CUSTOM FREE';
  const normalizedCustom = normalizeConfig(custom);
  assert.equal(normalizedCustom.intentRecognition.promptTemplate, 'MY CUSTOM INTENT');
  assert.equal(normalizedCustom.freeMode.plannerPromptTemplate, 'MY CUSTOM FREE');
});
