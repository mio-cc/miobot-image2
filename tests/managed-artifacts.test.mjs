import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ManagedArtifactRegistry, FileDeleteCapabilityHandler } from '../dist/apps/bot/src/managed-artifacts.js';

function setup() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'miobot-artifacts-'));
  const root = path.join(base, 'generated');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  const registry = new ManagedArtifactRegistry({ filePath: path.join(base, 'artifacts.json'), roots: [root] });
  return { base, root, outside, registry };
}

test('managed artifacts: owner/group scope isolation', () => {
  const { root, registry } = setup();
  const file = path.join(root, 'a.txt');
  fs.writeFileSync(file, 'alpha');
  const record = registry.register({ scope: { chatType: 'group', groupId: 'g1', userId: 'u1' }, localPath: file, name: 'a.txt', source: 'test' });
  assert.match(record.artifactId, /^art_/);
  assert.equal(registry.getOwned(record.artifactId, { chatType: 'group', groupId: 'g1', userId: 'u1' })?.artifactId, record.artifactId);
  assert.equal(registry.getOwned(record.artifactId, { chatType: 'group', groupId: 'g1', userId: 'u2' }), undefined);
  assert.equal(registry.getOwned(record.artifactId, { chatType: 'group', groupId: 'g2', userId: 'u1' }), undefined);
  assert.equal(registry.list({ chatType: 'private', userId: 'u1' }).length, 0);
});

test('managed artifacts: delete verifies fingerprint and removes file', () => {
  const { root, registry } = setup();
  const file = path.join(root, 'delete.txt');
  fs.writeFileSync(file, 'delete-me');
  const record = registry.register({ scope: { chatType: 'private', userId: 'u1' }, localPath: file, source: 'test' });
  const deleted = registry.deleteOwned(record.artifactId, { chatType: 'private', userId: 'u1' });
  assert.ok(deleted.deletedAt);
  assert.equal(fs.existsSync(file), false);
});

test('managed artifacts: changed file is rejected after approval', () => {
  const { root, registry } = setup();
  const file = path.join(root, 'changed.txt');
  fs.writeFileSync(file, 'before');
  const record = registry.register({ scope: { chatType: 'private', userId: 'u1' }, localPath: file, source: 'test' });
  fs.writeFileSync(file, 'after-change');
  assert.throws(() => registry.deleteOwned(record.artifactId, { chatType: 'private', userId: 'u1' }), /artifact_(changed|hash_changed)/);
  assert.equal(fs.existsSync(file), true);
});

test('managed artifacts: outside roots and symlinks are rejected', () => {
  const { root, outside, registry } = setup();
  const outsideFile = path.join(outside, 'secret.txt');
  fs.writeFileSync(outsideFile, 'secret');
  assert.throws(() => registry.register({ scope: { chatType: 'private', userId: 'u1' }, localPath: outsideFile, source: 'test' }), /outside_managed_roots/);
  const link = path.join(root, 'link.txt');
  try {
    fs.symlinkSync(outsideFile, link);
    assert.throws(() => registry.register({ scope: { chatType: 'private', userId: 'u1' }, localPath: link, source: 'test' }), /regular_file|outside_managed_roots/);
  } catch (error) {
    if (error?.code !== 'EPERM') throw error;
  }
});

test('managed artifacts: file.delete handler only works with owned artifact id', async () => {
  const { root, registry } = setup();
  const file = path.join(root, 'handler.txt');
  fs.writeFileSync(file, 'handler');
  const record = registry.register({ scope: { chatType: 'private', userId: 'u1' }, localPath: file, source: 'test' });
  const handler = new FileDeleteCapabilityHandler(registry);
  const invocation = {
    request: { chat: { type: 'private', userId: 'u1' }, user: { qq: 'u1' } },
    plan: { planId: 'p1' }, step: { id: 's1', capability: 'file.delete', args: { artifactId: record.artifactId } },
  };
  const result = await handler.execute(invocation);
  assert.equal(result.status, 'success');
  assert.equal(fs.existsSync(file), false);
  const foreign = await handler.execute({ ...invocation, request: { ...invocation.request, user: { qq: 'u2' } } });
  assert.equal(foreign.status, 'failed');
  assert.match(foreign.error, /artifact_not_found_or_forbidden/);
});