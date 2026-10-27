import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONFIG_SCHEMA_VERSION,
  exportConfig,
  importConfig,
} from '../dist/packages/config/src/index.js';

const node = {
  name: 'Legacy Node',
  baseUrl: 'https://legacy.example/v1',
  key: 'test-key',
  enabled: true,
  models: ['legacy-model'],
  modelsFetchedAt: '2026-01-01T00:00:00.000Z',
};

test('config import v2: wrapper upgrades to v3 and keeps legacy values', () => {
  const raw = {
    version: 2,
    exportedAt: '2026-10-26T14:14:00.000Z',
    config: {
      panel: { port: 3021, passwordSeed: 'legacy-seed' },
      napcat: { wsUrl: 'ws://legacy-napcat:3001', token: 'legacy-token' },
      llm: {
        apiKeys: [node],
        chatNodeIndex: 0,
        chatModel: 'legacy-model',
        chatEnabled: true,
      },
      bot: {
        replyFormat: 'forward',
        persona: { enabled: true, name: 'Legacy Bot', systemPrompt: 'legacy persona' },
        groupContext: { enabled: true },
        autoContinue: { enabled: true },
      },
      orchestration: {
        suno: { enabled: true, baseUrl: 'https://suno.legacy.example', apiKey: 'legacy-suno-key' },
      },
    },
  };
  const imported = importConfig(raw);
  assert.equal(imported.sourceVersion, 2);
  assert.equal(imported.sourceFormat, 'export-wrapper-v2');
  assert.equal(imported.config.panel.port, 3021);
  assert.equal(imported.config.napcat.wsUrl, 'ws://legacy-napcat:3001');
  assert.equal(imported.config.llm.apiKeys.length, 1);
  assert.equal(imported.config.llm.chatModel, 'legacy-model');
  assert.equal(imported.config.bot.persona.name, 'Legacy Bot');
  assert.equal(imported.config.bot.groupContext.enabled, true);
  assert.equal(imported.config.bot.autoContinue.enabled, true);
  assert.equal(imported.config.orchestration.suno.baseUrl, 'https://suno.legacy.example');
  assert.equal(imported.config.agent.mode, 'enforce');
  assert.equal(imported.config.toolRegistry.enabled, true);
  assert.equal(imported.config.replyPolicy.enabled, true);

  const exported = exportConfig(imported.config);
  assert.equal(exported.version, CONFIG_SCHEMA_VERSION);
  const again = importConfig(exported);
  assert.equal(again.sourceFormat, 'export-wrapper-v3');
  assert.equal(again.config.llm.apiKeys.length, 1);
  assert.equal(again.config.llm.chatModel, 'legacy-model');
  assert.equal(again.config.bot.persona.name, 'Legacy Bot');
  assert.equal(again.config.agent.mode, 'enforce');
});
