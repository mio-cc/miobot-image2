import fs from 'node:fs';
import path from 'node:path';
import type { StructuredLogger } from '../../../packages/logger/src/index.js';

/**
 * MCP 凭据存储（方案 D13/D15）：`data/mcp-credentials.json` 独立 secret 文件。
 * - 凭据不进 config.json，GET /api/config 永不包含（规避数组元素打码难题）。
 * - 按 serverId 存取；accountId 字段为多账号预留（D15，本阶段不消费）。
 * - 原子写（tmp + rename）；文件权限尽力收紧为 0600。
 */

export interface McpStoredCredential {
  accessToken: string;
  refreshToken?: string;
  /** ISO 时间；缺省视为长期有效（由服务器侧 401 兜底触发刷新）。 */
  expiresAt?: string;
  scope?: string;
  /** token 端点（授权编排时写入；bot 侧 401 刷新时使用）。 */
  tokenEndpoint?: string;
  /** RFC 8707 resource 参数（授权编排时写入；刷新时回带）。 */
  resource?: string;
  /** 多账号预留（D15）。 */
  accountId?: string;
}

/** DCR 动态注册的客户端信息（公共客户端，client_id 非机密）。 */
export interface McpStoredClient {
  clientId: string;
  redirectUri: string;
  /** DCR 时声明的 scope；变更后必须重新注册，不能复用旧 client。 */
  scope?: string;
}

interface McpCredentialFile {
  version: 1;
  credentials: Record<string, McpStoredCredential>;
  /** Phase 3：DCR 注册信息（向后兼容：旧文件无此节按空处理）。 */
  clients?: Record<string, McpStoredClient>;
}

export class McpCredentialStore {
  private readonly logger?: StructuredLogger;
  private cache: McpCredentialFile | null = null;
  /** 跨进程文件变更感知：面板进程写凭据后，bot 进程按 mtime 失效重读（走查实测发现）。 */
  private cacheMtimeMs = -1;

  constructor(options: { filePath: string; logger?: StructuredLogger }) {
    this.filePathValue = options.filePath;
    this.logger = options.logger;
  }

  private load(): McpCredentialFile {
    let mtimeMs = -1;
    try { mtimeMs = fs.statSync(this.filePathValue).mtimeMs; } catch { mtimeMs = -1; }
    if (this.cache && this.cacheMtimeMs === mtimeMs) return this.cache;
    try {
      if (mtimeMs >= 0) {
        const parsed = JSON.parse(fs.readFileSync(this.filePathValue, 'utf8')) as Partial<McpCredentialFile>;
        const credentials: Record<string, McpStoredCredential> = {};
        for (const [serverId, credential] of Object.entries(parsed?.credentials || {})) {
          if (!credential || typeof credential !== 'object' || typeof (credential as any).accessToken !== 'string') continue;
          credentials[serverId] = credential as McpStoredCredential;
        }
        const clients: Record<string, McpStoredClient> = {};
        for (const [serverId, client] of Object.entries(parsed?.clients || {})) {
          if (!client || typeof client !== 'object' || typeof (client as any).clientId !== 'string') continue;
          clients[serverId] = client as McpStoredClient;
        }
        this.cache = { version: 1, credentials, clients };
        this.cacheMtimeMs = mtimeMs;
      } else {
        this.cache = { version: 1, credentials: {} };
        this.cacheMtimeMs = -1;
      }
    } catch (error) {
      this.logger?.warn('mcp 凭据文件读取失败，按空库处理', { filePath: this.filePathValue, error: String((error as Error)?.message || error) });
      this.cache = { version: 1, credentials: {} };
      this.cacheMtimeMs = mtimeMs;
    }
    return this.cache;
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.load(), null, 2), 'utf8');
      try { fs.chmodSync(tmp, 0o600); } catch { /* Windows 上语义有限，尽力而为 */ }
      fs.renameSync(tmp, this.filePath);
    } catch (error) {
      this.logger?.warn('mcp 凭据文件写入失败', { filePath: this.filePath, error: String((error as Error)?.message || error) });
    }
  }

  get(serverId: string): McpStoredCredential | undefined {
    return this.load().credentials[String(serverId)];
  }

  set(serverId: string, credential: McpStoredCredential): void {
    const file = this.load();
    file.credentials[String(serverId)] = credential;
    this.save();
  }

  clear(serverId: string): void {
    const file = this.load();
    let changed = false;
    if (String(serverId) in file.credentials) {
      delete file.credentials[String(serverId)];
      changed = true;
    }
    if (file.clients && String(serverId) in file.clients) {
      delete file.clients[String(serverId)];
      changed = true;
    }
    if (changed) this.save();
  }

  /** Phase 3：DCR 注册信息（OAuth 回调复用同一 client，避免重复注册）。 */
  getClient(serverId: string): McpStoredClient | undefined {
    return this.load().clients?.[String(serverId)];
  }

  setClient(serverId: string, client: McpStoredClient): void {
    const file = this.load();
    file.clients = file.clients || {};
    file.clients[String(serverId)] = client;
    this.save();
  }

  /** 文件路径（watch/诊断用）。 */
  get filePath(): string {
    return this.filePathValue;
  }

  private readonly filePathValue: string;
}
