import { applyTemplateById, renderPromptTemplate } from '../../../packages/image/src/index.js';
import type { ModelClient } from '../../../packages/model/src/index.js';
import type { AppConfig } from '../../../packages/config/src/index.js';

/**
 * 生图提示词流水线(优化版):本地模板渲染 → 可选 LLM 润色(enhance) → 生成;失败时安全改写重试一次。
 * 复用 packages/image 的 applyTemplateById/renderPromptTemplate;润色/改写走 ModelClient。
 */
export interface ImagePromptPipeline {
  /** 渲染模板 + 可选润色,返回最终 prompt。 */
  prepare(input: { prompt: string; templateId?: string }): Promise<string>;
  /** 生成失败后的安全改写(返回 undefined 表示未启用/失败)。 */
  safeRewrite(prompt: string): Promise<string | undefined>;
}

export function createImagePromptPipeline(client: ModelClient, getConfig: () => AppConfig): ImagePromptPipeline {
  async function rewrite(prompt: string, nodeIndex: number, model: string, template: string): Promise<string> {
    const rendered = renderPromptTemplate(template, { rawPrompt: prompt, prompt }) || prompt;
    const res = await client.chat(nodeIndex, { model, messages: [{ role: 'user', content: rendered }] });
    return cleanupModelText(res.text) || prompt;
  }

  return {
    async prepare({ prompt, templateId }) {
      const cfg = getConfig();
      let out = applyTemplateById(prompt, templateId, cfg.bot.promptTemplates) || prompt;
      const llm = cfg.llm;
      if (llm.enhanceEnabled && String(llm.enhanceModel || '').trim()) {
        try {
          out = await rewrite(out, llm.enhanceNodeIndex, llm.enhanceModel, llm.enhancePromptTemplate);
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
        return await rewrite(prompt, llm.enhanceNodeIndex, llm.enhanceModel, llm.safeRewritePromptTemplate);
      } catch {
        return undefined;
      }
    },
  };
}

function cleanupModelText(value: string): string {
  return String(value || '').trim().replace(/^```(?:json|text)?/i, '').replace(/```$/i, '').trim();
}
