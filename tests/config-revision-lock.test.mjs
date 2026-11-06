import test from 'node:test';
import assert from 'node:assert/strict';

import { ConfigRepository, WebApi, derivePanelToken } from '../dist/packages/web-api/src/index.js';

/**
 * POST /api/config 乐观锁（2026-11-06 收敛批次）：
 * 提示词注册表 / 导入 / 回滚等旁路保存会直接递增服务端 revision；
 * 面板携带陈旧快照 revision 提交必须被 409 拒绝，否则 deepMerge 会把
 * 旁路改动（典型：注册表刚改的提示词）悄悄覆盖回旧值。
 */

function makeApi() {
  const repository = new ConfigRepository({
    initialConfig: {
      panel: { port: 3018, passwordSeed: 'lock-test-password' },
      napcat: { wsUrl: 'ws://127.0.0.1:3001', token: 'tok' },
      llm: { chatModel: 'gpt-4o', apiKeys: [{ name: 'A', baseUrl: 'http://a', key: 'sk-real-key-zzzz1234', enabled: true, models: ['gpt-4o'], modelsFetchedAt: '' }] },
    },
  });
  const api = new WebApi({ repository });
  const token = derivePanelToken(repository.getConfig().panel.passwordSeed);
  const auth = { authorization: `Bearer ${token}` };
  return { api, repository, auth };
}

test('revision 乐观锁: 陈旧 revision 的包装提交被 409 拒绝且配置不变', async () => {
  const { api, repository, auth } = makeApi();
  const current = repository.revision;
  const masked = repository.getMaskedConfig();
  masked.bot = { ...(masked.bot || {}), textReply: { maxChars: 1800, splitDelayMs: 1, showPartPrefix: true } };

  const res = await api.handle({
    method: 'POST', path: '/api/config', headers: auth,
    body: { revision: current - 1, config: masked },
  });
  assert.equal(res.status, 409, `期望 409，实际 ${res.status}`);
  assert.match(res.body.error, /配置已被其他入口修改/);
  assert.equal(repository.revision, current, '被拒绝的提交不应递增 revision');
  assert.equal(repository.getConfig().bot?.textReply?.maxChars ?? 1800, 1800, '被拒绝的提交不应写入配置');
});

test('revision 乐观锁: revision 匹配的包装提交正常保存并递增', async () => {
  const { api, repository, auth } = makeApi();
  const current = repository.revision;
  const masked = repository.getMaskedConfig();
  masked.bot = { ...(masked.bot || {}), textReply: { maxChars: 2500, splitDelayMs: 800, showPartPrefix: true } };

  const res = await api.handle({
    method: 'POST', path: '/api/config', headers: auth,
    body: { revision: current, config: masked },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.revision, current + 1);
  assert.equal(repository.getConfig().bot.textReply.maxChars, 2500);
  // 密钥往返不因包装体损坏
  assert.equal(repository.getConfig().llm.apiKeys[0].key, 'sk-real-key-zzzz1234');
});

test('revision 乐观锁: 裸配置体（旧调用方）不校验 revision 仍可保存', async () => {
  const { api, repository, auth } = makeApi();
  const masked = repository.getMaskedConfig();
  masked.bot = { ...(masked.bot || {}), textReply: { maxChars: 3000, splitDelayMs: 800, showPartPrefix: true } };

  const res = await api.handle({ method: 'POST', path: '/api/config', headers: auth, body: masked });
  assert.equal(res.status, 200, `期望 200，实际 ${res.status}`);
  assert.equal(repository.getConfig().bot.textReply.maxChars, 3000);
});

test('revision 乐观锁: 旁路保存后面板旧快照再提交被拒（防回滚场景）', async () => {
  const { api, repository, auth } = makeApi();
  // 面板基于 r1 拿到快照
  const panelSnapshot = repository.getMaskedConfig();
  const panelRevision = repository.revision;
  // 旁路入口（提示词注册表等）直接改提示词并保存 → revision 递增
  const cfg = repository.getConfig();
  cfg.bot.tts.preprocess.promptTemplate = '注册表刚改的提示词';
  repository.saveConfig(cfg);
  assert.equal(repository.revision, panelRevision + 1);

  // 面板拿着旧快照（还是老提示词）保存任何字段 → 必须被拒绝，防止把注册表改动覆盖回旧值
  panelSnapshot.bot.textReply = { maxChars: 2100, splitDelayMs: 800, showPartPrefix: true };
  const res = await api.handle({
    method: 'POST', path: '/api/config', headers: auth,
    body: { revision: panelRevision, config: panelSnapshot },
  });
  assert.equal(res.status, 409);
  assert.equal(repository.getConfig().bot.tts.preprocess.promptTemplate, '注册表刚改的提示词', '注册表改动不应被旧快照回滚');
});
