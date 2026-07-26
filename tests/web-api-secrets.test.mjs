import test from 'node:test';
import assert from 'node:assert/strict';

import { ConfigRepository, WebApi, derivePanelToken } from '../dist/packages/web-api/src/index.js';
import { maskSecretValue } from '../dist/packages/web-api/src/secrets.js';

/**
 * 密钥打码往返。
 * 关键性质：面板全程只看到打码值，而「原样提交回来」绝不能把真实密钥写没。
 */

function makeConfig() {
  return {
    panel: { port: 3018, passwordSeed: 'super-secret-password' },
    napcat: { wsUrl: 'ws://127.0.0.1:3001', token: 'napcat-token-value' },
    promptsChat: { apiKey: 'prompts-api-key-value' },
    llm: {
      chatModel: 'gpt-4o',
      apiKeys: [
        { name: 'A', baseUrl: 'https://a.example.com/v1', key: 'sk-real-key-aaaaaaaa1234' },
        { name: 'B', baseUrl: 'https://b.example.com/v1', key: 'sk-real-key-bbbbbbbb5678' },
        { name: 'C', baseUrl: 'https://c.example.com/v1', key: '' },
      ],
    },
  };
}

function makeApi() {
  const repository = new ConfigRepository({ initialConfig: makeConfig() });
  const api = new WebApi({ repository });
  const token = derivePanelToken(repository.getConfig().panel.passwordSeed);
  const auth = { authorization: `Bearer ${token}` };
  return { api, repository, auth };
}

test('打码: 保留头尾便于辨认, 中间隐藏', () => {
  const masked = maskSecretValue('sk-real-key-aaaaaaaa1234');
  assert.ok(masked.includes('••••'));
  assert.ok(masked.endsWith('1234'));
  assert.ok(!masked.includes('real-key'));
  assert.equal(maskSecretValue(''), '');
  assert.equal(maskSecretValue('abc'), '••••••••');
});

test('GET /api/config 不再明文回传任何密钥', async () => {
  const { api, auth } = makeApi();
  const res = await api.handle({ method: 'GET', path: '/api/config', headers: auth });
  const text = JSON.stringify(res.body.config);

  assert.ok(!text.includes('sk-real-key-aaaaaaaa1234'), '节点密钥不应明文出现');
  assert.ok(!text.includes('sk-real-key-bbbbbbbb5678'));
  assert.ok(!text.includes('super-secret-password'), '面板密码不应明文出现');
  assert.ok(!text.includes('napcat-token-value'));
  assert.ok(!text.includes('prompts-api-key-value'));

  // 非密钥字段不受影响
  assert.equal(res.body.config.llm.chatModel, 'gpt-4o');
  assert.equal(res.body.config.napcat.wsUrl, 'ws://127.0.0.1:3001');
  // 用 hasKey 告诉前端这个节点有没有密钥
  assert.equal(res.body.config.llm.apiKeys[0].hasKey, true);
  assert.equal(res.body.config.llm.apiKeys[2].hasKey, false);
});

test('内部消费者仍拿到真实密钥（bot 运行时要用它调上游）', () => {
  const { repository } = makeApi();
  assert.equal(repository.getConfig().llm.apiKeys[0].key, 'sk-real-key-aaaaaaaa1234');
  assert.equal(repository.getConfig().panel.passwordSeed, 'super-secret-password');
});

test('原样回存: 真实密钥保持不变', async () => {
  const { api, repository, auth } = makeApi();
  const read = await api.handle({ method: 'GET', path: '/api/config', headers: auth });

  const submitted = JSON.parse(JSON.stringify(read.body.config));
  submitted.llm.chatModel = 'gpt-4o-mini'; // 只改了别的字段
  await api.handle({ method: 'POST', path: '/api/config', headers: auth, body: submitted });

  const stored = repository.getConfig();
  assert.equal(stored.llm.apiKeys[0].key, 'sk-real-key-aaaaaaaa1234', '密钥不能被打码值覆盖');
  assert.equal(stored.llm.apiKeys[1].key, 'sk-real-key-bbbbbbbb5678');
  assert.equal(stored.panel.passwordSeed, 'super-secret-password');
  assert.equal(stored.napcat.token, 'napcat-token-value');
  assert.equal(stored.llm.chatModel, 'gpt-4o-mini', '真正修改的字段要生效');
});

test('用户输入新密钥时按新值保存', async () => {
  const { api, repository, auth } = makeApi();
  const read = await api.handle({ method: 'GET', path: '/api/config', headers: auth });

  const submitted = JSON.parse(JSON.stringify(read.body.config));
  submitted.llm.apiKeys[0].key = 'sk-brand-new-key';
  await api.handle({ method: 'POST', path: '/api/config', headers: auth, body: submitted });

  const stored = repository.getConfig();
  assert.equal(stored.llm.apiKeys[0].key, 'sk-brand-new-key');
  assert.equal(stored.llm.apiKeys[1].key, 'sk-real-key-bbbbbbbb5678', '没改的那个保持原值');
});

test('清空密钥的意图会被保留', async () => {
  const { api, repository, auth } = makeApi();
  const read = await api.handle({ method: 'GET', path: '/api/config', headers: auth });

  const submitted = JSON.parse(JSON.stringify(read.body.config));
  submitted.napcat.token = '';
  await api.handle({ method: 'POST', path: '/api/config', headers: auth, body: submitted });

  assert.equal(repository.getConfig().napcat.token, '');
});

test('保存响应与登录响应同样不含明文密钥', async () => {
  const { api, auth } = makeApi();
  const saved = await api.handle({ method: 'POST', path: '/api/config', headers: auth, body: { llm: { chatModel: 'gpt-4o' } } });
  assert.ok(!JSON.stringify(saved.body.config).includes('sk-real-key-aaaaaaaa1234'));

  const login = await api.handle({ method: 'POST', path: '/api/login', body: { password: 'super-secret-password' } });
  assert.ok(!JSON.stringify(login.body.config).includes('sk-real-key-aaaaaaaa1234'));
});

test('导出仍保留真实密钥（备份必须可还原）', async () => {
  const { api, auth } = makeApi();
  const res = await api.handle({ method: 'GET', path: '/api/config/export', headers: auth });
  assert.ok(JSON.stringify(res.body.export).includes('sk-real-key-aaaaaaaa1234'), '导出是备份用途，需要真实密钥');
});

test('导入打码过的配置不会把密钥写坏', async () => {
  const { api, repository, auth } = makeApi();
  const read = await api.handle({ method: 'GET', path: '/api/config', headers: auth });
  await api.handle({ method: 'POST', path: '/api/config/import', headers: auth, body: { config: read.body.config } });
  assert.equal(repository.getConfig().llm.apiKeys[0].key, 'sk-real-key-aaaaaaaa1234');
});
