import test from 'node:test';
import assert from 'node:assert/strict';

import { createDefaultConfig, importConfig } from '../dist/packages/config/src/index.js';
import { ImageModule } from '../dist/packages/image/src/index.js';
import { FreeModeEngine } from '../dist/packages/free-mode/src/index.js';
import { ReplyStrategyEngine } from '../dist/packages/reply/src/index.js';
import { routeBotMessage } from '../dist/packages/bot-router/src/index.js';
import { createWebApi } from '../dist/packages/web-api/src/index.js';
import { createPanelController } from '../dist/packages/web-panel/src/index.js';

function apiClient(api) {
  async function request(method, path, token, body) {
    const response = await api.handle({ method, path, headers: token ? { authorization: `Bearer ${token}` } : {}, body });
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

class FakeLlm {
  calls = [];
  async generateImages(request) {
    this.calls.push({ method: 'generateImages', request });
    const count = request.count || 1;
    return {
      images: Array.from({ length: count }, (_item, index) => ({ kind: 'base64', data: `image-${index + 1}-${request.prompt}`, index })),
      raw: { ok: true },
      status: 200,
    };
  }
  async editImage(request) {
    this.calls.push({ method: 'editImage', request });
    return { images: [{ kind: 'base64', data: `edited-${request.images.length}-${request.prompt}`, index: 0 }], raw: { ok: true }, status: 200 };
  }
  async createVision(request) {
    this.calls.push({ method: 'createVision', request });
    return { text: `vision:${request.prompt}:${request.imageUrls.length}`, raw: { ok: true }, status: 200 };
  }
}

class FakeReplyClient {
  calls = [];
  async sendGroupText(groupId, text, replyToMessageId) { this.calls.push({ method: 'sendGroupText', groupId, text, replyToMessageId }); return { success: true, messageId: 'gt-1' }; }
  async sendPrivateText(userId, text) { this.calls.push({ method: 'sendPrivateText', userId, text }); return { success: true, messageId: 'pt-1' }; }
  async sendGroupTextForward(groupId, nodes, botName) { this.calls.push({ method: 'sendGroupTextForward', groupId, nodes, botName }); return { success: true, forwardId: 'gf-text' }; }
  async sendPrivateTextForward(userId, nodes, botName) { this.calls.push({ method: 'sendPrivateTextForward', userId, nodes, botName }); return { success: true, forwardId: 'pf-text' }; }
  async sendGroupImage(groupId, fileUrl, summaryText) { this.calls.push({ method: 'sendGroupImage', groupId, fileUrl, summaryText }); return { success: true, messageId: `gi-${this.calls.length}` }; }
  async sendPrivateImage(userId, fileUrl) { this.calls.push({ method: 'sendPrivateImage', userId, fileUrl }); return { success: true, messageId: `pi-${this.calls.length}` }; }
  async sendGroupImagesForward(groupId, fileUrls, botName) { this.calls.push({ method: 'sendGroupImagesForward', groupId, fileUrls, botName }); return { success: true, forwardId: 'gf-images' }; }
}

class FakePlanner {
  calls = [];
  constructor(text) { this.text = text; }
  async createText(request) { this.calls.push(request); return { text: this.text, raw: { ok: true } }; }
}

function routerConfig(config, overrides = {}) {
  return {
    botId: '10000',
    commands: config.bot.commands,
    whitelistGroups: config.bot.whitelistGroups,
    whitelistPrivate: config.bot.whitelistPrivate,
    blacklistGroupUsers: config.bot.blacklistGroupUsers,
    triggerModes: config.bot.triggerModes,
    freeModeEnabled: config.freeMode.enabled,
    chatEnabled: config.llm.chatEnabled,
    ...overrides,
  };
}

test('e2e: admin imports legacy config, panel renders, password save rotates token, and export round-trips', async () => {
  const legacy = {
    version: 1,
    config: {
      panel: { password: 'change-me-on-first-login' },
      llm: { nodes: [{ name: 'node-a', baseUrl: 'http://localhost:8317/v1', key: 'test-key-a', enabled: true }] },
      bot: { replyFormat: 'quote', commands: { draw: '画图' } },
    },
  };
  const api = createWebApi();
  const client = apiClient(api);
  const controller = createPanelController(client);

  const login = await controller.login('change-me-on-first-login');
  assert.equal(login.authenticated, true);
  const imported = await controller.importConfig(legacy);
  assert.equal(imported.viewModel.canRender, true);
  assert.equal(imported.viewModel.sections.replyStrategies.data.text, 'quote');
  assert.ok(imported.migrations.some((item) => item.id === 'bot.commands.draw-to-genImage'));

  const oldToken = imported.token;
  const saved = await controller.saveConfig({ panel: { passwordSeed: 'rotated' } });
  assert.notEqual(saved.token, oldToken);
  assert.equal(saved.tokenVersion, 2);

  const exportResponse = await api.handle({ method: 'GET', path: '/api/config/export', headers: { authorization: `Bearer ${saved.token}` } });
  assert.equal(exportResponse.status, 200);
  const roundTrip = importConfig(exportResponse.body.export);
  assert.equal(roundTrip.sourceFormat, 'export-wrapper-v2');
  assert.equal(roundTrip.config.panel.passwordSeed, 'rotated');
});

test('e2e: group mention image command routes to ImageModule and multi-image reply forward', async () => {
  const config = createDefaultConfig();
  config.freeMode.enabled = true;
  config.bot.replyStrategies.multiImage = 'forward';
  const route = routeBotMessage(
    { chatType: 'group', groupId: '1000', userId: '2000', rawMessage: '[CQ:at,qq=10000] 生图 16:9! 2! 星云猫', messageId: 'm-1' },
    routerConfig(config),
  );
  assert.equal(route.kind, 'command');
  assert.equal(route.command, 'genImage');

  const llm = new FakeLlm();
  const replyClient = new FakeReplyClient();
  const reply = new ReplyStrategyEngine(replyClient, config.bot.replyStrategies);
  const image = new ImageModule({
    llm,
    reply,
    imageModel: config.llm.imageModel,
    defaultSize: '1024x1024',
    defaultCount: config.llm.imageCount,
  });
  const result = await image.generate({
    rawPrompt: route.args,
    context: { chatType: 'group', groupId: '1000', senderId: '2000', replyToMessageId: 'm-1', botName: 'Miobot' },
  });

  assert.equal(llm.calls[0].method, 'generateImages');
  assert.equal(llm.calls[0].request.size, '1536x1024');
  assert.equal(llm.calls[0].request.count, 2);
  assert.deepEqual(result.images, ['base64://image-1-星云猫', 'base64://image-2-星云猫']);
  assert.equal(replyClient.calls[0].method, 'sendGroupImagesForward');
  assert.deepEqual(replyClient.calls[0].fileUrls, result.images);
});

test('e2e: group edit command routes to ImageModule.edit and sends single image reply', async () => {
  const config = createDefaultConfig();
  const route = routeBotMessage(
    { chatType: 'group', groupId: '1000', userId: '2000', rawMessage: '[CQ:at,qq=10000] 改图 改成水彩', messageId: 'm-2' },
    routerConfig(config),
  );
  assert.equal(route.kind, 'command');
  assert.equal(route.command, 'editImage');

  const llm = new FakeLlm();
  const replyClient = new FakeReplyClient();
  const reply = new ReplyStrategyEngine(replyClient, { image: 'plain', multiImage: 'plain' });
  const image = new ImageModule({ llm, reply, imageModel: config.llm.imageModel, editModel: config.llm.editModel });
  const result = await image.edit({ rawPrompt: route.args, images: ['base64://input-a'], context: { chatType: 'group', groupId: '1000', senderId: '2000' } });

  assert.equal(llm.calls[0].method, 'editImage');
  assert.deepEqual(llm.calls[0].request.images, ['base64://input-a']);
  assert.deepEqual(result.images, ['base64://edited-1-改成水彩']);
  assert.equal(replyClient.calls[0].method, 'sendGroupImage');
});

test('e2e: private no-command message enters free mode planner and replies privately', async () => {
  const config = createDefaultConfig();
  config.freeMode.enabled = true;
  const route = routeBotMessage({ chatType: 'private', userId: '2000', rawMessage: '帮我写一句欢迎语' }, routerConfig(config));
  assert.equal(route.kind, 'freeMode');

  const planner = new FakePlanner('{"action":"text","text":"欢迎来到频道！"}');
  const replyClient = new FakeReplyClient();
  const reply = new ReplyStrategyEngine(replyClient, { text: 'plain' });
  const fakeImage = { generate: async () => { throw new Error('not expected'); }, edit: async () => { throw new Error('not expected'); } };
  const freeMode = new FreeModeEngine({ planner, image: fakeImage, reply, model: config.freeMode.model });
  const result = await freeMode.handle({ userContent: route.commandText, context: { chatType: 'private', userId: '2000', botName: 'Miobot' } });

  assert.equal(result.action, 'text');
  assert.equal(result.text, '欢迎来到频道！');
  assert.equal(planner.calls[0].model, config.freeMode.model);
  assert.equal(replyClient.calls[0].method, 'sendPrivateText');
  assert.equal(replyClient.calls[0].text, '欢迎来到频道！');
});

test('e2e: help/clear/template commands stay explicit even when free mode is enabled', () => {
  const config = createDefaultConfig();
  config.freeMode.enabled = true;
  const messages = [
    ['help', 'help'],
    ['清空 当前会话', 'clear'],
    ['模板库', 'templateLibrary'],
  ];
  config.bot.commands.clear = '清空, clear';
  for (const [raw, command] of messages) {
    const route = routeBotMessage({ chatType: 'group', groupId: '1000', userId: '2000', rawMessage: `[CQ:at,qq=10000] ${raw}` }, routerConfig(config));
    assert.equal(route.kind, 'command');
    assert.equal(route.command, command);
  }
});

test('e2e: reply-to-bot group text falls back to chat when free mode is disabled', () => {
  const config = createDefaultConfig();
  config.freeMode.enabled = false;
  config.llm.chatEnabled = true;
  const route = routeBotMessage(
    { chatType: 'group', groupId: '1000', userId: '2000', rawMessage: '[CQ:reply,id=old-msg] 继续解释', replyToBot: true },
    routerConfig(config),
  );
  assert.equal(route.kind, 'chat');
  assert.equal(route.commandText, '继续解释');
  assert.equal(route.trigger.replyTriggered, true);
});
