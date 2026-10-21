import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ConfigRepository,
  createWebApi,
  derivePanelToken,
} from '../dist/packages/web-api/src/index.js';
import {
  createPanelController,
  createPanelViewModel,
  reducePanelDraft,
  renderPanelShell,
} from '../dist/packages/web-panel/src/index.js';
import { renderPanelApp } from '../dist/apps/panel/src/main.js';

function clientFromApi(api) {
  async function request(method, path, token, body) {
    const response = await api.handle({
      method,
      path,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      body,
    });
    if (response.status !== 200) throw new Error(response.body?.error || `HTTP ${response.status}`);
    return response.body;
  }
  return {
    login(password) { return request('POST', '/api/login', undefined, { password }); },
    loadConfig(token) { return request('GET', '/api/config', token); },
    saveConfig(token, config) { return request('POST', '/api/config', token, config); },
    importConfig(token, payload) { return request('POST', '/api/config/import', token, payload); },
  };
}

const legacyConfigWithoutNewSections = {
  version: 1,
  config: {
    panel: { password: 'change-me-on-first-login' },
    napcat: { websocketUrl: 'ws://localhost:3001', token: 'redacted-napcat-token' },
    llm: {
      nodes: [{ name: 'legacy-node', baseUrl: 'http://localhost:8317/v1', key: 'test-key-legacy', enabled: true }],
      chatModel: 'gpt-4o-mini',
    },
    bot: {
      replyFormat: 'quote',
      groupWhitelist: ['1000'],
      commands: { draw: '画图' },
      promptTemplates: [{ id: 'legacy_tpl', title: 'Legacy', prompt: 'draw {{prompt}}' }],
    },
  },
};

test('web panel: legacy imported config missing freeMode/replyStrategies still renders', () => {
  const vm = createPanelViewModel(legacyConfigWithoutNewSections);
  assert.equal(vm.canRender, true);
  assert.equal(vm.sections.freeMode.ready, true);
  assert.equal(vm.sections.freeMode.data.enabled, false);
  assert.equal(vm.sections.replyStrategies.ready, true);
  assert.deepEqual(vm.sections.replyStrategies.data, { text: 'quote', image: 'quote', multiImage: 'quote', video: 'plain', multiVideo: 'forward', file: 'forward', multiFile: 'forward', mixed: 'forward' });
  assert.match(renderPanelShell(vm), /ready:freeMode/);
});

test('web api: import endpoint normalizes legacy wrapper and reports migrations', async () => {
  const api = createWebApi();
  const client = clientFromApi(api);
  const login = await client.login('change-me-on-first-login');
  const imported = await client.importConfig(login.auth.token, legacyConfigWithoutNewSections);
  assert.equal(imported.success, true);
  assert.equal(imported.config.freeMode.model, 'gpt-4o-mini');
  assert.equal(imported.config.bot.replyStrategies.text, 'quote');
  assert.equal(imported.config.bot.commands.genImage.includes('画图'), true);
  assert.ok(imported.importResult.migrations.some((item) => item.id === 'bot.replyFormat-to-replyStrategies'));
  assert.ok(imported.importResult.migrations.some((item) => item.id === 'panel.password-to-passwordSeed'));
});

test('web api: save emits hot reload event without restarting process', () => {
  const repo = new ConfigRepository({ now: () => new Date('2026-05-28T00:00:00.000Z') });
  const events = [];
  repo.onReload((event, config) => events.push({ event, config }));
  const saved = repo.saveConfig({ llm: { chatModel: 'gpt-4.1-mini' } });
  assert.equal(saved.success, true);
  assert.equal(saved.revision, 2);
  assert.equal(events.length, 1);
  assert.equal(events[0].event.reloadedAt, '2026-05-28T00:00:00.000Z');
  assert.equal(events[0].config.llm.chatModel, 'gpt-4.1-mini');
  assert.ok(saved.hotReload.changedPaths.includes('llm.chatModel'));
  assert.equal(saved.hotReload.napcatReconnectRequired, false);
});

test('web api: compact save response omits full config payload', async () => {
  const api = createWebApi();
  const client = clientFromApi(api);
  const login = await client.login('change-me-on-first-login');
  const response = await api.handle({
    method: 'POST',
    path: '/api/config?compact=1',
    headers: { authorization: `Bearer ${login.auth.token}` },
    body: { llm: { chatEnabled: false } },
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.success, true);
  assert.equal('config' in response.body, false);
  assert.ok(response.body.hotReload.changedPaths.includes('llm.chatEnabled'));
  assert.equal(response.body.auth.token, login.auth.token);
});

test('web api: napcat websocket/token changes are marked for hot reconnect', () => {
  const repo = new ConfigRepository();
  const saved = repo.saveConfig({ napcat: { wsUrl: 'ws://localhost:4000', token: 'redacted-new-token' } });
  assert.equal(saved.hotReload.napcatReconnectRequired, true);
  assert.ok(saved.hotReload.changedPaths.includes('napcat.wsUrl'));
  assert.ok(saved.hotReload.changedPaths.includes('napcat.token'));
});

test('web panel: passwordSeed save response refreshes frontend token automatically', async () => {
  const api = createWebApi();
  const controller = createPanelController(clientFromApi(api));
  const loggedIn = await controller.login('change-me-on-first-login');
  const oldToken = loggedIn.token;
  assert.equal(oldToken, derivePanelToken('change-me-on-first-login'));

  const saved = await controller.saveConfig({ panel: { passwordSeed: 'new-test-password' } });
  assert.equal(saved.lastError, undefined);
  assert.notEqual(saved.token, oldToken);
  assert.equal(saved.token, derivePanelToken('new-test-password'));
  assert.equal(saved.tokenVersion, 2);

  const oldAuth = await api.handle({ method: 'GET', path: '/api/config', headers: { authorization: `Bearer ${oldToken}` } });
  assert.equal(oldAuth.status, 401);
  const newAuth = await api.handle({ method: 'GET', path: '/api/config', headers: { authorization: `Bearer ${saved.token}` } });
  assert.equal(newAuth.status, 200);
});

test('web panel: controller import updates config, migrations, and render model', async () => {
  const api = createWebApi();
  const controller = createPanelController(clientFromApi(api));
  await controller.login('change-me-on-first-login');
  const state = await controller.importConfig(legacyConfigWithoutNewSections);
  assert.equal(state.lastError, undefined);
  assert.equal(state.viewModel.sections.replyStrategies.data.text, 'quote');
  assert.equal(state.viewModel.sections.templates.data.count, 1);
  assert.ok(state.migrations.some((item) => item.id === 'bot.commands.draw-to-genImage'));
});

test('web panel: draft reducer deep merges partial edits and keeps defaults', () => {
  const draft = reducePanelDraft(legacyConfigWithoutNewSections, { freeMode: { enabled: true }, bot: { replyStrategies: { image: 'plain' } } });
  assert.equal(draft.freeMode.enabled, true);
  assert.equal(draft.freeMode.maxOutputImages, 4);
  assert.equal(draft.bot.replyStrategies.text, 'quote');
  assert.equal(draft.bot.replyStrategies.image, 'plain');
  assert.equal(draft.bot.replyStrategies.multiImage, 'quote');
});

test('panel app: renderPanelApp builds P11 shell from legacy config', () => {
  const app = renderPanelApp(legacyConfigWithoutNewSections);
  assert.equal(app.phase, 'P11-web-panel');
  assert.match(app.shell, /Miobot Admin Panel/);
  assert.equal(app.viewModel.sections.connection.ready, true);
});

test('web api: login rejects stale or wrong password after passwordSeed changes', async () => {
  const api = createWebApi();
  const client = clientFromApi(api);
  const login = await client.login('change-me-on-first-login');
  await client.saveConfig(login.auth.token, { panel: { passwordSeed: 'rotated' } });
  await assert.rejects(() => client.login('change-me-on-first-login'), /密码错误/);
  const rotated = await client.login('rotated');
  assert.equal(rotated.auth.token, derivePanelToken('rotated'));
});

test('web api: permission preview reflects user rules and hard deny over owner allow', async () => {
  const api = createWebApi();
  const login = await api.handle({ method: 'POST', path: '/api/login', body: { password: 'change-me-on-first-login' } });
  const token = login.body.auth.token;
  const saved = await api.handle({
    method: 'POST',
    path: '/api/config',
    headers: { authorization: 'Bearer ' + token },
    body: {
      bot: { ownerQQs: ['900'] },
      orchestration: {
        permissions: {
          hardDenyEnabled: true,
          hardDenyCapabilities: ['config.update'],
          rules: [{ id: 'user-image-deny', scope: 'user', mode: 'deny', qq: '42', priority: 10 }],
        },
      },
    },
  });
  assert.equal(saved.status, 200);

  const userPreview = await api.handle({
    method: 'POST',
    path: '/api/orchestration/permissions/preview',
    headers: { authorization: 'Bearer ' + token },
    body: { capability: 'image.generate', userQq: '42', role: 'user', riskLevel: 'low' },
  });
  assert.equal(userPreview.status, 200);
  assert.equal(userPreview.body.preview.decision, 'deny');
  assert.equal(userPreview.body.preview.matchedRule, 'matrix:user-image-deny');

  const ownerPreview = await api.handle({
    method: 'POST',
    path: '/api/orchestration/permissions/preview',
    headers: { authorization: 'Bearer ' + token },
    body: { capability: 'config.update', userQq: '900', role: 'owner', riskLevel: 'critical' },
  });
  assert.equal(ownerPreview.status, 200);
  assert.equal(ownerPreview.body.preview.decision, 'deny');
  assert.equal(ownerPreview.body.preview.hardDenied, true);
  assert.equal(ownerPreview.body.preview.matchedRule, 'hard-deny:config.update');
});
test('web api: external Suno capability stays disabled until explicitly enabled', async () => {
  const api = createWebApi();
  const login = await api.handle({ method: 'POST', path: '/api/login', body: { password: 'change-me-on-first-login' } });
  const token = login.body.auth.token;
  const response = await api.handle({ method: 'GET', path: '/api/orchestration/capabilities', headers: { authorization: 'Bearer ' + token } });
  assert.equal(response.status, 200);
  assert.equal(response.body.capabilities.find((item) => item.id === 'audio.music.generate')?.enabled, false);
  assert.equal(response.body.manifest.schemaVersion, 1);
  assert.match(response.body.manifest.version, /^cm_[0-9a-f]{8}$/);
  const manifestImage = response.body.manifest.capabilities.find((item) => item.id === 'image.generate');
  assert.equal(manifestImage.effect, 'generate');
  assert.deepEqual(manifestImage.sideEffects, ['creates_artifact']);
  assert.equal(Object.prototype.hasOwnProperty.call(manifestImage, 'notFor'), false);
});
test('web api: config versions are audited and can be rolled back', async () => {
  const api = createWebApi();
  const login = await api.handle({ method: 'POST', path: '/api/login', body: { password: 'change-me-on-first-login' } });
  const token = login.body.auth.token;
  const headers = { authorization: 'Bearer ' + token };
  await api.handle({ method: 'POST', path: '/api/config', headers, body: { llm: { chatModel: 'model-a' } } });
  await api.handle({ method: 'POST', path: '/api/config', headers, body: { llm: { chatModel: 'model-b' } } });
  const versions = await api.handle({ method: 'GET', path: '/api/config/versions', headers });
  assert.equal(versions.status, 200);
  assert.ok(versions.body.versions.length >= 3);
  const target = versions.body.versions.find((item) => item.changedPaths.includes('llm.chatModel') && item.version === 2);
  assert.ok(target);
  const rolled = await api.handle({ method: 'POST', path: '/api/config/rollback', headers, body: { version: 2 } });
  assert.equal(rolled.status, 200);
  assert.equal(rolled.body.config.llm.chatModel, 'model-a');
  assert.ok(rolled.body.hotReload.changedPaths.includes('llm.chatModel'));
  const after = await api.handle({ method: 'GET', path: '/api/config/versions', headers });
  assert.equal(after.body.versions[after.body.versions.length - 1].current, true);
});
test('web api: prompt versions can be evaluated, diffed, activated and rolled back', async () => {
  const api = createWebApi();
  const login = await api.handle({ method: 'POST', path: '/api/login', body: { password: 'change-me-on-first-login' } });
  const headers = { authorization: 'Bearer ' + login.body.auth.token };
  await api.handle({
    method: 'POST', path: '/api/config', headers,
    body: { orchestration: { promptOptimization: {
      enabled: true, canaryPercent: 25, activeVersionId: 'v1', canaryVersionId: 'v2',
      versions: [
        { id: 'v1', name: 'stable', content: 'stable prompt', status: 'active', createdAt: '2026-01-01' },
        { id: 'v2', name: 'candidate', content: 'candidate prompt', status: 'canary', createdAt: '2026-01-02' },
      ],
    } } },
  });
  const evaluation = await api.handle({
    method: 'POST', path: '/api/orchestration/prompts/evaluate', headers,
    body: { versionId: 'v2', samples: 60, successRate: 0.95, averageScore: 0.9, safetyFailures: 0, ownerApproved: true },
  });
  assert.equal(evaluation.status, 200);
  assert.equal(evaluation.body.decision.promote, true);
  const diff = await api.handle({ method: 'GET', path: '/api/orchestration/prompts/v2/diff', headers });
  assert.equal(diff.status, 200);
  assert.ok(diff.body.diff.some((line) => line.type === 'remove'));
  const activated = await api.handle({ method: 'POST', path: '/api/orchestration/prompts/activate', headers, body: { versionId: 'v2', mode: 'active' } });
  assert.equal(activated.status, 200);
  assert.equal(activated.body.config.orchestration.promptOptimization.activeVersionId, 'v2');
  const rolled = await api.handle({ method: 'POST', path: '/api/orchestration/prompts/rollback', headers, body: { versionId: 'v1' } });
  assert.equal(rolled.status, 200);
  assert.equal(rolled.body.config.orchestration.promptOptimization.activeVersionId, 'v1');
});
test('web api: capability health test and trace replay are available', async () => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const nodePath = await import('node:path');
  const traceFile = nodePath.join(os.tmpdir(), 'miobot-trace-' + Date.now() + '.jsonl');
  await fs.writeFile(traceFile, [
    JSON.stringify({ id: 't1', requestId: 'req-replay', stage: 'request', summary: 'start', timestamp: '2026-01-01T00:00:00.000Z' }),
    JSON.stringify({ id: 't2', requestId: 'req-replay', stage: 'execute', summary: 'done', timestamp: '2026-01-01T00:00:01.000Z' }),
    JSON.stringify({ id: 't3', requestId: 'other', stage: 'request', summary: 'other', timestamp: '2026-01-01T00:00:02.000Z' }),
  ].join('\n') + '\n', 'utf8');
  const previous = process.env.MIOBOT_TRACE_FILE;
  process.env.MIOBOT_TRACE_FILE = traceFile;
  try {
    const api = createWebApi();
    const login = await api.handle({ method: 'POST', path: '/api/login', body: { password: 'change-me-on-first-login' } });
    const headers = { authorization: 'Bearer ' + login.body.auth.token };
    const testResult = await api.handle({ method: 'POST', path: '/api/orchestration/capabilities/test', headers, body: { id: 'image.generate' } });
    assert.equal(testResult.status, 200);
    assert.ok(['ok', 'unconfigured', 'disabled'].includes(testResult.body.capability.health.status));
    const replay = await api.handle({ method: 'GET', path: '/api/orchestration/traces/req-replay', headers });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.timeline.length, 2);
    assert.equal(replay.body.timeline[1].stage, 'execute');
  } finally {
    if (previous === undefined) delete process.env.MIOBOT_TRACE_FILE;
    else process.env.MIOBOT_TRACE_FILE = previous;
    await fs.unlink(traceFile).catch(() => undefined);
  }
});