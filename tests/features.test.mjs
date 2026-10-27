import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FEATURE_DEFINITIONS,
  defaultFeatureSettings,
  featureAliasCollisions,
  normalizeFeatureSettings,
} from '../dist/packages/shared/src/features.js';
import { importConfig, normalizeConfig } from '../dist/packages/config/src/index.js';
import { routeBotMessage } from '../dist/packages/bot-router/src/index.js';
import { createAdminService } from '../dist/packages/admin-service/src/index.js';
import { toModelNodes } from '../dist/apps/bot/src/config-bridge.js';
import { sanitizeModelImageReferences } from '../dist/apps/bot/src/deps.js';

test('features: every catalog entry has a stable setting and unimplemented features stay disabled', () => {
  const defaults = defaultFeatureSettings();
  assert.equal(Object.keys(defaults).length, FEATURE_DEFINITIONS.length);
  for (const def of FEATURE_DEFINITIONS) {
    assert.ok(defaults[def.id], `missing default setting for ${def.id}`);
    assert.equal(defaults[def.id].enabled, def.implemented);
  }
  const migrated = normalizeFeatureSettings({
    'image.original': { enabled: true, aliases: ['原图'] },
  });
  assert.equal(migrated['image.original'].enabled, false);
});

test('features: legacy command aliases migrate into image.generate', () => {
  const result = importConfig({ bot: { commands: { genImage: '画画, imagine, 创作图' } } });
  const config = result.config;
  assert.ok(result.migrations.some((item) => item.id === 'bot.commands-to-features'));
  const aliases = config.bot.features['image.generate'].aliases;
  assert.ok(aliases.includes('创作图'));
  assert.ok(aliases.includes('imagine'));
  assert.ok(aliases.includes('画画'));
  assert.equal(aliases[0], 'imagine');
  assert.equal(config.bot.features.help.enabled, true);
});

test('features: alias collisions are reported only for enabled features', () => {
  const settings = defaultFeatureSettings();
  settings.help.aliases = ['same'];
  settings.clear.aliases = ['same'];
  settings.clear.enabled = true;
  assert.deepEqual(featureAliasCollisions(settings), [{ alias: 'same', featureIds: ['help', 'clear'] }]);
  settings.clear.enabled = false;
  assert.deepEqual(featureAliasCollisions(settings), []);
});

const featureCommands = [
  { id: 'help', command: 'help', aliases: ['help'], scopes: ['group', 'private'], groupActivation: 'direct' },
  { id: 'image.generate', command: 'genImage', aliases: ['draw', '画'], scopes: ['group', 'private'], groupActivation: 'mention-or-reply' },
];

function routerConfig(overrides = {}) {
  return {
    botId: '10000',
    botAliases: ['@bot'],
    commands: { genImage: 'draw, 画', help: 'help' },
    features: featureCommands,
    triggerModes: { mention: true, replyToBot: true },
    freeModeEnabled: true,
    chatEnabled: true,
    ...overrides,
  };
}

test('features: explicit command honors group activation and private scope', () => {
  const groupMention = routeBotMessage(
    { chatType: 'group', rawMessage: '[CQ:at,qq=10000] draw a cat', groupId: '1', userId: '2' },
    routerConfig(),
  );
  assert.equal(groupMention.kind, 'command');
  assert.equal(groupMention.command, 'genImage');
  assert.equal(groupMention.metadata.featureId, 'image.generate');

  const direct = routeBotMessage(
    { chatType: 'group', rawMessage: 'help', groupId: '1', userId: '2' },
    routerConfig(),
  );
  assert.equal(direct.kind, 'command');
  assert.equal(direct.command, 'help');

  const noMention = routeBotMessage(
    { chatType: 'group', rawMessage: 'draw a cat', groupId: '1', userId: '2' },
    routerConfig(),
  );
  assert.equal(noMention.kind, 'ignored');
  assert.equal(noMention.reason, 'group-not-triggered');

  const privateMessage = routeBotMessage(
    { chatType: 'private', rawMessage: 'draw a cat', userId: '2' },
    routerConfig(),
  );
  assert.equal(privateMessage.kind, 'command');
  assert.equal(privateMessage.command, 'genImage');
});


test('features: an explicitly empty feature list does not fall back to legacy commands', () => {
  const groupHelp = routeBotMessage(
    { chatType: 'group', rawMessage: 'help', groupId: '1', userId: '2' },
    routerConfig({ features: [] }),
  );
  assert.equal(groupHelp.kind, 'ignored');
  assert.equal(groupHelp.reason, 'group-not-triggered');

  const privateHelp = routeBotMessage(
    { chatType: 'private', rawMessage: 'help', userId: '2' },
    routerConfig({ features: [] }),
  );
  assert.notEqual(privateHelp.kind, 'command');
});


test('admin api: feature catalog is exposed with dynamic settings', async () => {
  const service = createAdminService({ initialConfig: normalizeConfig({}) });
  const res = await service.handle({
    method: 'GET',
    path: '/api/features',
    headers: { authorization: `Bearer ${service.repository.getAuthSnapshot(false).token}` },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.ok(Array.isArray(res.body.definitions));
  assert.ok(res.body.definitions.some((item) => item.id === 'image.generate'));
  assert.deepEqual(res.body.settings['image.generate'].aliases.length > 0, true);
  assert.deepEqual(res.body.collisions, []);
});


test('api node headers: apiKey/env templates expand before request', () => {
  const config = normalizeConfig({});
  config.llm.apiKeys[0].key = 'secret-key';
  config.llm.apiKeys[0].headers = { Authorization: 'Bearer {{apiKey}}', 'X-Test-Env': '{{env:MIOTEST_HEADER_VALUE}}', 'X-None': '{{env:MIOTEST_MISSING_VALUE}}' };
  process.env.MIOTEST_HEADER_VALUE = 'env-value';
  const nodes = toModelNodes(config);
  assert.equal(nodes[0].headers.Authorization, 'Bearer secret-key');
  assert.equal(nodes[0].headers['X-Test-Env'], 'env-value');
  assert.equal(nodes[0].headers['X-None'], undefined);
  delete process.env.MIOTEST_HEADER_VALUE;
});


test('model image sanitizer: never forwards QQ CDN or local refs upstream', () => {
  const result = sanitizeModelImageReferences([
    'data:image/png;base64,AAAA',
    'https://gchat.qpic.cn/download?rkey=secret',
    'https://example.com/public.png',
    '2F4E9D49282C5B22757A249618A7AE95.jpg',
    'base64://AAAA',
  ]);
  assert.deepEqual(result.images, ['data:image/png;base64,AAAA', 'https://example.com/public.png']);
  assert.equal(result.dropped, 3);
});


test('admin api: search test endpoint is wired through injected dependency', async () => {
  const service = createAdminService({
    initialConfig: normalizeConfig({}),
    deps: {
      testSearch: async () => ({ status: 200, body: { success: true, response: { provider: 'deepseek', results: [] } } }),
    },
  });
  const res = await service.handle({
    method: 'POST',
    path: '/api/search/test',
    headers: { authorization: `Bearer ${service.repository.getAuthSnapshot(false).token}` },
    body: { query: 'test' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.response.provider, 'deepseek');
});
