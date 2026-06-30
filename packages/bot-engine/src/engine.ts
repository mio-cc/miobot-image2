import { createIntentRouter, type IntentDecision, type IntentInput, type IntentKind, type IntentParams, type PlannerClient } from '../../intent-router/src/index.js';
import type { CapabilityRegistry } from '../../model/src/index.js';
import { createCapabilityRegistry } from '../../model/src/index.js';
import { resolveImageCapabilities, type EngineRoutingConfig } from './capabilities.js';

/** 下游能力（由 apps/bot 用 model/image/reply 实现；测试可注入 fake）。 */
export interface BotEngineDeps {
  chat(req: { model: string; text: string; images?: string[]; sessionId?: string; nodeIndex?: number }): Promise<{ text: string }>;
  generateImages(req: { model: string; prompt: string; size?: string; count?: number; quality?: string; templateId?: string }): Promise<{ images: string[] }>;
  editImage(req: { model: string; prompt: string; images: string[]; size?: string; quality?: string }): Promise<{ images: string[] }>;
  interrogate(req: { model: string; images: string[]; prompt?: string }): Promise<{ text: string }>;
}

export interface BotEngineOptions {
  deps: BotEngineDeps;
  /** 返回当前配置切片（每次 handle 读取，支持热重载）。 */
  getConfig: () => EngineRoutingConfig;
  registry?: CapabilityRegistry;
  planner?: PlannerClient;
  /** 可选日志器（用于诊断意图路由的 gate/caps 决策）。 */
  log?: { info(message: string, data?: Record<string, unknown>): void; warn(message: string, data?: Record<string, unknown>): void; error(message: string, data?: Record<string, unknown>): void };
}

export interface BotEngineInput extends IntentInput {
  /** 会话键(group:xxx / private:xxx),供 chat 取用对话记忆。 */
  sessionId?: string;
}

export interface BotEngineResult {
  kind: IntentKind;
  decision: IntentDecision;
  text?: string;
  images?: string[];
  handled: boolean;
}

export class BotEngine {
  private readonly deps: BotEngineDeps;
  private readonly getConfig: () => EngineRoutingConfig;
  private readonly registry: CapabilityRegistry;
  private readonly planner?: PlannerClient;
  private readonly log?: { info(message: string, data?: Record<string, unknown>): void; warn(message: string, data?: Record<string, unknown>): void; error(message: string, data?: Record<string, unknown>): void };

  constructor(options: BotEngineOptions) {
    this.deps = options.deps;
    this.getConfig = options.getConfig;
    this.registry = options.registry || createCapabilityRegistry();
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
    const p = decision.params;
    switch (decision.kind) {
      case 'chat': {
        // freeMode planner 返回 chat 时用 freeMode 的节点+模型，不依赖 chatNodeIndex/chatModel
        const usedPlanner = decision.usedPlanner;
        const chatModel = usedPlanner && cfg.freeModeModel ? cfg.freeModeModel : cfg.chatModel;
        const chatNode = usedPlanner && cfg.freeModeNodeIndex !== undefined ? cfg.freeModeNodeIndex : undefined;
        const { text } = await this.deps.chat({ model: chatModel, text: p.prompt || input.text, images, sessionId: input.sessionId, nodeIndex: chatNode });
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
      default:
        return { kind: 'ignore', decision, handled: false };
    }
  }
}

export function createBotEngine(options: BotEngineOptions): BotEngine {
  return new BotEngine(options);
}
