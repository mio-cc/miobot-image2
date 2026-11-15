import test from 'node:test';
import assert from 'node:assert/strict';

import { parseArgs, parsePs, redact } from '../scripts/runtime-diagnostics.mjs';

test('runtime diagnostics: parses options and samples', () => {
  const options = parseArgs(['--samples', '3', '--interval', '2', '--top', '10', '--journal-lines', '0', '--no-journal', '--json', '--save', '/tmp/report.json']);
  assert.equal(options.samples, 3);
  assert.equal(options.interval, 2);
  assert.equal(options.top, 10);
  assert.equal(options.journalLines, 0);
  assert.equal(options.noJournal, true);
  assert.equal(options.json, true);
  assert.equal(options.save, '/tmp/report.json');
  assert.throws(() => parseArgs(['--nope']), /unknown option/);
});

test('runtime diagnostics: redacts credentials in process/journal text', () => {
  const text = redact('API_TOKEN=abc --api-key=secret-value NORMAL=ok');
  assert.ok(!text.includes('abc'));
  assert.ok(!text.includes('secret-value'));
  assert.ok(text.includes('NORMAL=ok'));
});

test('runtime diagnostics: parses ps rows with full command', () => {
  const rows = parsePs('  101     1 root      12.5  3.2 01:02:03 Sl /usr/bin/node scripts/bot-runtime-v2.mjs\n');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].pid, 101);
  assert.equal(rows[0].ppid, 1);
  assert.equal(rows[0].cpu, 12.5);
  assert.equal(rows[0].args, '/usr/bin/node scripts/bot-runtime-v2.mjs');
});
