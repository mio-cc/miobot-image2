import test from 'node:test';
import assert from 'node:assert/strict';

const { builtinCapabilityDescriptors, applyCapabilityOverrides, buildCapabilityManifest } = await import('../dist/packages/orchestration/src/index.js');
const { toolSpecFromCapabilityDescriptor } = await import('../dist/packages/tool-runtime/src/index.js');
const { normalizeConfig } = await import('../dist/packages/config/src/index.js');

test('R25 presentationHint defaults to empty and does not alter tool descriptions', () => {
  const descriptor = builtinCapabilityDescriptors().find((item) => item.id === 'web.search');
  assert.ok(descriptor);
  assert.equal(descriptor.presentationHint, '');
  const spec = toolSpecFromCapabilityDescriptor(descriptor); spec.exposure = 'core';
  assert.equal(spec.metadata?.presentationHint, '');
  assert.doesNotMatch(spec.description, /展示方式推荐/);
});

test('R25 presentationHint follows capability overrides into tool contract, planner manifest and config JSON', () => {
  const descriptor = builtinCapabilityDescriptors().find((item) => item.id === 'web.search');
  const withHint = applyCapabilityOverrides([descriptor], {
    'web.search': { presentationHint: '图表' },
  })[0];
  assert.equal(withHint.presentationHint, '图表');

  const spec = toolSpecFromCapabilityDescriptor(withHint);
  assert.equal(spec.metadata?.presentationHint, '图表');
  assert.match(spec.description, /【展示方式推荐】图表/);

  const manifest = buildCapabilityManifest([withHint]);
  assert.equal(manifest.capabilities[0].presentationHint, '图表');

  const cfg = normalizeConfig({
    orchestration: { capabilityOverrides: { 'web.search': { presentationHint: '图表' } } },
  });
  assert.equal(cfg.orchestration.capabilityOverrides['web.search'].presentationHint, '图表');
});

test('R25 a future plugin can define presentationHint in its descriptor', () => {
  const descriptor = {
    id: 'plugin.future',
    version: '1.0.0',
    name: '未来插件',
    description: '返回排行榜数据',
    presentationHint: '排行榜',
    provider: 'plugin-future',
    enabled: true,
    mode: 'sync',
    riskLevel: 'low',
    inputSchema: { type: 'object', properties: {}, additionalProperties: true },
  };
  const spec = toolSpecFromCapabilityDescriptor(descriptor); spec.exposure = 'core';
  assert.equal(spec.metadata?.presentationHint, '排行榜');
  assert.match(spec.description, /【展示方式推荐】排行榜/);
  assert.equal(buildCapabilityManifest([descriptor]).capabilities[0].presentationHint, '排行榜');
});

test('R25 the hint is actually present in the tool definition sent to the Agent model', async () => {
  const { createAgentHost } = await import('../dist/apps/bot/src/agent-host.js');
  const { createDefaultConfig } = await import('../dist/packages/config/src/index.js');
  const { InMemoryAgentSessionManager } = await import('../dist/packages/agent-runtime/src/index.js');
  const descriptor = {
    id: 'plugin.hinted', version: '1.0.0', name: '带推荐的能力', description: '返回数据',
    presentationHint: '图表', provider: 'plugin-test', enabled: true, mode: 'sync', riskLevel: 'low',
    inputSchema: { type: 'object', properties: {}, additionalProperties: true },
  };
  const spec = toolSpecFromCapabilityDescriptor(descriptor); spec.exposure = 'core';
  const captured = [];
  const cfg = createDefaultConfig();
  cfg.agent.enabled = true;
  cfg.agent.mode = 'enforce';
  cfg.freeMode.enabled = false;
  cfg.toolRegistry.enabled = true;
  const host = createAgentHost({
    getConfig: () => cfg,
    client: {
      async chat(_nodeIndex, request) {
        captured.push(request);
        return { text: '已处理。', raw: {}, finishReason: 'stop' };
      },
      can: () => true,
    },
    sessions: new InMemoryAgentSessionManager({}),
    toolBindings: () => [{ spec, handler: async (call) => ({ ok: true, callId: call.id, content: 'ok', outputs: [] }) }],
    preflightToolCall: () => ({ allowed: true }),
  });
  await host({ text: '处理一下', chatType: 'private', userId: '1', sessionId: 'private:hint' });
  const tools = captured[0]?.toolSpecs || captured[0]?.tools || [];

  const tool = tools.find((item) => item?.function?.name === 'plugin.hinted' || item?.name === 'plugin.hinted');
  assert.ok(tool, 'hinted tool should be in model request: ' + JSON.stringify(tools.map((item) => item?.function?.name || item?.name)));
  const text = JSON.stringify(tool);
  assert.match(text, /展示方式推荐/);
  assert.match(text, /图表/);
});
