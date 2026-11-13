import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeConfig,
  createDefaultConfig,
  importConfig,
  exportConfig,
} from '../dist/packages/config/src/index.js';

const ENV_KEYS = ['MIOBOT_ONEBOT_BACKEND', 'MIOBOT_ONEBOT_WS_URL', 'MIOBOT_ONEBOT_TOKEN'];

function clearEnv() {
  for (const key of ENV_KEYS) delete process.env[key];
}

test('miohh adapter: 默认 backend 为 napcat（向后兼容）', () => {
  clearEnv();
  const config = createDefaultConfig();
  assert.equal(config.napcat.backend, 'napcat');
});

test('miohh adapter: 环境变量覆盖 backend/wsUrl/token', () => {
  clearEnv();
  process.env.MIOBOT_ONEBOT_BACKEND = 'miohh';
  process.env.MIOBOT_ONEBOT_WS_URL = 'ws://127.0.0.1:3001';
  process.env.MIOBOT_ONEBOT_TOKEN = 'test-token';
  try {
    const config = normalizeConfig({});
    assert.equal(config.napcat.backend, 'miohh');
    assert.equal(config.napcat.wsUrl, 'ws://127.0.0.1:3001');
    assert.equal(config.napcat.token, 'test-token');
  } finally {
    clearEnv();
  }
});

test('miohh adapter: 旧变量名 MIOBOT_NAPCAT_* 兼容', () => {
  clearEnv();
  process.env.MIOBOT_NAPCAT_WS_URL = 'ws://127.0.0.1:3001';
  process.env.MIOBOT_NAPCAT_TOKEN = 'legacy-token';
  try {
    const config = normalizeConfig({});
    assert.equal(config.napcat.wsUrl, 'ws://127.0.0.1:3001');
    assert.equal(config.napcat.token, 'legacy-token');
  } finally {
    clearEnv();
  }
});

test('miohh adapter: 配置内 backend=miohh 可持久化/导入导出', () => {
  clearEnv();
  const imported = importConfig({
    napcat: {
      backend: 'miohh',
      wsUrl: 'ws://127.0.0.1:3001',
      token: 'abc',
      mountOutputDir: '/var/lib/miobot/out',
      mountOutputContainerDir: '/var/lib/miobot/out',
    },
  }).config;
  assert.equal(imported.napcat.backend, 'miohh');
  assert.equal(imported.napcat.wsUrl, 'ws://127.0.0.1:3001');
  assert.equal(imported.napcat.mountOutputDir, '/var/lib/miobot/out');

  const exported = exportConfig(imported);
  assert.equal(exported.config.napcat.backend, 'miohh');
  const again = importConfig(exported.config).config;
  assert.equal(again.napcat.backend, 'miohh');
});

test('miohh adapter: 非法 backend 回落 napcat', () => {
  clearEnv();
  const config = normalizeConfig({ napcat: { backend: 'unknown-backend' } });
  assert.equal(config.napcat.backend, 'napcat');
});
