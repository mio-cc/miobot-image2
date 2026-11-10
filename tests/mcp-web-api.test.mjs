// Phase 3（web-api MCP 端点）：mock AS 全链集成测试
// connect（发现链+DCR+PKCE→授权 URL）→ 浏览器 302（mock AS 发 code）→ callback（state 配对+code 交换+凭据落盘+触发文件）
// → status（快照读取）→ disconnect（清凭据）；鉴权语义：connect 需 token，callback 公开。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-webapi-'));
process.env.MIOBOT_DATA_DIR = dataDir;
process.env.MIOBOT_PANEL_ORIGIN = 'http://panel.test:3000';

const { createWebApi, derivePanelToken } = await import('../dist/packages/web-api/src/index.js');
const { startMockAuthorizationServer } = await import('./fixtures/mcp-oauth-as.mjs');

// 面板令牌 = derivePanelToken(passwordSeed)（isAuthorized 只认派生 token，S2 常量时间比较）。
const SEED = 'test-panel-token';
const TOKEN = derivePanelToken(SEED);
const authHeaders = { authorization: `Bearer ${TOKEN}` };

async function createConfiguredApi(mcpUrl) {
  const api = createWebApi({
    initialConfig: {
      panel: { passwordSeed: SEED },
      orchestration: {
        mcpServers: [{ id: 'suno', enabled: true, transport: 'http', url: mcpUrl, auth: 'oauth', allowlist: ['echo', 'generate'] }],
      },
    },
  });
  return api;
}

test('mcp web-api: connect→callback 全链——授权 URL、code 交换、凭据落盘、触发文件', async () => {
  const server = await startMockAuthorizationServer();
  try {
    const api = await createConfiguredApi(server.mcpUrl);

    // 未带面板令牌：connect 拒绝。
    const unauth = await api.handle({ method: 'POST', path: '/api/mcp/connect', body: { serverId: 'suno' } });
    assert.equal(unauth.status, 401);

    // 发起授权：发现链 + DCR + PKCE → 授权 URL。
    const connect = await api.handle({ method: 'POST', path: '/api/mcp/connect', headers: authHeaders, body: { serverId: 'suno' } });
    assert.equal(connect.status, 200, JSON.stringify(connect.body));
    const { authorizationUrl, state } = connect.body;
    assert.ok(authorizationUrl.includes('/authorize/'), '授权 URL 指向 AS');
    assert.ok(state.startsWith('mcpst-'));
    assert.equal(new URL(authorizationUrl).searchParams.get('scope'), 'api:v0 offline_access', 'scope 来自资源元数据');
    const registerRequest = server.requests.find((request) => request.path.endsWith('/register/'));
    assert.equal(registerRequest.body.scope, 'api:v0 offline_access', 'DCR 同步声明相同 scope');

    // 浏览器访问授权 URL：mock AS 校验参数后 302 回 redirect_uri?code&state。
    const authorizeResponse = await fetch(authorizationUrl, { redirect: 'manual' });
    assert.equal(authorizeResponse.status, 302);
    const location = new URL(authorizeResponse.headers.get('location'));
    assert.equal(location.origin + location.pathname, 'http://panel.test:3000/api/mcp/callback');
    const code = location.searchParams.get('code');
    assert.ok(code);

    // 回调（鉴权例外）：state 配对 → code 交换 → 凭据落盘 → 302 回面板页（/admin/ hash 路由）。
    const callback = await api.handle({ method: 'GET', path: `/api/mcp/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}` });
    assert.equal(callback.status, 302, JSON.stringify(callback.body));
    assert.equal(callback.headers.location, '/admin/#/mcp/suno?authorized=1');

    const credentials = JSON.parse(fs.readFileSync(path.join(dataDir, 'mcp-credentials.json'), 'utf8'));
    assert.ok(credentials.credentials.suno.accessToken.startsWith('at-'), 'access token 落盘');
    assert.ok(credentials.credentials.suno.refreshToken, 'refresh token 落盘');
    assert.equal(credentials.credentials.suno.resource, server.mcpUrl, 'RFC 8707 resource 记录');
    assert.ok(credentials.clients.suno.clientId.startsWith('dcr-'), 'DCR client 注册信息落盘');
    const trigger = JSON.parse(fs.readFileSync(path.join(dataDir, 'mcp-trigger.json'), 'utf8'));
    assert.equal(trigger.action, 'oauth:suno', '触发文件写入（bot 即时热重载）');

    // 伪造 state 的回调被拒绝。
    const badCallback = await api.handle({ method: 'GET', path: `/api/mcp/callback?code=x&state=forged` });
    assert.equal(badCallback.status, 400);
    assert.ok(badCallback.body.error.includes('state_mismatch'));
  } finally {
    await server.close();
  }
});

test('mcp web-api: Box OAuth uses boxes connect from resource metadata', async () => {
  const server = await startMockAuthorizationServer({
    scopesSupported: ['boxes', 'connect'],
    challengeScope: 'boxes connect',
    expectedScope: 'boxes connect',
  });
  try {
    const api = createWebApi({
      initialConfig: {
        panel: { passwordSeed: SEED },
        orchestration: {
          mcpServers: [{
            id: 'box',
            enabled: true,
            transport: 'http',
            url: server.mcpUrl,
            auth: 'oauth',
          }],
        },
      },
    });
    const connect = await api.handle({ method: 'POST', path: '/api/mcp/connect', headers: authHeaders, body: { serverId: 'box' } });
    assert.equal(connect.status, 200, JSON.stringify(connect.body));
    const authorizationUrl = new URL(connect.body.authorizationUrl);
    assert.equal(authorizationUrl.searchParams.get('scope'), 'boxes connect', '不能把 Suno 的 scope 发给 Box');
    const registration = server.requests.find((request) => request.path.endsWith('/register/'));
    assert.equal(registration.body.scope, 'boxes connect', 'Box DCR 声明 boxes connect');
    const authorizeResponse = await fetch(authorizationUrl, { redirect: 'manual' });
    assert.equal(authorizeResponse.status, 302, await authorizeResponse.text());
  } finally {
    await server.close();
  }
});

test('mcp web-api: status 读取 bot 快照（query 与 path-search 双形态兼容）', async () => {
  fs.writeFileSync(path.join(dataDir, 'mcp-status.json'), JSON.stringify({
    version: 1,
    servers: [{ serverId: 'suno', state: 'connected', toolCount: 2, enabledToolCount: 2, lastChangedAt: '2026-11-06T00:00:00Z' }],
    children: [{ serverId: 'suno', name: 'echo', summary: 'Read and echo', effect: 'retrieve', riskLevel: 'low', enabled: true }],
  }));
  const api = await createConfiguredApi('http://127.0.0.1:9/mcp');
  const status = await api.handle({ method: 'GET', path: '/api/mcp/status', headers: authHeaders });
  assert.equal(status.status, 200);
  assert.equal(status.body.status.servers[0].state, 'connected');
  assert.equal(status.body.status.children[0].name, 'echo');
});

test('mcp web-api: capabilities 接口合并 MCP 根（P4 二期）——覆盖应用、默认 deny、快照状态进描述、合成 health 三态', async () => {
  fs.writeFileSync(path.join(dataDir, 'mcp-status.json'), JSON.stringify({
    version: 1,
    servers: [{ serverId: 'suno', state: 'connected', toolCount: 10, enabledToolCount: 10, lastChangedAt: '2026-11-07T00:00:00Z' }],
    children: [],
  }));
  const api = createWebApi({
    initialConfig: {
      panel: { passwordSeed: SEED },
      orchestration: {
        mcpServers: [{ id: 'suno', enabled: true, transport: 'http', url: 'http://127.0.0.1:9/mcp', auth: 'oauth', allowlist: ['echo', 'generate'] }],
        capabilityOverrides: { 'mcp.suno': { name: 'Suno 官方', enabled: true, riskLevel: 'high' } },
      },
    },
  });
  const res = await api.handle({ method: 'GET', path: '/api/orchestration/capabilities', headers: authHeaders });
  assert.equal(res.status, 200);
  const root = res.body.capabilities.find((item) => item.id === 'mcp.suno');
  assert.ok(root, 'capabilities 列表包含 MCP 根');
  assert.equal(root.name, 'Suno 官方', '根覆盖 name 应用');
  assert.equal(root.enabled, true, '根覆盖 enabled 应用');
  assert.equal(root.riskLevel, 'high', '根覆盖 riskLevel 应用');
  assert.ok(root.description.includes('已连接（10 子项）'), '快照状态进描述');
  assert.equal(root.provider, 'mcp:suno');
  // 合成 health（能力中心 MCP 分类卡片数据源）：已连接 = ok + 子项数进 detail。
  assert.equal(root.health.status, 'ok', '已连接 → health ok');
  assert.ok(root.health.detail.includes('已连接（10 子项）'), 'health detail 含子项数');
  // 内置能力的 health 仍走 capabilityHealth（无合成值时不被覆盖）。
  const builtin = res.body.capabilities.find((item) => item.id === 'tts.speak');
  assert.ok(builtin && builtin.health, '内置能力 health 照旧合成');

  // 未配置覆盖的服务器：默认 deny；无快照 → 未连接（unconfigured）。
  const api2 = createWebApi({ initialConfig: { panel: { passwordSeed: SEED }, orchestration: { mcpServers: [{ id: 'bare', enabled: true, transport: 'http', url: 'http://x/mcp' }] } } });
  const res2 = await api2.handle({ method: 'GET', path: '/api/orchestration/capabilities', headers: authHeaders });
  const bare = res2.body.capabilities.find((item) => item.id === 'mcp.bare');
  assert.equal(bare.enabled, false, '默认 deny');
  assert.ok(bare.description.includes('未连接'), '无快照按未连接描述');
  assert.equal(bare.health.status, 'unconfigured', '无快照 → health unconfigured');
  assert.equal(bare.health.detail, '未连接');

  // 停用（server.enabled:false）→ health disabled；待授权（needs-auth）→ unconfigured + 待授权。
  const api3 = createWebApi({ initialConfig: { panel: { passwordSeed: SEED }, orchestration: { mcpServers: [
    { id: 'off', enabled: false, transport: 'http', url: 'http://x/mcp' },
    { id: 'auth-pending', enabled: true, transport: 'http', url: 'http://x/mcp', auth: 'oauth' },
  ] } } });
  const res3 = await api3.handle({ method: 'GET', path: '/api/orchestration/capabilities', headers: authHeaders });
  const off = res3.body.capabilities.find((item) => item.id === 'mcp.off');
  assert.equal(off.health.status, 'disabled', 'server.enabled:false → health disabled');
  assert.equal(off.health.detail, '已停用');
  // 内置 OAuth 项首次出现（从未授权、还没有快照）→ 卡片必须存在且状态是待授权。
  const pendingBefore = res3.body.capabilities.find((item) => item.id === 'mcp.auth-pending');
  assert.ok(pendingBefore, '未授权也合成卡片');
  assert.ok(pendingBefore.description.includes('待授权'), '无快照 OAuth 按待授权描述');
  assert.equal(pendingBefore.health.status, 'unconfigured');
  assert.equal(pendingBefore.health.detail, '未连接 · 待授权');
  fs.writeFileSync(path.join(dataDir, 'mcp-status.json'), JSON.stringify({
    version: 1,
    servers: [{ serverId: 'auth-pending', state: 'needs-auth', toolCount: 0, enabledToolCount: 0, lastChangedAt: '2026-11-07T00:00:00Z' }],
    children: [],
  }));
  const res4 = await api3.handle({ method: 'GET', path: '/api/orchestration/capabilities', headers: authHeaders });
  const pending = res4.body.capabilities.find((item) => item.id === 'mcp.auth-pending');
  assert.equal(pending.health.status, 'unconfigured', 'needs-auth → health unconfigured');
  assert.ok(pending.health.detail.includes('待授权'), '待授权进 health detail');
});

test('mcp web-api: disconnect 清凭据并触发；connect 对未知 server 报 400', async () => {
  const server = await startMockAuthorizationServer();
  try {
    const api = await createConfiguredApi(server.mcpUrl);
    // 未知 server。
    const notFound = await api.handle({ method: 'POST', path: '/api/mcp/connect', headers: authHeaders, body: { serverId: 'ghost' } });
    assert.equal(notFound.status, 400);
    assert.ok(notFound.body.error.includes('mcp_server_not_found'));

    // disconnect：凭据清理 + trigger。
    const disconnect = await api.handle({ method: 'POST', path: '/api/mcp/disconnect', headers: authHeaders, body: { serverId: 'suno' } });
    assert.equal(disconnect.status, 200);
    const after = JSON.parse(fs.readFileSync(path.join(dataDir, 'mcp-credentials.json'), 'utf8'));
    assert.equal(after.credentials.suno, undefined, '凭据已清');
    assert.equal(after.clients.suno, undefined, 'client 注册已清');
    const trigger = JSON.parse(fs.readFileSync(path.join(dataDir, 'mcp-trigger.json'), 'utf8'));
    assert.equal(trigger.action, 'disconnect:suno');

    // reconnect：仅写 trigger。
    const reconnect = await api.handle({ method: 'POST', path: '/api/mcp/reconnect', headers: authHeaders, body: { serverId: 'suno' } });
    assert.equal(reconnect.status, 200);
    const trigger2 = JSON.parse(fs.readFileSync(path.join(dataDir, 'mcp-trigger.json'), 'utf8'));
    assert.equal(trigger2.action, 'reconnect:suno');
  } finally {
    await server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
