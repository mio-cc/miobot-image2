import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const router = readFileSync('web-panel/src/router/index.ts', 'utf8');

test('R22 panel routes have exactly one /search and /render definition', () => {
  assert.equal((router.match(/path:\s*'\/search'/g) || []).length, 1);
  assert.equal((router.match(/path:\s*'\/render'/g) || []).length, 1);
  assert.ok(!router.includes("path: '/search',\n        redirect"));
  assert.ok(!router.includes("path: '/render',\n        redirect"));
});
