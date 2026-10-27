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
  if (toolName === 'code.render') values.push(Math.max(0, Number(cfg.codeRender?.timeoutMs) || 0) + Math.max(0, Number(cfg.browserRender?.timeoutMs) || 0) + 60_000);
  if (toolName === 'tts.speak') {
    values.push(Math.max(0, Number(cfg.bot.tts?.timeoutMs) || 0) + Math.max(0, Number(cfg.bot.tts?.preprocess?.timeoutMs) || 0) + 30_000);
  }
  if (toolName === 'audio.music.generate' || toolName === 'audio.music.replace_section') {
    values.push(Math.max(0, Number(cfg.orchestration.suno?.timeoutMs) || 0) + Math.max(0, Number(cfg.orchestration.suno?.pollIntervalMs) || 0) + 60_000);
  }
  if (toolName === 'browser.render') values.push(Math.max(0, Number(cfg.browserRender?.timeoutMs) || 0) + 60_000);
  return Math.max(...values.filter((value) => Number.isFinite(value) && value > 0));
}
