import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CONFIG_MIGRATION_TABLE,
  CONFIG_SCHEMA_VERSION,
  createDefaultConfig,
  exportConfig,
  importConfig,
  normalizeConfig,
} from '../dist/packages/config/src/index.js';

const sampleNode = { name: 'Node A', baseUrl: 'http://localhost:8317/v1', key: 'test-key-a', enabled: true, models: ['gpt-4o-mini'], modelsFetchedAt: '2026-05-27T00:00:00.000Z' };

test('migration: imports bare legacy config object and preserves known fields', () => {
  const result = importConfig({
    panel: { port: 4090, passwordSeed: 'pw' },
    napcat: { wsUrl: 'ws://bot:3001', token: 'redacted-token-a' },
    llm: { apiKeys: [sampleNode], chatModel: 'gpt-4.1-mini' },
  });
  assert.equal(result.sourceFormat, 'bare-config');
  assert.equal(result.config.panel.port, 4090);
  assert.equal(result.config.napcat.wsUrl, 'ws://bot:3001');
  assert.equal(result.config.llm.apiKeys[0].name, 'Node A');
  assert.equal(result.config.llm.chatModel, 'gpt-4.1-mini');
});

test('migration: unwraps old export wrapper format', () => {
  const result = importConfig({ version: 1, exportedAt: '2026-05-27T00:00:00.000Z', config: { panel: { port: 3020 } } });
  assert.equal(result.sourceFormat, 'export-wrapper-v1');
  assert.equal(result.sourceVersion, 1);
  assert.equal(result.config.panel.port, 3020);
  assert.ok(result.migrations.some((item) => item.id === 'export-wrapper-v1.config-to-root'));
});

test('migration: missing sections are filled from defaults', () => {
  const config = normalizeConfig({});
  const defaults = createDefaultConfig();
  assert.equal(config.panel.port, defaults.panel.port);
  assert.equal(config.napcat.actionTimeoutMs, defaults.napcat.actionTimeoutMs);
  assert.equal(config.bot.commands.help, defaults.bot.commands.help);
  assert.equal(config.freeMode.maxOutputImages, defaults.freeMode.maxOutputImages);
});

test('migration: panel.password is renamed to panel.passwordSeed', () => {
  const result = importConfig({ panel: { password: 'legacy-test-password' } });
  assert.equal(result.config.panel.passwordSeed, 'legacy-test-password');
  assert.ok(result.migrations.some((item) => item.id === 'panel.password-to-passwordSeed'));
});

test('migration: napcat.websocketUrl is renamed to napcat.wsUrl', () => {
  const result = importConfig({ napcat: { websocketUrl: 'ws://legacy-host:3001' } });
  assert.equal(result.config.napcat.wsUrl, 'ws://legacy-host:3001');
  assert.ok(result.migrations.some((item) => item.id === 'napcat.websocketUrl-to-wsUrl'));
});

test('migration: llm.nodes is renamed to llm.apiKeys', () => {
  const result = importConfig({ llm: { nodes: [{ ...sampleNode, name: 'Legacy Node' }] } });
  assert.equal(result.config.llm.apiKeys[0].name, 'Legacy Node');
  assert.ok(result.migrations.some((item) => item.id === 'llm.nodes-to-apiKeys'));
});

test('migration: llm.apiNodes is renamed to llm.apiKeys', () => {
  const result = importConfig({ llm: { apiNodes: [{ ...sampleNode, name: 'API Node' }] } });
  assert.equal(result.config.llm.apiKeys[0].name, 'API Node');
  assert.ok(result.migrations.some((item) => item.id === 'llm.apiNodes-to-apiKeys'));
});

test('migration: legacy llm interrogate fields backfill canvas interrogate fields', () => {
  const result = importConfig({
    llm: {
      apiKeys: [sampleNode],
      interrogateNodeIndex: 0,
      interrogateModel: 'vision-model',
      interrogatePromptTemplate: 'describe {{image}}',
      interrogateTimeoutMs: 45678,
    },
  });
  assert.equal(result.config.canvas.interrogateModel, 'vision-model');
  assert.equal(result.config.canvas.interrogatePromptTemplate, 'describe {{image}}');
  assert.equal(result.config.canvas.interrogateTimeoutMs, 45678);
  assert.equal(result.config.canvas.interrogateTemplateTimeoutMs, 45678);
  assert.ok(result.migrations.some((item) => item.id === 'llm.interrogate-to-canvas.interrogate'));
});

test('migration: bot.replyFormat creates replyStrategies when missing', () => {
  const result = importConfig({ bot: { replyFormat: 'quote' } });
  assert.equal(result.config.bot.replyFormat, 'quote');
  assert.deepEqual(result.config.bot.replyStrategies, { text: 'quote', image: 'quote', multiImage: 'quote' });
  assert.ok(result.migrations.some((item) => item.id === 'bot.replyFormat-to-replyStrategies'));
});

test('migration: whitelist and blacklist legacy fields are renamed and normalized', () => {
  const result = importConfig({
    bot: {
      groupWhitelist: ['1000', '1000', ' 2000 '],
      privateWhitelist: '3000, 4000',
      blacklistUsers: ['5000', '', '6000'],
    },
  });
  assert.deepEqual(result.config.bot.whitelistGroups, ['1000', '2000']);
  assert.deepEqual(result.config.bot.whitelistPrivate, ['3000', '4000']);
  assert.deepEqual(result.config.bot.blacklistGroupUsers, ['5000', '6000']);
});

test('migration: bot.commands.draw is renamed to commands.genImage and imageCount is defaulted', () => {
  const result = importConfig({ bot: { commands: { draw: ['画图', 'draw'] } } });
  assert.equal(result.config.bot.commands.genImage, '画图, draw, 生图, 画');
  assert.equal(result.config.bot.commands.imageCount, 's');
  assert.ok(result.migrations.some((item) => item.id === 'bot.commands.draw-to-genImage'));
  assert.ok(result.migrations.some((item) => item.id === 'bot.commands.imageCount-default'));
});

test('migration: type errors are normalized without throwing', () => {
  const result = importConfig({
    panel: { port: '70000' },
    napcat: { actionTimeoutMs: '100' },
    bot: { textReply: { maxChars: '-10' }, imageCompression: { scale: 9, quality: -1 } },
    freeMode: { maxOutputImages: 99 },
  });
  assert.equal(result.config.panel.port, 65535);
  assert.equal(result.config.napcat.actionTimeoutMs, 3000);
  assert.equal(result.config.bot.textReply.maxChars, 0);
  assert.equal(result.config.bot.imageCompression.scale, 1);
  assert.equal(result.config.bot.imageCompression.quality, 1);
  assert.equal(result.config.freeMode.maxOutputImages, 4);
});

test('migration: bot owner and tts settings are normalized', () => {
  const result = importConfig({
    bot: {
      botQqId: ' 10000 ',
      ownerQQs: '10001，10001\n10002;10003',
      tts: {
        enabled: 'true',
        provider: 'bad-provider',
        apiUrl: ' https://tts.example/v1 ',
        apiKey: 'secret',
        model: '',
        voiceId: ' voice-a ',
        format: 'ogg',
        autoTextMaxChars: 99999,
        timeoutMs: 1,
        speed: 9,
        volume: -99,
        latency: 'turbo',
      },
    },
  });

  assert.equal(result.config.bot.botQqId, '10000');
  assert.deepEqual(result.config.bot.ownerQQs, ['10001', '10002', '10003']);
  assert.equal(result.config.bot.tts.enabled, true);
  assert.equal(result.config.bot.tts.provider, 'fish-audio');
  assert.equal(result.config.bot.tts.apiUrl, 'https://tts.example/v1');
  assert.equal(result.config.bot.tts.model, 's2-pro');
  assert.equal(result.config.bot.tts.voiceId, 'voice-a');
  assert.equal(result.config.bot.tts.format, 'mp3');
  assert.equal(result.config.bot.tts.autoTextMaxChars, 4000);
  assert.equal(result.config.bot.tts.timeoutMs, 5000);
  assert.equal(result.config.bot.tts.speed, 2);
  assert.equal(result.config.bot.tts.volume, -20);
  assert.equal(result.config.bot.tts.latency, 'normal');
});

test('migration: hugging face config and cached models are normalized', () => {
  const result = importConfig({
    huggingFace: {
      enabled: 'true',
      useForChat: 'true',
      token: ' hf-test-token ',
      selectedModelId: 'org/chat-model',
      selectedProvider: 'cerebras',
      requestMode: 'bad-mode',
      timeoutMs: 1,
      cacheTtlSeconds: 9999999,
      filters: {
        pipelineTag: 'image-text-to-text',
        inference: 'bad',
        gated: 'bad',
        sort: 'bad',
        direction: '1',
        limit: 999,
        onlyChatCompatible: 'false',
      },
      cachedModels: [{
        id: 'org/chat-model',
        downloads: '12',
        likes: '3',
        tags: 'chat,vision',
        pipeline_tag: 'text-generation',
      }],
    },
  });

  assert.equal(result.config.huggingFace.enabled, true);
  assert.equal(result.config.huggingFace.useForChat, true);
  assert.equal(result.config.huggingFace.token, 'hf-test-token');
  assert.equal(result.config.huggingFace.requestMode, 'openai-chat');
  assert.equal(result.config.huggingFace.timeoutMs, 5000);
  assert.equal(result.config.huggingFace.cacheTtlSeconds, 604800);
  assert.equal(result.config.huggingFace.filters.pipelineTag, 'image-text-to-text');
  assert.equal(result.config.huggingFace.filters.inference, 'warm');
  assert.equal(result.config.huggingFace.filters.gated, 'false');
  assert.equal(result.config.huggingFace.filters.sort, 'downloads');
  assert.equal(result.config.huggingFace.filters.direction, '1');
  assert.equal(result.config.huggingFace.filters.limit, 200);
  assert.equal(result.config.huggingFace.filters.onlyChatCompatible, false);
  assert.equal(result.config.huggingFace.cachedModels[0].code, 'hf.1');
  assert.equal(result.config.huggingFace.cachedModels[0].downloads, 12);
  assert.deepEqual(result.config.huggingFace.cachedModels[0].tags, ['chat', 'vision']);
});

test('migration: hugging face legacy snake_case sort names are converted for Hub API', () => {
  assert.equal(importConfig({ huggingFace: { filters: { sort: 'last_modified' } } }).config.huggingFace.filters.sort, 'lastModified');
  assert.equal(importConfig({ huggingFace: { filters: { sort: 'created_at' } } }).config.huggingFace.filters.sort, 'createdAt');
  assert.equal(importConfig({ huggingFace: { filters: { sort: 'trending_score' } } }).config.huggingFace.filters.sort, 'trendingScore');
});

test('migration: model node can split combined base url and key paste', () => {
  const result = importConfig({
    llm: {
      apiKeys: [{
        name: 'Any Router',
        baseUrl: 'https://anyrouter.top/v1-密钥sk-test123',
        key: '',
        enabled: true,
      }],
    },
  });

  assert.equal(result.config.llm.apiKeys[0].baseUrl, 'https://anyrouter.top/v1');
  assert.equal(result.config.llm.apiKeys[0].key, 'sk-test123');
});

test('migration: export adds version, exportedAt, and normalized config payload', () => {
  const exported = exportConfig({ panel: { port: '3033' } }, { exportedAt: '2026-05-27T12:00:00.000Z' });
  assert.equal(exported.version, CONFIG_SCHEMA_VERSION);
  assert.equal(exported.exportedAt, '2026-05-27T12:00:00.000Z');
  assert.equal(exported.config.panel.port, 3033);
  assert.equal(exported.config.napcat.wsUrl, createDefaultConfig().napcat.wsUrl);
});

test('migration: exported v2 wrapper can be imported again', () => {
  const exported = exportConfig({ bot: { replyStrategies: { text: 'plain', image: 'forward', multiImage: 'quote' } } }, { exportedAt: '2026-05-27T12:00:00.000Z' });
  const result = importConfig(exported);
  assert.equal(result.sourceFormat, 'export-wrapper-v2');
  assert.equal(result.config.bot.replyStrategies.text, 'plain');
  assert.equal(result.config.bot.replyStrategies.multiImage, 'quote');
});

test('migration: table documents all field rename rules used by P3', () => {
  const ids = new Set(CONFIG_MIGRATION_TABLE.map((item) => item.id));
  assert.ok(ids.has('panel.password-to-passwordSeed'));
  assert.ok(ids.has('napcat.websocketUrl-to-wsUrl'));
  assert.ok(ids.has('llm.nodes-to-apiKeys'));
  assert.ok(ids.has('llm.interrogate-to-canvas.interrogate'));
  assert.ok(ids.has('bot.replyFormat-to-replyStrategies'));
  assert.ok(CONFIG_MIGRATION_TABLE.length >= 10);
});
