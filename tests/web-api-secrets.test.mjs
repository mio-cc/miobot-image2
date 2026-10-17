import test from 'node:test';
import assert from 'node:assert/strict';

import { ConfigRepository, WebApi, createConfigRepository, derivePanelToken } from '../dist/packages/web-api/src/index.js';
import { findUnresolvedSecrets, maskConfigSecrets, maskSecretValue, unmaskConfigSecrets } from '../dist/packages/web-api/src/secrets.js';

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

/* ── 删/移动节点后的密钥保全（复查确认的高危缺陷） ────────────────── */

test('删掉中间节点再保存，其余节点的真实密钥不受影响', () => {
  const repo = createConfigRepository({
    initialConfig: {
      panel: { passwordSeed: 'seed-value-1234' },
      llm: {
        apiKeys: [
          { name: 'n0', baseUrl: 'https://a/v1', key: 'sk-aaaaaaaaaaaa1111' },
          { name: 'n1', baseUrl: 'https://b/v1', key: 'sk-bbbbbbbbbbbb2222' },
          { name: 'n2', baseUrl: 'https://c/v1', key: 'sk-cccccccccccc3333' },
        ],
      },
    },
  });

  // 面板拿到的是打码版
  const masked = repo.getMaskedConfig();
  assert.ok(masked.llm.apiKeys.every((n) => n.key.includes('••••')), '面板不该拿到明文');

  // 用户删掉第 0 个节点（面板就是 splice），把剩下的原样提交回来
  const submitted = JSON.parse(JSON.stringify(masked));
  submitted.llm.apiKeys.splice(0, 1);
  repo.saveConfig(submitted);

  const after = repo.getConfig();
  assert.equal(after.llm.apiKeys.length, 2);
  assert.equal(after.llm.apiKeys[0].key, 'sk-bbbbbbbbbbbb2222', 'n1 的密钥必须原样保留');
  assert.equal(after.llm.apiKeys[1].key, 'sk-cccccccccccc3333', 'n2 的密钥必须原样保留');
  assert.ok(!after.llm.apiKeys.some((n) => n.key.includes('••••')), '不能把圆点串写进配置');
});

test('节点重排后密钥跟着节点走，不会张冠李戴', () => {
  const repo = createConfigRepository({
    initialConfig: {
      llm: {
        apiKeys: [
          { name: 'n0', baseUrl: 'https://a/v1', key: 'sk-aaaaaaaaaaaa1111' },
          { name: 'n1', baseUrl: 'https://b/v1', key: 'sk-bbbbbbbbbbbb2222' },
        ],
      },
    },
  });

  const submitted = JSON.parse(JSON.stringify(repo.getMaskedConfig()));
  submitted.llm.apiKeys.reverse();
  repo.saveConfig(submitted);

  const after = repo.getConfig();
  assert.equal(after.llm.apiKeys[0].name, 'n1');
  assert.equal(after.llm.apiKeys[0].key, 'sk-bbbbbbbbbbbb2222', '密钥要跟着节点走');
  assert.equal(after.llm.apiKeys[1].key, 'sk-aaaaaaaaaaaa1111');
});

test('新增节点填了真密钥，旧节点不受影响', () => {
  const repo = createConfigRepository({
    initialConfig: { llm: { apiKeys: [{ name: 'n0', baseUrl: 'https://a/v1', key: 'sk-aaaaaaaaaaaa1111' }] } },
  });
  const submitted = JSON.parse(JSON.stringify(repo.getMaskedConfig()));
  submitted.llm.apiKeys.push({ name: 'new', baseUrl: 'https://n/v1', key: 'sk-newnewnewnew9999', enabled: true, models: [] });
  repo.saveConfig(submitted);

  const after = repo.getConfig();
  assert.equal(after.llm.apiKeys[0].key, 'sk-aaaaaaaaaaaa1111');
  assert.equal(after.llm.apiKeys[1].key, 'sk-newnewnewnew9999');
});

test('导入别处打码过的配置：整份拒绝，不写坏本机凭据', () => {
  const repo = createConfigRepository({
    initialConfig: {
      panel: { passwordSeed: 'my-real-password' },
      napcat: { wsUrl: 'ws://localhost:3001', token: 'my-real-napcat-token' },
      llm: { apiKeys: [{ name: 'n0', baseUrl: 'https://a/v1', key: 'sk-my-real-key-1111' }] },
    },
  });

  // 别人机器上导出的配置：圆点串对不上本机任何旧值
  const foreign = {
    config: {
      panel: { passwordSeed: 'his••••••••word' },
      napcat: { wsUrl: 'ws://other:3001', token: 'his••••••••oken' },
      llm: { apiKeys: [{ name: 'theirs', baseUrl: 'https://x/v1', key: 'sk-••••••••9999' }] },
    },
  };

  assert.throws(() => repo.importAndSave(foreign), /仍是打码值/);

  const after = repo.getConfig();
  assert.equal(after.panel.passwordSeed, 'my-real-password', '本机面板密码不能被圆点覆盖');
  assert.equal(after.napcat.token, 'my-real-napcat-token');
  assert.equal(after.llm.apiKeys[0].key, 'sk-my-real-key-1111');
});

test('findUnresolvedSecrets 指名道姓地列出问题字段', () => {
  const bad = findUnresolvedSecrets({
    panel: { passwordSeed: 'aaa••••••••bbb' },
    llm: { apiKeys: [{ name: '好用的中转', key: 'sk-••••••••1234' }, { name: 'ok', key: 'sk-real' }] },
  });
  assert.ok(bad.some((x) => x.includes('panel.passwordSeed')));
  assert.ok(bad.some((x) => x.includes('好用的中转')), '要带上节点名，用户才知道去哪改');
  assert.equal(bad.length, 2);
});

/* ── 打码口子（捞验证确认：HF token 与导入响应绕过了打码） ────────────── */

test('huggingFace.token 也要打码', () => {
  const repo = createConfigRepository({
    initialConfig: { huggingFace: { token: 'hf_realtokenvalue1234' } },
  });
  const masked = repo.getMaskedConfig();
  assert.ok(masked.huggingFace.token.includes('••••'), 'HF token 不能明文发给浏览器');
  assert.equal(repo.getConfig().huggingFace.token, 'hf_realtokenvalue1234', '内部消费者仍要拿真值');

  // 原样提交回来不能把真 token 写坏
  repo.saveConfig(JSON.parse(JSON.stringify(masked)));
  assert.equal(repo.getConfig().huggingFace.token, 'hf_realtokenvalue1234');
});

test('导入接口的响应体里不能出现任何明文凭据', () => {
  const repo = createConfigRepository({
    initialConfig: {
      panel: { passwordSeed: 'my-real-password-1234' },
      napcat: { wsUrl: 'ws://localhost:3001', token: 'napcat-real-token-9876' },
      huggingFace: { token: 'hf_realtokenvalue1234' },
      llm: { apiKeys: [{ name: 'n0', baseUrl: 'https://a/v1', key: 'sk-real-key-abcdefgh' }] },
    },
  });

  // 导入一份新配置（带真实凭据，模拟本机导出的备份）
  const result = repo.importAndSave({
    config: {
      panel: { passwordSeed: 'imported-password-5555' },
      napcat: { wsUrl: 'ws://localhost:3001', token: 'imported-napcat-7777' },
      huggingFace: { token: 'hf_importedtoken8888' },
      llm: { apiKeys: [{ name: 'n0', baseUrl: 'https://b/v1', key: 'sk-imported-key-9999' }] },
    },
  });

  const wire = JSON.stringify(result);
  for (const secret of ['imported-password-5555', 'imported-napcat-7777', 'hf_importedtoken8888', 'sk-imported-key-9999']) {
    assert.ok(!wire.includes(secret), `响应体里出现了明文凭据：${secret}`);
  }
  assert.ok(result.importResult.config.panel.passwordSeed.includes('••••'), 'importResult.config 也必须是打码版');
  // 迁移信息要保留
  assert.ok(Array.isArray(result.importResult.migrations));

  // 真值确实写进去了
  assert.equal(repo.getConfig().panel.passwordSeed, 'imported-password-5555');
  assert.equal(repo.getConfig().huggingFace.token, 'hf_importedtoken8888');
});

test('默认密码的判断由后端下结论——前端拿到的是打码值，比不出来', () => {
  const fresh = createConfigRepository({});
  assert.equal(fresh.getAuthSnapshot().usingDefaultPassword, true, '全新部署必须报警');
  assert.ok(fresh.getMaskedConfig().panel.passwordSeed.includes('••••'),
    '前端手里的种子是打码的，它自己跟默认值永远不相等——所以这个判断只能由后端做');

  const changed = createConfigRepository({ initialConfig: { panel: { passwordSeed: '我改过了-longer-than-8' } } });
  assert.equal(changed.getAuthSnapshot().usingDefaultPassword, false);
});


test('secret mask: sensitive API node headers are masked and restored', () => {
  const config = makeConfig();
  config.llm.apiKeys[0].headers = { Authorization: 'Bearer header-secret-123456', 'X-Custom': 'plain-value' };
  const masked = maskConfigSecrets(config);
  assert.notEqual(masked.llm.apiKeys[0].headers.Authorization, 'Bearer header-secret-123456');
  assert.equal(masked.llm.apiKeys[0].headers['X-Custom'], 'plain-value');
  const restored = unmaskConfigSecrets(masked, config);
  assert.equal(restored.llm.apiKeys[0].headers.Authorization, 'Bearer header-secret-123456');
  assert.deepEqual(findUnresolvedSecrets(masked), []);
});


test('secret mask: search and jina keys are masked', () => {
  const config = makeConfig();
  config.search = { apiKey: 'search-secret-key-123456', jinaApiKey: 'jina-secret-key-123456' };
  const masked = maskConfigSecrets(config);
  assert.notEqual(masked.search.apiKey, config.search.apiKey);
  assert.notEqual(masked.search.jinaApiKey, config.search.jinaApiKey);
  const restored = unmaskConfigSecrets(masked, config);
  assert.equal(restored.search.apiKey, config.search.apiKey);
  assert.equal(restored.search.jinaApiKey, config.search.jinaApiKey);
});
