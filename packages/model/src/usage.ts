import type { TextUsage } from './ports.js';

function toCount(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : undefined;
}

/**
 * 从各家响应里提取 token 用量（与可选的计费成本，部分中转会回传）。
 * T3.6：usage 抓到后进 trace 与每日日报——没有它，"成本断路器"只有估算没有事实。
 */
export function extractTextUsage(raw: unknown): TextUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const root = raw as Record<string, any>;
  const usage = root.usage && typeof root.usage === 'object' ? root.usage as Record<string, any> : undefined;
  const meta = root.usageMetadata && typeof root.usageMetadata === 'object' ? root.usageMetadata as Record<string, any> : undefined;
  if (!usage && !meta) return undefined;

  let promptTokens: number | undefined;
  let completionTokens: number | undefined;
  let totalTokens: number | undefined;
  let cost: number | undefined;

  if (usage) {
    // OpenAI 兼容（含多数中转）
    promptTokens = toCount(usage.prompt_tokens) ?? toCount(usage.input_tokens);
    completionTokens = toCount(usage.completion_tokens) ?? toCount(usage.output_tokens);
    totalTokens = toCount(usage.total_tokens) ?? toCount(usage.totalTokens);
    // 部分中转直接回传金额（美元）
    const rawCost = Number(usage.cost ?? usage.total_cost ?? usage.amount);
    if (Number.isFinite(rawCost) && rawCost > 0) cost = rawCost;
  } else if (meta) {
    // Gemini generateContent
    promptTokens = toCount(meta.promptTokenCount);
    completionTokens = toCount(meta.candidatesTokenCount);
    totalTokens = toCount(meta.totalTokenCount);
  }
  if (totalTokens === undefined && (promptTokens !== undefined || completionTokens !== undefined)) {
    totalTokens = (promptTokens || 0) + (completionTokens || 0);
  }
  if (promptTokens === undefined && completionTokens === undefined && totalTokens === undefined && cost === undefined) return undefined;
  return {
    ...(promptTokens !== undefined ? { promptTokens } : {}),
    ...(completionTokens !== undefined ? { completionTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(cost !== undefined ? { cost } : {}),
  };
}
