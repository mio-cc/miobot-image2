import test from 'node:test';
import assert from 'node:assert/strict';

import {
  cleanupCommandText,
  findCommandPrefix,
  hasBotMention,
  isGroupUserBlacklisted,
  parseEnhanceMode,
  parseTriggers,
  routeBotMessage,
  stripCommandPrefix,
} from '../dist/packages/bot-router/src/index.js';

const commands = {
  genImage: '生图, 画, draw',
  img2Img: '图生图, 参考图, i2i',
  editImage: '改图, 编辑, edit',
  interrogate: '反推, 看图, 描述, prompt',
  originalImage: '原图, original, rawpic',
  referencedTemplateImage: '套模板, 引用模板生图, rt',
  templateLibrary: '模板库, 模板, mb',
  help: '/help, help, 帮助',
  clear: 'clear, 清空',
  remotePromptSearch: 'pp, 远程模板',
  remotePromptSmartImage: 'spp, 智能远程模板',
  toggleEnhance: '润色, enhance',
  forceEnhance: '强润色, force-enhance',
  disableEnhance: '原文, raw',
};

function config(overrides = {}) {
  return {
    botId: '10000',
    botAliases: ['@bot'],
    commands,
    triggerModes: { mention: true, replyToBot: true },
    freeModeEnabled: true,
    chatEnabled: true,
    ...overrides,
  };
}

function group(rawMessage, overrides = {}) {
  return { chatType: 'group', rawMessage, groupId: '100', userId: '200', ...overrides };
}

function priv(rawMessage, overrides = {}) {
  return { chatType: 'private', rawMessage, userId: '200', ...overrides };
}

test('bot router: trigger aliases are deduped, normalized, and longest-first', () => {
  assert.deepEqual(parseTriggers('画, draw, 画, 图生图, i2i'), ['draw', '图生图', 'i2i', '画']);
});

test('bot router: command prefix accepts space, bang and colon separators', () => {
  assert.equal(findCommandPrefix('draw: a cat', commands.genImage), 'draw');
  assert.equal(stripCommandPrefix('draw! a cat', 'draw'), 'a cat');
});

test('bot router: group whitelist blocks before trigger and commands', () => {
  const decision = routeBotMessage(group('[CQ:at,qq=10000] help', { groupId: '999' }), config({ whitelistGroups: ['100'] }));
  assert.equal(decision.kind, 'ignored');
  assert.equal(decision.reason, 'group-not-whitelisted');
});

test('bot router: group user blacklist blocks before commands', () => {
  const decision = routeBotMessage(group('[CQ:at,qq=10000] help', { userId: '200' }), config({ blacklistGroupUsers: ['*:200'] }));
  assert.equal(decision.kind, 'ignored');
  assert.equal(decision.reason, 'group-user-blacklisted');
  assert.equal(isGroupUserBlacklisted('100', '200', ['*:200']), true);
});

test('bot router: unrelated group message is ignored when it has no mention, reply, or direct command', () => {
  const decision = routeBotMessage(group('今天吃什么'), config());
  assert.equal(decision.kind, 'ignored');
  assert.equal(decision.reason, 'group-not-triggered');
});

test('bot router: reply-to-bot ownership can trigger chat without mention', () => {
  const decision = routeBotMessage(
    group('[CQ:reply,id=abc123] 继续说', { replyToBot: true }),
    config({ freeModeEnabled: false, chatEnabled: true }),
  );
  assert.equal(decision.kind, 'chat');
  assert.equal(decision.commandText, '继续说');
  assert.equal(decision.trigger.replyTriggered, true);
  assert.equal(decision.trigger.mentionTriggered, false);
});

test('bot router: reply-to-bot with only non-bot at/image/file payload is ignored', () => {
  const decision = routeBotMessage(
    group('[CQ:reply,id=abc123][CQ:image,file=quoted.png][CQ:at,qq=23333]', { replyToBot: true }),
    config({ freeModeEnabled: true, chatEnabled: true }),
  );
  assert.equal(decision.kind, 'ignored');
  assert.equal(decision.reason, 'group-not-triggered');
  assert.equal(decision.trigger.replyTriggered, false);
});

test('bot router: explicit image command wins over free mode in group mention flow', () => {
  const decision = routeBotMessage(group('[CQ:at,qq=10000] 生图 润色 一只猫'), config({ freeModeEnabled: true }));
  assert.equal(decision.kind, 'command');
  assert.equal(decision.command, 'genImage');
  assert.equal(decision.args, '一只猫');
  assert.equal(decision.metadata.enhance.forceEnhance, true);
});

test('bot router: help command is never stolen by free mode', () => {
  const decision = routeBotMessage(group('[CQ:at,qq=10000] help'), config({ freeModeEnabled: true }));
  assert.equal(decision.kind, 'command');
  assert.equal(decision.command, 'help');
});

test('bot router: clear command is never stolen by free mode', () => {
  const decision = routeBotMessage(group('[CQ:at,qq=10000] 清空 当前会话'), config({ freeModeEnabled: true }));
  assert.equal(decision.kind, 'command');
  assert.equal(decision.command, 'clear');
  assert.equal(decision.args, '当前会话');
});

test('bot router: template library command is never stolen by free mode', () => {
  const decision = routeBotMessage(group('[CQ:at,qq=10000] 模板库'), config({ freeModeEnabled: true }));
  assert.equal(decision.kind, 'command');
  assert.equal(decision.command, 'templateLibrary');
});

test('bot router: free mode handles mentioned group text after explicit commands miss', () => {
  const decision = routeBotMessage(group('[CQ:at,qq=10000] 随便聊聊'), config({ freeModeEnabled: true, chatEnabled: true }));
  assert.equal(decision.kind, 'freeMode');
  assert.equal(decision.commandText, '随便聊聊');
});

test('bot router: chat handles mentioned group text when free mode is disabled', () => {
  const decision = routeBotMessage(group('[CQ:at,qq=10000] 你好'), config({ freeModeEnabled: false, chatEnabled: true }));
  assert.equal(decision.kind, 'chat');
  assert.equal(decision.commandText, '你好');
});

test('bot router: private whitelist blocks before explicit commands', () => {
  const decision = routeBotMessage(priv('help', { userId: '999' }), config({ whitelistPrivate: ['200'] }));
  assert.equal(decision.kind, 'ignored');
  assert.equal(decision.reason, 'private-not-whitelisted');
});

test('bot router: private explicit command does not require mention', () => {
  const decision = routeBotMessage(priv('帮助'), config({ freeModeEnabled: true }));
  assert.equal(decision.kind, 'command');
  assert.equal(decision.command, 'help');
});

test('bot router: private no-command text enters free mode before normal chat', () => {
  const decision = routeBotMessage(priv('帮我想一个设定'), config({ freeModeEnabled: true, chatEnabled: true }));
  assert.equal(decision.kind, 'freeMode');
});

test('bot router: private no-command text enters chat when free mode is disabled', () => {
  const decision = routeBotMessage(priv('普通聊天'), config({ freeModeEnabled: false, chatEnabled: true }));
  assert.equal(decision.kind, 'chat');
});

test('bot router: remote prompt command strips bang separator and keeps query', () => {
  const decision = routeBotMessage(group('[CQ:at,qq=10000] pp! cyberpunk cat'), config({ freeModeEnabled: true }));
  assert.equal(decision.kind, 'command');
  assert.equal(decision.command, 'remotePromptSearch');
  assert.equal(decision.matchedAlias, 'pp');
  assert.equal(decision.args, 'cyberpunk cat');
});

test('bot router: direct legacy group help command triggers without mention', () => {
  const decision = routeBotMessage(group('help'), config({ freeModeEnabled: true }));
  assert.equal(decision.kind, 'command');
  assert.equal(decision.command, 'help');
  assert.equal(decision.trigger.commandTriggered, true);
});

test('bot router: group referenced original choice routes as explicit original image choice', () => {
  const decision = routeBotMessage(
    group('[CQ:reply,id=msg-1] 2', { replyToBot: true, originalChoiceAvailable: true }),
    config({ freeModeEnabled: true }),
  );
  assert.equal(decision.kind, 'command');
  assert.equal(decision.command, 'originalImageChoice');
  assert.equal(decision.args, '2');
});

test('bot router: bot mention cleanup supports CQ at and @bot aliases', () => {
  assert.equal(hasBotMention('[CQ:at,qq=10000] hello', '10000'), true);
  assert.equal(cleanupCommandText('@bot + hello', '10000', ['@bot']), 'hello');
});

test('bot router: enhance parser handles force and disable aliases', () => {
  assert.deepEqual(parseEnhanceMode('强润色 夜景', commands), {
    prompt: '夜景',
    forceEnhance: true,
    enhanceMode: 'force',
    matchedAlias: '强润色',
  });
  assert.deepEqual(parseEnhanceMode('原文 夜景', commands), {
    prompt: '夜景',
    forceEnhance: false,
    enhanceMode: 'disable',
    matchedAlias: '原文',
  });
});
