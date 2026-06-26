import type { PackageDescriptor } from '@miobot-v2/shared';

export const INTENT_ROUTER_PACKAGE: PackageDescriptor = {
  name: '@miobot-v2/intent-router',
  phase: 'P3-intent-router',
};

/**
 * 自动路由能识别的意图。`ignore` 表示没有任何可执行内容。
 * 显式命令（help/clear/模板库/远程模板等）由 bot-router 在进入本模块之前处理，
 * 本模块只负责"未命中显式命令、但被触发"的内容的能力判定。
 */
export type IntentKind =
  | 'chat'
  | 'image.generate'
  | 'image.edit'
  | 'image.interrogate'
  | 'ignore';

/** 决策来源：signal=确定性信号命中（无 LLM）；planner=LLM 规划器；fallback=兜底规则。 */
export type IntentSource = 'signal' | 'planner' | 'fallback';

/** 各能力是否在当前配置下可用（节点已启用 + 模型具备该能力）。 */
export interface IntentCapabilities {
  chat?: boolean;
  imageGenerate?: boolean;
  imageEdit?: boolean;
  interrogate?: boolean;
}

export interface IntentInput {
  /** 经 bot-router 清洗后的纯文本内容（已剥离 @、reply 段等）。 */
  text: string;
  /** 当前消息直接附带的图片引用（url / base64 / data url）。 */
  images?: string[];
  /** 引用消息/合并转发中可取到的图片（影响 edit/interrogate 判定）。 */
  hasReferencedImage?: boolean;
  chatType?: 'group' | 'private';
}

/** 最终落到下游能力的参数。bang 参数始终覆盖 planner 输出。 */
export interface IntentParams {
  prompt: string;
  size?: string;
  count?: number;
  quality?: string;
  templateId?: string;
  /** 识别到的 bang token，便于下游复用/记录。 */
  tokens: string[];
}

export interface IntentDecision {
  kind: IntentKind;
  source: IntentSource;
  /** 0..1，确定性信号通常 >=0.85，planner 给 0.7，兜底 <=0.5。 */
  confidence: number;
  reason: string;
  params: IntentParams;
  usedPlanner: boolean;
  /** 因能力不可用而发生的降级（原意图 -> 实际意图），用于日志与可观测性。 */
  degradedFrom?: IntentKind;
}

export interface IntentSignal {
  kind: IntentKind;
  confidence: number;
  reason: string;
}
