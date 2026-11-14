import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../../../packages/config/src/index.js';
import type { StructuredLogger } from '../../../packages/logger/src/index.js';
import type { ModelFallbackController } from './model-fallback.js';
import {
  OpenAIEmbeddingProvider,
  memoryDayKey,
  type EmbeddingProvider,
  type IngestMemoryInput,
  type MemoryContextResult,
  type MemoryDocument,
  type MemoryHit,
  type MemoryNamespace,
  type MemorySummarizer,
  type RetrieveMemoryInput,
} from './memory-service.js';

export interface QdrantMemoryOptions {
  rootDir: string | (() => string);
  getConfig: () => AppConfig;
  embedding?: EmbeddingProvider;
  fallback?: ModelFallbackController;
  summarize?: MemorySummarizer;
  isRejectedMessageId?: (messageId: string) => boolean;
  logger?: StructuredLogger;
  url?: string;
  apiKey?: string;
  collection?: string;
  timeoutMs?: number;
}

type QdrantPayload = Record<string, unknown>;
interface QdrantPoint { id: string; vector?: number[]; payload?: QdrantPayload; score?: number; }

export class QdrantMemoryService {
  private readonly embedding: EmbeddingProvider;
  private readonly url: string;
  private readonly apiKey: string;
  private readonly collection: string;
  private readonly timeoutMs: number;
  private ready: Promise<void> | undefined;

  constructor(private readonly options: QdrantMemoryOptions) {
    this.embedding = options.embedding || new OpenAIEmbeddingProvider(options.getConfig, options.logger, options.fallback);
    this.url = String(options.url || process.env.QDRANT_URL || '').replace(/\/+$/, '');
    this.apiKey = String(options.apiKey || process.env.QDRANT_API_KEY || '');
    this.collection = String(options.collection || process.env.QDRANT_COLLECTION || 'miobot_memory');
    this.timeoutMs = Math.max(1000, Number(options.timeoutMs || process.env.QDRANT_TIMEOUT_MS || 10000));
  }

  private rootPath(): string {
    const value = typeof this.options.rootDir === 'function' ? this.options.rootDir() : this.options.rootDir;
    return String(value || '').trim() || path.resolve('.runtime', 'memory');
  }

  private get enabled(): boolean {
    const memory = this.options.getConfig().orchestration.memory;
    return Boolean(memory.enabled && memory.autoIngest);
  }

  private async request(method: string, route: string, body?: unknown): Promise<any> {
    if (!this.url) throw new Error('qdrant_url_missing');
    if (!this.apiKey) throw new Error('qdrant_api_key_missing');
    const response = await fetch(this.url + route, {
      method,
      headers: { 'api-key': this.apiKey, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await response.text().catch(() => '');
    if (!response.ok) throw new Error('qdrant_http_' + response.status + ':' + text.slice(0, 200));
    return text ? JSON.parse(text) : {};
  }

  private async ensureCollection(): Promise<void> {
    if (!this.ready) {
      this.ready = (async () => {
        const memory = this.options.getConfig().orchestration.memory;
        const dimensions = Math.max(1, Math.trunc(Number(memory.embeddingDimensions) || 1536));
        let info: any;
        try {
          info = await this.request('GET', '/collections/' + encodeURIComponent(this.collection));
        } catch (error) {
          if (!String((error as Error)?.message || error).includes('qdrant_http_404')) throw error;
        }
        const vectors = info?.result?.config?.params?.vectors;
        const size = Number(vectors?.size || 0);
        if (size && size !== dimensions) throw new Error('qdrant_dimension_mismatch:' + size + '!=' + dimensions);
        if (!size) {
          await this.request('PUT', '/collections/' + encodeURIComponent(this.collection) + '?wait=true', {
            vectors: { size: dimensions, distance: 'Cosine' },
            optimizers_config: { default_segment_number: 2 },
          });
        }
        for (const [field, schema] of [
          ['botId', 'keyword'], ['scope', 'keyword'], ['groupId', 'keyword'], ['userId', 'keyword'],
          ['messageId', 'keyword'], ['dayBucket', 'keyword'], ['createdAt', 'datetime'], ['text', 'text'],
        ] as const) {
          try {
            await this.request('PUT', '/collections/' + encodeURIComponent(this.collection) + '/index?wait=true', { field_name: field, field_schema: schema });
          } catch { /* index already exists or backend rejected optional index */ }
        }
      })();
    }
    await this.ready;
  }

  private pointId(value: string): string {
    const hex = createHash('sha256').update(String(value)).digest('hex');
    return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-4' + hex.slice(13, 16) + '-8' + hex.slice(17, 20) + '-' + hex.slice(20, 32);
  }

  private async upsert(points: QdrantPoint[]): Promise<void> {
    if (!points.length) return;
    await this.ensureCollection();
    for (let offset = 0; offset < points.length; offset += 64) {
      await this.request('PUT', '/collections/' + encodeURIComponent(this.collection) + '/points?wait=true', { points: points.slice(offset, offset + 64) });
    }
  }

  private filterFor(base: Record<string, string>, extra: Array<Record<string, unknown>> = []): Record<string, unknown> {
    const must: Array<Record<string, unknown>> = [];
    for (const [key, value] of Object.entries(base)) {
      if (value !== '') must.push({ key, match: { value } });
    }
    must.push(...extra);
    return { must };
  }

  private augmentText(text: string, attachments?: IngestMemoryInput["attachments"]): string {
    const refs = (attachments || []).map((item) => "[" + item.type + ":" + String(item.ref || item.name || "") + "]").filter((item) => item !== "[image:]" && item !== "[file:]");
    return [String(text || "").trim(), ...refs].filter(Boolean).join("\\n");
  }

  private payloadFor(doc: MemoryDocument, input?: IngestMemoryInput): QdrantPayload {
    return {
      id: doc.id,
      botId: doc.botId,
      scope: doc.scope,
      groupId: doc.groupId,
      userId: doc.userId,
      authorName: doc.authorName,
      role: doc.role,
      text: doc.text,
      createdAt: doc.createdAt,
      dayBucket: memoryDayKey(doc.createdAt),
      messageId: doc.messageId,
      embeddingModel: doc.embeddingModel,
      embeddingDimensions: doc.embeddingDimensions,
      source: input?.source || "observation",
      attachments: input?.attachments || [],
    };
  }

  private docFromPayload(payload: QdrantPayload, score = 0): MemoryHit {
    return {
      id: String(payload.id || ""),
      scope: String(payload.scope || "group_shared") as MemoryHit["scope"],
      groupId: String(payload.groupId || ""),
      userId: String(payload.userId || ""),
      authorName: String(payload.authorName || payload.userId || ""),
      role: String(payload.role || "user") as MemoryHit["role"],
      text: String(payload.text || ""),
      createdAt: String(payload.createdAt || ""),
      messageId: payload.messageId === undefined ? undefined : String(payload.messageId),
      score,
    };
  }

  private rejected(messageId: string | undefined): boolean {
    if (!messageId) return false;
    try { return Boolean(this.options.isRejectedMessageId?.(messageId)); } catch { return false; }
  }

  private async embed(input: string[]): Promise<number[][]> {
    return this.embedding.embed(input);
  }

  async ingest(input: IngestMemoryInput): Promise<{ ok: boolean; indexed: number; deduped?: boolean; error?: string }> {
    const results = await this.ingestBatch([input]);
    return results[0];
  }

  async ingestBatch(inputs: IngestMemoryInput[]): Promise<Array<{ ok: boolean; indexed: number; deduped?: boolean; error?: string }>> {
    const memory = this.options.getConfig().orchestration.memory;
    if (!memory.enabled || !memory.autoIngest) return (inputs || []).map(() => ({ ok: false, indexed: 0, error: "memory_disabled" }));
    const items = (inputs || []).map((input) => ({ input, text: this.augmentText(input.text, input.attachments) }));
    const results = items.map(() => ({ ok: false, indexed: 0 } as { ok: boolean; indexed: number; deduped?: boolean; error?: string }));
    const embeddable = items.map((item, index) => ({ item, index })).filter(({ item }) => item.text);
    if (!embeddable.length) return results;
    let vectors: number[][];
    try { vectors = await this.embed(embeddable.map(({ item }) => item.text)); } catch (error) {
      const message = String((error as Error)?.message || error);
      return results.map(() => ({ ok: false, indexed: 0, error: message }));
    }
    const points: QdrantPoint[] = [];
    for (let i = 0; i < embeddable.length; i += 1) {
      const { item, index } = embeddable[i];
      const vector = vectors[i] || [];
      if (!vector.length) { results[index] = { ok: false, indexed: 0, error: "empty_embedding" }; continue; }
      const input = item.input;
      const createdAt = input.eventTime || input.createdAt || new Date().toISOString();
      const messageId = String(input.messageId || this.pointId(item.text.slice(0, 200) + createdAt));
      const base: MemoryDocument = {
        id: "", botId: input.botId, scope: "group_shared", groupId: String(input.groupId || ""), userId: String(input.userId || ""),
        authorName: String(input.authorName || input.userId || ""), role: input.role, text: item.text, createdAt,
        messageId, embeddingModel: this.embedding.model, embeddingDimensions: this.embedding.dimensions, embedding: vector,
      };
      if (input.chatType === "group") {
        const groupId = String(input.groupId || "");
        const groupDoc = { ...base, id: "g:" + messageId + ":" + input.role, scope: "group_shared" as const, groupId };
        points.push({ id: this.pointId(groupDoc.id), vector, payload: this.payloadFor(groupDoc, input) });
        if (memory.userGlobalProfileEnabled) {
          const personalDoc = { ...base, id: "p:" + messageId + ":" + input.role, scope: "personal_group_user" as const, groupId: "" };
          points.push({ id: this.pointId(personalDoc.id), vector, payload: this.payloadFor(personalDoc, input) });
        }
      } else {
        const privateDoc = { ...base, id: "u:" + messageId + ":" + input.role, scope: "private_user" as const };
        points.push({ id: this.pointId(privateDoc.id), vector, payload: this.payloadFor(privateDoc, input) });
      }
      results[index] = { ok: true, indexed: 1 };
    }
    try { await this.upsert(points); } catch (error) {
      const message = String((error as Error)?.message || error);
      return results.map((result) => result.ok ? { ok: false, indexed: 0, error: message } : result);
    }
    return results;
  }

  private scopeFilters(input: RetrieveMemoryInput): Array<{ filter: Record<string, unknown>; label: string }> {
    const output: Array<{ filter: Record<string, unknown>; label: string }> = [];
    const add = (label: string, base: Record<string, string>) => {
      output.push({ label, filter: this.filterFor(base) });
    };
    if (input.chatType === "group") {
      const groupId = String(input.groupId || "");
      const requested = input.scopeFilter && input.scopeFilter.length ? input.scopeFilter : ["group_shared", ...(this.options.getConfig().orchestration.memory.userGlobalProfileEnabled ? ["personal_group_user" as const] : [])];
      if (requested.includes("group_shared")) add("group:" + groupId, { botId: input.botId, groupId, scope: "group_shared" });
      if (requested.includes("personal_group_user")) add("personal:" + input.userId, { botId: input.botId, userId: input.userId, scope: "personal_group_user" });
      if (requested.includes("private_user")) add("private:" + input.userId, { botId: input.botId, userId: input.userId, scope: "private_user" });
    } else {
      const requested = input.scopeFilter && input.scopeFilter.length ? input.scopeFilter : ["private_user"];
      if (requested.includes("private_user")) add("private:" + input.userId, { botId: input.botId, userId: input.userId, scope: "private_user" });
      if (requested.includes("personal_group_user")) add("personal:" + input.userId, { botId: input.botId, userId: input.userId, scope: "personal_group_user" });
    }
    return output;
  }

  async retrieve(input: RetrieveMemoryInput): Promise<MemoryContextResult> {
    const memory = this.options.getConfig().orchestration.memory;
    if (!memory.enabled) return { context: "", hits: [], degraded: false, namespaces: [] };
    const policy = this.options.getConfig().contextPolicy;
    const topK = Math.max(1, Math.trunc(Number(input.topK) || policy.memoryTopK));
    const minScore = Number.isFinite(Number(input.minScore)) ? Number(input.minScore) : policy.memoryMinScore;
    const maxChars = Math.max(200, Math.trunc(Number(input.maxContextChars) || policy.memoryMaxChars));
    const query = String(input.query || "").trim();
    const excludeIds = new Set((input.excludeMessageIds || []).map((id) => String(id)).filter(Boolean));
    const excludeTexts = new Set((input.excludeTexts || []).map((text) => String(text || "").replace(/\\s+/g, " ").trim()).filter(Boolean));
    const filters = this.scopeFilters(input);
    let queryVector: number[] | undefined;
    let degraded = false;
    if (query) {
      try { queryVector = (await this.embed([query]))[0]; } catch (error) { degraded = true; this.options.logger?.warn("qdrant query embedding failed", { error: String((error as Error)?.message || error) }); }
    }
    const hits: MemoryHit[] = [];
    for (const scope of filters) {
      try {
        if (queryVector?.length) {
          const result = await this.request("POST", "/collections/" + encodeURIComponent(this.collection) + "/points/search", {
            vector: queryVector, limit: Math.max(topK * 2, 5), with_payload: true, score_threshold: Math.max(0, minScore), filter: scope.filter,
          });
          for (const point of result?.result || []) {
            if (point.score !== undefined && Number(point.score) < minScore) continue;
            hits.push(this.docFromPayload(point.payload || {}, Number(point.score) || 0));
          }
        } else {
          const result = await this.request("POST", "/collections/" + encodeURIComponent(this.collection) + "/points/scroll", { filter: scope.filter, limit: Math.max(topK * 2, 20), with_payload: true, with_vector: false });
          for (const point of result?.result?.points || []) hits.push(this.docFromPayload(point.payload || {}, 0));
        }
      } catch (error) {
        degraded = true;
        this.options.logger?.warn("qdrant memory search failed", { scope: scope.label, error: String((error as Error)?.message || error) });
      }
    }
    const seen = new Set<string>();
    const merged = hits.filter((hit) => {
      if (!hit.text || excludeIds.has(String(hit.messageId || ""))) return false;
      const normalized = hit.text.replace(/\\s+/g, " ").trim();
      if (excludeTexts.has(normalized)) return false;
      const key = String(hit.messageId || normalized);
      if (seen.has(key)) return false;
      seen.add(key);
      return !this.rejected(hit.messageId) && !this.options.isRejectedMessageId?.(String(hit.messageId || ""));
    });
    merged.sort((a, b) => b.score - a.score || String(b.createdAt).localeCompare(String(a.createdAt)));
    const selected = merged.slice(0, topK);
    const contextLines: string[] = [];
    let used = 0;
    for (const hit of selected) {
      const role = hit.role === "assistant" ? "助手" : hit.role === "system" ? "摘要" : "用户";
      const stamp = String(hit.createdAt || "").slice(0, 16).replace("T", " ");
      const line = "[" + stamp + "] " + hit.authorName + " [QQ:" + hit.userId + "] (" + role + "): " + hit.text.replace(/\\s+/g, " ").slice(0, 500);
      if (used + line.length > maxChars) continue;
      contextLines.push(line); used += line.length;
    }
    return { context: contextLines.join("\\n"), hits: selected, degraded, namespaces: filters.map((item) => item.label) };
  }

  private statePath(): string { return path.join(this.rootPath(), "retention-state.json"); }
  private async readRetentionState(): Promise<{ lastRetentionRunAt?: string }> {
    try { return JSON.parse(await fs.readFile(this.statePath(), "utf8")); } catch { return {}; }
  }
  async retentionState(): Promise<{ lastRetentionRunAt?: string; due: boolean; cleanupIntervalDays: number; retentionDays: number }> {
    const memory = this.options.getConfig().orchestration.memory;
    const state = await this.readRetentionState();
    return { ...(state.lastRetentionRunAt ? { lastRetentionRunAt: state.lastRetentionRunAt } : {}), due: this.shouldRunRetention(Date.now(), state), cleanupIntervalDays: Math.max(1, memory.retention.cleanupIntervalDays), retentionDays: Math.max(1, memory.retentionDays) };
  }
  shouldRunRetention(now = Date.now(), state: { lastRetentionRunAt?: string } = {}): boolean {
    const interval = Math.max(1, this.options.getConfig().orchestration.memory.retention.cleanupIntervalDays) * 86400000;
    const last = Date.parse(String(state.lastRetentionRunAt || ""));
    return !Number.isFinite(last) || now - last >= interval;
  }
  private async deleteFilter(filter: Record<string, unknown>): Promise<void> {
    await this.ensureCollection();
    await this.request("POST", "/collections/" + encodeURIComponent(this.collection) + "/points/delete?wait=true", { filter });
  }
  private async countFilter(filter: Record<string, unknown>): Promise<number> {
    await this.ensureCollection();
    const result = await this.request("POST", "/collections/" + encodeURIComponent(this.collection) + "/points/count", { filter, exact: true });
    return Number(result?.result?.count || 0);
  }
  private async scroll(filter: Record<string, unknown>, limit = 1000): Promise<any[]> {
    const points: any[] = [];
    let offset: unknown; do {
      const body: Record<string, unknown> = { filter, limit, with_payload: true, with_vector: false };
      if (offset !== undefined) body.offset = offset;
      const result = await this.request("POST", "/collections/" + encodeURIComponent(this.collection) + "/points/scroll", body);
      const page = result?.result || {};
      for (const point of page.points || []) points.push(point);
      offset = page.next_page_offset;
    } while (offset !== undefined && offset !== null);
    return points;
  }

  async listNamespaces(): Promise<Array<{ key: string; namespace: MemoryNamespace; count: number }>> {
    try {
      const points = await this.scroll({});
      const groups = new Map<string, { namespace: MemoryNamespace; count: number }>();
      for (const point of points) {
        const payload = point.payload || {};
        const scope = String(payload.scope || "");
        const kind: MemoryNamespace["kind"] = scope === "private_user" ? "private" : scope === "personal_group_user" ? "personal" : "group";
        const ns: MemoryNamespace = { kind, botId: String(payload.botId || ""), ...(kind === "group" ? { groupId: String(payload.groupId || "") } : { userId: String(payload.userId || ""), ...(kind === "personal" ? { groupId: "" } : {}) }) };
        const key = kind + ":" + ns.botId + ":" + (ns.groupId || "") + ":" + (ns.userId || "");
        const existing = groups.get(key);
        if (existing) existing.count += 1; else groups.set(key, { namespace: ns, count: 1 });
      }
      return [...groups.entries()].map(([key, value]) => ({ key, namespace: value.namespace, count: value.count }));
    } catch { return []; }
  }

  async clearNamespace(ns: MemoryNamespace): Promise<void> {
    const base: Record<string, string> = { botId: ns.botId };
    if (ns.groupId) base.groupId = String(ns.groupId);
    if (ns.userId) base.userId = String(ns.userId);
    if (ns.kind === "group") base.scope = "group_shared";
    else if (ns.kind === "personal") base.scope = "personal_group_user";
    else base.scope = "private_user";
    await this.deleteFilter(this.filterFor(base));
  }

  async clearUser(botId: string, userId: string, groupId?: string): Promise<number> {
    const base: Record<string, string> = { botId, userId };
    if (groupId) base.groupId = String(groupId);
    const filter = this.filterFor(base);
    const count = await this.countFilter(filter);
    if (count) await this.deleteFilter(filter);
    return count;
  }

  async removeByMessageId(messageId: string): Promise<number> {
    const value = String(messageId || "").trim();
    if (!value) return 0;
    const filter = this.filterFor({ messageId: value });
    const count = await this.countFilter(filter);
    if (count) await this.deleteFilter(filter);
    return count;
  }

  async retentionCleanup(input: { now?: number; dryRun?: boolean; backup?: boolean; force?: boolean } = {}): Promise<{ ran: boolean; dryRun: boolean; removed: number; namespaces: number; cutoffDay: string; backupFile?: string; ranAt: string; reason?: string }> {
    const memory = this.options.getConfig().orchestration.memory;
    const now = input.now ?? Date.now();
    const ranAt = new Date(now).toISOString();
    const cutoff = new Date(now - (Math.max(1, memory.retentionDays) - 1) * 86400000).toISOString();
    const cutoffDay = memoryDayKey(cutoff);
    const base = { ran: false, dryRun: input.dryRun === true, removed: 0, namespaces: 0, cutoffDay, ranAt };
    if (!memory.enabled) return { ...base, reason: "memory_disabled" };
    const state = await this.readRetentionState();
    if (!input.dryRun && !input.force && !this.shouldRunRetention(now, state)) return { ...base, reason: "not_due" };
    const filter = { must: [{ key: "createdAt", range: { lt: cutoff } }] };
    const points = await this.scroll(filter);
    let backupFile: string | undefined;
    if (input.backup !== false && points.length && !input.dryRun) {
      await fs.mkdir(this.rootPath(), { recursive: true });
      backupFile = path.join(this.rootPath(), "retention-backup-" + ranAt.replace(/[:.]/g, "-") + ".json");
      await fs.writeFile(backupFile, JSON.stringify({ exportedAt: ranAt, count: points.length, documents: points.map((point) => point.payload || {}) }, null, 2), "utf8");
    }
    if (!input.dryRun && points.length) {
      const ids = points.map((point) => point.id);
      for (let offset = 0; offset < ids.length; offset += 256) {
        await this.request("POST", "/collections/" + encodeURIComponent(this.collection) + "/points/delete?wait=true", { points: ids.slice(offset, offset + 256) });
      }
      await fs.mkdir(this.rootPath(), { recursive: true });
      await fs.writeFile(this.statePath(), JSON.stringify({ lastRetentionRunAt: ranAt }, null, 2), "utf8");
    }
    return { ran: true, dryRun: input.dryRun === true, removed: input.dryRun ? 0 : points.length, namespaces: new Set(points.map((point) => String(point.payload?.scope || ""))).size, cutoffDay, ranAt, ...(backupFile ? { backupFile } : {}) };
  }

  async summarizeSession(input: { botId: string; chatType: "group" | "private"; groupId?: string; userId: string; messages: Array<{ role: "user" | "assistant" | "system"; text: string; userId?: string }> }): Promise<{ ok: boolean; summaryChars?: number; error?: string }> {
    const memory = this.options.getConfig().orchestration.memory;
    if (!memory.enabled || !memory.autoIngest) return { ok: false, error: "memory_disabled" };
    if (!this.options.summarize) return { ok: false, error: "summarizer_missing" };
    const messages = (input.messages || []).filter((item) => item.role !== "system" && String(item.text || "").trim());
    if (messages.length < 2) return { ok: false, error: "not_enough_turns" };
    const namespace: MemoryNamespace = input.chatType === "group" ? { kind: "group", botId: input.botId, groupId: String(input.groupId || "") } : { kind: "private", botId: input.botId, userId: String(input.userId) };
    let summary = "";
    try { summary = String(await this.options.summarize({ namespace, messages: messages as any }) || "").trim(); } catch (error) { return { ok: false, error: String((error as Error)?.message || error) }; }
    if (!summary) return { ok: false, error: "empty_summary" };
    const result = await this.ingest({ botId: input.botId, chatType: input.chatType, groupId: input.groupId, userId: input.userId, authorName: "会话收尾摘要", role: "system", text: "【会话收尾摘要】" + summary, messageId: "tail:" + Date.now(), source: "summary" });
    return result.ok ? { ok: true, summaryChars: summary.length } : { ok: false, error: result.error };
  }

  async consolidate(): Promise<{ namespaces: number; scored: number; merged: number; evicted: number; pruned: number }> {
    return { namespaces: 0, scored: 0, merged: 0, evicted: 0, pruned: 0 };
  }

  async flush(): Promise<void> {}
}
