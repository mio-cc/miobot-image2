import test from 'node:test';
import assert from 'node:assert/strict';

const { inferCapabilityToolExposure } = await import('../dist/apps/bot/src/capability-tool-adapter.js');
const { toolSpecFromCapabilityDescriptor, ToolRegistry } = await import('../dist/packages/tool-runtime/src/index.js');
const { builtinCapabilityDescriptors } = await import('../dist/packages/orchestration/src/builtin-capabilities.js');

const base = (id, provider) => ({
  id, name: id, description: id, provider, mode: 'sync', riskLevel: 'low', mergeable: true,
  outputKinds: ['text'], inputSchema: { type: 'object', properties: {}, additionalProperties: true },
});

test('R23 HTTP/plugin/MCP capabilities are domain-visible without tool search', () => {
  assert.equal(inferCapabilityToolExposure(base('http.weather', 'http-generic')), 'core');
  assert.equal(inferCapabilityToolExposure(base('novel.platform', 'plugin-novel')), 'core');
  assert.equal(inferCapabilityToolExposure(base('mcp.search', 'mcp:demo')), 'core');
  assert.equal(inferCapabilityToolExposure(base('web.fetch', 'builtin')), undefined);
  assert.equal(inferCapabilityToolExposure(base('http.weather', 'http-generic'), 'hidden'), 'hidden');
});

test('R23 core discovery tools are visible as domain tools', () => {
  for (const id of ['capability.catalog', 'web.fetch', 'job.cancel', 'report.render']) {
    assert.equal(toolSpecFromCapabilityDescriptor(base(id, 'builtin')).exposure, id === 'capability.catalog' ? 'domain' : id === 'web.fetch' || id === 'job.cancel' || id === 'report.render' ? 'domain' : undefined);
  }
});

test('R23 dynamic HTTP/plugin tools survive the production 24-tool loadout budget', () => {
  const specs = [];
  for (const descriptor of builtinCapabilityDescriptors()) {
    specs.push(toolSpecFromCapabilityDescriptor(descriptor, { exposure: inferCapabilityToolExposure(descriptor) }));
  }
  for (const [id, provider] of [['http.weather', 'http-generic'], ['http.bing', 'http-generic'], ['novel.platform', 'plugin-novel']]) {
    const descriptor = base(id, provider);
    specs.push(toolSpecFromCapabilityDescriptor(descriptor, { exposure: inferCapabilityToolExposure(descriptor) }));
  }
  const registry = new ToolRegistry();
  for (const spec of specs) registry.register(spec);
  const loadout = registry.resolveLoadout({ exposures: ['core', 'domain'], maxTools: 24 });
  const names = new Set(loadout.tools.map((tool) => tool.name));
  assert.ok(names.has('http.weather'));
  assert.ok(names.has('http.bing'));
  assert.ok(names.has('novel.platform'));
  assert.ok(names.has('capability.catalog'));
});
