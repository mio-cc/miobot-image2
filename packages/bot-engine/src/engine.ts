import { createIntentRouter, type IntentDecision, type IntentInput, type IntentKind, type IntentParams, type PlannerClient } from '../../intent-router/src/index.js';
import type { CapabilityRegistry, ReasoningEffort } from '../../model/src/index.js';
import { createCapabilityRegistry } from '../../model/src/index.js';
import { resolveImageCapabilities, type EngineRoutingConfig } from './capabilities.js';

/** 下游能力（由 apps/bot 用 model/image/reply 实现；测试可注入 fake）。 */
export interface BotEngineDeps {
  chat(req: { model: string; text: string; images?: string[]; videos?: string[]; sessionId?: string; nodeIndex?: number; context?: string; timeoutMs?: number; maxTokens?: number; reasoningEffort?: ReasoningEffort }): Promise<{ text: string }>;
  generateImages(req: { model: string; prompt: string; size?: string; count?: number; quality?: string; templateId?: string }): Promise<{ images: string[] }>;
  editImage(req: { model: string; prompt: string; images: string[]; size?: string; quality?: string }): Promise<{ images: string[] }>;
  interrogate(req: { model: string; images: string[]; prompt?: string }): Promise<{ text: string }>;
  /** 视频生成；返回可发送的 url / data URL 列表。 */
  generateVideo(req: { model: string; prompt: string; imageUrl?: string; duration?: number; aspectRatio?: string; resolution?: string }): Promise<{ videos: string[] }>;
}

export interface BotEngineOptions {
  deps: BotEngineDeps;
  /** 返回当前配置切片（每次 handle 读取，支持热重载）。 */
  getConfig: () => EngineRoutingConfig;
  /** 传函数则每次现读，能力覆盖改动即时生效。 */
  registry?: CapabilityRegistry | (() => CapabilityRegistry);
  planner?: PlannerClient;
  /** 可选日志器（用于诊断意图路由的 gate/caps 决策）。 */
  log?: { info(message: string, data?: Record<string, unknown>): void; warn(message: string, data?: Record<string, unknown>): void; error(message: string, data?: Record<string, unknown>): void };
}

export interface BotEngineInput extends IntentInput {
  /** 会话键(group:xxx / private:xxx),供 chat 取用对话记忆。 */
  sessionId?: string;
  /** 群聊上下文(@bot 时拉取的最近群聊记录),以 system 消息注入 chat 模型。 */
  context?: string;
  /** 引用消息文本(回复某条消息时该消息的文字内容),仅注入 chat 路径,不污染图像 prompt。 */
  referenceText?: string;
  /** 合并转发展开文本,仅注入 chat 路径,不污染图像 prompt。 */
  forwardText?: string;
}

export interface BotEngineResult {
  kind: IntentKind;
  decision: IntentDecision;
  text?: string;
  images?: string[];
  /** 生成的视频 url / data URL，由 reply/napcat 发 type:video。 */
  videos?: string[];
  handled: boolean;
}

export class BotEngine {
  private readonly deps: BotEngineDeps;
  private readonly getConfig: () => EngineRoutingConfig;
  private readonly registrySource: () => CapabilityRegistry;
  private get registry(): CapabilityRegistry { return this.registrySource(); }
  private readonly planner?: PlannerClient;
  private readonly log?: { info(message: string, data?: Record<string, unknown>): void; warn(message: string, data?: Record<string, unknown>): void; error(message: string, data?: Record<string, unknown>): void };

  constructor(options: BotEngineOptions) {
    this.deps = options.deps;
    this.getConfig = options.getConfig;
    const registry = options.registry;
    if (typeof registry === 'function') {
      this.registrySource = registry;
    } else {
      const fixed = registry || createCapabilityRegistry();
      this.registrySource = () => fixed;
    }
    this.planner = options.planner;
    this.log = options.log;
  }

  /** 自动路由：判断 chat/生图/改图/反推 并分发。能力门控基于模型实际档案。 */
  async handleAuto(input: BotEngineInput): Promise<BotEngineResult> {
    const cfg = this.getConfig();
    const caps = resolveImageCapabilities(cfg, this.registry);
    const router = createIntentRouter({
      planner: this.planner,
      plannerModel: cfg.freeModeModel,
      plannerVisionEnabled: this.registry.can(cfg.freeModeModel, 'vision'),
      plannerPromptTemplate: cfg.plannerPromptTemplate,
      timeoutMs: cfg.plannerTimeoutMs,
      capabilities: caps,
      preferEditWhenImagePresent: cfg.preferEditWhenImagePresent,
      maxCount: cfg.maxOutputImages ?? 4,
    });
    const decision = await router.route(input);
    this.log?.info('意图路由完成', {
      kind: decision.kind, source: decision.source, reason: decision.reason,
      caps, chatEnabled: cfg.chatEnabled, chatModel: cfg.chatModel,
      freeModeEnabled: cfg.freeModeEnabled, freeModeModel: cfg.freeModeModel,
      inputText: (input.text || '').slice(0, 80),
    });
    return this.dispatch(decision, input, cfg);
  }

  /**
   * 显式命令直达：跳过意图路由，强制按指定能力分发(prompt/size/count 等由调用方给定)。
   * 用于 bot-router 命中显式命令(genImage/editImage/interrogate)时，避免再过一遍自动判定。
   */
  async handleExplicit(
    kind: Exclude<IntentKind, 'ignore'>,
    input: BotEngineInput,
    params: { prompt?: string; size?: string; count?: number; quality?: string; templateId?: string; tokens?: string[] } = {},
  ): Promise<BotEngineResult> {
    const cfg = this.getConfig();
    const decision: IntentDecision = {
      kind,
      source: 'signal',
      confidence: 1,
      reason: 'explicit-command',
      params: {
        prompt: params.prompt ?? input.text,
        size: params.size,
        count: params.count,
        quality: params.quality,
        templateId: params.templateId,
        tokens: params.tokens ?? [],
      } as IntentParams,
      usedPlanner: false,
    };
    return this.dispatch(decision, input, cfg);
  }

  private async dispatch(decision: IntentDecision, input: BotEngineInput, cfg: EngineRoutingConfig): Promise<BotEngineResult> {
    const images = (input.images || []).filter(Boolean);
    const videos = (input.videos || []).filter(Boolean);
    const p = decision.params;
    switch (decision.kind) {
      case 'chat': {
        // freeMode planner 返回 chat 时用 freeMode 的节点+模型，不依赖 chatNodeIndex/chatModel。
        // 但 planner 失败回退(source==='fallback')时不再继续用可能已挂掉的 freeMode 节点,
        // 改回 chat 节点,让纯文本对话至少能回 —— 否则 freeMode 节点一挂,planner 失败 +
        // fallback chat 又用同一节点,bot 完全瘫痪(403/超时连环)。
        const usedPlanner = decision.usedPlanner;
        const isFallback = decision.source === 'fallback';
        const useFreeMode = usedPlanner && !isFallback;
        const chatModel = useFreeMode && cfg.freeModeModel ? cfg.freeModeModel : cfg.chatModel;
        const chatNode = useFreeMode && cfg.freeModeNodeIndex !== undefined ? cfg.freeModeNodeIndex : undefined;
        // chat 路径注入引用/转发上下文(模型需要理解在聊什么);图像路径用纯 prompt 不污染。
        const baseText = p.prompt || input.text;
        const chatText = composeChatText(baseText, input.referenceText, input.forwardText);
        const { text } = await this.deps.chat({
          model: chatModel, text: chatText, images, videos, sessionId: input.sessionId,
          nodeIndex: chatNode, context: input.context, timeoutMs: cfg.plannerTimeoutMs, reasoningEffort: cfg.reasoningEffort,
        });
        return { kind: 'chat', decision, text, handled: true };
      }
      case 'image.generate': {
        const { images: out } = await this.deps.generateImages({ model: cfg.imageModel, prompt: p.prompt, size: p.size, count: p.count, quality: p.quality, templateId: p.templateId });
        return { kind: 'image.generate', decision, images: out, handled: true };
      }
      case 'image.edit': {
        const { images: out } = await this.deps.editImage({ model: cfg.editModel, prompt: p.prompt, images, size: p.size, quality: p.quality });
        return { kind: 'image.edit', decision, images: out, handled: true };
      }
      case 'image.interrogate': {
        const { text } = await this.deps.interrogate({ model: cfg.interrogateModel, images, prompt: p.prompt || undefined });
        return { kind: 'image.interrogate', decision, text, handled: true };
      }
      case 'video.generate': {
        // 图生视频：优先用当前消息/引用图第一张作为起始帧；纯文生视频可不带图。
        const imageUrl = images[0];
        const aspectRatio = p.size && /^\d{1,2}:\d{1,2}$/.test(p.size) ? p.size : undefined;
        const { videos: out } = await this.deps.generateVideo({
          model: cfg.videoModel,
          prompt: p.prompt,
          imageUrl,
          duration: p.duration,
          aspectRatio,
          resolution: p.resolution,
        });
        return { kind: 'video.generate', decision, videos: out, handled: true };
      }
      default:
        return { kind: 'ignore', decision, handled: false };
    }
  }
}

export function createBotEngine(options: BotEngineOptions): BotEngine {
  return new BotEngine(options);
}

/**
 * 把用户文本 + 引用内容 + 转发内容合成为 chat 用的文本。
 * 仅用于 chat 路径;图像 generate/edit/interrogate 路径用纯 prompt,不注入引用文本。
 */
function composeChatText(userText: string, referenceText?: string, forwardText?: string): string {
  const body = String(userText || '').trim();
  const parts: string[] = [];
  if (body) parts.push(body);
  if (referenceText) parts.push(`【引用内容】\n${referenceText}`);
  if (forwardText) parts.push(`【合并转发内容】\n${forwardText}`);
  if (!parts.length) return '请根据引用/转发内容处理。';
  return parts.join('\n\n');
}
