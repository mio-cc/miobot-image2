import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  writeFileAtomicSync,
  writeJsonAtomicSync,
  readJsonSync,
  fileExists,
  DebouncedWriter,
  FileJsonStore,
  InMemoryJsonStore,
  ConfigStore,
  CanvasStateStore,
  LogFileStore,
  filterLogRecords,
  mergeLogRecords,
} from '../dist/packages/storage/src/index.js';

async function tmpDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'miobot-storage-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('atomic: write/read roundtrip and fallback on missing file', async (t) => {
  const dir = await tmpDir(t);
  const file = path.join(dir, 'nested', 'data.json');
  writeJsonAtomicSync(file, { a: 1, b: 'x' });
  assert.equal(fileExists(file), true);
  assert.deepEqual(readJsonSync(file, null), { a: 1, b: 'x' });
  assert.deepEqual(readJsonSync(path.join(dir, 'missing.json'), { fallback: true }), { fallback: true });
});

test('atomic: corrupt json falls back without throwing', async (t) => {
  const dir = await tmpDir(t);
  const file = path.join(dir, 'bad.json');
  writeFileAtomicSync(file, '{ this is not json');
  assert.deepEqual(readJsonSync(file, { ok: false }), { ok: false });
});

test('debounce: coalesces multiple schedules into one flush', async () => {
  let flushes = 0;
  const w = new DebouncedWriter(() => { flushes += 1; }, 5);
  w.schedule();
  w.schedule();
  w.schedule();
  assert.equal(w.pending, true);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(flushes, 1);
  assert.equal(w.pending, false);
});

test('debounce: flush() writes immediately, dispose() drops pending', () => {
  let flushes = 0;
  const w = new DebouncedWriter(() => { flushes += 1; }, 1000);
  w.schedule();
  w.flush();
  assert.equal(flushes, 1);
  w.schedule();
  w.dispose();
  assert.equal(w.pending, false);
});

test('FileJsonStore: save/load with default fallback', async (t) => {
  const dir = await tmpDir(t);
  const store = new FileJsonStore(path.join(dir, 'f.json'), { defaultValue: { n: 0 } });
  assert.equal(store.exists(), false);
  assert.deepEqual(store.load(), { n: 0 });
  store.save({ n: 42 });
  assert.equal(store.exists(), true);
  assert.deepEqual(store.load(), { n: 42 });
});

test('InMemoryJsonStore: save/load without disk', () => {
  const store = new InMemoryJsonStore();
  assert.equal(store.exists(), false);
  store.save({ hello: 'world' });
  assert.equal(store.exists(), true);
  assert.deepEqual(store.load(), { hello: 'world' });
});

test('ConfigStore: applies normalize hook on load and save', () => {
  const backing = new InMemoryJsonStore();
  const normalize = (raw) => ({ version: 1, ...(raw && typeof raw === 'object' ? raw : {}) });
  const store = new ConfigStore(backing, { defaultValue: { version: 1 }, normalize });
  assert.deepEqual(store.load(), { version: 1 });
  const saved = store.save({ name: 'bot' });
  assert.deepEqual(saved, { version: 1, name: 'bot' });
  assert.deepEqual(store.load(), { version: 1, name: 'bot' });
});

test('CanvasStateStore: in-memory get/set/update with debounced flush', async (t) => {
  const dir = await tmpDir(t);
  const file = path.join(dir, 'canvas.json');
  const store = new CanvasStateStore(file, { defaultValue: { projects: [] }, debounceMs: 5 });
  store.set({ projects: ['p1'] });
  assert.deepEqual(store.get(), { projects: ['p1'] });
  store.update((s) => { s.projects.push('p2'); });
  assert.deepEqual(store.get(), { projects: ['p1', 'p2'] });
  store.flush();
  // 落盘后用新实例从磁盘读回，验证持久化。
  const reopened = new CanvasStateStore(file, { defaultValue: { projects: [] } });
  assert.deepEqual(reopened.get(), { projects: ['p1', 'p2'] });
});

test('LogFileStore: append, query by level/scope/contains, clear', async (t) => {
  const dir = await tmpDir(t);
  const store = new LogFileStore(path.join(dir, 'sys.ndjson'));
  store.append({ timestamp: '2026-05-27T00:00:01.000Z', level: 'info', scope: 'bot', message: 'started' });
  store.append({ timestamp: '2026-05-27T00:00:02.000Z', level: 'error', scope: 'bot:image', message: 'gen failed' });
  store.append({ timestamp: '2026-05-27T00:00:03.000Z', level: 'debug', scope: 'admin', message: 'tick' });

  assert.equal(store.readAll().length, 3);
  assert.equal(store.query({ level: 'error' }).length, 1);
  assert.equal(store.query({ level: 'warn' }).length, 0); // 精确匹配：无 warn 记录
  assert.equal(store.query({ scope: 'bot' }).length, 2); // 前缀匹配 bot 与 bot:image
  assert.equal(store.query({ contains: 'failed' }).length, 1);
  assert.equal(store.query({ limit: 2 }).length, 2);

  store.clear();
  assert.equal(store.readAll().length, 0);
});

test('LogFileStore: skips corrupt lines', async (t) => {
  const dir = await tmpDir(t);
  const file = path.join(dir, 'mixed.ndjson');
  await fs.writeFile(file, '{"timestamp":"2026-05-27T00:00:01.000Z","level":"info","scope":"a","message":"ok"}\nNOT JSON\n\n', 'utf8');
  const store = new LogFileStore(file);
  assert.equal(store.readAll().length, 1);
});

test('mergeLogRecords: dedupes by identity, sorts by timestamp, applies limit', () => {
  const a = [
    { timestamp: '2026-05-27T00:00:02.000Z', level: 'info', scope: 's', message: 'b' },
    { timestamp: '2026-05-27T00:00:01.000Z', level: 'info', scope: 's', message: 'a' },
  ];
  const b = [
    { timestamp: '2026-05-27T00:00:02.000Z', level: 'info', scope: 's', message: 'b' }, // dup of a[0]
    { timestamp: '2026-05-27T00:00:03.000Z', level: 'info', scope: 's', message: 'c' },
  ];
  const merged = mergeLogRecords(a, b);
  assert.deepEqual(merged.map((r) => r.message), ['a', 'b', 'c']);
  assert.deepEqual(mergeLogRecords(a, b, 2).map((r) => r.message), ['b', 'c']);
});

test('filterLogRecords: standalone filter matches store.query semantics', () => {
  const records = [
    { timestamp: '1', level: 'debug', scope: 'x', message: 'one' },
    { timestamp: '2', level: 'error', scope: 'x:y', message: 'two' },
  ];
  assert.equal(filterLogRecords(records, { scope: 'x' }).length, 2);
  assert.equal(filterLogRecords(records, { level: 'error' }).length, 1);
});
