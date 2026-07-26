import test from 'node:test';
import assert from 'node:assert/strict';

import { isBindingFresh, resolveNodeName, resolveRowStatus } from '../dist/packages/web-panel/src/index.js';

/**
 * 「能力分工」表格：体检快照 vs 实时配置。
 *
 * 原来的写法是 binding?.nodeName || 实时配置 || '—'——快照非空，
 * 兜底永远轮不到，用户在展开区改了节点，外层那一列纹丝不动。
 */

const BINDING = { key: 'chat', nodeIndex: 0, nodeName: '旧节点', model: 'gpt-4o-mini', ok: true, operations: ['chat'] };

test('快照与当前配置一致时才算数', () => {
  assert.equal(isBindingFresh(BINDING, { nodeIndex: 0, model: 'gpt-4o-mini' }), true);
  assert.equal(isBindingFresh(BINDING, { nodeIndex: 1, model: 'gpt-4o-mini' }), false, '换了节点');
  assert.equal(isBindingFresh(BINDING, { nodeIndex: 0, model: 'claude-opus-5' }), false, '换了模型');
  assert.equal(isBindingFresh(undefined, { nodeIndex: 0, model: 'x' }), false);
});

test('改了节点，那一列立刻显示新节点的名字', () => {
  const names = ['甲节点', '乙节点', '丙节点'];
  assert.equal(resolveNodeName(names, { nodeIndex: 0, model: 'gpt-4o-mini' }, BINDING), '甲节点');
  // 这条是这次的 bug 本体：快照还停在 0，配置已经指向 2
  assert.equal(resolveNodeName(names, { nodeIndex: 2, model: 'gpt-4o-mini' }, BINDING), '丙节点',
    '实时配置必须压过体检快照，否则改了节点界面不动');
});

test('节点没名字/索引越界时不能让那一列空掉', () => {
  assert.equal(resolveNodeName(['', '乙'], { nodeIndex: 0, model: 'm' }, BINDING), '旧节点', '退回快照名');
  assert.equal(resolveNodeName([], { nodeIndex: 3, model: 'm' }, undefined), '节点 4', '两个都没有就给占位');
  assert.equal(resolveNodeName(['甲'], { nodeIndex: 9, model: 'm' }, undefined), '节点 10');
});

test('状态点：改了还没保存时既不给绿也不给红', () => {
  const state = { nodeIndex: 0, model: 'gpt-4o-mini' };
  assert.equal(resolveRowStatus(BINDING, state), 'ok');
  assert.equal(resolveRowStatus({ ...BINDING, ok: false }, state), 'broken');

  // 换了节点：旧结论作废，新的还没算——沿用旧结论等于说谎
  assert.equal(resolveRowStatus(BINDING, { nodeIndex: 1, model: 'gpt-4o-mini' }), 'stale');
  assert.equal(resolveRowStatus({ ...BINDING, ok: false }, { nodeIndex: 1, model: 'gpt-4o-mini' }), 'stale',
    '刚把坏节点换成好节点，不该继续报红');
});

test('能力被关掉时优先显示「已停用」，不受体检结果影响', () => {
  const state = { nodeIndex: 0, model: 'gpt-4o-mini' };
  assert.equal(resolveRowStatus({ ...BINDING, ok: false }, state, { enabled: false }), 'disabled');
  assert.equal(resolveRowStatus(BINDING, { nodeIndex: 5, model: 'x' }, { enabled: false }), 'disabled');
});

test('压根没有体检结果时算 broken，不是 stale', () => {
  // stale 的含义是「有结论但已作废」；从没体检过是另一回事
  assert.equal(resolveRowStatus(undefined, { nodeIndex: 0, model: 'm' }), 'broken');
});
