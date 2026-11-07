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
