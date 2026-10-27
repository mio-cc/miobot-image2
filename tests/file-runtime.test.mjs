import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDefaultConfig, normalizeConfig } from '../dist/packages/config/src/index.js';
/** R9 修复后 Agent 默认 enforce：文件运行时测试走旧命令路径，显式关闭 agent（聊天语义另测）。 */
function normalizeConfigWithAgentOff(input) {
  const cfg = normalizeConfig(typeof input === 'function' ? input() : input);
  if (cfg.agent) { cfg.agent.enabled = false; cfg.agent.mode = 'off'; cfg.intentRecognition.enabled = false; }
  return cfg;
}

import { createBotMessageRuntime, detectFileGenerateRequest, extractFiles } from '../dist/apps/bot/src/runtime.js';
import { PendingFileIndex } from '../dist/packages/file-ingest/src/index.js';

function decision() {
  return { kind: 'chat', source: 'signal', confidence: 1, reason: 'explicit-command', params: { prompt: '', tokens: [] }, usedPlanner: false };
}

test('runtime file: extracts file segments without downloading', () => {
  const files = extractFiles({
    message: [
      { type: 'at', data: { qq: '100' } },
      { type: 'file', data: { file_id: 'f1', name: 'a.txt', size: 5 } },
    ],
    raw_message: '[CQ:at,qq=100] 读取文件 [CQ:file,file_id=f1,name=a.txt,size=5]',
  });
  assert.equal(files.length, 1);
  assert.equal(files[0].fileId, 'f1');
  assert.equal(files[0].name, 'a.txt');
});

test('runtime file: same-message file read downloads, parses, and asks chat model', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'miobot-runtime-file-'));
  const source = path.join(dir, 'source.txt');
  await fs.writeFile(source, 'Miibot private file content', 'utf8');
  const cfg = normalizeConfigWithAgentOff({ ...createDefaultConfig(), bot: { ...createDefaultConfig().bot, replyStrategies: { text: 'plain', image: 'plain', multiImage: 'plain', video: 'plain', multiVideo: 'forward', file: 'forward', multiFile: 'forward', mixed: 'forward' } } });
  cfg.bot.botQqId = '100';
  cfg.bot.files.enabled = true;
  const index = new PendingFileIndex({ filePath: path.join(dir, 'pending.json') });
  index.loadSync();
  const sent = [];
  let modelPrompt = '';
  const reply = {
    async sendGroupText(groupId, text) { sent.push(String(text)); return { success: true, messageId: 1 }; },
    async sendPrivateText(userId, text) { sent.push(String(text)); return { success: true, messageId: 1 }; },
  };
  const app = {
    sessions: { clear() {}, append() {}, get() { return []; } },
    registry: () => ({ can: () => true }),
    handle: async () => { throw new Error('should not call app.handle'); },
    client: { async chat() { return { text: '{"intent":"file.generate","args":"生成一个 DeepSeek 的 md 介绍文档","fileType":"md","confidence":0.96}' }; } },
    engine: {
      async handleExplicit(kind, input, params) {
        modelPrompt = input.text;
        return { kind: 'chat', handled: true, text: '文件分析完成', decision: decision() };
      },
      async handle() { throw new Error('should not call app.handle'); },
    },
  };
  const runtime = createBotMessageRuntime({
    app,
    reply,
    getConfig: () => cfg,
    selfId: () => '100',
    fileIndex: index,
    downloadFile: async () => source,
  });
  const result = await runtime.handleMessageEvent({
    post_type: 'message',
    message_type: 'group',
    message_id: 9001,
    group_id: 1,
    user_id: 2,
    time: Math.floor(Date.now() / 1000),
    raw_message: '[CQ:at,qq=100] 读取文件 [CQ:file,file_id=f1,name=a.txt,size=26]',
    message: [
      { type: 'at', data: { qq: '100' } },
      { type: 'text', data: { text: ' 读取文件 ' } },
      { type: 'file', data: { file_id: 'f1', name: 'a.txt', size: 26 } },
    ],
  });
  assert.equal(result.handled, true, JSON.stringify(result));
  assert.match(modelPrompt, /Miibot private file content/);
  assert.ok(sent.some((text) => text.includes('文件分析完成')));
  await fs.rm(dir, { recursive: true, force: true });
});


test('runtime file: generation command builds and sends a file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'miobot-runtime-filegen-'));
  const cfg = normalizeConfigWithAgentOff({ ...createDefaultConfig(), bot: { ...createDefaultConfig().bot, replyStrategies: { text: 'plain', image: 'plain', multiImage: 'plain', video: 'plain', multiVideo: 'forward', file: 'plain', multiFile: 'forward', mixed: 'forward' } } });
  cfg.bot.botQqId = '100';
  const filesSent = [];
  let uploadCalled = false;
  const reply = {
    async sendGroupText(groupId, text) { return { success: true, messageId: 1 }; },
    async sendPrivateText(userId, text) { return { success: true, messageId: 1 }; },
    async sendGroupFile(groupId, file, name) { filesSent.push({ file, name }); return { success: true, messageId: 2 }; },
  };
  const app = {
    sessions: { clear() {}, append() {}, get() { return []; } },
    registry: () => ({ can: () => true }),
    handle: async () => { throw new Error('should not call app.handle'); },
    client: {},
    engine: {
      async handleExplicit() {
        return { kind: 'chat', handled: true, text: '{"type":"docx","fileName":"weekly","title":"周报","sections":[{"heading":"进展","body":"完成文件功能"}]}', decision: decision() };
      },
      async handle() { throw new Error('should not call app.handle'); },
    },
  };
  const runtime = createBotMessageRuntime({
    app, reply, getConfig: () => cfg, selfId: () => '100',
    generatedFileDir: dir,
    uploadFile: async (localPath, name, mime) => {
      uploadCalled = true;
      const stat = await fs.stat(localPath);
      assert.ok(stat.size > 100);
      assert.match(mime, /wordprocessingml/);
      return `http://example.test/${encodeURIComponent(name)}`;
    },
  });
  const result = await runtime.handleMessageEvent({
    post_type: 'message', message_type: 'group', message_id: 9002, group_id: 1, user_id: 2,
    time: Math.floor(Date.now() / 1000),
    raw_message: '[CQ:at,qq=100] 生成文件 一份Word周报',
    message: [{ type: 'at', data: { qq: '100' } }, { type: 'text', data: { text: ' 生成文件 一份Word周报' } }],
  });
  assert.equal(result.handled, true, JSON.stringify(result));
  assert.equal(uploadCalled, true);
  assert.equal(filesSent.length, 1);
  assert.match(filesSent[0].file, /weekly/);
  await fs.rm(dir, { recursive: true, force: true });
});

test('runtime image: schedules auto recall using returned message id', async () => {
  const cfg = normalizeConfigWithAgentOff(createDefaultConfig());
  cfg.bot.botQqId = '100';
  cfg.bot.autoRecallImages = true;
  cfg.bot.autoRecallDelaySeconds = 1;
  cfg.bot.imageCompression.enabled = false;
  const recalled = [];
  const reply = {
    async sendGroupText() { return { success: true, messageId: 1 }; },
    async sendGroupImage() { return { success: true, messageId: 77 }; },
  };
  const app = {
    sessions: { clear() {}, append() {}, get() { return []; } },
    registry: () => ({ can: () => true }),
    handle: async () => { throw new Error('should not call app.handle'); },
    client: {},
    engine: {
      async handleExplicit() {
        return { kind: 'image.generate', handled: true, images: ['data:image/png;base64,AAAA'], decision: { kind: 'image.generate', source: 'signal', confidence: 1, reason: 'explicit-command', params: { prompt: '猫', tokens: [] }, usedPlanner: false } };
      },
      async handle() { throw new Error('should not call app.handle'); },
    },
  };
  const runtime = createBotMessageRuntime({
    app, reply, getConfig: () => cfg, selfId: () => '100',
    deleteMessage: async (messageId) => { recalled.push(String(messageId)); return true; },
  });
  const result = await runtime.handleMessageEvent({
    post_type: 'message', message_type: 'group', message_id: 9003, group_id: 1, user_id: 2,
    time: Math.floor(Date.now() / 1000),
    raw_message: '[CQ:at,qq=100] 生图 一只猫',
    message: [{ type: 'at', data: { qq: '100' } }, { type: 'text', data: { text: ' 生图 一只猫' } }],
  });
  assert.equal(result.handled, true, JSON.stringify(result));
  await new Promise((resolve) => setTimeout(resolve, 1150));
  assert.deepEqual(recalled, ['77']);
});


test('runtime file: detects natural-language md/document generation but not image generation', () => {
  assert.equal(detectFileGenerateRequest('生成 一个 DeepSeek 的 md 介绍文档'), true);
  assert.equal(detectFileGenerateRequest('帮我做一份 Excel 表格'), true);
  assert.equal(detectFileGenerateRequest('生成一张猫的图片'), false);
  assert.equal(detectFileGenerateRequest('你好'), false);
});

test('runtime file: natural-language md request produces a real .md file instead of chat text', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'miobot-natural-filegen-'));
  const cfg = normalizeConfigWithAgentOff(createDefaultConfig());
  cfg.bot.botQqId = '100';
  cfg.freeMode.enabled = true;
  cfg.bot.replyStrategies.text = 'forward';
  cfg.bot.replyStrategies.file = 'plain';
  const filesSent = [];
  const reply = {
    async sendGroupText() { return { success: true, messageId: 1 }; },
    async sendGroupFile(groupId, file, name) { filesSent.push({ file, name }); return { success: true, messageId: 2 }; },
  };
  const app = {
    sessions: { clear() {}, append() {}, get() { return []; } },
    registry: () => ({ can: () => true }),
    handle: async () => { throw new Error('should not call app.handle'); },
    client: {},
    engine: {
      async handleExplicit() {
        return { kind: 'chat', handled: true, text: '{"type":"md","fileName":"deepseek-intro","title":"DeepSeek 介绍","content":"# DeepSeek 介绍正文"}', decision: decision() };
      },
      async handle() { throw new Error('should not call app.handle'); },
    },
  };
  const runtime = createBotMessageRuntime({
    app, reply, getConfig: () => cfg, selfId: () => '100',
    generatedFileDir: dir,
    uploadFile: async (localPath, name, mime) => {
      assert.match(name, /\.md$/);
      assert.match(mime, /markdown/);
      const text = await fs.readFile(localPath, 'utf8');
      assert.match(text, /# DeepSeek/);
      return `http://example.test/${encodeURIComponent(name)}`;
    },
  });
  const result = await runtime.handleMessageEvent({
    post_type: 'message', message_type: 'group', message_id: 9010, group_id: 1, user_id: 2,
    time: Math.floor(Date.now() / 1000),
    raw_message: '[CQ:at,qq=100] 生成 一个 DeepSeek 的 md 介绍文档',
    message: [{ type: 'at', data: { qq: '100' } }, { type: 'text', data: { text: ' 生成 一个 DeepSeek 的 md 介绍文档' } }],
  });
  assert.equal(result.handled, true, JSON.stringify(result));
  assert.equal(filesSent.length, 1);
  assert.match(filesSent[0].file, /deepseek-intro\.md|deepseek-intro/);
  await fs.rm(dir, { recursive: true, force: true });
});


test('runtime intent: model chat intent bypasses freeMode planner and calls explicit chat', async () => {
  const cfg = normalizeConfigWithAgentOff(createDefaultConfig());
  cfg.bot.botQqId = '100';
  cfg.freeMode.enabled = true;
  cfg.intentRecognition.enabled = true;
  const texts = [];
  let plannerCalls = 0;
  const app = {
    sessions: { clear() {}, append() {}, get() { return []; } },
    registry: () => ({ can: () => true }),
    handle: async () => { plannerCalls += 1; throw new Error('freeMode planner should not run'); },
    client: { async chat() { return { text: '{"intent":"chat","args":"你好","confidence":0.99}' }; } },
    engine: {
      async handleExplicit(kind) {
        assert.equal(kind, 'chat');
        return { kind: 'chat', handled: true, text: '普通聊天回复', decision: decision() };
      },
    },
  };
  const reply = { async sendGroupText(groupId, text) { texts.push({ groupId, text }); return { success: true, messageId: 1 }; } };
  const runtime = createBotMessageRuntime({ app, reply, getConfig: () => cfg, selfId: () => '100' });
  const result = await runtime.handleMessageEvent({
    post_type: 'message', message_type: 'group', message_id: 9011, group_id: 1, user_id: 2,
    time: Math.floor(Date.now() / 1000),
    raw_message: '[CQ:at,qq=100] 你好',
    message: [{ type: 'at', data: { qq: '100' } }, { type: 'text', data: { text: ' 你好' } }],
  });
  assert.equal(result.handled, true, JSON.stringify(result));
  assert.equal(plannerCalls, 0);
  assert.equal(texts.length, 1);
  assert.match(texts[0].text, /普通聊天回复/);
});
