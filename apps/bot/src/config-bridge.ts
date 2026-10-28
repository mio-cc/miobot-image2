import type { AppConfig, ConfigCapabilityOverride } from '../../../packages/config/src/index.js';
import type { CapabilityOverride, ModelNode, ModelOperation, ProviderDialect } from '../../../packages/model/src/index.js';

/** bot 各能力使用哪个节点（对应 16 路由表里 bot 那几条）。 */
export interface BotRouting {
  chatNodeIndex: number;
  imageNodeIndex: number;
  editNodeIndex: number;
  interrogateNodeIndex: number;
  videoNodeIndex: number;
  freeModeNodeIndex: number;
  /** 视频 HTTP 超时与轮询参数（透传 generateVideo）。 */
  videoTimeoutMs?: number;
  videoPollTimeoutMs?: number;
  videoPollIntervalMs?: number;
  /**
   * 生图/改图/反推的超时。以前这三个字段在 config 里归一化得好好的、面板上也能改，
   * 但从来没有任何调用方把它们传给 ModelClient，于是全部落到客户端默认的 60s——
   * 而 gpt-image 系单次出图 60-180s 很常见，等于所有生图必然超时。
   */
  imageTimeoutMs?: number;
  interrogateTimeoutMs?: number;
  /** 生图失败重试（面板上原本是个死输入框）。 */
  imageRetryCount?: number;
  imageRetryDelayMs?: number;
  /** 改图请求形态的手动挡。面板上这个下拉框以前对 ModelClient 完全无效。 */
  imageEditRequestMode?: 'auto' | 'json-images' | 'json-image' | 'multipart';
}

const KNOWN_DIALECTS: ProviderDialect[] = ['openai', 'anthropic', 'gemini', 'huggingface', 'custom'];

// ── R15/M-1+M-4：多源配置收口（bridge 是唯一读取点）────────────────────────
// 业务层禁止再写 `a ?? b ?? c` 多源链；凡是有历史双源/多源的字段，统一在
// bridge 里读一次、给定唯一优先级，业务侧只取 bridge 输出。

/**
 * 群历史上下文的单一读取点（M-1）。历史上有两套字段：v3 contextPolicy.*
 * 与旧 bot.groupContext.*——两页 UI 都能改、运行时 `?? ` 链取值导致"配置失灵"。
 * R15 裁定：contextPolicy 为唯一真源；bot.groupContext 仅作老配置迁移来源，
 * 只有 contextPolicy 未设置（undefined，而非 false）时才回退旧值。
 */
export function toGroupContextConfig(cfg: AppConfig): { enabled: boolean; messageCount: number; skipForward: boolean; includeImages: boolean; maxChars: number } {
  const cp = cfg.contextPolicy;
  const gc = cfg.bot?.groupContext;
  return {
    enabled: cp?.groupContextEnabled ?? gc?.enabled ?? true,
    messageCount: cp?.groupContextMessages ?? gc?.messageCount ?? 30,
    skipForward: gc?.skipForward ?? true,
    includeImages: gc?.includeImages ?? true,
    maxChars: cp?.groupContextMaxChars ?? gc?.maxChars ?? 4000,
  };
}

/**
 * 主聊天模型（节点+模型名）的单一读取点（M-4 前半）。历史四级 fallback：
 * 专用位 ?? planner ?? llm.chat* —— 收进 bridge 一处，语义与旧链路一致：
 * 显式专用位优先，没有专用配置时退到 chat 主模型。
 */
export function toMainModelSelection(cfg: AppConfig): { nodeIndex: number; model: string } {
  return {
    nodeIndex: Number(cfg.agent?.mainNodeIndex ?? cfg.llm?.chatNodeIndex ?? 0),
    model: String(cfg.agent?.mainModel || cfg.llm?.chatModel || '').trim(),
  };
}

/**
 * 推断节点方言：优先节点显式 dialect 字段（向后兼容，老配置没有则继续），
 * 其次看 provider 是否恰好是已知方言名，最后兜底 openai（= 现状行为）。
 * 注：给 ApiNode 正式加 dialect 字段属于 config schema 变更，待 P-config 落；此处用宽松读取桥接。
 */
function inferDialect(node: Record<string, unknown>): ProviderDialect {
  const explicit = String(node.dialect || '').trim().toLowerCase();
  if ((KNOWN_DIALECTS as string[]).includes(explicit)) return explicit as ProviderDialect;
  const provider = String(node.provider || '').trim().toLowerCase();
  if ((KNOWN_DIALECTS as string[]).includes(provider)) return provider as ProviderDialect;
  return 'openai';
}

/** AppConfig.llm.apiKeys(ApiNode[]) → model 层 ModelNode[]。 */
export function toModelNodes(cfg: AppConfig): ModelNode[] {
  const nodes = cfg.llm?.apiKeys || [];
  return nodes.map((node) => {
    const raw = node as unknown as Record<string, unknown>;
    const mapped: ModelNode = {
      name: node.name,
      dialect: inferDialect(raw),
      baseUrl: node.baseUrl,
      apiKey: node.key,
      headers: expandApiNodeHeaders(node.headers, node.key),
      models: node.models,
      enabled: node.enabled,
      concurrency: node.concurrency,
    };
    if (raw.requestMode !== undefined) mapped.requestMode = raw.requestMode as ModelNode['requestMode'];
    if (raw.custom !== undefined) mapped.custom = raw.custom as ModelNode['custom'];
    return mapped;
  });
}

/** AppConfig → bot-engine 路由切片（模型 + 开关）。每次 handle 读取，支持热重载。 */
function expandHeaderValue(value: string, apiKey: string): string {
  return String(value || '')
    .replace(/\{\{\s*apiKey\s*\}\}/gi, apiKey)
    .replace(/\{\{\s*env:([A-Z0-9_]+)\s*\}\}/gi, (_, name) => String(process.env[name] || ''))
    .replace(/^\$ENV:([A-Z0-9_]+)$/i, (_, name) => String(process.env[name] || ''));
}

function expandApiNodeHeaders(headers: Record<string, string> | undefined, apiKey: string): Record<string, string> | undefined {
  if (!headers || typeof headers !== 'object') return headers;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const expanded = expandHeaderValue(value, apiKey);
    if (expanded) out[key] = expanded;
  }
  return out;
}

export function toBotRouting(cfg: AppConfig): BotRouting {
  return {
    chatNodeIndex: cfg.llm.chatNodeIndex,
    imageNodeIndex: cfg.llm.imageNodeIndex,
    editNodeIndex: cfg.llm.editNodeIndex,
    interrogateNodeIndex: cfg.llm.interrogateNodeIndex,
    videoNodeIndex: cfg.llm.videoNodeIndex,
    freeModeNodeIndex: cfg.freeMode.nodeIndex,
    videoTimeoutMs: cfg.llm.videoTimeoutMs,
    videoPollTimeoutMs: cfg.llm.videoPollTimeoutMs,
    videoPollIntervalMs: cfg.llm.videoPollIntervalMs,
    imageTimeoutMs: cfg.llm.imageTimeoutMs,
    interrogateTimeoutMs: cfg.llm.interrogateTimeoutMs,
    imageRetryCount: cfg.llm.imageRetryCount,
    imageRetryDelayMs: cfg.llm.imageRetryDelayMs,
    imageEditRequestMode: cfg.llm.imageEditRequestMode,
  };
}

/** AppConfig.llm.capabilityOverrides(配置层) → model 层 CapabilityOverride[]。把 string[] operations 转成强类型 ModelOperation[]。 */
export function toCapabilityOverrides(overrides: ConfigCapabilityOverride[] | undefined): CapabilityOverride[] {
  if (!Array.isArray(overrides) || !overrides.length) return [];
  const ALLOWED: ModelOperation[] = ['chat', 'vision', 'interrogate', 'image.generate', 'image.edit', 'video.generate'];
  return overrides
    .filter((o) => o && String(o.model || '').trim())
    .map((o) => {
      const ops = (o.operations || []).map((op) => String(op || '').trim() as ModelOperation).filter((op) => (ALLOWED as string[]).includes(op));
      return ops.length ? { model: String(o.model).trim(), operations: ops } : { model: String(o.model).trim() };
    });
}
