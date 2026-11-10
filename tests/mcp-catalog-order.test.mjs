import test from 'node:test';
import assert from 'node:assert/strict';
import { fitCatalogLines, prioritizeMcpCatalogDescriptors } from '../dist/apps/bot/src/capability-basic.js';

test('capability.catalog: MCP roots survive truncation and non-MCP order is stable', () => {
  const regular = Array.from({ length: 50 }, (_, index) => ({ id: `tool.${index}` }));
  const roots = [{ id: 'mcp.suno-official' }, { id: 'mcp.box' }];
  const ordered = prioritizeMcpCatalogDescriptors([...regular, ...roots]);
  assert.deepEqual(ordered.slice(0, 2).map((item) => item.id), ['mcp.suno-official', 'mcp.box']);
  assert.deepEqual(ordered.slice(0, 40).filter((item) => item.id.startsWith('mcp.')).map((item) => item.id), ['mcp.suno-official', 'mcp.box']);
  assert.deepEqual(ordered.slice(2).map((item) => item.id), regular.map((item) => item.id), '非 MCP 顺序保持稳定');
});

test('capability.catalog: uses a character budget instead of a hard 40-line cut', () => {
  const currentCatalog = Array.from({ length: 66 }, (_, index) => `- tool.${index}: ${'x'.repeat(80)}`);
  const fitted = fitCatalogLines(currentCatalog, 12_000);
  assert.equal(fitted.lines.length, 66, 'current 66-item catalog should fit');
  assert.equal(fitted.omitted, 0);

  const oversized = Array.from({ length: 500 }, (_, index) => `- tool.${index}: ${'x'.repeat(100)}`);
  const bounded = fitCatalogLines(oversized, 12_000);
  assert.ok(bounded.lines.length > 40, 'budget should allow more than 40 lines');
  assert.ok(bounded.omitted > 0);
  assert.ok(bounded.usedChars <= 12_000);
});
