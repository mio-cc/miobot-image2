import type { CapabilityRegistry, ReasoningEffort } from '../../model/src/index.js';
import type { IntentCapabilities } from '../../intent-router/src/index.js';

/** 引擎路由所需的配置切片（由 apps/bot 从 normalized config 提供，支持热重载）。 */
export interface EngineRoutingConfig {
  chatEnabled?: boolean;
  chatModel: string;
  imageEnabled?: boolean;
  imageModel: string;
  editModel: string;
  interrogateModel: string;
  freeModeModel: string;
  freeModeNodeIndex?: number;
  freeModeEnabled?: boolean;
  preferEditWhenImagePresent?: boolean;
  maxOutputImages?: number;
  plannerTimeoutMs?: number;
  plannerPromptTemplate?: string;
  /** 推理模型(gpt-5/o1/o3/o4)的 reasoning_effort, 透传给 chat 请求。 */
  reasoningEffort?: ReasoningEffort;
}

/**
 * 把"配置里给各能力指派的模型 + 开关"翻译成 intent-router 的能力门控。
 * 关键：能力是否可用 = 开关开启 AND 该模型档案确实具备此能力。
 * 这正是修复"可以把生图路由指向纯文本模型"的地方。
 */
export function resolveImageCapabilities(cfg: EngineRoutingConfig, registry: CapabilityRegistry): IntentCapabilities {
  // chat 能力需同时考虑自由模式：freeMode 的文本回复走 freeMode 节点/freeModeModel，
  // 不应被 chatModel 的能力（或 chatEnabled）卡死，否则自由模式下任何对话都会被
  // gate() 降级成 ignore → bot 不回复。
  const chatCapable =
    (cfg.chatEnabled !== false && registry.can(cfg.chatModel, 'chat')) ||
    (Boolean(cfg.freeModeEnabled) && registry.can(cfg.freeModeModel, 'chat'));
  return {
    chat: chatCapable,
    imageGenerate: cfg.imageEnabled !== false && registry.can(cfg.imageModel, 'image.generate'),
    imageEdit: cfg.imageEnabled !== false && registry.can(cfg.editModel, 'image.edit'),
    interrogate: registry.can(cfg.interrogateModel, 'interrogate'),
  };
}
