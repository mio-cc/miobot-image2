import type { CapabilityRegistry } from '../../../packages/model/src/index.js';
import type { AppConfig } from '../../../packages/config/src/index.js';
import type { RuntimeDeps } from './deps.js';
import type { RuntimeDecision, RuntimeExplicitEngine, RuntimeExplicitParams, RuntimeInput, RuntimeIntentKind, RuntimeResult } from './runtime-types.js';

export interface ExplicitExecutorOptions {
  deps: RuntimeDeps;
  getConfig: () => AppConfig;
  registry: () => CapabilityRegistry;
  beforeDispatch?: (decision: RuntimeDecision, input: RuntimeInput) => Promise<(() => void) | void>;
  log?: { info(message: string, data?: Record<string, unknown>): void; warn(message: string, data?: Record<string, unknown>): void; error(message: string, data?: Record<string, unknown>): void };
}

/**
 * 显式执行器只做确定性的模型操作，不做自动意图规划。
 * 自然语言路由由 AgentRuntime 负责；本执行器服务于精确命令、文件读取/生成和审批恢复。
 */
export class ExplicitExecutor implements RuntimeExplicitEngine {
  constructor(private readonly options: ExplicitExecutorOptions) {}

  private decision(kind: RuntimeIntentKind, prompt: string, reason: string): RuntimeDecision {
    return { kind, source: 'explicit', confidence: 1, reason, params: { prompt, tokens: [] } };
  }

  async handleExplicit(kind: RuntimeIntentKind, input: RuntimeInput, params: RuntimeExplicitParams): Promise<RuntimeResult> {
    const cfg = this.options.getConfig();
    const prompt = String(params.prompt || input.text || '');
    const decision = this.decision(kind, prompt, 'explicit_command');
    const before = await this.options.beforeDispatch?.(decision, input);
    try {
      if (kind === 'chat') {
        const result = await this.options.deps.chat({
          model: cfg.llm.chatModel,
          text: prompt,
          images: input.images,
          videos: input.videos,
          sessionId: input.sessionId,
          nodeIndex: cfg.llm.chatNodeIndex,
          context: input.context,
          reasoningEffort: cfg.llm.reasoningEffort,
          forceSearch: input.forceSearch,
          timeoutMs: 120_000,
        });
        return { kind: 'chat', decision, text: result.text, handled: true };
      }

      if (kind === 'image.generate') {
        if (!cfg.llm.imageEnabled || !this.options.registry().can(cfg.llm.imageModel, 'image.generate')) {
          this.options.log?.warn('image.generate 未执行，回退到 chat', {
            reason: !cfg.llm.imageEnabled ? 'llm.imageEnabled=false' : 'model_capability_unsupported',
            imageEnabled: cfg.llm.imageEnabled === true,
            imageNodeIndex: cfg.llm.imageNodeIndex,
            imageModel: cfg.llm.imageModel,
            canGenerate: this.options.registry().can(cfg.llm.imageModel, 'image.generate'),
          });
          const fallback = await this.options.deps.chat({
            model: cfg.llm.chatModel,
            text: prompt,
            images: input.images,
            videos: input.videos,
            sessionId: input.sessionId,
            nodeIndex: cfg.llm.chatNodeIndex,
            context: input.context,
            reasoningEffort: cfg.llm.reasoningEffort,
          });
          return { kind: 'chat', decision, text: fallback.text, handled: true };
        }
        const result = await this.options.deps.generateImages({
          model: cfg.llm.imageModel,
          prompt,
          size: params.size,
          width: params.width,
          height: params.height,
          count: params.count,
          quality: params.quality,
          templateId: params.templateId,
        });
        return { kind: 'image.generate', decision, images: result.images, handled: true };
      }

      if (kind === 'image.edit') {
        const result = await this.options.deps.editImage({
          model: cfg.llm.editModel,
          prompt,
          images: input.images || [],
          width: params.width,
          height: params.height,
          quality: params.quality,
          size: params.size,
        });
        return { kind: 'image.edit', decision, images: result.images, handled: true };
      }

      if (kind === 'image.interrogate') {
        const result = await this.options.deps.interrogate({
          model: cfg.llm.interrogateModel,
          images: input.images || [],
          prompt,
        });
        return { kind: 'image.interrogate', decision, text: result.text, handled: true };
      }

      if (kind === 'video.generate') {
        if (!cfg.llm.videoEnabled || !this.options.registry().can(cfg.llm.videoModel, 'video.generate')) {
          const fallback = await this.options.deps.chat({
            model: cfg.llm.chatModel,
            text: prompt,
            images: input.images,
            videos: input.videos,
            sessionId: input.sessionId,
            nodeIndex: cfg.llm.chatNodeIndex,
            context: input.context,
            reasoningEffort: cfg.llm.reasoningEffort,
          });
          return { kind: 'chat', decision, text: fallback.text, handled: true };
        }
        const result = await this.options.deps.generateVideo({
          model: cfg.llm.videoModel,
          prompt,
          imageUrl: input.images?.[0],
          duration: Number((params as Record<string, unknown>).duration) || undefined,
          aspectRatio: params.size && /^\d{1,2}:\d{1,2}$/.test(params.size) ? params.size : undefined,
          resolution: typeof (params as Record<string, unknown>).resolution === 'string' ? String((params as Record<string, unknown>).resolution) : undefined,
        });
        return { kind: 'video.generate', decision, videos: result.videos, handled: true };
      }

      return { kind: 'ignore', decision, handled: false };
    } finally {
      before?.();
    }
  }
}
