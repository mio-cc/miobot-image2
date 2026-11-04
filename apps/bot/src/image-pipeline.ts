import { applyTemplateById, renderPromptTemplate } from '../../../packages/image/src/index.js';
import type { ModelClient } from '../../../packages/model/src/index.js';
import type { AppConfig } from '../../../packages/config/src/index.js';
import { withPurposeFallback, type ModelFallbackController } from './model-fallback.js';

/**
 * 生图提示词流水线(优化版):本地模板渲染 → 可选 LLM 润色(enhance) → 生成;失败时安全改写重试一次。
 * 复用 packages/image 的 applyTemplateById/renderPromptTemplate;润色/改写走 ModelClient。
 * P2(方案 6-P2):润色接入用途级备用——purpose 常量 'enhance',主润色模型失败按状态机切备救本次;
 * 未配置备用(fallbackEnhanceModel 空)时整体 bypass,行为与原先逐字节一致。润色失败仍不阻塞生图。
 */
export interface ImagePromptPipeline {
  /** 渲染模板 + 可选润色,返回最终 prompt。 */
  prepare(input: { prompt: string; templateId?: string }): Promise<string>;
  /** 生成失败后的安全改写(返回 undefined 表示未启用/失败)。 */
  safeRewrite(prompt: string): Promise<string | undefined>;
}

export function createImagePromptPipeline(client: ModelClient, getConfig: () => AppConfig, fallback?: ModelFallbackController): ImagePromptPipeline {
  async function rewrite(prompt: string, nodeIndex: number, model: string, template: string): Promise<string> {
    const rendered = renderPromptTemplate(template, { rawPrompt: prompt, prompt }) || prompt;
    const res = await client.chat(nodeIndex, { model, messages: [{ role: 'user', content: rendered }] });
    return cleanupModelText(res.text) || prompt;
  }

  /** enhance 调用统一出口（接入点 purpose = 'enhance'）；无 controller 时保持原直调。
   *  turn=false 用于生图失败后的安全改写（修复类调用 → follow 当前档位，不切不计数）。 */
  async function enhanceCall(prompt: string, template: string, turn = true): Promise<string> {
    const llm = getConfig().llm;
    if (!fallback) return rewrite(prompt, llm.enhanceNodeIndex, llm.enhanceModel, template);
    return withPurposeFallback(fallback, 'enhance',
      { nodeIndex: llm.enhanceNodeIndex, model: llm.enhanceModel },
      (target) => rewrite(prompt, target.nodeIndex, target.model, template),
      { turn });
  }

  return {
    async prepare({ prompt, templateId }) {
      const cfg = getConfig();
      let out = applyTemplateById(prompt, templateId, cfg.bot.promptTemplates) || prompt;
      const llm = cfg.llm;
      if (llm.enhanceEnabled && String(llm.enhanceModel || '').trim()) {
        try {
          out = await enhanceCall(out, llm.enhancePromptTemplate);
        } catch {
          // 润色失败不阻塞,继续用未润色的 prompt。
        }
      }
      return out;
    },
    async safeRewrite(prompt) {
      const llm = getConfig().llm;
      if (!llm.safeRewriteOnFailure || !String(llm.enhanceModel || '').trim()) return undefined;
      try {
        // 生图失败后的安全改写 = 修复类调用 → turn=false（follow 当前档位，不切不计数）。
        return await enhanceCall(prompt, llm.safeRewritePromptTemplate, false);
      } catch {
        return undefined;
      }
    },
  };
}

function cleanupModelText(value: string): string {
  return String(value || '').trim().replace(/^```(?:json|text)?/i, '').replace(/```$/i, '').trim();
}
