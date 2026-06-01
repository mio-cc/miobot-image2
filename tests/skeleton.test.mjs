import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const rawPackageJson = readFileSync(new URL('../package.json', import.meta.url), 'utf8').replace(/^\uFEFF/, '');
const pkg = JSON.parse(rawPackageJson);

test('v2 skeleton package metadata is present', () => {
  assert.equal(pkg.name, 'napcat-omnibot-v2');
  assert.ok(Array.isArray(pkg.workspaces));
  assert.ok(pkg.workspaces.includes('packages/*'));
  assert.ok(pkg.workspaces.includes('apps/*'));
});
