import test from 'node:test';
import assert from 'node:assert/strict';
import { createMetrics, METRIC_EVENTS } from '../dist/packages/core/src/metrics.js';

test('metrics R9: agent_failure participates in totals, series and event catalog', () => {
  const metrics = createMetrics({ now: () => Date.parse('2026-10-26T14:00:00.000Z') });
  metrics.record('agent_failure');
  metrics.record('agent_failure');
  const snapshot = metrics.snapshot();
  assert.ok(METRIC_EVENTS.includes('agent_failure'));
  assert.equal(snapshot.totals.agent_failure, 2);
  assert.equal(snapshot.series.agent_failure.reduce((sum, value) => sum + value, 0), 2);
});
