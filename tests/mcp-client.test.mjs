import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { McpClient, mcpToolToDescriptor, McpToolCapabilityHandler, inferEffectFromDescription } from '../dist/apps/bot/src/mcp-client.js';
import { createDefaultConfig } from '../dist/packages/config/src/index.js';
import { OrchestrationEnforcer } from '../dist/apps/bot/src/orchestration-enforce.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const serverScript = path.join(dir, 'fixtures', 'mcp-echo-server.mjs');

test('mcp T4.1: stdio client——initialize/list/call 全链路', async () => {
  const client = new McpClient({ id: 'echo', enabled: true, transport: 'stdio', command: process.execPath, args: [serverScript] }, { timeoutMs: 10000 });
  await client.initialize();
  const tools = await client.listTools();
  assert.equal(tools.length, 2);
  assert.equal(tools[0].name, 'echo');
  const called = await client.callTool('echo', { text: '你好' });
  assert.deepEqual(called.content, [{ type: 'text', text: 'echo:你好' }]);
  const failed = await client.callTool('nope', {}).catch(() => null);
  assert.equal(failed, null, '未知工具按 JSON-RPC error 拒绝');
  client.close();
});

test('mcp T4.1: tool → descriptor——effect 推断、默认 deny、allowlist 过滤', () => {
  const echoTool = { name: 'echo', description: 'Read and echo back the given text' };
  const sendTool = { name: 'send_message', description: 'Send a message to an external channel' };
  const echoDescriptor = mcpToolToDescriptor('echo', echoTool);
  assert.equal(echoDescriptor.id, 'mcp.echo.echo');
  assert.equal(echoDescriptor.effect, 'retrieve', 'read/echo → retrieve');
  assert.equal(echoDescriptor.riskLevel, 'medium');
  assert.equal(echoDescriptor.enabled, false, '默认全 deny');
  assert.equal(echoDescriptor.sideEffects?.includes('external_call'), true);
  const sendDescriptor = mcpToolToDescriptor('echo', sendTool);
  assert.equal(sendDescriptor.effect, 'mutate', 'send → mutate');
  assert.equal(inferEffectFromDescription('Generate a nice image'), 'generate');
  assert.equal(inferEffectFromDescription('删除指定记录'), 'delete');
  assert.equal(inferEffectFromDescription(''), 'unknown');
});

test('mcp T4.1: 注册进 enforcer 后（显式启用）可被规划执行', async () => {
  const cfg = createDefaultConfig();
  cfg.orchestration.enabled = true;
  cfg.orchestration.mode = 'enforce';
  cfg.orchestration.planner.enabled = true;
  cfg.orchestration.planner.actionAlignmentGuardEnabled = false;
  cfg.orchestration.planner.nodeIndex = 1;
  cfg.orchestration.planner.model = 'planner-test';
  const fakeApp = {
    handle: async () => ({ kind: 'chat', handled: true, text: 'chat', decision: { kind: 'chat', source: 'fallback', confidence: 1, reason: '', params: { prompt: '', tokens: [] }, usedPlanner: false } }),
    engine: { handleExplicit: async () => null },
    sessions: { clear() {} }, registry: () => ({}), client: {},
  };
  const fakeClient = {
    async chat() {
      return { text: JSON.stringify({ planId: 'p1', requestId: 'r1', goal: 'answer', steps: [{ id: 's1', capability: 'mcp.echo.echo', args: { text: '你好' } }], confidence: 0.9 }) };
    },
  };
  const enforcer = new OrchestrationEnforcer({ getConfig: () => cfg, app: fakeApp, client: fakeClient });
  const mcp = new McpClient({ id: 'echo', enabled: true, transport: 'stdio', command: process.execPath, args: [serverScript] }, { timeoutMs: 10000 });
  await mcp.initialize();
  const descriptor = { ...mcpToolToDescriptor('echo', { name: 'echo', description: 'Read and echo back the given text' }), enabled: true };
  enforcer.registerCapability(descriptor, new McpToolCapabilityHandler(mcp, 'echo'));
  const result = await enforcer.handle({ text: '回声 你好', chatType: 'private', userId: '1' });
  mcp.close();
  assert.equal(result.handled, true);
  const text = (result.result?.text || '') + JSON.stringify(result.result?.replyPlan?.groups || []);
  assert.ok(text.includes('echo:你好'), 'MCP 工具输出应送达：' + text.slice(0, 200));
});

test('mcp T4.1: 配置规整——mcpServers 非法条目丢弃', async () => {
  const cfg = createDefaultConfig();
  assert.deepEqual(cfg.orchestration.mcpServers, []);
  const { importConfig } = await import('../dist/packages/config/src/index.js');
  const result = importConfig({ orchestration: { mcpServers: [
    { id: 'ok-http', enabled: true, transport: 'http', url: 'http://mcp.local/mcp' },
    { id: 'ok-stdio', transport: 'stdio', command: 'node', args: ['s.mjs'], allowlist: ['echo'] },
    { id: 'no-command', transport: 'stdio' },
    { transport: 'http', url: 'http://x' },
    { id: 'no-url', transport: 'http' },
  ] } });
  const servers = result.config.orchestration.mcpServers;
  assert.equal(servers.length, 2, '缺 id/command/url 的条目丢弃');
  assert.equal(servers[0].id, 'ok-http');
  assert.equal(servers[0].enabled, true);
  assert.equal(servers[1].command, 'node');
  assert.deepEqual(servers[1].allowlist, ['echo']);
});
