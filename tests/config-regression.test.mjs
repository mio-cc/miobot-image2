import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CONFIG_MIGRATION_TABLE,
  CONFIG_PACKAGE,
  CONFIG_SCHEMA_VERSION,
  createDefaultConfig,
  exportConfig,
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

test('config regression: old example-like export imports with all required v2 sections', () => {
  const result = importConfig(legacyConfigExampleLike());
  assert.equal(result.sourceFormat, 'export-wrapper-v1');
  assert.equal(result.config.panel.passwordSeed, 'legacy-test-password');
  assert.equal(result.config.napcat.wsUrl, 'ws://localhost:3001');
  assert.equal(result.config.napcat.mountOutputDir, 'C:/miobot/output');
  assert.equal(result.config.freeMode.enabled, false);
  assert.equal(result.config.freeMode.model, 'gpt-4o-mini');
  assert.deepEqual(result.config.bot.replyStrategies, { text: 'quote', image: 'quote', multiImage: 'quote' });
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
  assert.equal(result.config.canvas.dataDir, 'D:/canvas-data');
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

test('config regression: aliases from arrays are deduped and keep default fallbacks', () => {
  const result = importConfig({ bot: { commands: { genImage: ['draw', 'Draw', '画图'] } } });
  assert.equal(result.config.bot.commands.genImage, 'draw, 画图, 生图, 画');
  assert.match(result.config.bot.commands.help, /\/help/);
});
