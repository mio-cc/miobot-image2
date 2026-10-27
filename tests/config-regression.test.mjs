import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CONFIG_MIGRATION_TABLE,
  LEGACY_FREE_MODE_PROMPT_V1,
  LEGACY_FREE_MODE_PROMPT_V2,
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
  // free-mode 默认模板不再教模型输出 video action（解析器不支持，会被误当生图）；
  // 改为要求模型用文本回复并带 video 字样，交给上游视频信号链路处理。
  assert.doesNotMatch(defaults.freeMode.plannerPromptTemplate, /"action":"video"/);
  assert.match(defaults.freeMode.plannerPromptTemplate, /do not choose an image action/);
  assert.equal(defaults.bot.progress.imageEnabled, false);
  assert.equal(defaults.bot.progress.audioEnabled, false);
  assert.equal(defaults.bot.progress.videoEnabled, true);
  assert.equal(defaults.orchestration.suno.defaultVocalGender, 'auto');
  assert.equal(defaults.orchestration.planner.alignmentReviewMaxTokens, 1000);
  assert.equal(defaults.orchestration.suno.composerMaxTokens, 6000);
  assert.equal(defaults.orchestration.suno.composerTemperature, 0.6);
  assert.equal(defaults.orchestration.suno.sendLyricsWithMusic, false);
    assert.equal(defaults.orchestration.suno.historyMaxRecords, 100);
    assert.equal(defaults.orchestration.suno.historyPromptLimit, 5, 'C8 瘦身：默认注入条数减半');
  assert.equal(defaults.intentRecognition.maxTokens, 240);
  assert.equal(defaults.orchestration.suno.defaultLanguage, '');
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
  assert.equal(roundTrip.sourceFormat, 'export-wrapper-v3');
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
  assert.equal(roundTrip.sourceFormat, 'export-wrapper-v3');
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
  // 2026-10 前的默认模板教 video action，会被解析器误当生图；已知默认值必须自动升级。
  const cfgV2 = createDefaultConfig();
  cfgV2.freeMode.plannerPromptTemplate = LEGACY_FREE_MODE_PROMPT_V2;
  const normalizedV2 = normalizeConfig(cfgV2);
  assert.doesNotMatch(normalizedV2.freeMode.plannerPromptTemplate, /"action":"video"/);
  assert.match(normalizedV2.freeMode.plannerPromptTemplate, /do not choose an image action/);
  const custom = createDefaultConfig();
  custom.intentRecognition.promptTemplate = 'MY CUSTOM INTENT';
  custom.freeMode.plannerPromptTemplate = 'MY CUSTOM FREE';
  const normalizedCustom = normalizeConfig(custom);
  assert.equal(normalizedCustom.intentRecognition.promptTemplate, 'MY CUSTOM INTENT');
  assert.equal(normalizedCustom.freeMode.plannerPromptTemplate, 'MY CUSTOM FREE');
});

test('config regression T0.7: reply 文本兜底与 overflow 默认值', () => {
  const defaults = createDefaultConfig();
  assert.equal(defaults.orchestration.reply.textFallback, 'always');
  assert.equal(defaults.orchestration.reply.overflowPolicy, 'forward');
  const cfg = createDefaultConfig();
  cfg.orchestration.reply.textFallback = 'nonsense';
  cfg.orchestration.reply.overflowPolicy = 'nonsense';
  const normalized = normalizeConfig(cfg);
  assert.equal(normalized.orchestration.reply.textFallback, 'always');
  assert.equal(normalized.orchestration.reply.overflowPolicy, 'forward');
});

test('config regression T2.2: 每用户消息频率上限默认值与归一化', () => {
  const defaults = createDefaultConfig();
  assert.equal(defaults.bot.messageRateLimitPerMinute, 0, '默认关闭，防刷屏静默丢弃需面板显式开启');
  const cfg = createDefaultConfig();
  cfg.bot.messageRateLimitPerMinute = 999;
  const normalized = normalizeConfig(cfg);
  // 上限不再硬编码在后端（面板 UI max=60 是唯一上限），手改 config 的值原样透传
  assert.equal(normalized.bot.messageRateLimitPerMinute, 999);
  const off = normalizeConfig({ ...createDefaultConfig(), bot: { ...createDefaultConfig().bot, messageRateLimitPerMinute: 0 } });
  assert.equal(off.bot.messageRateLimitPerMinute, 0);
});

test('config regression TR.5: 旧开关的关闭状态物化为 orch.capabilityOverrides 单源', () => {
  const result = importConfig({
    llm: { imageEnabled: false, videoEnabled: false },
    codeRender: { enabled: false },
    bot: { features: { 'file.list': { enabled: false }, 'search.web': { enabled: false } } },
  });
  const overrides = result.config.orchestration.capabilityOverrides;
  assert.equal(overrides['image.generate']?.enabled, false, 'llm.imageEnabled=false 应物化 image.generate 关闭');
  assert.equal(overrides['video.generate']?.enabled, false, 'llm.videoEnabled=false 应物化 video.generate 关闭');
  assert.equal(overrides['code.render']?.enabled, false, 'codeRender.enabled=false 应物化 code.render 关闭');
  assert.equal(overrides['file.list']?.enabled, false, 'features.file.list 关闭应物化 file.list 关闭');
  assert.equal(overrides['web.search']?.enabled, false, 'features.search.web 关闭应物化 web.search 关闭');
  // 旧开关保持原值：v2 链路继续读它们，行为不变
  assert.equal(result.config.llm.imageEnabled, false);
  assert.equal(result.config.codeRender.enabled, false);
  assert.equal(result.config.bot.features['file.list'].enabled, false);
  assert.ok(result.migrations.some((item) => item.id === 'switches-to-orch.capabilityOverrides'));
});

test('config regression TR.5: 显式 override 优先并回填旧开关（含缺失的 feature 设置）', () => {
  const result = importConfig({
    llm: { imageEnabled: false },
    orchestration: { capabilityOverrides: { 'image.generate': { enabled: true }, 'help': { enabled: false } } },
  });
  assert.equal(result.config.orchestration.capabilityOverrides['image.generate'].enabled, true, '显式 override 不被旧开关覆盖');
  assert.equal(result.config.llm.imageEnabled, true, '显式 override 回填 llm.imageEnabled');
  assert.equal(result.config.bot.features['image.generate'].enabled, true, '显式 override 回填 feature 设置');
  assert.equal(result.config.bot.features['help'].enabled, false, '缺失的 feature 设置按 override 补齐');
});

test('config regression TR.5: 默认开启的能力不物化 override（保持稀疏）', () => {
  const result = importConfig({});
  const overrides = result.config.orchestration.capabilityOverrides;
  assert.equal(overrides['image.generate'], undefined);
  assert.equal(overrides['chat.reply'], undefined);
  assert.equal(overrides['video.generate'], undefined);
  assert.equal(overrides['code.render'], undefined);
  assert.ok(!result.migrations.some((item) => item.id === 'switches-to-orch.capabilityOverrides'));
});

test('config regression 兼容性修复: 显式 overflowPolicy=truncate 不得被强转为 forward', () => {
  const cfg = createDefaultConfig();
  cfg.orchestration.reply.overflowPolicy = 'truncate';
  const normalized = normalizeConfig(cfg);
  assert.equal(normalized.orchestration.reply.overflowPolicy, 'truncate', '用户显式选择保留');
  const absent = normalizeConfig(createDefaultConfig());
  assert.equal(absent.orchestration.reply.overflowPolicy, 'forward', '缺省仍为 forward');
  const invalid = createDefaultConfig();
  invalid.orchestration.reply.overflowPolicy = 'nonsense';
  assert.equal(normalizeConfig(invalid).orchestration.reply.overflowPolicy, 'forward', '非法值回退 forward');
});

test('config regression: Suno timeout 是任务等待上限，至少 10 分钟', () => {
  const short = normalizeConfig({ orchestration: { suno: { timeoutMs: 20000 } } });
  assert.equal(short.orchestration.suno.timeoutMs, 600000, '20 秒等待会误杀 Suno 远程任务');
  const custom = normalizeConfig({ orchestration: { suno: { timeoutMs: 900000 } } });
  assert.equal(custom.orchestration.suno.timeoutMs, 900000, '合法的更长任务等待应保留');
});