// Phase 3 测试用 mock 授权服务器（镜像 Phase 0 实测的 Suno OAuth 形态）：
// - GET /mcp：无凭据 401 + WWW-Authenticate（resource_metadata 指向本服务器 well-known）
// - GET /.well-known/oauth-protected-resource/mcp：资源元数据（authorization_servers 指向 /api/v2/external/oauth）
// - GET /.well-known/oauth-authorization-server/api/v2/external/oauth：AS 元数据（authorize/token/register 端点）
// - POST /api/v2/external/oauth/register/：DCR 注册（记录请求体，返回 201 + client_id）
// - GET /api/v2/external/oauth/authorize/：校验参数（client_id/redirect_uri/state/code_challenge/resource）→ 302 回 redirect_uri?code&state
// - POST /api/v2/external/oauth/token/：PKCE 校验（sha256(verifier)==challenge）与 resource 校验；
//   authorization_code → 发 token；refresh_token → 轮换新 token；可标记失效
import http from 'node:http';
import { createHash } from 'node:crypto';

function base64Url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function startMockAuthorizationServer() {
  const requests = [];
  const codeChallenges = new Map(); // code → challenge
  const refreshTokens = new Map();  // refreshToken → { valid: boolean }
  let registeredClient = null;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const base = `http://127.0.0.1:${server.address()?.port ?? ''}`;
    const issuerPath = '/api/v2/external/oauth';

    if (req.method === 'GET' && url.pathname === '/mcp') {
      res.writeHead(401, {
        'content-type': 'application/json',
        'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
      });
      res.end(JSON.stringify({ error: 'sign in to use this server' }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/mcp') {
      // 与 GET 同为 401（Suno 实测：POST initialize 与 GET SSE 均返回 401 + WWW-Authenticate）。
      req.on('data', () => { /* 消费 body */ });
      req.on('end', () => {
        res.writeHead(401, {
          'content-type': 'application/json',
          'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
        });
        res.end(JSON.stringify({ error: 'sign in to use this server' }));
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/.well-known/oauth-protected-resource/mcp') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        authorization_servers: [`${base}${issuerPath}`],
        resource: `${base}/mcp`,
        scopes_supported: ['api:v0', 'offline_access'],
      }));
      return;
    }
    if (req.method === 'GET' && url.pathname === `/.well-known/oauth-authorization-server${issuerPath}`) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        issuer: `${base}${issuerPath}`,
        authorization_endpoint: `${base}${issuerPath}/authorize/`,
        token_endpoint: `${base}${issuerPath}/token/`,
        registration_endpoint: `${base}${issuerPath}/register/`,
        revocation_endpoint: `${base}${issuerPath}/revoke_token/`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        scopes_supported: ['api:v0', 'offline_access'],
      }));
      return;
    }

    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(body); } catch { /* 表单或空体 */ }
      let form = null;
      try { form = Object.fromEntries(new URLSearchParams(body)); } catch { /* 非 URL 编码 */ }
      requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body: parsed, form });

      if (req.method === 'POST' && url.pathname === `${issuerPath}/register/`) {
        if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.redirect_uris)) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_client_metadata', error_description: 'The body must be a JSON object' }));
          return;
        }
        registeredClient = { clientId: `dcr-test-${Date.now()}`, redirectUris: parsed.redirect_uris };
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          client_id: registeredClient.clientId,
          redirect_uris: registeredClient.redirectUris,
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
          scope: 'api:v0 offline_access',
        }));
        return;
      }

      if (req.method === 'GET' && url.pathname === `${issuerPath}/authorize/`) {
        const q = Object.fromEntries(url.searchParams);
        if (!registeredClient || q.client_id !== registeredClient.clientId) {
          res.writeHead(400, { 'content-type': 'text/html' }); res.end('unauthorized_client'); return;
        }
        if (!q.redirect_uri || !q.state || !q.code_challenge || q.code_challenge_method !== 'S256' || !q.resource) {
          res.writeHead(400, { 'content-type': 'text/html' }); res.end('Missing required OAuth parameters'); return;
        }
        const code = `code-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        codeChallenges.set(code, q.code_challenge);
        const redirect = new URL(q.redirect_uri);
        redirect.searchParams.set('code', code);
        redirect.searchParams.set('state', q.state);
        res.writeHead(302, { location: redirect.toString() });
        res.end();
        return;
      }

      if (req.method === 'POST' && url.pathname === `${issuerPath}/token/`) {
        const q = form || {};
        if (q.resource !== `${base}/mcp`) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_target' }));
          return;
        }
        if (q.grant_type === 'authorization_code') {
          const challenge = codeChallenges.get(q.code);
          const computed = q.code_verifier ? base64Url(createHash('sha256').update(q.code_verifier).digest()) : null;
          if (!challenge || computed !== challenge) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'invalid_grant' }));
            return;
          }
          codeChallenges.delete(q.code);
          const refreshToken = `rt-${Date.now()}`;
          refreshTokens.set(refreshToken, { valid: true });
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ access_token: `at-${Date.now()}`, refresh_token: refreshToken, expires_in: 3600, scope: 'api:v0 offline_access', token_type: 'Bearer' }));
          return;
        }
        if (q.grant_type === 'refresh_token') {
          const entry = refreshTokens.get(q.refresh_token);
          if (!entry || !entry.valid) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'invalid_grant' }));
            return;
          }
          entry.valid = false; // 轮换：旧 refresh token 一次性
          const refreshToken = `rt-${Date.now()}-new`;
          refreshTokens.set(refreshToken, { valid: true });
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ access_token: `at-${Date.now()}-new`, refresh_token: refreshToken, expires_in: 3600, token_type: 'Bearer' }));
          return;
        }
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'unsupported_grant_type' }));
        return;
      }

      res.writeHead(404); res.end();
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    port,
    mcpUrl: `http://127.0.0.1:${port}/mcp`,
    requests,
    get registeredClientId() { return registeredClient?.clientId ?? null; },
    invalidateRefreshToken(token) { const entry = refreshTokens.get(token); if (entry) entry.valid = false; },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
