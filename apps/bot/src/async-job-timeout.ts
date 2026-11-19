import type { AppConfig } from '../../../packages/config/src/index.js';

/** 任务级超时；ComfyUI 的排队和生成是两个阶段，不能复用单次 120s tool timeout。 */
export function resolveAsyncJobTimeoutMs(cfg: AppConfig, toolName: string, requestedMs?: number): number {
  const values = [Math.max(0, Number(requestedMs) || 0), 15 * 60_000];
  const comfy = cfg.llm.apiKeys?.[cfg.llm.imageNodeIndex]?.comfyui;
  const imageFamily = toolName === 'image.generate' || toolName === 'image.edit' || toolName === 'template.use';
  if (imageFamily && comfy && Number(comfy.pollTimeoutMs) === 0) {
    // 明确的等 ComfyUI 完成模式：不要在本地按 15 分钟截断。
    return 0;
  }
  if (imageFamily) {
    values.push(Math.max(0, Number(cfg.llm.imageTimeoutMs) || 0));
    if (comfy) values.push(Math.max(0, Number(comfy.queueTimeoutMs) || 0) + Math.max(0, Number(comfy.pollTimeoutMs) || 0) + 60_000);
  }
  if (toolName === 'video.generate') values.push(Math.max(0, Number(cfg.llm.videoTimeoutMs) || 0) + Math.max(0, Number(cfg.llm.videoPollTimeoutMs) || 0) + 60_000);
  if (toolName === 'code.render' || toolName === 'report.render') values.push(Math.max(0, Number(cfg.codeRender?.timeoutMs) || 0) + Math.max(0, Number(cfg.browserRender?.timeoutMs) || 0) + 60_000);
  if (toolName === 'tts.speak') {
    values.push(Math.max(0, Number(cfg.bot.tts?.timeoutMs) || 0) + Math.max(0, Number(cfg.bot.tts?.preprocess?.timeoutMs) || 0) + 30_000);
  }
  if (toolName === 'audio.music.generate' || toolName === 'audio.music.replace_section') {
    values.push(Math.max(0, Number(cfg.orchestration.suno?.timeoutMs) || 0) + Math.max(0, Number(cfg.orchestration.suno?.pollIntervalMs) || 0) + 60_000);
  }
  if (toolName === 'browser.render') values.push(Math.max(0, Number(cfg.browserRender?.timeoutMs) || 0) + 60_000);
  return Math.max(...values.filter((value) => Number.isFinite(value) && value > 0));
}

/**
 * 高分辨率视频更慢，给异步任务超时加档（2026-11-19）。
 *
 * 依据：fal 的 minimax h3-max 文档把 1080P 描述为「native generation resolution,
 * or 1080P latent refinement from a native 768P source」——即 1080P 是在 768P 基础上
 * 再做一次 refinement，单次生成耗时明显更长。原来的超时只按 videoTimeoutMs + pollTimeoutMs
 * 计算，1080P 容易在 refinement 阶段被判超时。
 *
 * 返回 0 表示不加档；调用方对「本身是无超时（0）」的任务不应该动手。
 */
export function resolutionTimeoutBonusMs(toolName: string, args: unknown): number {
  if (toolName !== 'video.generate') return 0;
  const raw = args && typeof args === 'object' ? (args as Record<string, unknown>).resolution : undefined;
  const res = String(raw || '').toLowerCase();
  if (res === '1080p') return 10 * 60_000;
  if (res === '768p') return 5 * 60_000;
  return 0;
}
