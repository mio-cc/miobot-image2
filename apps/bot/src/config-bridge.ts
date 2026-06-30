import type { AppConfig } from '../../../packages/config/src/index.js';
import type { EngineRoutingConfig } from '../../../packages/bot-engine/src/index.js';
import type { ModelNode, ProviderDialect } from '../../../packages/model/src/index.js';

/** bot 各能力使用哪个节点（对应 16 路由表里 bot 那几条）。 */
export interface BotRouting {
  chatNodeIndex: number;
  imageNodeIndex: number;
  editNodeIndex: number;
  interrogateNodeIndex: number;
  freeModeNodeIndex: number;
}

const KNOWN_DIALECTS: ProviderDialect[] = ['openai', 'anthropic', 'gemini', 'huggingface', 'custom'];

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
      headers: node.headers,
      models: node.models,
      enabled: node.enabled,
    };
    if (raw.requestMode !== undefined) mapped.requestMode = raw.requestMode as ModelNode['requestMode'];
    if (raw.custom !== undefined) mapped.custom = raw.custom as ModelNode['custom'];
    return mapped;
  });
}

/** AppConfig → bot-engine 路由切片（模型 + 开关）。每次 handle 读取，支持热重载。 */
export function toEngineRoutingConfig(cfg: AppConfig): EngineRoutingConfig {
  return {
    chatEnabled: cfg.llm.chatEnabled,
    chatModel: cfg.llm.chatModel,
    imageEnabled: cfg.llm.imageEnabled,
    imageModel: cfg.llm.imageModel,
    editModel: cfg.llm.editModel,
    interrogateModel: cfg.llm.interrogateModel,
    freeModeModel: cfg.freeMode.model,
    freeModeNodeIndex: cfg.freeMode.nodeIndex,
    freeModeEnabled: cfg.freeMode.enabled,
    preferEditWhenImagePresent: cfg.freeMode.preferEditWhenImagePresent,
    maxOutputImages: cfg.freeMode.maxOutputImages,
    plannerTimeoutMs: cfg.freeMode.timeoutMs,
    plannerPromptTemplate: cfg.freeMode.plannerPromptTemplate,
  };
}

/** AppConfig → bot 各能力的节点索引。 */
export function toBotRouting(cfg: AppConfig): BotRouting {
  return {
    chatNodeIndex: cfg.llm.chatNodeIndex,
    imageNodeIndex: cfg.llm.imageNodeIndex,
    editNodeIndex: cfg.llm.editNodeIndex,
    interrogateNodeIndex: cfg.llm.interrogateNodeIndex,
    freeModeNodeIndex: cfg.freeMode.nodeIndex,
  };
}
