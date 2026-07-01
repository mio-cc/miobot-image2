import { createBotEngine, type BotEngine, type BotEngineInput, type BotEngineResult } from '../../../packages/bot-engine/src/index.js';
import { createCapabilityRegistry, createModelClient, type CapabilityRegistry, type ModelClient } from '../../../packages/model/src/index.js';
import { createSessionStore, type SessionStore } from '../../../packages/core/src/index.js';
import type { PlannerClient } from '../../../packages/intent-router/src/index.js';
import type { AppConfig } from '../../../packages/config/src/index.js';
import { toBotRouting, toEngineRoutingConfig, toModelNodes, toCapabilityOverrides } from './config-bridge.js';
import { createModelBackedDeps, createModelPlanner } from './deps.js';
import { createImagePromptPipeline, type ImagePromptPipeline } from './image-pipeline.js';

export const DEFAULT_CHAT_SYSTEM_PROMPT = '你是 Miobot，一个运行在 QQ/Napcat 上的中文机器人。回答要简洁、直接、有帮助。';

export interface BotAppOptions {
  /** 返回当前 normalized 配置；每次请求读取以支持热重载（模型/开关/节点索引即时生效）。 */
  getConfig: () => AppConfig;
  /** 可注入自定义 ModelClient（测试用 fake）；不传则按当前配置节点表自动构造。 */
  client?: ModelClient;
  registry?: CapabilityRegistry;
  /** 自定义规划器；不传则用 ModelClient 后端(freeMode 节点)。 */
  planner?: PlannerClient;
  /** 会话记忆；不传则按 config.llm.maxConversationRounds/Chars 自动创建。 */
  sessions?: SessionStore;
  /** chat 系统提示词。 */
  chatSystemPrompt?: string;
  /** 生图提示词流水线；不传则用 ModelClient 后端(模板渲染+润色+安全改写)。 */
  pipeline?: ImagePromptPipeline;
  /** 可选日志器（透传给 BotEngine，用于诊断意图路由的 gate/caps 决策）。 */
  log?: { info(message: string, data?: Record<string, unknown>): void; warn(message: string, data?: Record<string, unknown>): void; error(message: string, data?: Record<string, unknown>): void };
}

export interface BotApp {
  engine: BotEngine;
  client: ModelClient;
  sessions: SessionStore;
  /** 处理一条入站消息（自动意图路由 + 能力门控分发）。 */
  handle(input: BotEngineInput): Promise<BotEngineResult>;
}

/**
 * 组装 bot 应用：bot-engine(编排) + model(统一模型层) + 会话记忆 + 规划器 + 配置桥接。
 * 这是 bot-runtime.mjs 里"failover/能力/分发/会话"内联逻辑的去向——现在全在可测的包里。
 *
 * 热重载说明：路由(nodeIndex)与引擎配置每次 handle 都重新读取；但 ModelClient 的"节点表"
 * 在构造时固定。若节点列表本身变化（增删/改 baseUrl/方言），需由 main 重新 createBotApp。
 */
export function createBotApp(options: BotAppOptions): BotApp {
  const registry = options.registry || createCapabilityRegistry({ overrides: toCapabilityOverrides(options.getConfig().llm.capabilityOverrides) });
  const client = options.client || createModelClient({ nodes: toModelNodes(options.getConfig()), registry });
  const initial = options.getConfig();
  const sessions = options.sessions || createSessionStore({
    maxRounds: initial.llm.maxConversationRounds,
    maxChars: initial.llm.maxConversationChars,
    ttlMs: Math.max(0, (initial.llm.sessionTtlMinutes ?? 0) * 60_000),
  });
  const planner = options.planner || createModelPlanner(client, () => toBotRouting(options.getConfig()).freeModeNodeIndex);
  const pipeline = options.pipeline || createImagePromptPipeline(client, options.getConfig);
  const deps = createModelBackedDeps({
    client,
    getRouting: () => toBotRouting(options.getConfig()),
    sessions,
    chatSystemPrompt: options.chatSystemPrompt ?? DEFAULT_CHAT_SYSTEM_PROMPT,
    pipeline,
    logger: options.log,
  });
  const engine = createBotEngine({
    deps,
    getConfig: () => toEngineRoutingConfig(options.getConfig()),
    registry,
    planner,
    log: options.log,
  });
  return {
    engine,
    client,
    sessions,
    handle: (input) => engine.handleAuto(input),
  };
}
