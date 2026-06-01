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
  assert.deepEqual(vm.sections.replyStrategies.data, { text: 'quote', image: 'quote', multiImage: 'quote' });
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
