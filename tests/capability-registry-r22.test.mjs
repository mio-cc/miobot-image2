import test from 'node:test';
import assert from 'node:assert/strict';

const { createDefaultConfig } = await import('../dist/packages/config/src/index.js');
const { OrchestrationEnforcer } = await import('../dist/apps/bot/src/orchestration-enforce.js');
const { HttpCapabilityRegistry } = await import('../dist/apps/bot/src/capability-http-generic.js');

test('R22 assembled handlers and HTTP descriptors reach listCapabilities', () => {
  const cfg = createDefaultConfig();
  cfg.orchestration.enabled = true;
  cfg.orchestration.mode = 'enforce';
  const fakeApp = {
    handle: async () => ({ kind: 'chat', handled: true, text: 'chat' }),
    engine: { handleExplicit: async () => null },
    sessions: { clear() {} }, registry: () => ({}), client: {},
  };
  const fakeClient = { chat: async () => ({ text: '{}' }) };
  const handler = { execute: async () => ({ jobId: 'p', stepId: 's', status: 'success', outputs: [] }) };
  const handlers = new Map([['http.example', handler]]);
  const enforcer = new OrchestrationEnforcer({ getConfig: () => cfg, app: fakeApp, client: fakeClient, handlers });
  assert.equal(enforcer.getCapabilityHandler('http.example'), handler, '装配层 handler 必须进入 dispatcher');
  const http = new HttpCapabilityRegistry({
    getConfig: () => ({ browserRender: { allowPrivateHosts: false } }),
    assertSafeUrl: async (raw) => new URL(raw),
  });
  http.load([{ id: 'http.example', name: 'Example', description: 'x', category: '信息', endpoint: 'https://example.test/api', outputKind: 'text' }]);
  const descriptor = http.toCapabilityDescriptor('http.example');
  assert.ok(descriptor, 'HTTP descriptor must be generated');
  enforcer.registerCapability(descriptor, handler);
  assert.ok(enforcer.listCapabilities().some((item) => item.id === 'http.example'), 'registered HTTP descriptor must be listed');
  assert.equal(enforcer.getCapabilityHandler('http.example'), handler);
});
