import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createLogger, MemoryLogSink, JsonFileLogSink } from '../dist/packages/logger/src/index.js';
import {
  createModelQueueKey,
  isRetryableError,
  normalizeError,
  resolveTimeoutMs,
  runWithRetry,
  runWithTimeout,
  TaskQueue,
} from '../dist/packages/core/src/index.js';

test('logger: writes structured records and redacts secrets', () => {
  const sink = new MemoryLogSink(10);
  const logger = createLogger({ scope: 'test', level: 'debug', sinks: [sink], clock: () => new Date('2026-05-27T00:00:00.000Z') });
  logger.info('hello', { token: 'redacted-token', nested: { apiKey: 'test-key-redacted', visible: 'ok' } });

  const [record] = sink.all();
  assert.equal(record.timestamp, '2026-05-27T00:00:00.000Z');
  assert.equal(record.level, 'info');
  assert.equal(record.scope, 'test');
  assert.equal(record.message, 'hello');
  assert.deepEqual(record.data, { token: '[REDACTED]', nested: { apiKey: '[REDACTED]', visible: 'ok' } });
});

test('logger: supports child scopes, level filtering, memory query, and bounds', () => {
  const sink = new MemoryLogSink(2);
  const logger = createLogger({ scope: 'root', level: 'info', sinks: [sink] });
  logger.debug('hidden');
  logger.info('first');
  logger.child('child').warn('second');
  logger.error('third');

  assert.equal(sink.all().length, 2);
  assert.equal(sink.query({ scope: 'root:child' }).length, 1);
  assert.equal(sink.query({ level: 'error' })[0].message, 'third');
});

test('logger: persists redacted structured records to ndjson', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'miobot-log-sink-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'system.ndjson');
  const logger = createLogger({
    scope: 'persist',
    level: 'debug',
    sinks: [new JsonFileLogSink(filePath)],
    clock: () => new Date('2026-05-27T00:00:00.000Z'),
  });

  logger.info('saved', { apiKey: 'sk-secret-value', visible: 'ok' });

  const lines = (await fs.readFile(filePath, 'utf8')).trim().split(/\r?\n/);
  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0]);
  assert.equal(record.scope, 'persist');
  assert.equal(record.message, 'saved');
  assert.deepEqual(record.data, { apiKey: '[REDACTED]', visible: 'ok' });
});

test('error-normalizer: serializes timeout errors as retryable', () => {
  const error = normalizeError(Object.assign(new Error('timeout of 3000ms exceeded'), { code: 'ECONNABORTED' }));
  assert.equal(error.category, 'timeout');
  assert.equal(error.retryable, true);
  assert.equal(error.code, 'ECONNABORTED');
});

test('error-normalizer: detects network and upstream errors', () => {
  assert.equal(normalizeError(new Error('socket hang up')).category, 'network');
  assert.equal(normalizeError(new Error('data[].error: INTERNAL_ERROR')).category, 'upstream');
  assert.equal(isRetryableError(new Error('ECONNRESET')), true);
});

test('error-normalizer: validation errors are serializable but not retryable', () => {
  const error = normalizeError(new Error('missing b64_json/base64/url'));
  assert.equal(error.category, 'validation');
  assert.equal(error.retryable, false);
});

test('error-normalizer: invalidated auth tokens are validation errors', () => {
  const error = normalizeError(new Error('Your authentication token has been invalidated. Please try signing in again.'));
  assert.equal(error.category, 'validation');
  assert.equal(error.retryable, false);
});

test('timeout-policy: resolves per-operation timeout with min/max clamps', () => {
  assert.equal(resolveTimeoutMs({ defaultMs: 1000, byOperation: { image: 5000 }, minMs: 100, maxMs: 3000 }, 'image'), 3000);
  assert.equal(resolveTimeoutMs({ defaultMs: 50, minMs: 100 }, 'chat'), 100);
});

test('timeout-policy: runWithTimeout rejects slow operations', async () => {
  await assert.rejects(
    () => runWithTimeout(() => new Promise((resolve) => setTimeout(resolve, 50)), { operationName: 'slow', timeoutMs: 5 }),
    /timed out after 5ms/,
  );
});

test('retry-policy: retries retryable errors and records attempts', async () => {
  let calls = 0;
  const attempts = [];
  const result = await runWithRetry(() => {
    calls += 1;
    if (calls < 3) throw Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' });
    return 'ok';
  }, { retries: 3, delayMs: 10, sleep: async () => undefined }, attempts);

  assert.equal(result, 'ok');
  assert.equal(calls, 3);
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].error.category, 'network');
});

test('retry-policy: stops on non-retryable validation errors', async () => {
  let calls = 0;
  await assert.rejects(
    () => runWithRetry(() => { calls += 1; throw new Error('missing b64_json/base64/url'); }, { retries: 5, delayMs: 0 }),
    /missing b64_json/,
  );
  assert.equal(calls, 1);
});

test('task-queue: limits concurrency per provider/model key', async () => {
  const queue = new TaskQueue({ defaultConcurrency: 1 });
  let running = 0;
  let maxRunning = 0;
  const release = [];
  const tasks = [1, 2, 3].map((id) => queue.enqueue({ provider: 'openai', model: 'gpt-image-2' }, async () => {
    running += 1;
    maxRunning = Math.max(maxRunning, running);
    await new Promise((resolve) => release.push(resolve));
    running -= 1;
    return id;
  }));

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(maxRunning, 1);
  assert.equal(queue.snapshot()[0].queued, 2);
  release.shift()();
  await new Promise((resolve) => setTimeout(resolve, 0));
  release.shift()();
  await new Promise((resolve) => setTimeout(resolve, 0));
  release.shift()();
  assert.deepEqual(await Promise.all(tasks), [1, 2, 3]);
});

test('task-queue: different model keys can run independently', async () => {
  const queue = new TaskQueue({ defaultConcurrency: 1 });
  let running = 0;
  let maxRunning = 0;
  const a = queue.enqueue({ provider: 'openai', model: 'a' }, async () => { running += 1; maxRunning = Math.max(maxRunning, running); await new Promise((resolve) => setTimeout(resolve, 10)); running -= 1; return 'a'; });
  const b = queue.enqueue({ provider: 'openai', model: 'b' }, async () => { running += 1; maxRunning = Math.max(maxRunning, running); await new Promise((resolve) => setTimeout(resolve, 10)); running -= 1; return 'b'; });
  assert.deepEqual(await Promise.all([a, b]), ['a', 'b']);
  assert.equal(maxRunning, 2);
  assert.equal(createModelQueueKey('OpenAI', 'GPT-4o'), 'openai::gpt-4o');
});
