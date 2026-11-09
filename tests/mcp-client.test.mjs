import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { McpClient, mcpToolToDescriptor, McpToolCapabilityHandler, inferEffectFromDescription } from '../dist/apps/bot/src/mcp-client.js';
import { createDefaultConfig } from '../dist/packages/config/src/index.js';
import { OrchestrationEnforcer } from '../dist/apps/bot/src/orchestration-enforce.js';
import { startMcpHttpServer } from './fixtures/mcp-http-server.mjs';

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
  // echoTool 无 annotations：按新语义回落到描述关键词推断（"Read ..." → low），
  // 旧断言 medium 是 annotations 缺失时的固定默认值，已不适用；
  // 有 annotations 时以 readOnlyHint/destructiveHint 为准（见下面显式用例）。
  assert.equal(echoDescriptor.riskLevel, 'low', '无 annotations → 描述含 Read → low');
  assert.equal(inferEffectFromDescription('Read and echo back', {}), 'retrieve');
  assert.equal(inferEffectFromDescription('Generate audio GET /v0/audio/{id}', { readOnlyHint: false }), 'generate', 'readOnlyHint=false 不被描述里的 GET 误判');
  assert.equal(mcpToolToDescriptor('echo', { name: 'write', description: 'Write a record', annotations: { readOnlyHint: false } }).riskLevel, 'high', 'readOnlyHint=false → high（默认需确认）');
  assert.equal(mcpToolToDescriptor('echo', { name: 'peek', description: 'Peek at data', annotations: { readOnlyHint: true } }).riskLevel, 'low', 'readOnlyHint=true → low');
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
  const result = await enforcer.handle({ text: '回声 你好', chatType: 'private', userId: '1', plan: { planId: 'p1', requestId: 'r1', goal: 'answer', steps: [{ id: 's1', capability: 'mcp.echo.echo', args: { text: '你好' } }], budget: { maxSteps: 1 }, needsClarification: false, confidence: 0.9, source: 'command' } });
  mcp.close();
  assert.equal(result.handled, true);
  const text = (result.result?.text || '') + JSON.stringify(result.result?.replyPlan?.groups || []);
  assert.ok(text.includes('echo:你好'), 'MCP 工具输出应送达：' + text.slice(0, 200));
});

test('mcp T4.1: 配置规整——mcpServers 非法条目丢弃', async () => {
  const cfg = createDefaultConfig();
  // 内置预置：默认配置自带 Suno（未授权前是待授权，不消耗额度）。
  assert.equal(cfg.orchestration.mcpServers.length, 1);
  assert.equal(cfg.orchestration.mcpServers[0].id, 'suno-official');
  assert.equal(cfg.orchestration.mcpServers[0].builtin, true);
  const { importConfig } = await import('../dist/packages/config/src/index.js');
  const result = importConfig({ orchestration: { mcpServers: [
    { id: 'ok-http', enabled: true, transport: 'http', url: 'http://mcp.local/mcp' },
    { id: 'ok-stdio', transport: 'stdio', command: 'node', args: ['s.mjs'], allowlist: ['echo'] },
    { id: 'no-command', transport: 'stdio' },
    { transport: 'http', url: 'http://x' },
    { id: 'no-url', transport: 'http' },
  ] } });
  const servers = result.config.orchestration.mcpServers;
  assert.equal(servers.length, 3, '缺 id/command/url 的条目丢弃 + 内置预置补一条');
  assert.equal(servers[0].id, 'ok-http');
  assert.equal(servers[0].enabled, true);
  assert.equal(servers[1].command, 'node');
  assert.deepEqual(servers[1].allowlist, ['echo']);
  assert.equal(servers[2].id, 'suno-official');

  // 内置合并绝不能覆盖用户已有配置：生产手写 suno-official 且停用的环境，升级后必须保持停用。
  const existing = importConfig({ orchestration: { mcpServers: [
    { id: 'suno-official', enabled: false, transport: 'http', url: 'https://api.suno.com/mcp', auth: 'oauth' },
  ] } }).config.orchestration.mcpServers;
  assert.equal(existing.length, 1, '不重复追加内置项');
  assert.equal(existing[0].enabled, false, '用户停用状态保持');
  assert.equal(existing[0].builtin, true, '只补内置标记');
});

// ═══ Phase 1（传输层硬化）：会话保持 / 分页 / 404 自愈 / structuredContent / 通知流 / stdio 自愈 ═══

test('mcp Phase1: HTTP 会话保持——initialize 捕获 Mcp-Session-Id，后续请求回带 + 分页合并', async () => {
  const server = await startMcpHttpServer();
  try {
    const client = new McpClient({ id: 'http-echo', enabled: true, transport: 'http', url: server.url }, { timeoutMs: 5000 });
    await client.initialize();
    const tools = await client.listTools();
    assert.equal(tools.length, 3, '两页分页合并（2+1）');
    assert.equal(tools[2].name, 'lookup');
    const listRequests = server.requests.filter((r) => r.method === 'tools/list');
    assert.ok(listRequests.length >= 2, '分页至少请求两页');
    for (const r of listRequests) {
      assert.equal(typeof r.session, 'string', '后续请求回带会话头');
    }
    client.close();
  } finally {
    await server.close();
  }
});

test('mcp Phase1: 404 会话失效自愈——清 session 重 initialize 后重放成功', async () => {
  const server = await startMcpHttpServer();
  try {
    const client = new McpClient({ id: 'http-echo', enabled: true, transport: 'http', url: server.url }, { timeoutMs: 5000 });
    await client.initialize();
    server.invalidateSession(); // 模拟服务端会话过期
    const tools = await client.listTools(); // 旧 session → 404 → 自动重开 → 重放
    assert.equal(tools.length, 3, '自愈后分页仍完整');
    const methods = server.requests.map((r) => r.method);
    const initializeCount = methods.filter((m) => m === 'initialize').length;
    assert.equal(initializeCount, 2, 'initialize 恰好两次（首次 + 自愈重开）');
    const lastList = [...server.requests].reverse().find((r) => r.method === 'tools/list');
    assert.equal(lastList.session, server.session, '重放请求使用自愈后的新会话头');
    client.close();
  } finally {
    await server.close();
  }
});

test('mcp Phase1: structuredContent 透传', async () => {
  const server = await startMcpHttpServer();
  try {
    const client = new McpClient({ id: 'http-echo', enabled: true, transport: 'http', url: server.url }, { timeoutMs: 5000 });
    await client.initialize();
    const called = await client.callTool('echo', { text: '你好' });
    assert.equal(called.content[0].text, 'echo:你好');
    assert.deepEqual(called.structuredContent, { echoed: '你好' }, '结构化内容透传');
    client.close();
  } finally {
    await server.close();
  }
});

test('mcp Phase1: GET 通知流——list_changed 回调可收到', async () => {
  const server = await startMcpHttpServer();
  try {
    const events = [];
    const client = new McpClient({ id: 'http-echo', enabled: true, transport: 'http', url: server.url }, {
      timeoutMs: 5000,
      onNotification: (method) => events.push(method),
    });
    await client.initialize();
    const stop = await client.listen();
    await new Promise((resolve) => setTimeout(resolve, 300));
    stop();
    assert.ok(events.includes('notifications/tools/list_changed'), '收到工具变更通知：' + JSON.stringify(events));
    client.close();
  } finally {
    await server.close();
  }
});

test('mcp Phase1: stdio 崩溃自愈——kill 后下次调用按策略重新拉起', async () => {
  const client = new McpClient(
    { id: 'echo', enabled: true, transport: 'stdio', command: process.execPath, args: [serverScript] },
    { timeoutMs: 10000, reconnect: { maxAttempts: 3, delayMs: 50 } },
  );
  await client.initialize();
  const first = await client.callTool('echo', { text: 'a' });
  assert.equal(first.content[0].text, 'echo:a');
  client.child.kill(); // 模拟崩溃
  // flake 治理：固定 150ms 等 exit 事件在并行负载下不够——kill 到 exit 回调（child=null、
  // lastExitAt 记账）之间有事件循环竞态，抢跑会向已死管道 write 触发 EPIPE。
  // 改为确定性等待 exit 回调完成（child === null）再发起下一次调用，断言本身不变。
  const exitDeadline = Date.now() + 5000;
  while (client.child !== null && Date.now() < exitDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(client.child, null, 'kill 后 exit 回调应在 5s 内完成（child 置空）');
  const second = await client.callTool('echo', { text: 'b' }); // exit 后自动拉起
  assert.equal(second.content[0].text, 'echo:b', '崩溃后自愈完成调用');
  client.close();
});
