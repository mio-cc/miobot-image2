import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  parseArgs,
  resolvePaths,
  formatBytes,
  parseDu,
  parseSizePath,
  parseFindOutput,
} from '../scripts/storage-maintenance.mjs';

test('storage: formatBytes keeps readable units', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1024), '1.0 KiB');
  assert.equal(formatBytes(1024 * 1024), '1.0 MiB');
});

test('storage: parseArgs parses command and options in both syntaxes', () => {
  const options = parseArgs(['clean', '--apply', '--yes', '--data-dir=/srv/data', '--backup-days=9']);
  assert.equal(options.command, 'clean');
  assert.equal(options.apply, true);
  assert.equal(options.yes, true);
  assert.equal(options.dataDir, '/srv/data');
  assert.equal(options.backupDays, 9);
  assert.equal(parseArgs(['clean', '--include-logs', '--log-days=21']).logDays, 21);
  assert.equal(parseArgs([]).dataDir, undefined, 'path defaults must stay unresolved so env file can win');
});

test('storage: parseArgs rejects unknown options and invalid numbers', () => {
  assert.throws(() => parseArgs(['scan', '--nope']), /unknown option/);
  assert.throws(() => parseArgs(['scan', '--backup-days=0']), /invalid positive number/);
});

test('storage: resolvePaths prefers CLI, then environment, then defaults', () => {
  const envFile = { DATA_DIR: '/srv/file-data', MIOBOT_RUNTIME_DIR: '/srv/file-runtime', LOG_DIR: '/srv/file-log' };
  const fromEnv = resolvePaths({}, { DATA_DIR: '/srv/env-data', MIOBOT_RUNTIME_DIR: '/srv/env-runtime', LOG_DIR: '/srv/env-log' }, envFile);
  assert.equal(fromEnv.dataDir, path.resolve('/srv/env-data'));
  assert.equal(fromEnv.memoryDir, path.resolve('/srv/env-runtime/memory'));
  assert.equal(fromEnv.logDir, path.resolve('/srv/env-log'));
  const fromCli = resolvePaths({ dataDir: '/srv/cli-data' }, {}, envFile);
  assert.equal(fromCli.dataDir, path.resolve('/srv/cli-data'));
});

test('storage: du and find output parsers keep sizes and paths', () => {
  assert.deepEqual(parseDu('12\t/var/data\n4096\t/var/data/memory\n'), [
    { path: '/var/data/memory', bytes: 4096 },
    { path: '/var/data', bytes: 12 },
  ]);
  assert.deepEqual(parseSizePath('8\t/tmp/a\n'), [{ path: '/tmp/a', bytes: 8 }]);
  const rows = parseFindOutput('1700000000\t42\t/tmp/old\n');
  assert.equal(rows[0].bytes, 42);
  assert.equal(rows[0].mtimeMs, 1700000000 * 1000);
});
