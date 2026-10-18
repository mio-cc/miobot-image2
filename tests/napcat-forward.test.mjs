import test from 'node:test';
import assert from 'node:assert/strict';

import { buildNestedTextForwardNodes } from '../dist/packages/napcat/src/index.js';

test('napcat: nested text forward keeps inner chunks as node children of one outer node', () => {
  const nodes = buildNestedTextForwardNodes([
    [{ title: 'Miobot 1/2', content: '(1/2) first' }],
    [{ title: 'Miobot 2/2', content: '(2/2) second' }],
  ], { botName: 'Miobot', userId: '10000' });
  assert.equal(nodes.length, 2);
  assert.equal(nodes[0].type, 'node');
  assert.equal(nodes[0].data.nickname, 'Miobot 合并转发 1/2');
  const inner = nodes[0].data.content;
  assert.equal(inner[0].type, 'node');
  assert.equal(inner[0].data.nickname, 'Miobot 1/2');
  assert.deepEqual(inner[0].data.content, [{ type: 'text', data: { text: '(1/2) first' } }]);
});