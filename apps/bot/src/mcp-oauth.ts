import { createHash, randomBytes } from 'node:crypto';

/**
 * MCP OAuth 2.1 流程（方案 D9，Phase 0 实测零偏差：RFC 9728 → RFC 8414 → DCR → PKCE S256 → Bearer）：
 * - discoverAuthorizationServers：解析 401 WWW-Authenticate 的 resource_metadata → 取资源元数据（RFC 9728）。
 * - fetchAuthorizationServerMetadata：AS 元数据（RFC 8414，规范位置优先、后缀位置回退——Phase 0 实测两者均可用）。
 * - registerClient：动态客户端注册（RFC 7591，公共客户端 auth=none）。
 * - generatePkce / buildAuthorizationUrl：S256 PKCE 与授权 URL 构造（含 RFC 8707 resource 参数）。
 * - exchangeCode / refreshAccessToken：授权码交换与刷新（token 请求同样携带 resource）。
 *
 * 全部为无状态纯函数（fetch 可注入），会话/凭据状态由调用方（Manager）管理。
 */

export interface McpOAuthFetchOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface McpProtectedResourceMetadata {
  authorizationServers: string[];
  scopesSupported: string[];
  resource?: string;
}

export interface McpAuthorizationServerMetadata {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  revocationEndpoint?: string;
  scopesSupported?: string[];
  codeChallengeMethodsSupported?: string[];
  grantTypesSupported?: string[];
}

export interface McpRegisteredClient {
  clientId: string;
  clientSecret?: string;
  redirectUris: string[];
  scope?: string;
}

export interface McpPkcePair {
  verifier: string;
  challenge: string;
}

export interface McpTokenResponse {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  scope?: string;
  tokenType?: string;
}

function resolveFetch(options: McpOAuthFetchOptions): typeof fetch {
  return options.fetchImpl || fetch;
}

function timeoutMs(options: McpOAuthFetchOptions): number {
  return Math.max(5000, Number(options.timeoutMs) || 20000);
}

/** 解析 401 响应 WWW-Authenticate 头里的 resource_metadata URL（RFC 9728 §5.1）。 */
export function parseResourceMetadataUrl(wwwAuthenticate: string | null | undefined): string | undefined {
  const raw = String(wwwAuthenticate || '');
  const match = raw.match(/resource_metadata="([^"]+)"/i);
  return match ? match[1] : undefined;
}

/** Parse the scope parameter from a Bearer challenge (RFC 6750 / RFC 9728). */
export function parseScopeFromWwwAuthenticate(wwwAuthenticate: string | null | undefined): string | undefined {
  const raw = String(wwwAuthenticate || '');
  const quoted = raw.match(/scope="([^"]*)"/i);
  if (quoted) return quoted[1].trim() || undefined;
  const unquoted = raw.match(/scope=([^,\s]+)/i);
  return unquoted ? unquoted[1].trim() || undefined : undefined;
}

/** Merge OAuth scope sources without cross-service hardcoding.
 *  Resource metadata is authoritative for this resource, but some servers
 *  advertise additional write scopes only in AS metadata or the WWW-Authenticate
 *  challenge. Requesting only the first source produces read-only tokens. */
export function mergeOAuthScopes(...sources: Array<string | string[] | null | undefined>): string {
  const seen = new Set<string>();
  for (const source of sources) {
    const values = Array.isArray(source) ? source : String(source || '').split(/\s+/);
    for (const raw of values) {
      const scope = String(raw || '').trim();
      if (scope && !seen.has(scope)) seen.add(scope);
    }
  }
  return [...seen].join(' ');
}

/** Fetch protected resource metadata (RFC 9728): authorization servers and declared scopes. */
export async function discoverProtectedResourceMetadata(resourceMetadataUrl: string, options: McpOAuthFetchOptions = {}): Promise<McpProtectedResourceMetadata> {
  const response = await resolveFetch(options)(resourceMetadataUrl, { signal: AbortSignal.timeout(timeoutMs(options)) });
  if (!response.ok) throw new Error(`mcp_oauth_resource_metadata_${response.status}`);
  const metadata = await response.json() as Record<string, unknown>;
  const servers = Array.isArray(metadata?.authorization_servers)
    ? metadata.authorization_servers.map(String).filter(Boolean)
    : [];
  if (!servers.length) throw new Error('mcp_oauth_no_authorization_server');
  return {
    authorizationServers: servers,
    scopesSupported: Array.isArray(metadata?.scopes_supported)
      ? metadata.scopes_supported.map(String).map((item) => item.trim()).filter(Boolean)
      : [],
    ...(typeof metadata?.resource === 'string' ? { resource: metadata.resource } : {}),
  };
}

/** Backward-compatible helper: only returns authorization_servers. */
export async function discoverAuthorizationServers(resourceMetadataUrl: string, options: McpOAuthFetchOptions = {}): Promise<string[]> {
  return (await discoverProtectedResourceMetadata(resourceMetadataUrl, options)).authorizationServers;
}

/** 取 AS 元数据（RFC 8414）：先试规范位置（issuer 路径中插），失败再试 issuer 后缀位置。 */
export async function fetchAuthorizationServerMetadata(issuer: string, options: McpOAuthFetchOptions = {}): Promise<McpAuthorizationServerMetadata> {
  const urls: string[] = [];
  try {
    const parsed = new URL(issuer);
    // 规范位置：scheme://host/.well-known/oauth-authorization-server + path（路径中插）。
    urls.push(new URL(`/.well-known/oauth-authorization-server${parsed.pathname}`, parsed.origin).toString().replace(/\/$/, ''));
    // 后缀位置：issuer + /.well-known/oauth-authorization-server（Phase 0 实测 Suno 两者均可用）。
    urls.push(`${issuer.replace(/\/$/, '')}/.well-known/oauth-authorization-server`);
  } catch {
    throw new Error('mcp_oauth_invalid_issuer');
  }
  let lastStatus = 0;
  for (const url of urls) {
    const response = await resolveFetch(options)(url, { signal: AbortSignal.timeout(timeoutMs(options)) });
    if (!response.ok) { lastStatus = response.status; continue; }
    const raw = await response.json() as Record<string, unknown>;
    if (typeof raw.authorization_endpoint !== 'string' || typeof raw.token_endpoint !== 'string') {
      throw new Error('mcp_oauth_invalid_as_metadata');
    }
    return {
      issuer: String(raw.issuer || issuer),
      authorizationEndpoint: String(raw.authorization_endpoint),
      tokenEndpoint: String(raw.token_endpoint),
      ...(typeof raw.registration_endpoint === 'string' ? { registrationEndpoint: String(raw.registration_endpoint) } : {}),
      ...(typeof raw.revocation_endpoint === 'string' ? { revocationEndpoint: String(raw.revocation_endpoint) } : {}),
      ...(Array.isArray(raw.scopes_supported) ? { scopesSupported: raw.scopes_supported.map(String) } : {}),
      ...(Array.isArray(raw.code_challenge_methods_supported) ? { codeChallengeMethodsSupported: raw.code_challenge_methods_supported.map(String) } : {}),
      ...(Array.isArray(raw.grant_types_supported) ? { grantTypesSupported: raw.grant_types_supported.map(String) } : {}),
    };
  }
  throw new Error(`mcp_oauth_as_metadata_${lastStatus}`);
}

/** 动态客户端注册（RFC 7591）：公共客户端（token_endpoint_auth_method=none，无 secret）。 */
export async function registerClient(
  registrationEndpoint: string,
  input: { clientName: string; redirectUris: string[]; scope?: string },
  options: McpOAuthFetchOptions = {},
): Promise<McpRegisteredClient> {
  const response = await resolveFetch(options)(registrationEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: input.clientName,
      redirect_uris: input.redirectUris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      ...(input.scope ? { scope: input.scope } : {}),
    }),
    signal: AbortSignal.timeout(timeoutMs(options)),
  });
  const raw = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok || !raw || typeof raw.client_id !== 'string') {
    const description = String(raw?.error_description || raw?.error || response.status);
    throw new Error(`mcp_oauth_registration_failed:${description}`);
  }
  return {
    clientId: String(raw.client_id),
    ...(typeof raw.client_secret === 'string' ? { clientSecret: String(raw.client_secret) } : {}),
    redirectUris: Array.isArray(raw.redirect_uris) ? raw.redirect_uris.map(String) : input.redirectUris,
    ...(typeof raw.scope === 'string' ? { scope: String(raw.scope) } : {}),
  };
}

function base64Url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** PKCE S256：生成 verifier 与 challenge（RFC 7636）。 */
export function generatePkce(): McpPkcePair {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

/** 构造授权 URL：标准参数 + PKCE（S256）+ RFC 8707 resource 参数 + state。 */
export function buildAuthorizationUrl(input: {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  scope?: string;
  state: string;
  codeChallenge: string;
  resource: string;
}): string {
  const url = new URL(input.authorizationEndpoint);
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', input.redirectUri);
  if (input.scope) url.searchParams.set('scope', input.scope);
  url.searchParams.set('state', input.state);
  url.searchParams.set('code_challenge', input.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('resource', input.resource);
  return url.toString();
}

interface McpTokenRequestInput {
  tokenEndpoint: string;
  clientId: string;
  resource: string;
  options?: McpOAuthFetchOptions;
}

async function postTokenRequest(
  input: McpTokenRequestInput & { body: Record<string, string> },
): Promise<McpTokenResponse> {
  const response = await resolveFetch(input.options || {})(input.tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(input.body).toString(),
    signal: AbortSignal.timeout(timeoutMs(input.options || {})),
  });
  const raw = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok || !raw || typeof raw.access_token !== 'string') {
    const error = String(raw?.error || response.status);
    throw new Error(`mcp_oauth_token_failed:${error}`);
  }
  return {
    accessToken: String(raw.access_token),
    ...(typeof raw.refresh_token === 'string' ? { refreshToken: String(raw.refresh_token) } : {}),
    ...(Number.isFinite(Number(raw.expires_in)) ? { expiresIn: Number(raw.expires_in) } : {}),
    ...(typeof raw.scope === 'string' ? { scope: String(raw.scope) } : {}),
    ...(typeof raw.token_type === 'string' ? { tokenType: String(raw.token_type) } : {}),
  };
}

/** 授权码交换（公共客户端 auth=none：不带 client_secret，RFC 8707 resource 必带）。 */
export function exchangeCode(
  input: McpTokenRequestInput & { code: string; redirectUri: string; codeVerifier: string },
): Promise<McpTokenResponse> {
  return postTokenRequest({
    ...input,
    body: {
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: input.clientId,
      code_verifier: input.codeVerifier,
      resource: input.resource,
    },
  });
}

/** 刷新访问令牌（公共客户端 auth=none；RFC 8707 resource 必带）。 */
export function refreshAccessToken(
  input: McpTokenRequestInput & { refreshToken: string },
): Promise<McpTokenResponse> {
  return postTokenRequest({
    ...input,
    body: {
      grant_type: 'refresh_token',
      refresh_token: input.refreshToken,
      client_id: input.clientId,
      resource: input.resource,
    },
  });
}
