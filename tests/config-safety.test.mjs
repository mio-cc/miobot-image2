import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { FileJsonStore } from '../dist/packages/storage/src/json-store.js';
import { ConfigStore } from '../dist/packages/storage/src/config-store.js';
import { createConfigRepository } from '../dist/packages/web-api/src/index.js';
import { normalizeConfig } from '../dist/packages/config/src/index.js';

/**
 * 配置的数据安全。
 * 这里每条都对应一个会**丢用户数据**或**被注入**的真实场景，
 * 不是风格问题。
 */

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'miobot-cfg-'));
}

test('config.json 损坏时：备份原文件、拒绝写盘、不覆盖用户数据', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'config.json');
  const broken = '{ "panel": { "passwordSeed": "real-password" },, }';
  fs.writeFileSync(file, broken, 'utf8');

  const events = [];
  const store = new FileJsonStore(file, {
    defaultValue: { panel: { passwordSeed: 'default' } },
    guardCorruptedFile: true,
    onCorrupted: (info) => events.push(info),
  });

  const loaded = store.load();
  assert.equal(store.isCorrupted(), true, '应标记为损坏');
  assert.equal(loaded.panel.passwordSeed, 'default', '内存里回退默认值');
  assert.equal(events.length, 1, '应触发损坏回调');

  // 磁盘原文件必须原样保留
  assert.equal(fs.readFileSync(file, 'utf8'), broken);
  // 必须生成备份
  const backups = fs.readdirSync(dir).filter((n) => n.includes('config.json.broken-'));
  assert.equal(backups.length, 1);

  // 任何保存都必须被拒绝——否则用户的密钥会被默认值永久覆盖
  assert.throws(() => store.save({ panel: { passwordSeed: 'default' } }), /拒绝写入/);
  assert.equal(fs.readFileSync(file, 'utf8'), broken, '磁盘内容不能被改动');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('config.json 修好后可恢复正常写盘', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, '{ bad json', 'utf8');

  const store = new FileJsonStore(file, { defaultValue: {}, guardCorruptedFile: true });
  store.load();
  assert.equal(store.isCorrupted(), true);

  fs.writeFileSync(file, JSON.stringify({ panel: { passwordSeed: 'real' } }), 'utf8');
  const reloaded = store.load();
  assert.equal(store.isCorrupted(), false);
  assert.equal(reloaded.panel.passwordSeed, 'real');

  store.save({ panel: { passwordSeed: 'real2' } });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).panel.passwordSeed, 'real2');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('文件不存在或为空不算损坏（首次启动要能正常写入）', () => {
  const dir = tmpDir();
  const missing = path.join(dir, 'nope.json');
  const store = new FileJsonStore(missing, { defaultValue: { a: 1 }, guardCorruptedFile: true });
  assert.deepEqual(store.load(), { a: 1 });
  assert.equal(store.isCorrupted(), false);
  store.save({ a: 2 });
  assert.deepEqual(JSON.parse(fs.readFileSync(missing, 'utf8')), { a: 2 });

  const empty = path.join(dir, 'empty.json');
  fs.writeFileSync(empty, '   ', 'utf8');
  const store2 = new FileJsonStore(empty, { defaultValue: { b: 1 }, guardCorruptedFile: true });
  assert.deepEqual(store2.load(), { b: 1 });
  assert.equal(store2.isCorrupted(), false);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('未开启保护的仓储保持原有行为（缓存类文件损坏可直接重建）', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'cache.json');
  fs.writeFileSync(file, '{ broken', 'utf8');

  const store = new FileJsonStore(file, { defaultValue: { ok: true } });
  assert.deepEqual(store.load(), { ok: true });
  store.save({ ok: false });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { ok: false });

  fs.rmSync(dir, { recursive: true, force: true });
});

test('ConfigStore 对 config.json 默认开启损坏保护', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, '{ nope', 'utf8');

  const store = new ConfigStore(file, { defaultValue: { panel: {} } });
  store.load();
  assert.equal(store.isCorrupted(), true);
  assert.match(store.corruptionReason(), /\S/);
  assert.throws(() => store.save({ panel: {} }), /拒绝写入/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('配置合并挡住原型链注入', () => {
  const before = {}.polluted;
  normalizeConfig(JSON.parse('{"__proto__": {"polluted": "yes"}}'));
  assert.equal({}.polluted, before, '不应污染 Object.prototype');

  normalizeConfig(JSON.parse('{"bot": {"__proto__": {"pollutedNested": "yes"}}}'));
  assert.equal({}.pollutedNested, undefined, '嵌套注入同样要挡住');
});

test('白名单数字会被归一化为字符串（否则路由里永远匹配不上）', () => {
  const cfg = normalizeConfig({ bot: { whitelistGroups: [123456789, '  987654321  '], whitelistPrivate: [111] } });
  assert.deepEqual(cfg.bot.whitelistGroups, ['123456789', '987654321']);
  assert.deepEqual(cfg.bot.whitelistPrivate, ['111']);
});

/* ── 落盘失败必须让用户看见（复查确认：原来被空 catch 吞掉） ────────── */

test('落盘失败时 persisted=false，并把原因带回给面板', () => {
  const repo = createConfigRepository({ initialConfig: { bot: { botQqId: '1' } } });

  repo.onReload(() => { throw new Error('EACCES: permission denied'); });

  const result = repo.saveConfig({ bot: { botQqId: '2' } });
  assert.equal(result.persisted, false, '写盘失败必须如实报出来');
  assert.match(result.message, /写入磁盘失败/);
  assert.match(result.message, /EACCES/);
  assert.deepEqual(result.persistErrors, ['EACCES: permission denied']);

  // 内存里仍然生效（热重载不该被磁盘问题阻断），但用户会看到明确的失败提示
  assert.equal(repo.getConfig().bot.botQqId, '2');
});

test('落盘成功时 persisted=true，消息不变', () => {
  const repo = createConfigRepository({ initialConfig: { bot: { botQqId: '1' } } });
  let saved = 0;
  repo.onReload(() => { saved += 1; });
  const result = repo.saveConfig({ bot: { botQqId: '2' } });
  assert.equal(result.persisted, true);
  assert.equal(result.persistErrors, undefined);
  assert.equal(saved, 1);
});

test('一个监听器炸了不影响其它监听器', () => {
  const repo = createConfigRepository({ initialConfig: {} });
  const ran = [];
  repo.onReload(() => { ran.push('a'); });
  repo.onReload(() => { throw new Error('boom'); });
  repo.onReload(() => { ran.push('c'); });

  const result = repo.saveConfig({ bot: { botQqId: '9' } });
  assert.deepEqual(ran, ['a', 'c'], '中间那个抛错不该阻断后面的');
  assert.equal(result.persisted, false);
});

/* ── bot 进程跨进程热重载（web 与 bot 是两个进程，只共享 config.json） ───── */

function tempConfigFile(initial) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miobot-reload-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify(initial), 'utf8');
  return file;
}

function writeConfig(file, value) {
  fs.writeFileSync(file, JSON.stringify(value), 'utf8');
  // 同一毫秒内写两次时 mtimeMs 可能不变，显式往前推一点保证能被检测到
  const later = new Date(Date.now() + 10);
  fs.utimesSync(file, later, later);
}

test('loadIfChanged: 文件没变时复用缓存，变了立刻取到新值', () => {
  const file = tempConfigFile({ bot: { botQqId: '111' } });
  const store = new ConfigStore(file, { defaultValue: normalizeConfig({}), normalize: normalizeConfig });

  const first = store.loadIfChanged();
  assert.equal(first.bot.botQqId, '111');
  assert.equal(store.loadIfChanged(), first, '文件没动就该复用同一个对象，避免每条消息都 normalize 一遍');

  writeConfig(file, { bot: { botQqId: '222' } });
  const second = store.loadIfChanged();
  assert.equal(second.bot.botQqId, '222', '面板保存后，bot 下一条消息就要用上新配置');
  assert.notEqual(second, first);
});

test('loadIfChanged: 文件中途读不到时继续用旧配置，绝不回落默认值', () => {
  const file = tempConfigFile({ bot: { botQqId: '111', whitelistGroups: ['123'] } });
  const store = new ConfigStore(file, { defaultValue: normalizeConfig({}), normalize: normalizeConfig });

  const good = store.loadIfChanged();
  assert.deepEqual(good.bot.whitelistGroups, ['123']);

  fs.rmSync(file);
  const after = store.loadIfChanged();
  assert.deepEqual(after.bot.whitelistGroups, ['123'],
    '文件读不到时若回落默认值，白名单会突然清空——对 bot-router 来说等于全放行');
});

test('loadIfChanged: 文件被写坏时同样保留旧配置', () => {
  const file = tempConfigFile({ bot: { botQqId: '111', whitelistGroups: ['123'] } });
  const store = new ConfigStore(file, { defaultValue: normalizeConfig({}), normalize: normalizeConfig });
  store.loadIfChanged();

  fs.writeFileSync(file, '{ 这不是合法 JSON', 'utf8');
  const later = new Date(Date.now() + 10);
  fs.utimesSync(file, later, later);

  const after = store.loadIfChanged();
  assert.deepEqual(after.bot.whitelistGroups, ['123'], '解析失败不能 fail-open');
  assert.equal(after.bot.botQqId, '111');
});
