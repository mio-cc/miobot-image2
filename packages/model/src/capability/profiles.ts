import type { ModelOperation } from '../ports.js';

/** 某模型的能力档案（约束 + 支持的操作）。 */
export interface ModelProfile {
  operations: ModelOperation[];
  /** 生图/改图支持的尺寸枚举；空表示不限制。 */
  sizes?: string[];
  /** 是否支持 size 参数（false = 该模型生图接口根本不接受 size，如 xAI grok / Gemini 原生生图）。默认按是否有 sizes/通用处理。 */
  supportsSize?: boolean;
  supportsCount?: boolean;     // 是否支持 n / count
  supportsQuality?: boolean;   // 是否支持 quality
  supportsMask?: boolean;      // 改图是否支持 mask
  maxImagesPerRequest?: number;
}

/** 文本/视觉对话的默认档案。 */
export const CHAT_PROFILE: ModelProfile = { operations: ['chat', 'vision', 'interrogate'] };
/** 纯文本对话（无 vision）。 */
export const TEXT_ONLY_PROFILE: ModelProfile = { operations: ['chat'] };
/** OpenAI gpt-image 系列。 */
export const GPT_IMAGE_PROFILE: ModelProfile = {
  operations: ['image.generate', 'image.edit'],
  sizes: ['auto', '1024x1024', '1024x1536', '1536x1024'],
  supportsSize: true, supportsCount: true, supportsQuality: true, supportsMask: true, maxImagesPerRequest: 16,
};
/** DALL·E 3：不支持 n>1、不支持改图。 */
export const DALLE3_PROFILE: ModelProfile = {
  operations: ['image.generate'],
  sizes: ['1024x1024', '1024x1792', '1792x1024'],
  supportsSize: true, supportsCount: false, supportsQuality: true, supportsMask: false, maxImagesPerRequest: 1,
};
/** DALL·E 2：支持改图 + mask + n，尺寸只有三档正方形。 */
export const DALLE2_PROFILE: ModelProfile = {
  operations: ['image.generate', 'image.edit'],
  sizes: ['256x256', '512x512', '1024x1024'],
  supportsSize: true, supportsCount: true, supportsQuality: false, supportsMask: true, maxImagesPerRequest: 10,
};
/** xAI Grok 生图(grok-2-image)：OpenAI 兼容端点，但**不接受 size/quality/style/response_format**，只认 prompt/n。 */
export const GROK_IMAGE_PROFILE: ModelProfile = {
  operations: ['image.generate'],
  sizes: [],
  supportsSize: false, supportsCount: true, supportsQuality: false, supportsMask: false, maxImagesPerRequest: 10,
};
/** Gemini 原生生图(gemini-*-image / imagen / nano-banana)：走 generateContent，**不接受 OpenAI 的 size/quality**。 */
export const GEMINI_IMAGE_PROFILE: ModelProfile = {
  operations: ['image.generate', 'image.edit'],
  sizes: [],
  supportsSize: false, supportsCount: false, supportsQuality: false, supportsMask: false, maxImagesPerRequest: 1,
};
/** 通用图像（flux / sd / 各家中转）。 */
export const GENERIC_IMAGE_PROFILE: ModelProfile = {
  operations: ['image.generate', 'image.edit'],
  supportsSize: true, supportsCount: true, supportsQuality: false, supportsMask: false, maxImagesPerRequest: 4,
};

/** 模型名 → 档案 的内置匹配规则（按顺序，先命中先用）。 */
export interface ProfileRule { test: RegExp; profile: ModelProfile }

export const BUILTIN_PROFILE_RULES: ProfileRule[] = [
  // ── 生图类（务必排在聊天/视觉规则之前，避免被 gemini/grok/qwen 等通名抢先误判为对话）──
  { test: /gpt-image|gpt_image/i, profile: GPT_IMAGE_PROFILE },
  { test: /dall[-_\s]?e[-_\s]?3/i, profile: DALLE3_PROFILE },
  { test: /dall[-_\s]?e/i, profile: DALLE2_PROFILE },
  { test: /grok[-_\s.\w]*image/i, profile: GROK_IMAGE_PROFILE },
  { test: /gemini[-_\s.\w]*image|imagen|nano[-_\s]?banana/i, profile: GEMINI_IMAGE_PROFILE },
  { test: /qwen[-_\s]?image|wan[-_\s]?x|wanx/i, profile: GENERIC_IMAGE_PROFILE },
  { test: /(flux|stable[-_\s]?diffusion|sdxl|sd3|sd-?turbo|midjourney|kolors|seedream|hunyuan-?image|cogview|playground-?v|ideogram|recraft|kontext|luma-?photon)/i, profile: GENERIC_IMAGE_PROFILE },
  // ── 多模态对话（vision）──
  { test: /(gpt-4o|gpt-4\.|gpt-4-turbo|gpt-5|chatgpt-4o|o1|o3|o4|claude|gemini|grok[-_\s.\w]*vision|qwen[-_\s]?vl|qwen[\d.]+-?vl|llava|vl-|vision|internvl|glm-4v|glm-[0-9.]*v|yi-vision|step-1v|pixtral|llama-?3\.2|llama-?4|phi-?3\.5-vision|phi-?4|minicpm-?v|molmo|aria|deepseek[-_\s]?vl|deepseek[\d.]*-?vl|minimax[-_\s]?vl|sensenova[-_\s]?vl|abab[-_\s]?vision|doubao[-_\s]?vision)/i, profile: CHAT_PROFILE },
  // ── 纯文本对话 ──
  { test: /(gpt-3\.5|deepseek(?![-_\s]?vl)|qwen|moonshot|kimi|yi-|glm-4(?!v)|glm-3|llama|mistral|mixtral|gemma|baichuan|ernie|spark|hunyuan(?!-?image)|command-?r|abab(?![-_\s]?vision)|doubao(?![-_\s]?vision))/i, profile: TEXT_ONLY_PROFILE },
];

export function inferProfileByName(model: string): ModelProfile | undefined {
  const name = String(model || '').trim();
  if (!name) return undefined;
  for (const rule of BUILTIN_PROFILE_RULES) {
    if (rule.test.test(name)) return rule.profile;
  }
  return undefined;
}
