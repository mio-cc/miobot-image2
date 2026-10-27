import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONFIG_V3_FIELD_METADATA,
  createDefaultConfig,
  defaultConfigV3Sections,
  exportConfig,
  importConfig,
  normalizeConfig,
} from '../dist/packages/config/src/index.js';

test('config v3 R1: new runtime sections default to enforce/enabled (P0-1) and cannot disable media direct-only', () => {
  const config = createDefaultConfig();
  // P0-1 修复：旧自然语言链路已删除，Agent 是唯一主运行时——缺省必须直接可用。
  assert.equal(config.agent.enabled, true);
  assert.equal(config.agent.mode, 'enforce');
  assert.equal(config.toolRegistry.enabled, true);
  assert.equal(config.replyPolicy.enabled, true);
  assert.equal(config.replyPolicy.audioDirectOnly, true);
  assert.equal(config.replyPolicy.fileDirectOnly, true);
  assert.equal(config.agent.repair.maxProtocolRepairs, 2);
  assert.equal(config.agent.repair.maxSchemaRepairsPerCall, 2);
  assert.equal(config.agent.repair.maxTotalOutputRepairs, 4);
  assert.equal(config.agent.repair.maxRepeatedErrorCount, 2);
  assert.equal(config.contextPolicy.spillEnabled, true);
  assert.equal(config.freeMode.enabled, false, 'legacy free-mode must remain untouched in R1');
});

test('config v3 R1: normalize clamps enums/ranges and hard-locks audio/file direct-only', () => {
  const config = normalizeConfig({
    agent: {
      enabled: true,
      mode: 'enforce',
      mainNodeIndex: -5,
      mainModel: '  main-model  ',
      fallbackNodeIndex: 3,
      fallbackModel: ' fallback ',
      maxModelRounds: 999,
      maxToolRounds: -1,
      maxParallelTools: 0,
      maxTokens: 0,
      temperature: 9,
      timeoutMs: 10,
      turnTimeoutMs: 10,
      repair: {
        maxProtocolRepairs: 99,
        maxSchemaRepairsPerCall: -3,
        maxTotalOutputRepairs: 999,
        maxRepeatedErrorCount: 0,
        repairTemperature: 4,
        allowTextFallback: false,
      },
    },
    toolRegistry: {
      enabled: true,
      maxToolsPerTurn: 999,
      maxToolSchemaBytes: 1,
      defaultMaxRetries: -1,
      defaultMaxConcurrency: 999,
      exposure: { 'image.generate': 'core', 'bad.tool': 'nope' },
    },
    replyPolicy: {
      enabled: true,
      defaultVoice: 'loud',
      forcedForwardThreshold: 999999,
      hardMaxChars: 0,
      hardMaxMessages: 999,
      audioDirectOnly: false,
      fileDirectOnly: false,
    },
    contextPolicy: {
      historyMaxRounds: 0,
      historyMaxChars: 1,
      groupContextMessages: 0,
      memoryTopK: 999,
      memoryMinScore: 2,
      compactionThresholdTokens: 1,
      pinnedFactsMaxItems: 0,
    },
  });

  assert.equal(config.agent.enabled, true);
  assert.equal(config.agent.mode, 'enforce');
  assert.equal(config.agent.mainNodeIndex, 0);
  assert.equal(config.agent.mainModel, 'main-model');
  assert.equal(config.agent.fallbackNodeIndex, 3);
  assert.equal(config.agent.fallbackModel, 'fallback');
  assert.equal(config.agent.maxModelRounds, 100);
  assert.equal(config.agent.maxToolRounds, 0);
  assert.equal(config.agent.maxParallelTools, 1);
  assert.equal(config.agent.maxTokens, 1);
  assert.equal(config.agent.temperature, 2);
  assert.equal(config.agent.timeoutMs, 1_000);
  assert.equal(config.agent.turnTimeoutMs, 1_000);
  assert.equal(config.agent.repair.maxProtocolRepairs, 20);
  assert.equal(config.agent.repair.maxSchemaRepairsPerCall, 0);
  assert.equal(config.agent.repair.maxTotalOutputRepairs, 40);
  assert.equal(config.agent.repair.maxRepeatedErrorCount, 1);
  assert.equal(config.agent.repair.repairTemperature, 1);
  assert.equal(config.agent.repair.allowTextFallback, false);

  assert.equal(config.toolRegistry.enabled, true);
  assert.equal(config.toolRegistry.maxToolsPerTurn, 128);
  assert.equal(config.toolRegistry.maxToolSchemaBytes, 1_024);
  assert.equal(config.toolRegistry.defaultMaxRetries, 0);
  assert.equal(config.toolRegistry.defaultMaxConcurrency, 64);
  assert.deepEqual(config.toolRegistry.exposure, { 'image.generate': 'core' });

  assert.equal(config.replyPolicy.defaultVoice, 'auto');
  assert.equal(config.replyPolicy.forcedForwardThreshold, 100_000);
  assert.equal(config.replyPolicy.hardMaxChars, 1);
  assert.equal(config.replyPolicy.hardMaxMessages, 100);
  assert.equal(config.replyPolicy.audioDirectOnly, true);
  assert.equal(config.replyPolicy.fileDirectOnly, true);

  assert.equal(config.contextPolicy.historyMaxRounds, 1);
  assert.equal(config.contextPolicy.historyMaxChars, 500);
  assert.equal(config.contextPolicy.groupContextMessages, 1);
  assert.equal(config.contextPolicy.memoryTopK, 100);
  assert.equal(config.contextPolicy.memoryMinScore, 1);
  assert.equal(config.contextPolicy.compactionThresholdTokens, 1_000);
  assert.equal(config.contextPolicy.pinnedFactsMaxItems, 1);
});

test('config v3 R1: every default leaf has field metadata with the same default', () => {
  const leaves = flattenLeaves(defaultConfigV3Sections());
  const metadata = new Map(CONFIG_V3_FIELD_METADATA.map((item) => [item.key, item]));
  assert.equal(metadata.size, CONFIG_V3_FIELD_METADATA.length, 'field metadata keys must be unique');
  for (const [key, value] of leaves) {
    const item = metadata.get(key);
    assert.ok(item, `missing config v3 field metadata: ${key}`);
    assert.deepEqual(item.defaultValue, value, `default mismatch for ${key}`);
  }
  assert.ok(metadata.has('agent.fallbackNodeIndex'));
  assert.ok(metadata.has('agent.fallbackModel'));
  assert.equal(metadata.get('replyPolicy.audioDirectOnly').danger, true);
  assert.equal(metadata.get('agent.mode').enumValues.includes('off'), true);
});

test('config v3 R1: old config without new sections is filled safely and export/import is idempotent', () => {
  const oldStyle = {
    panel: { port: 3019, passwordSeed: 'seed' },
    freeMode: { enabled: true },
    intentRecognition: { enabled: true },
    bot: { persona: { enabled: true, name: 'Mio', systemPrompt: 'be nice' } },
    orchestration: { enabled: true, mode: 'enforce' },
  };
  const normalized = normalizeConfig(oldStyle);
  assert.equal(normalized.panel.port, 3019);
  assert.equal(normalized.freeMode.enabled, true);
  assert.equal(normalized.intentRecognition.enabled, true);
  assert.equal(normalized.bot.persona.name, 'Mio');
  assert.equal(normalized.orchestration.enabled, true);
  // P0-1 修复：旧配置没有 agent 分区时自动迁移为 enforce/enabled（旧链路已删除，无回退）。
  assert.equal(normalized.agent.enabled, true);
  assert.equal(normalized.agent.mode, 'enforce');
  assert.equal(normalized.toolRegistry.enabled, true);
  assert.equal(normalized.replyPolicy.enabled, true);

  const exported = exportConfig(normalized, { exportedAt: '2026-10-26T10:00:00.000Z' });
  const imported = importConfig(exported);
  assert.deepEqual(imported.config, normalized);
  assert.equal(imported.config.agent.mode, 'enforce');
  assert.equal(imported.config.replyPolicy.audioDirectOnly, true);
});

function flattenLeaves(value, prefix = '') {
  const out = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  const entries = Object.entries(value);
  if (!entries.length && prefix) return [[prefix, value]];
  for (const [key, item] of entries) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (item && typeof item === 'object' && !Array.isArray(item)) out.push(...flattenLeaves(item, path));
    else out.push([path, item]);
  }
  return out;
}
