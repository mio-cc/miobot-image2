// Phase 3（OAuth 模块，方案 D9）：mock AS 全链验证
// 发现链（RFC 9728/8414）→ DCR 注册（RFC 7591）→ PKCE S256 授权 URL → 302 回落 → code 交换（resource 必带）
// → refresh 成功/失效（invalid_grant → needs-auth 判定依据）；附 CredentialStore 持久化。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  parseResourceMetadataUrl,
  parseScopeFromWwwAuthenticate,
  discoverAuthorizationServers,
  discoverProtectedResourceMetadata,
  fetchAuthorizationServerMetadata,
  mergeOAuthScopes,
  registerClient,
  generatePkce,
  buildAuthorizationUrl,
  exchangeCode,
  refreshAccessToken,
} from '../dist/apps/bot/src/mcp-oauth.js';
import { McpCredentialStore } from '../dist/apps/bot/src/mcp-credential-store.js';
import { startMockAuthorizationServer } from './fixtures/mcp-oauth-as.mjs';

async function fetchNoRedirect(url, init) {
  // 授权端点 302 不自动跟随（与 curl -i 同语义），便于断言 location。
  return fetch(url, { ...init, redirect: 'manual' });
}

test('mcp oauth: 发现链——401 WWW-Authenticate → 资源元数据 → AS 元数据（RFC 9728/8414）', async () => {
  const server = await startMockAuthorizationServer();
  try {
    const probe = await fetch(server.mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(probe.status, 401);
    const metadataUrl = parseResourceMetadataUrl(probe.headers.get('www-authenticate'));
    assert.ok(metadataUrl, '解析出 resource_metadata URL');
    const servers = await discoverAuthorizationServers(metadataUrl);
    assert.equal(servers.length, 1);
    const metadata = await fetchAuthorizationServerMetadata(servers[0]);
    assert.ok(metadata.authorizationEndpoint.includes('/authorize/'));
    assert.ok(metadata.tokenEndpoint.includes('/token/'));
    assert.ok(metadata.registrationEndpoint?.includes('/register/'));
    assert.deepEqual(metadata.codeChallengeMethodsSupported, ['S256']);
    assert.ok(metadata.grantTypesSupported?.includes('refresh_token'));
  } finally {
    await server.close();
  }
});

test('mcp oauth: scope comes from challenge/resource metadata', async () => {
  assert.equal(parseScopeFromWwwAuthenticate('Bearer resource_metadata="https://x/meta", scope="boxes connect"'), 'boxes connect');
  assert.equal(parseScopeFromWwwAuthenticate('Bearer resource_metadata="https://x/meta"'), undefined);

  const server = await startMockAuthorizationServer({
    scopesSupported: ['boxes', 'connect'],
    challengeScope: 'boxes connect',
  });
  try {
    const probe = await fetch(server.mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const metadataUrl = parseResourceMetadataUrl(probe.headers.get('www-authenticate'));
    assert.ok(metadataUrl);
    const metadata = await discoverProtectedResourceMetadata(metadataUrl);
    assert.deepEqual(metadata.authorizationServers, [`http://127.0.0.1:${server.port}/api/v2/external/oauth`]);
    assert.deepEqual(metadata.scopesSupported, ['boxes', 'connect']);
  } finally {
    await server.close();
  }
});

test('mcp oauth: scope merge deduplicates resource/challenge scopes', () => {
  assert.equal(
    mergeOAuthScopes(['api:v0', 'library:read'], 'api:v0 profile:read library:read'),
    'api:v0 library:read profile:read',
  );
  assert.equal(mergeOAuthScopes(undefined, null, ''), '');
});

test('mcp oauth: DCR 注册——公共客户端无 secret（RFC 7591）', async () => {
  const server = await startMockAuthorizationServer();
  try {
    const metadata = await fetchAuthorizationServerMetadata(`http://127.0.0.1:${server.port}/api/v2/external/oauth`);
    const client = await registerClient(metadata.registrationEndpoint, {
      clientName: 'miobot-probe',
      redirectUris: ['http://127.0.0.1:1/callback'],
    });
    assert.ok(client.clientId.startsWith('dcr-'));
    assert.equal(client.clientSecret, undefined, '公共客户端无 secret');
    const registerRequest = server.requests.find((r) => r.path.endsWith('/register/'));
    assert.equal(registerRequest.body.token_endpoint_auth_method, 'none');
    assert.deepEqual(registerRequest.body.grant_types, ['authorization_code', 'refresh_token']);
  } finally {
    await server.close();
  }
});

test('mcp oauth: PKCE + 授权 URL 构造——S256 challenge、resource/state 参数', async () => {
  const pkce = generatePkce();
  assert.ok(pkce.verifier.length >= 43 && pkce.verifier.length <= 128, 'verifier 长度合规（RFC 7636）');
  const url = buildAuthorizationUrl({
    authorizationEndpoint: 'https://as.example/authorize/',
    clientId: 'dcr-x',
    redirectUri: 'http://127.0.0.1:1/callback',
    scope: 'api:v0 offline_access',
    state: 'st-1',
    codeChallenge: pkce.challenge,
    resource: 'https://api.suno.com/mcp',
  });
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(parsed.searchParams.get('code_challenge'), pkce.challenge);
  assert.equal(parsed.searchParams.get('resource'), 'https://api.suno.com/mcp');
  assert.equal(parsed.searchParams.get('state'), 'st-1');
  assert.equal(parsed.searchParams.get('response_type'), 'code');
});

test('mcp oauth: 全链——授权 302 → code 交换（PKCE + resource 校验）→ token', async () => {
  const server = await startMockAuthorizationServer();
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const metadata = await fetchAuthorizationServerMetadata(`${base}/api/v2/external/oauth`);
    const redirectUri = `${base}/panel-callback`;
    const client = await registerClient(metadata.registrationEndpoint, { clientName: 'miobot', redirectUris: [redirectUri] });
    const pkce = generatePkce();
    const authorizeUrl = buildAuthorizationUrl({
      authorizationEndpoint: metadata.authorizationEndpoint,
      clientId: client.clientId,
      redirectUri,
      scope: 'api:v0 offline_access',
      state: 'probe-state',
      codeChallenge: pkce.challenge,
      resource: `${base}/mcp`,
    });
    const authorizeResponse = await fetchNoRedirect(authorizeUrl);
    assert.equal(authorizeResponse.status, 302);
    const location = new URL(authorizeResponse.headers.get('location'));
    assert.equal(location.searchParams.get('state'), 'probe-state', 'state 回传');
    const code = location.searchParams.get('code');
    assert.ok(code, '回落携带 code');

    const token = await exchangeCode({
      tokenEndpoint: metadata.tokenEndpoint,
      clientId: client.clientId,
      redirectUri,
      code,
      codeVerifier: pkce.verifier,
      resource: `${base}/mcp`,
    });
    assert.ok(token.accessToken.startsWith('at-'));
    assert.ok(token.refreshToken);
    assert.equal(token.expiresIn, 3600);

    const tokenRequest = server.requests.find((r) => r.path.endsWith('/token/') && r.form?.grant_type === 'authorization_code');
    assert.equal(tokenRequest.form.resource, `${base}/mcp`, 'token 请求携带 RFC 8707 resource');
    assert.equal(tokenRequest.form.code_verifier, pkce.verifier);

    // 错误 verifier → invalid_grant
    const badPkce = generatePkce();
    const badAuthorize = await fetchNoRedirect(buildAuthorizationUrl({
      authorizationEndpoint: metadata.authorizationEndpoint,
      clientId: client.clientId,
      redirectUri,
      state: 's2',
      codeChallenge: badPkce.challenge,
      resource: `${base}/mcp`,
    }));
    const badCode = new URL(badAuthorize.headers.get('location')).searchParams.get('code');
    await assert.rejects(
      exchangeCode({ tokenEndpoint: metadata.tokenEndpoint, clientId: client.clientId, redirectUri, code: badCode, codeVerifier: 'wrong-verifier', resource: `${base}/mcp` }),
      /mcp_oauth_token_failed:invalid_grant/,
      'PKCE 校验失败按 invalid_grant 拒绝',
    );
  } finally {
    await server.close();
  }
});

test('mcp oauth: refresh——成功轮换；失效后 invalid_grant（needs-auth 判定依据）', async () => {
  const server = await startMockAuthorizationServer();
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const metadata = await fetchAuthorizationServerMetadata(`${base}/api/v2/external/oauth`);
    const redirectUri = `${base}/panel-callback`;
    const client = await registerClient(metadata.registrationEndpoint, { clientName: 'miobot', redirectUris: [redirectUri] });
    const pkce = generatePkce();
    const authorizeUrl = buildAuthorizationUrl({
      authorizationEndpoint: metadata.authorizationEndpoint,
      clientId: client.clientId,
      redirectUri,
      state: 's3',
      codeChallenge: pkce.challenge,
      resource: `${base}/mcp`,
    });
    const code = new URL((await fetchNoRedirect(authorizeUrl)).headers.get('location')).searchParams.get('code');
    const first = await exchangeCode({ tokenEndpoint: metadata.tokenEndpoint, clientId: client.clientId, redirectUri, code, codeVerifier: pkce.verifier, resource: `${base}/mcp` });

    const refreshed = await refreshAccessToken({ tokenEndpoint: metadata.tokenEndpoint, clientId: client.clientId, refreshToken: first.refreshToken, resource: `${base}/mcp` });
    assert.ok(refreshed.refreshToken && refreshed.refreshToken !== first.refreshToken, 'refresh token 已轮换');

    // 旧 refresh token 已轮换失效 + 主动失效标记 → invalid_grant
    server.invalidateRefreshToken(refreshed.refreshToken);
    await assert.rejects(
      refreshAccessToken({ tokenEndpoint: metadata.tokenEndpoint, clientId: client.clientId, refreshToken: refreshed.refreshToken, resource: `${base}/mcp` }),
      /mcp_oauth_token_failed:invalid_grant/,
      'refresh 失效抛 invalid_grant（上层据此进入 needs-auth）',
    );
  } finally {
    await server.close();
  }
});

test('mcp credential store: set/get/clear + 文件持久化 + 重实例读回', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-cred-'));
  try {
    const filePath = path.join(dir, 'mcp-credentials.json');
    const store = new McpCredentialStore({ filePath });
    store.set('suno', { accessToken: 'at-1', refreshToken: 'rt-1', scope: 'api:v0 offline_access' });
    assert.equal(store.get('suno').accessToken, 'at-1');
    assert.equal(store.get('nonexistent'), undefined);

    const reloaded = new McpCredentialStore({ filePath });
    assert.equal(reloaded.get('suno').refreshToken, 'rt-1', '二次实例化从磁盘读回');
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(raw.credentials.suno.accessToken, 'at-1');
    assert.equal(raw.version, 1);

    reloaded.clear('suno');
    assert.equal(new McpCredentialStore({ filePath }).get('suno'), undefined, 'clear 后读回为空');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
