import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type { CapabilityHandler, CapabilityInvocation, ExecutionResult } from '../../../packages/orchestration/src/index.js';

export interface ArtifactScope {
  chatType: 'group' | 'private';
  groupId?: string;
  userId: string;
}

export interface ManagedArtifactRecord {
  artifactId: string;
  chatType: 'group' | 'private';
  groupId?: string;
  ownerUserId: string;
  localPath: string;
  publicUrl?: string;
  name: string;
  mime?: string;
  size: number;
  mtimeMs: number;
  sha256: string;
  source: string;
  createdAt: string;
  expiresAt?: string;
  deletedAt?: string;
}

export interface RegisterArtifactInput {
  scope: ArtifactScope;
  localPath: string;
  publicUrl?: string;
  name?: string;
  mime?: string;
  source: string;
  expiresAt?: string;
}

export interface ManagedArtifactRegistryOptions {
  filePath: string;
  roots: string[];
}

function insideRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

function hashFile(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function sameScope(record: ManagedArtifactRecord, scope: ArtifactScope): boolean {
  return record.chatType === scope.chatType
    && String(record.groupId || '') === String(scope.groupId || '')
    && record.ownerUserId === String(scope.userId);
}

/**
 * 用户可删除文件必须来自此注册表，绝不允许模型传任意路径。
 * 记录文件指纹；审批后若文件被替换，删除会失败。
 */
export class ManagedArtifactRegistry {
  private readonly records = new Map<string, ManagedArtifactRecord>();
  private readonly roots: string[];

  constructor(private readonly options: ManagedArtifactRegistryOptions) {
    const roots = (options.roots || []).map((root) => path.resolve(root)).filter(Boolean);
    if (!roots.length) throw new Error('managed_artifact_roots_empty');
    this.roots = roots;
    this.load();
  }

  register(input: RegisterArtifactInput): ManagedArtifactRecord {
    const localPath = path.resolve(String(input.localPath || ''));
    if (!existsSync(localPath)) throw new Error('artifact_not_found');
    const linkStat = lstatSync(localPath);
    if (!linkStat.isFile() || linkStat.isSymbolicLink()) throw new Error('artifact_not_regular_file');
    const realPath = realpathSync(localPath);
    if (!this.roots.some((root) => insideRoot(root, realPath))) throw new Error('artifact_outside_managed_roots');
    const existing = Array.from(this.records.values()).find((record) =>
      !record.deletedAt
      && sameScope(record, input.scope)
      && (record.publicUrl || record.localPath) === (input.publicUrl || realPath));
    if (existing) return { ...existing };
    const stat = statSync(realPath);
    const now = new Date().toISOString();
    const record: ManagedArtifactRecord = {
      artifactId: 'art_' + randomUUID().replace(/-/g, '').slice(0, 20),
      chatType: input.scope.chatType,
      groupId: input.scope.groupId === undefined ? undefined : String(input.scope.groupId),
      ownerUserId: String(input.scope.userId),
      localPath: realPath,
      publicUrl: input.publicUrl,
      name: String(input.name || path.basename(realPath)),
      mime: input.mime,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      sha256: hashFile(realPath),
      source: String(input.source || 'unknown'),
      createdAt: now,
      expiresAt: input.expiresAt,
    };
    this.records.set(record.artifactId, record);
    this.flush();
    return { ...record };
  }

  getOwned(artifactId: string, scope: ArtifactScope): ManagedArtifactRecord | undefined {
    const record = this.records.get(String(artifactId || ''));
    if (!record || record.deletedAt || !sameScope(record, scope)) return undefined;
    if (record.expiresAt && Date.parse(record.expiresAt) <= Date.now()) return undefined;
    return { ...record };
  }

  list(scope: ArtifactScope, limit = 20): ManagedArtifactRecord[] {
    return Array.from(this.records.values())
      .filter((record) => !record.deletedAt && sameScope(record, scope) && (!record.expiresAt || Date.parse(record.expiresAt) > Date.now()))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, Math.max(1, Math.min(100, limit)))
      .map((record) => ({ ...record }));
  }

  verify(record: ManagedArtifactRecord): { ok: true } | { ok: false; reason: string } {
    if (!existsSync(record.localPath)) return { ok: false, reason: 'artifact_missing' };
    const linkStat = lstatSync(record.localPath);
    if (!linkStat.isFile() || linkStat.isSymbolicLink()) return { ok: false, reason: 'artifact_not_regular_file' };
    const realPath = realpathSync(record.localPath);
    if (!this.roots.some((root) => insideRoot(root, realPath))) return { ok: false, reason: 'artifact_outside_managed_roots' };
    const stat = statSync(realPath);
    if (stat.size !== record.size || Math.abs(stat.mtimeMs - record.mtimeMs) > 0.5) return { ok: false, reason: 'artifact_changed' };
    if (hashFile(realPath) !== record.sha256) return { ok: false, reason: 'artifact_hash_changed' };
    return { ok: true };
  }

  deleteOwned(artifactId: string, scope: ArtifactScope): ManagedArtifactRecord {
    const record = this.getOwned(artifactId, scope);
    if (!record) throw new Error('artifact_not_found_or_forbidden');
    const verified = this.verify(record);
    if (!verified.ok) throw new Error(verified.reason);
    unlinkSync(record.localPath);
    const deleted = { ...record, deletedAt: new Date().toISOString() };
    this.records.set(record.artifactId, deleted);
    this.flush();
    return { ...deleted };
  }

  private load(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.options.filePath, 'utf8')) as { artifacts?: ManagedArtifactRecord[] };
      for (const record of parsed.artifacts || []) {
        if (record?.artifactId && record?.localPath) this.records.set(record.artifactId, record);
      }
    } catch { /* first run or corrupt index: start empty */ }
  }

  private flush(): void {
    mkdirSync(path.dirname(this.options.filePath), { recursive: true });
    const temp = this.options.filePath + '.tmp';
    writeFileSync(temp, JSON.stringify({ artifacts: Array.from(this.records.values()) }, null, 2), 'utf8');
    renameSync(temp, this.options.filePath);
  }
}

export class FileDeleteCapabilityHandler implements CapabilityHandler {
  constructor(
    private readonly registry: ManagedArtifactRegistry,
    private readonly audit?: (record: Record<string, unknown>) => void,
  ) {}

  async execute(invocation: CapabilityInvocation): Promise<ExecutionResult> {
    const artifactId = String(invocation.step.args?.artifactId || '').trim();
    const scope: ArtifactScope = {
      chatType: invocation.request.chat.type,
      groupId: invocation.request.chat.groupId,
      userId: invocation.request.user.qq,
    };
    try {
      if (!artifactId) throw new Error('artifact_id_required');
      const record = this.registry.deleteOwned(artifactId, scope);
      this.audit?.({ type: 'file.delete', actor: invocation.request.user.qq, requestId: invocation.request.requestId, jobId: invocation.plan.planId, capability: 'file.delete', decision: 'deleted', data: { artifactId: record.artifactId, groupId: scope.groupId, name: record.name, bytes: record.size, sha256Prefix: record.sha256.slice(0, 12) } });
      return {
        jobId: invocation.plan.planId,
        stepId: invocation.step.id,
        status: 'success',
        outputs: [{ kind: 'text', text: `已删除文件：${record.name}`, priority: 10, mergeable: true }],
        diagnostics: { artifactId: record.artifactId, bytes: record.size, sha256Prefix: record.sha256.slice(0, 12) },
      };
    } catch (error) {
      this.audit?.({ type: 'file.delete', actor: invocation.request.user.qq, requestId: invocation.request.requestId, jobId: invocation.plan.planId, capability: 'file.delete', decision: 'failed', reason: String((error as Error)?.message || error), data: { artifactId } });
      return {
        jobId: invocation.plan.planId,
        stepId: invocation.step.id,
        status: 'failed',
        outputs: [],
        error: String((error as Error)?.message || error),
        retryable: false,
      };
    }
  }
}