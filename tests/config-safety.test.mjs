import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { FileJsonStore } from '../dist/packages/storage/src/json-store.js';
import { ConfigStore } from '../dist/packages/storage/src/config-store.js';
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
