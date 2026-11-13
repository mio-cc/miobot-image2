import test from 'node:test';
import assert from 'node:assert/strict';

import { memoryDayKey } from '../dist/apps/bot/src/memory-service.js';

test('memory retention: day buckets use Asia/Shanghai regardless of server timezone', () => {
  assert.equal(memoryDayKey('2026-11-13T15:59:59.000Z'), '2026-11-13');
  assert.equal(memoryDayKey('2026-11-13T16:00:00.000Z'), '2026-11-14');
  assert.equal(memoryDayKey('2026-11-13T23:30:00.000+08:00'), '2026-11-13');
  assert.equal(memoryDayKey('bad-date'), '');
});
