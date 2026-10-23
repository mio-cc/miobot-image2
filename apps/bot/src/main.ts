export { createSentMessageTracker, createTrackingReplyClient, sentChatKey, type SentMessageTracker } from './sent-messages.js';
export { createImageProgress, formatImageEta, imageProgressLabel, renderImageProgressText, type ImageProgressKind, type ImageProgressHandle } from './image-progress.js';
import type { PackageDescriptor } from '@miobot-v2/shared';

export const BOT_APP: PackageDescriptor = {
  name: '@miobot-v2/app-bot',
  phase: 'P4-bot-engine',
};

export { createBotApp, DEFAULT_CHAT_SYSTEM_PROMPT, type BotApp, type BotAppOptions } from './app.js';
export { createModelBackedDeps, createModelPlanner, artifactToString, artifactsToStrings, videoArtifactToString, videoArtifactsToStrings, type ModelDepsOptions } from './deps.js';
export { createImagePromptPipeline, type ImagePromptPipeline } from './image-pipeline.js';
export { runInComfyUiQueue, ComfyUiQueueError, comfyUiQueueSnapshot, resetComfyUiQueuesForTest } from './comfyui-queue.js';
export { sanitizeComfyUiPrompt, sanitizeComfyUiParams } from './comfyui.js';
export {
  createCanvasGallerySync,
  resolveCanvasSyncEndpoint,
  resolvePublicImageBaseUrl,
  type CanvasGallerySync,
  type CanvasGallerySyncContext,
  type CanvasGallerySyncInput,
  type CanvasGallerySyncOptions,
} from './canvas-gallery.js';
export {
  createImageInputPreparer,
  createNapcatImageReferenceResolver,
  describeImageReference,
  imageDataUrlFromBase64,
  type ImageInputPreparer,
  type ImageInputPreparerOptions,
  type NapcatGetImageResponse,
  type NapcatImageReferenceResolverOptions,
} from './image-input.js';
export { buildTtsRequest, synthesizeSpeech, shouldUseTts, activeFishVoiceId, fishVoiceCandidates, type TtsRequestPlan, type TtsAudio, type TtsSynthesizeOptions } from './tts.js';
export { parseOwnerCommand, isOwner, type OwnerCommand, type OwnerParseContext } from './owner.js';
export { toModelNodes, toEngineRoutingConfig, toBotRouting, type BotRouting } from './config-bridge.js';
export {
  createBotMessageRuntime,
  toRouterConfig,
  toReplyStrategyConfig,
  extractImages,
  extractVideos,
  extractReplyIdFromEvent,
  normalizeImageUrl,
  normalizeVideoUrl,
  segmentsToRaw,
  NATURAL_INTENT_CATALOG,
  allReplyPlanOutputs,
  selectPrimaryTextForTts,
  replacePrimaryTextWithAudio,
  removePrimaryText,
  shouldSendMediaProgress,
  imageProgressTextForKind,
  imageProgressAverageKey,
  sendResult,
  type NapcatMessageEvent,
  type BotRuntimeOptions,
  type BotRuntimeResult,
} from './runtime.js';
export {
  extractForwardIds,
  normalizeForwardPayload,
  extractImagesFromForwardNodes,
  formatForwardMessages,
  extractReferenceText,
  composeEnrichedText,
} from './message-enrichment.js';

/** 兼容旧骨架探针（保留以防外部引用）。 */
export function describeBotAppSkeleton() {
  return {
    app: '@miobot-v2/app-bot',
    phase: 'P4-bot-engine' as const,
    packages: ['@miobot-v2/bot-engine', '@miobot-v2/model', '@miobot-v2/config'],
  };
}
