import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AuditService } from '../dist/apps/bot/src/audit-service.js';
import { pruneOrchestrationTraces } from '../dist/apps/bot/src/orchestration-trace.js';
import { ApprovalBroker, createApproval, decideApproval } from '../dist/packages/orchestration/src/index.js';

function tempFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miobot-audit-'));
  return path.join(dir, name);
}

test('audit: sensitive keys are redacted and retention removes old records', async () => {
  const file = tempFile('audit.jsonl');
  const audit = new AuditService({ filePath: file, retentionDays: 30, maxEntries: 100 });
  audit.append({ type: 'config.change', actor: 'owner', data: { apiKey: 'secret-value', nested: { password: 'p', note: 'keep' } } });
  audit.append({ type: 'file.delete', actor: 'u1', timestamp: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString(), data: { artifactId: 'old' } });
  const pruned = await audit.prune();
  assert.equal(pruned.removed, 1);
  const records = await audit.list(20);
  assert.equal(records.length, 1);
  assert.equal(records[0].data.apiKey, '[REDACTED]');
  assert.equal(records[0].data.nested.password, '[REDACTED]');
  assert.equal(records[0].data.nested.note, 'keep');
});

test('audit: trace retention prunes by timestamp', async () => {
  const file = tempFile('trace.jsonl');
  fs.writeFileSync(file, [
    JSON.stringify({ id: 'old', timestamp: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(), stage: 'request', summary: 'old' }),
    JSON.stringify({ id: 'new', timestamp: new Date().toISOString(), stage: 'request', summary: 'new' }),
  ].join('\n') + '\n');
  await pruneOrchestrationTraces(file, { retentionDays: 30, maxEntries: 100, maxBytes: 1024 * 1024 });
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.deepEqual(lines.map((item) => item.id), ['new']);
});

test('audit: approval retention keeps pending and protected approvals', () => {
  const old = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
  const terminal = createApproval({
    requestId: 'r-old', jobId: 'j-old', payload: { a: 1 }, capability: 'file.delete', riskLevel: 'high',
    requesterQq: '1', adminQqIds: ['900'], ttlMs: 60000, now: old,
  });
  const approved = decideApproval(terminal, { adminQq: '900', decision: 'approve', at: new Date(old.getTime() + 1000).toISOString() }, undefined, new Date(old.getTime() + 1000));
  const pending = createApproval({
    requestId: 'r-new', jobId: 'j-new', payload: { b: 2 }, capability: 'file.delete', riskLevel: 'high',
    requesterQq: '1', adminQqIds: ['900'], ttlMs: 600000,
  });
  const broker = new ApprovalBroker();
  broker.restore([approved, pending]);
  const cutoff = Date.now() - 180 * 24 * 60 * 60 * 1000;
  assert.equal(broker.pruneTerminal(cutoff).length, 1);
  assert.equal(broker.list().length, 1);
  broker.restore([approved, pending]);
  assert.equal(broker.pruneTerminal(cutoff, new Set([approved.approvalId])).length, 0);
  assert.equal(broker.list().length, 2);
});