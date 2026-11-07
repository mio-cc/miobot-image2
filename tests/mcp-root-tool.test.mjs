// Phase 2（方案 §4.4，D7/D17/D18/D22）：树形根工具单测
// 根构造（一服务器一根、默认 deny、description ≤500 字符）→ 子项映射（annotations/正则初筛、覆盖一票否决）
// → action 路由 / list_actions 目录 / mcp_unknown_action / 参数校验（$.params 路径）/ 输出前缀
// → 预算断言：N 子项服务器 → loadout 工具数 +1、schema 增量 = 根 schema（N=1/8/32 表驱动）
import test from 'node:test';
import assert from 'node:assert/strict';

import { McpClient } from '../dist/apps/bot/src/mcp-client.js';
import {
  buildMcpChildTools,
  buildMcpRootDescriptor,
  formatChildCatalog,
  McpRootToolHandler,
} from '../dist/apps/bot/src/mcp-root-tool.js';
import { toolSpecFromCapabilityDescriptor, toolSchemaByteLength, ToolRegistry } from '../dist/packages/tool-runtime/src/index.js';
import { startMcpHttpServer } from './fixtures/mcp-http-server.mjs';

const makeInvocation = (args) => ({
  plan: { planId: 'p1' },
  step: { id: 's1', capability: 'mcp.demo', args },
});

test('mcp root: 根 descriptor 构造——一服务器一根、默认 deny、分层摘要 ≤500 字符', () => {
  const children = buildMcpChildTools('demo', [
    { name: 'echo', description: 'Read and echo back the given text' },
    { name: 'generate', description: 'Create a new song' },
  ]);
  const descriptor = buildMcpRootDescriptor('demo', children);
  assert.equal(descriptor.id, 'mcp.demo');
  assert.equal(descriptor.provider, 'mcp:demo');
  assert.equal(descriptor.enabled, false, '根默认 deny');
  assert.equal(descriptor.riskLevel, 'medium');
  assert.ok(descriptor.description.length <= 500);
  assert.ok(descriptor.description.includes('2 个子操作'));
  assert.ok(descriptor.description.includes('list_actions'));
  assert.deepEqual((descriptor.inputSchema).required, ['action']);
  // D22：根覆盖（capabilityOverrides['mcp.demo']）——name/enabled/riskLevel/approvalRequired。
  const overridden = buildMcpRootDescriptor('demo', children, { name: 'Suno 官方', enabled: true, riskLevel: 'high', approvalRequired: true });
  assert.equal(overridden.name, 'Suno 官方');
  assert.equal(overridden.enabled, true);
  assert.equal(overridden.riskLevel, 'high');
  assert.equal(overridden.approvalRequired, true);
});

test('mcp root: 子项映射——annotations 初筛、正则兜底、覆盖一票否决（D8/D22）', () => {
  const children = buildMcpChildTools('demo', [
    { name: 'query', description: 'Query records', annotations: { readOnlyHint: true } },
    { name: 'purge', description: 'Purge records', annotations: { destructiveHint: true } },
    { name: 'plain', description: 'Do something' },
    { name: '中文查询', description: '查询数据' },
  ], {
    'mcp.demo.purge': { riskLevel: 'low' }, // 覆盖一票否决：destructiveHint 高风险被覆盖为 low
    'mcp.demo.query': { enabled: false },
    'mcp.demo.中文查询': { name: '数据查询' },
  });
  const byName = Object.fromEntries(children.map((child) => [child.name, child]));
  assert.equal(byName.query.riskLevel, 'low', 'readOnlyHint → low');
  assert.equal(byName.purge.riskLevel, 'low', '覆盖否决 annotations');
  assert.equal(byName.plain.riskLevel, 'medium', '默认 medium');
  assert.equal(byName.query.enabled, false, '覆盖停用子项');
  assert.equal(byName['中文查询'].displayName, '数据查询', 'D22 显示名覆盖');
  assert.equal(byName['中文查询'].riskLevel, 'low', '中文正则兜底');
});

test('mcp root: handler——list_actions 目录 / action 路由 / unknown_action / 参数校验 / 输出前缀（真实 HTTP 链路）', async () => {
  const server = await startMcpHttpServer();
  try {
    const client = new McpClient({ id: 'demo', enabled: true, transport: 'http', url: server.url }, { timeoutMs: 5000 });
    await client.initialize();
    const tools = await client.listTools();
    const children = buildMcpChildTools('demo', tools, { 'mcp.demo.send_message': { enabled: false } });
    const handler = new McpRootToolHandler(client, 'demo', children);

    // list_actions：目录文本，不触发外部调用。
    const catalog = await handler.execute(makeInvocation({ action: 'list_actions' }));
    assert.equal(catalog.status, 'success');
    assert.ok(catalog.outputs[0].text.includes('echo'), '目录包含子项名');
    assert.ok(catalog.outputs[0].text.includes('必填参数：text'), '目录含 required 提示');
    assert.ok(catalog.outputs[0].text.includes('已停用'), '目录标注停用子项');

    // action 路由 + 输出前缀。
    const called = await handler.execute(makeInvocation({ action: 'echo', params: { text: '你好' } }));
    assert.equal(called.status, 'success');
    assert.equal(called.outputs[0].text, '[mcp.demo/echo] echo:你好');
    assert.equal(called.diagnostics.action, 'echo', '诊断带 action 上下文');

    // 未知 action：附可用清单与近似建议。
    const unknown = await handler.execute(makeInvocation({ action: 'ech', params: {} }));
    assert.equal(unknown.status, 'failed');
    assert.ok(unknown.error.startsWith('mcp_unknown_action:ech'));
    assert.ok(unknown.error.includes('echo'), '近似建议');
    assert.equal(unknown.retryable, false);

    // 停用子项：mcp_action_disabled。
    const disabled = await handler.execute(makeInvocation({ action: 'send_message', params: {} }));
    assert.equal(disabled.status, 'failed');
    assert.ok(disabled.error.startsWith('mcp_action_disabled'));

    // 参数校验：$.params 路径 + required 提示。
    const invalid = await handler.execute(makeInvocation({ action: 'echo', params: {} }));
    assert.equal(invalid.status, 'failed');
    assert.ok(invalid.error.startsWith('mcp_action_params_invalid:echo'));
    assert.ok(invalid.error.includes('$.params.text'), '错误带字段路径');

    // 未带 action：默认 list_actions。
    const noAction = await handler.execute(makeInvocation({}));
    assert.equal(noAction.status, 'success');
    assert.ok(noAction.outputs[0].text.includes('子操作清单'));

    client.close();
  } finally {
    await server.close();
  }
});

test('mcp root: 预算断言——N 子项服务器 loadout 工具数 +1、根 schema 字节恒定不随 N 增长（N=1/8/32 表驱动）', () => {
  const schemaBytesByN = {};
  for (const n of [1, 8, 32]) {
    const tools = Array.from({ length: n }, (_, index) => ({ name: `tool_${index}`, description: `Tool number ${index}` }));
    const children = buildMcpChildTools('demo', tools);
    // 预算断言关注 loadout 形态：根以 enabled+domain 进入（默认 deny 会被 enabled 过滤，与预算无关）。
    const descriptor = buildMcpRootDescriptor('demo', children, { enabled: true });
    const registry = new ToolRegistry();
    registry.register(toolSpecFromCapabilityDescriptor(descriptor, { exposure: 'domain' }));
    const loadout = registry.resolveLoadout({ exposures: ['core', 'domain'], maxTools: 24, maxSchemaBytes: 48000 });
    assert.equal(loadout.tools.filter((tool) => tool.name === 'mcp.demo').length, 1, `N=${n}：根工具恰 1 个`);
    assert.equal(loadout.tools.length, 1, `N=${n}：整个 loadout 只有根（无平铺子项）`);
    const rootSpec = loadout.tools.find((tool) => tool.name === 'mcp.demo');
    schemaBytesByN[n] = toolSchemaByteLength({ inputSchema: rootSpec.inputSchema, outputSchema: rootSpec.outputSchema });
    assert.ok(schemaBytesByN[n] < 2000, `N=${n}：根 schema 字节远低于 48KB 预算（实际 ${schemaBytesByN[n]}）`);
  }
  assert.equal(schemaBytesByN[1], schemaBytesByN[32], '根 schema 字节与子项数量无关（O(1) 常驻，树形预算压缩）');
});

test('mcp root: formatChildCatalog——空树与超长截断', () => {
  assert.ok(formatChildCatalog('demo', []).includes('没有已进树的子操作'));
  const many = buildMcpChildTools('demo', Array.from({ length: 45 }, (_, index) => ({ name: `t${index}`, description: `Tool ${index}` })));
  const text = formatChildCatalog('demo', many);
  assert.ok(text.includes('仅显示前 40 项'));
});
