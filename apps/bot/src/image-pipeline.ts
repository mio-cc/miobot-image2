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
      // 阶段 1：本地模板库（用户按 id 指定的，可选）。
      let out = applyTemplateById(prompt, templateId, cfg.bot.promptTemplates) || prompt;
      const llm = cfg.llm;
      // 阶段 2：LLM 生图专用模板（局部渲染，无模型调用）。
      // 这条只在「LLM 生图」路径生效——ComfyUI 分支在 deps.generateImages 里提前 return，
      // 走的是 comfyuiTransform.promptTemplate，两者互不影响（线上时测 2026-11-19 澄清）。
      const imageStage = String((llm as { imagePromptTemplate?: string }).imagePromptTemplate || '').trim();
      if (imageStage) out = renderPromptTemplate(imageStage, { prompt: out, rawPrompt: out }) || out;
      // 阶段 3：可选的模型润色。
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

/**
 * 把润色/改写模型的输出规整成「可以直接送进生图接口的提示词」。
 *
 * 线上时测 2026-11-19：润色模板要求模型「只输出 JSON {prompt, negative_prompt, summary}」，
 * 而这里原来只去掉代码围栏——整段 JSON 被当成 prompt 发给上游。现在优先取 JSON 的
 * prompt 字段；不是 JSON（老模板要求纯文本）就原样用。
 */
function cleanupModelText(value: string): string {
  const text = String(value || '').trim().replace(/^```(?:json|text)?/i, '').replace(/```$/i, '').trim();
  if (!text) return '';
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
      const prompt = typeof parsed.prompt === 'string' ? parsed.prompt.trim() : '';
      if (prompt) {
        const negative = typeof parsed.negative_prompt === 'string' ? parsed.negative_prompt.trim() : '';
        return negative ? prompt + '\n\n(negative: ' + negative + ')' : prompt;
      }
    } catch {
      // 不是合法 JSON → 按纯文本处理（老模板的正常输出）。
    }
  }
  return text;
}
