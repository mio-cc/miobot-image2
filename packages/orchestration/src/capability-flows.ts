import type { CapabilityFlowConfig } from './config.js';

/**
 * 流程编排（2026-11-07 拍板）——默认调用链的**提示派生**（纯函数，无运行时状态）。
 *
 * 设计约束（方案 §3/§4）：
 * - 链只是「默认优先，不锁死」的提示：所有输出恒带「（默认路径，可按需调整）」；
 * - 偏离不提示、不记录、不计数、不粘滞（既定裁定适用）；
 * - 单步 = 自己 = 无链（未配置或 steps 仅含自身时一律视为无链，零提示零成本）；
 * - 两个注入点同源派生：目录行尾标记（formatFlowCatalogMarker）与工具 description
 *   尾拼（formatFlowHint）——模型偏离链直调工具时描述仍在场。
 */

type Flows = Record<string, CapabilityFlowConfig> | undefined;

function effectiveFlow(capabilityId: string, flows: Flows): CapabilityFlowConfig | undefined {
  const flow = flows?.[capabilityId];
  if (!flow?.steps?.length) return undefined;
  // 单步且就是自己 = 默认链 = 无链。
  if (flow.steps.length === 1 && flow.steps[0].capability === capabilityId) return undefined;
  return flow;
}

/** 该能力是否存在有效默认链（供 UI 与注入点判断）。 */
export function hasEffectiveFlow(capabilityId: string, flows: Flows): boolean {
  return effectiveFlow(capabilityId, flows) !== undefined;
}

/** 工具 description 尾拼文本（模型读，含每步 hint 与 when）。 */
export function formatFlowHint(capabilityId: string, flows: Flows): string {
  const flow = effectiveFlow(capabilityId, flows);
  if (!flow) return '';
  const steps = flow.steps.map((step) =>
    `${step.capability}`
    + (step.hint ? `（${step.hint}）` : '')
    + (step.when ? `｜当：${step.when}` : ''));
  return `默认调用组合：${steps.join(' → ')}（默认路径，可按需调整）`;
}

/** 能力目录（capability.catalog）行尾链标记——紧凑形式，超过 2 步截断。 */
export function formatFlowCatalogMarker(capabilityId: string, flows: Flows): string {
  const flow = effectiveFlow(capabilityId, flows);
  if (!flow) return '';
  const ids = flow.steps.map((step) => step.capability);
  const short = ids.length > 2 ? `${ids[0]} → ${ids[1]} → …` : ids.join(' → ');
  return `［默认链：${short}］`;
}
