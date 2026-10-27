import test from 'node:test';
import assert from 'node:assert/strict';
import { createWebApi } from '../dist/packages/web-api/src/index.js';

test('admin R7: config schema endpoint exposes v3 field metadata and migrations', async () => {
  const api = createWebApi();
  const login = await api.handle({ method: 'POST', path: '/api/login', body: { password: 'change-me-on-first-login' } });
  assert.equal(login.status, 200);
  const token = login.body.auth.token;
  const response = await api.handle({
    method: 'GET',
    path: '/api/config/schema',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.success, true);
  assert.equal(response.body.schemaVersion, 3);
  const keys = response.body.fields.map((field) => field.key);
  assert.ok(keys.includes('agent.enabled'));
  assert.ok(keys.includes('agent.mode'));
  assert.ok(keys.includes('toolRegistry.enabled'));
  assert.ok(keys.includes('replyPolicy.hardMaxMessages'));
  assert.ok(keys.includes('replyPolicy.audioDirectOnly'));
  assert.ok(keys.includes('contextPolicy.historyMaxRounds'));
  assert.ok(Array.isArray(response.body.migrations));
  assert.ok(response.body.migrations.length > 0);
});

test('admin R7: v3 runtime sections persist and normalize through config API', async () => {
  const api = createWebApi();
  const login = await api.handle({ method: 'POST', path: '/api/login', body: { password: 'change-me-on-first-login' } });
  const headers = { authorization: `Bearer ${login.body.auth.token}` };
  const saved = await api.handle({
    method: 'POST',
    path: '/api/config',
    headers,
    body: {
      agent: { enabled: true, mode: 'shadow', maxModelRounds: 5 },
      toolRegistry: { enabled: true, maxToolsPerTurn: 12 },
      replyPolicy: { enabled: true, hardMaxMessages: 4, hardMaxChars: 1500 },
      contextPolicy: { historyMaxRounds: 6, memoryTopK: 5 },
    },
  });
  assert.equal(saved.status, 200);
  const loaded = await api.handle({ method: 'GET', path: '/api/config', headers });
  assert.equal(loaded.status, 200);
  assert.equal(loaded.body.config.agent.enabled, true);
  assert.equal(loaded.body.config.agent.mode, 'shadow');
  assert.equal(loaded.body.config.agent.maxModelRounds, 5);
  assert.equal(loaded.body.config.toolRegistry.enabled, true);
  assert.equal(loaded.body.config.toolRegistry.maxToolsPerTurn, 12);
  assert.equal(loaded.body.config.replyPolicy.enabled, true);
  assert.equal(loaded.body.config.replyPolicy.hardMaxMessages, 4);
  assert.equal(loaded.body.config.replyPolicy.audioDirectOnly, true);
  assert.equal(loaded.body.config.contextPolicy.historyMaxRounds, 6);
  assert.equal(loaded.body.config.contextPolicy.memoryTopK, 5);
});

test('admin R7b: schema v3 export is current and v2 wrappers remain importable', async () => {
  const { CONFIG_SCHEMA_VERSION, createDefaultConfig, exportConfig, importConfig } = await import('../dist/packages/config/src/index.js');
  assert.equal(CONFIG_SCHEMA_VERSION, 3);
  const cfg = createDefaultConfig();
  const exported = exportConfig(cfg);
  assert.equal(exported.version, 3);
  const roundTrip = importConfig(exported);
  assert.equal(roundTrip.sourceFormat, 'export-wrapper-v3');
  const legacyV2 = importConfig({ version: 2, config: { panel: { passwordSeed: 'legacy' } } });
  assert.equal(legacyV2.sourceFormat, 'export-wrapper-v2');
  assert.equal(legacyV2.config.panel.passwordSeed, 'legacy');
  // P0-1 修复：v2 legacy 包装迁移后 Agent 直接可用（enforce/enabled），audio/file 直发不可关。
  assert.equal(legacyV2.config.agent.enabled, true);
  assert.equal(legacyV2.config.agent.mode, 'enforce');
  assert.equal(legacyV2.config.replyPolicy.audioDirectOnly, true);
});