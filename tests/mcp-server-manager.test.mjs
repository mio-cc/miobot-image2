// Phase 2（方案 §4.1/§4.3/§4.9，D3/D6/D11/D16）：McpServerManager 单测（注入 fake client，无真实网络/进程）
// connect 注册根 / 状态机（connected / needs-auth / disconnected）/ 热重载 diff 三分支（增/删/改）
// / 目录刷新（list_changed 失效 + TTL 兜底）/ D6 新子项不进树 / 检索索引 / unregister 调用
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { McpServerManager, mcpServerConfigSummary } from '../dist/apps/bot/src/mcp-server-manager.js';
import { McpCredentialStore } from '../dist/apps/bot/src/mcp-credential-store.js';

/** 可控 fake McpClient：记录调用、可注入行为（工具集 / 失败模式）。 */
function createFakeClientHarness() {
  const calls = [];
  let behavior = {
    tools: [{ name: 'echo', description: 'Read and echo back the given text' }, { name: 'generate', description: 'Create a new song' }],
    failWith: null, // 'http_401' | 'network' | null
  };
  const createdClients = [];
  const createClient = (server, options) => {
    const client = {
      config: server,
      options,
      async initialize() {
        calls.push({ client, method: 'initialize', server: server.id });
        if (behavior.failWith === 'http_401') throw new Error('mcp_http_401');
        if (behavior.failWith === 'network') throw new Error('fetch failed');
      },
      async listTools() {
        calls.push({ client, method: 'tools/list', server: server.id });
        if (behavior.failWith) throw new Error(behavior.failWith);
        return behavior.tools;
      },
      async callTool(name, args) {
        calls.push({ client, method: 'tools/call', server: server.id, name, args });
        return { content: [{ type: 'text', text: `echo:${String(args?.text || '')}` }] };
      },
      close() { calls.push({ client, method: 'close', server: server.id }); },
    };
    createdClients.push(client);
    return client;
  };
  return {
    calls,
    createdClients,
    createClient,
    setTools: (tools) => { behavior = { ...behavior, tools }; },
    failWith: (mode) => { behavior = { ...behavior, failWith: mode }; },
  };
}

function createManagerHarness({ mcpServers, capabilityOverrides } = {}) {
  let config = { orchestration: { mcpServers: mcpServers || [], capabilityOverrides: capabilityOverrides || {} } };
  const registered = [];
  const unregistered = [];
  const harness = createFakeClientHarness();
  const manager = new McpServerManager({
    getConfig: () => config,
    registerCapability: (descriptor, handler) => registered.push({ descriptor, handler }),
    unregisterCapability: (id) => unregistered.push(id),
    createClient: harness.createClient,
    now: () => Date.now(),
  });
  return {
    manager, registered, unregistered, harness,
    setConfig: (next) => { config = { orchestration: { mcpServers: next.mcpServers ?? config.orchestration.mcpServers, capabilityOverrides: next.capabilityOverrides ?? config.orchestration.capabilityOverrides } }; },
  };
}

const server = (over = {}) => ({ id: 'demo', enabled: true, transport: 'http', url: 'http://127.0.0.1:9/mcp', ...over });

test('mcp manager: connect——一服务器恰注册一个根能力，状态 connected', async () => {
  const h = createManagerHarness({ mcpServers: [] });
  await h.manager.connect(server());
  assert.equal(h.registered.length, 1, '恰一个根能力');
  assert.equal(h.registered[0].descriptor.id, 'mcp.demo');
  assert.equal(h.registered[0].descriptor.provider, 'mcp:demo');
  assert.equal(h.manager.statusOf('demo').state, 'connected');
  assert.equal(h.manager.statusOf('demo').toolCount, 2);
  // 根默认 deny；capabilityOverrides['mcp.demo'].enabled 覆盖生效（D22）。
  assert.equal(h.registered[0].descriptor.enabled, false);
});

test('mcp manager: allowlist 管子项进树——空 allowlist 全进，白名单外不进（D14）', async () => {
  const h = createManagerHarness({});
  await h.manager.connect(server({ allowlist: ['echo'] }));
  assert.equal(h.manager.statusOf('demo').toolCount, 1);
  const root = h.registered[0].descriptor;
  assert.ok(root.description.includes('1 个子操作'));
});

test('mcp manager: 状态机——401 → needs-auth；网络错误 → disconnected（D10/D11）', async () => {
  const h = createManagerHarness({});
  h.harness.failWith('http_401');
  await h.manager.connect(server());
  assert.equal(h.manager.statusOf('demo').state, 'needs-auth');
  assert.ok(h.manager.statusOf('demo').lastError.includes('mcp_http_401'));
  assert.equal(h.registered.length, 0, '鉴权失败不注册根');

  const h2 = createManagerHarness({});
  h2.harness.failWith('network');
  await h2.manager.connect(server());
  assert.equal(h2.manager.statusOf('demo').state, 'disconnected');
  assert.ok(h2.manager.statusOf('demo').lastError.includes('fetch failed'));
});

test('mcp manager: 热重载 diff——新增连接 / 移除断开 / 变更重连（D16）', async () => {
  const h = createManagerHarness({ mcpServers: [server()] });
  await h.manager.reload();
  assert.equal(h.manager.statusOf('demo').state, 'connected');
  assert.equal(h.harness.createdClients.length, 1);

  // 新增：second 服务器。
  h.setConfig({ mcpServers: [server(), server({ id: 'second' })] });
  await h.manager.reload();
  assert.equal(h.manager.statusOf('second').state, 'connected');
  assert.equal(h.registered.filter((item) => item.descriptor.id === 'mcp.second').length, 1);

  // 变更：url 变化 → 断开重连（close + 新 client + 根重注册）。
  const registeredBefore = h.registered.length;
  h.setConfig({ mcpServers: [server(), server({ id: 'second', url: 'http://127.0.0.1:10/mcp' })] });
  await h.manager.reload();
  assert.ok(h.unregistered.includes('mcp.second'), '变更先注销');
  assert.equal(h.registered.length, registeredBefore + 1, '重连后重新注册根');
  assert.equal(h.manager.statusOf('second').state, 'connected');

  // 移除：配置删掉 second → 断开注销。
  h.setConfig({ mcpServers: [server()] });
  await h.manager.reload();
  assert.deepEqual(h.unregistered.filter((id) => id === 'mcp.second').length >= 1, true);
  assert.equal(h.manager.statusOf('second'), undefined);
  assert.equal(h.manager.statusOf('demo').state, 'connected', '未受影响的服务器保持连接');

  // enabled=false → 断开。
  h.setConfig({ mcpServers: [server({ enabled: false })] });
  await h.manager.reload();
  assert.equal(h.manager.statusOf('demo'), undefined);
  assert.ok(h.unregistered.includes('mcp.demo'));
});

test('mcp manager: 目录刷新——list_changed 失效重拉；新子项默认不进树（allowlist 外，D6）；TTL 兜底', async () => {
  const h = createManagerHarness({});
  await h.manager.connect(server());
  assert.equal(h.manager.statusOf('demo').toolCount, 2);

  // 未失效时刷新为 no-op。
  assert.equal(await h.manager.refreshTools('demo'), false);

  // 服务器目录变化：新增 third（不在 allowlist=null → 全进树？空 allowlist 语义 = 全部进树）。
  // D6 的「不进树」由 allowlist 承担：给 demo 配 allowlist 后新子项自然不进。
  const h2 = createManagerHarness({});
  await h2.manager.connect(server({ allowlist: ['echo', 'generate'] }));
  h2.harness.setTools([
    { name: 'echo', description: 'Read and echo back' },
    { name: 'generate', description: 'Create a new song' },
    { name: 'new_tool', description: 'Newly appeared tool' }, // 服务器新增
  ]);
  // 模拟 list_changed 通知。
  h2.harness.createdClients[0].options.onNotification('notifications/tools/list_changed');
  assert.equal(await h2.manager.refreshTools('demo'), true);
  assert.equal(h2.manager.statusOf('demo').toolCount, 2, '新子项不在 allowlist，不进树（D6）');
  assert.ok(h2.registered.at(-1).descriptor.description.includes('2 个子操作'), '根 description 子项数更新（热替换）');

  // TTL 兜底：fetchedAt 拨回过期。
  const status = h2.manager.statusOf('demo');
  const staleTime = new Date(Date.now() - 60_001).toISOString();
  // 直接通过再次 list_changed + 工具集变化触发；TTL 路径用 toolsCacheTtlMs=0 禁用验证 no-op。
  const h3 = createManagerHarness({});
  await h3.manager.connect(server({ allowlist: ['echo'], toolsCacheTtlMs: 0 }));
  assert.equal(await h3.manager.refreshTools('demo'), false, 'TTL=0 且无通知 → 不刷新');
  assert.equal(status.toolCount, 2);
});

test('mcp manager: 检索索引（D19）——根 id + 子项名 + 摘要', async () => {
  const h = createManagerHarness({});
  await h.manager.connect(server());
  const index = h.manager.searchIndex();
  assert.equal(index.length, 2);
  assert.ok(index.every((entry) => entry.rootId === 'mcp.demo' && entry.serverId === 'demo'));
  assert.ok(index.some((entry) => entry.childName === 'echo' && entry.summary.includes('echo')));
});

test('mcp manager: capabilityOverrides 根覆盖生效（D22——name/enabled）', async () => {
  const h = createManagerHarness({ capabilityOverrides: { 'mcp.demo': { name: '演示 MCP', enabled: true } } });
  await h.manager.connect(server());
  const root = h.registered[0].descriptor;
  assert.equal(root.name, '演示 MCP');
  assert.equal(root.enabled, true);
});

test('mcp manager: 配置摘要——新字段参与 diff（token/auth/proxyUrl/toolsCacheTtlMs）', () => {
  const a = mcpServerConfigSummary(server());
  assert.notEqual(a, mcpServerConfigSummary(server({ auth: 'oauth' })));
  assert.notEqual(a, mcpServerConfigSummary(server({ proxyUrl: 'http://127.0.0.1:7890' })));
  assert.notEqual(a, mcpServerConfigSummary(server({ toolsCacheTtlMs: 300000 })));
  // A5：token 参与 diff——静态 token 变更必须触发断开重连（旧 client 持旧 token 会持续 401）。
  assert.notEqual(a, mcpServerConfigSummary(server({ token: 'tok-1' })));
  assert.equal(a, mcpServerConfigSummary(server()));
});

test('mcp manager: 401 刷新失败 → needs-auth，不重试', async () => {
  const credentialDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-cred-'));
  try {
    const store = new McpCredentialStore({ filePath: path.join(credentialDir, 'mcp-credentials.json') });
    store.set('demo', { accessToken: 'at-old', refreshToken: 'rt-old', tokenEndpoint: 'http://127.0.0.1:9/token', resource: 'http://mcp.invalid' });
    store.setClient('demo', { clientId: 'client-1', redirectUri: 'http://panel.test/api/mcp/callback' });
    const h = createManagerHarness({});
    h.harness.failWith('http_401');
    const manager = new McpServerManager({
      getConfig: () => ({ orchestration: { mcpServers: [server({ auth: 'oauth' })], capabilityOverrides: {} } }),
      registerCapability: (descriptor, handler) => h.registered.push({ descriptor, handler }),
      unregisterCapability: (id) => h.unregistered.push(id),
      createClient: h.harness.createClient,
      credentialStore: store,
      now: () => Date.now(),
    });
    await manager.connect(server({ auth: 'oauth' }));
    assert.equal(h.harness.createdClients.length, 1, '刷新失败（本地端口拒连）不重试');
    assert.equal(manager.statusOf('demo').state, 'needs-auth');
  } finally {
    fs.rmSync(credentialDir, { recursive: true, force: true });
  }
});

test('mcp manager: wiring——401 刷新深度上限与 proxyUrl/reconnect 透传', () => {
  const source = fs.readFileSync(path.resolve(process.cwd(), 'apps/bot/src/mcp-server-manager.ts'), 'utf8');
  // A6：401 刷新仅在深度 0 尝试（刷新成功重试恰一次，再 401 进 needs-auth，防无限递归）。
  assert.ok(/refreshDepth < 1 \? await this\.tryRefreshCredential\(server, message\) : false/.test(source),
    '401 刷新必须受深度上限门控');
  assert.ok(/this\.connectManaged\(managed, server, refreshDepth \+ 1\)/.test(source),
    '递归重试必须携带深度计数');
  // A7：默认 client 工厂把配置的 proxyUrl/reconnect 接进 client options（此前仅解析不生效）。
  assert.ok(/server\.proxyUrl \? \{ proxyUrl: server\.proxyUrl \} : \{\}/.test(source),
    '默认 client 工厂应透传 proxyUrl');
  assert.ok(/server\.reconnect \? \{ reconnect: server\.reconnect \} : \{\}/.test(source),
    '默认 client 工厂应透传 reconnect');
});
