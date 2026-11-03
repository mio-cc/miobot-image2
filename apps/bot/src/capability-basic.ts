import type { AppConfig } from '../../../packages/config/src/index.js';
import type { BotApp } from './app.js';
import type { ModelClient } from '../../../packages/model/src/index.js';
import type { StructuredLogger } from '../../../packages/logger/src/index.js';
import {
  type CapabilityHandler,
  type CapabilityInvocation,
  type ExecutionOutput,
  type ExecutionResult,
} from '../../../packages/orchestration/src/index.js';
import { synthesizeSpeech } from './tts.js';
import { buildHelpText } from './help-text.js';

function stringArg(args: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function baseResult(invocation: CapabilityInvocation, outputs: ExecutionOutput[], diagnostics?: Record<string, unknown>): ExecutionResult {
  return { jobId: invocation.plan.planId, stepId: invocation.step.id, status: 'success', outputs, diagnostics };
}

const SEARCH_BATCH_MAX_QUERIES = 8;
const SEARCH_BATCH_CONCURRENCY = 4;
const SEARCH_BATCH_MAX_CHARS = 12_000;

function searchQueries(args: Record<string, unknown>, fallback: string): string[] {
  const raw = Array.isArray(args.queries) ? args.queries : [];
  const values = [
    ...(typeof args.query === 'string' ? [args.query] : []),
    ...raw,
  ].map((value) => String(value || '').trim()).filter(Boolean);
  return Array.from(new Set(values)).slice(0, SEARCH_BATCH_MAX_QUERIES);
}

function capSearchText(value: string): string {
  const text = String(value || '').trim();
  if (text.length <= SEARCH_BATCH_MAX_CHARS) return text;
  return text.slice(0, SEARCH_BATCH_MAX_CHARS) + '\n\n[批量搜索内容已截断]';
}

export class SearchCapabilityHandler implements CapabilityHandler {
  constructor(private readonly app: BotApp) {}

  private async runEngineQuery(invocation: CapabilityInvocation, query: string) {
    return this.app.engine.handleExplicit('chat', {
      text: query,
      chatType: invocation.request.chat.type,
      sessionId: invocation.request.chat.type === 'group'
        ? `group:${invocation.request.chat.groupId}:${invocation.request.user.qq}`
        : `private:${invocation.request.user.qq}`,
      forceSearch: true,
      featureContext: {
        chatType: invocation.request.chat.type,
        groupId: invocation.request.chat.groupId,
        userId: invocation.request.user.qq,
        promptChars: query.length,
      },
    }, { prompt: query });
  }

  private async batchSearch(invocation: CapabilityInvocation, queries: string[]): Promise<ExecutionResult> {
    const service = this.app.search!;
    const results: Array<{ query: string; text: string }> = [];
    const failures: Array<{ query: string; error: string }> = [];
    let cursor = 0;
    const worker = async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= queries.length) return;
        const query = queries[index];
        try {
          const response = await service.search({ query, signal: invocation.signal });
          results[index] = { query, text: service.formatContext(response) };
        } catch (error) {
          results[index] = { query, text: '' };
          failures[index] = { query, error: String((error as Error)?.message || error).slice(0, 300) };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(SEARCH_BATCH_CONCURRENCY, queries.length) }, () => worker()));
    const blocks = results.map((item, index) => {
      const failure = failures[index];
      if (failure) return `【${failure.query}】搜索失败：${failure.error}`;
      return `【${item.query}】\n${item.text || '（没有搜索结果）'}`;
    });
    const text = capSearchText(blocks.join('\n\n'));
    return { jobId: invocation.plan.planId, stepId: invocation.step.id, status: 'success', outputs: text ? [{ kind: 'text', text, priority: 10, mergeable: true, meta: { batch: true, queryCount: queries.length } }] : [], diagnostics: { batch: true, queryCount: queries.length, failures: failures.filter(Boolean) } };
  }

  async execute(invocation: CapabilityInvocation): Promise<ExecutionResult> {
    const fallback = invocation.request.text;
    const queries = searchQueries(invocation.step.args || {}, fallback);
    if (queries.length > 1 && this.app.search) return this.batchSearch(invocation, queries);
    if (queries.length > 1) {
      // 兼容没有注入 search service 的测试/旧装配：并发走现有引擎，不改变单查询语义。
      const settled = await Promise.all(queries.map((query) => this.runEngineQuery(invocation, query).then((result) => ({ query, result }), (error) => ({ query, error }))));
      const text = capSearchText(settled.map((item: any) => item.error ? `【${item.query}】搜索失败：${String(item.error?.message || item.error)}` : `【${item.query}】\n${String(item.result?.text || '')}`).join('\n\n'));
      return { jobId: invocation.plan.planId, stepId: invocation.step.id, status: 'success', outputs: text ? [{ kind: 'text', text, priority: 10, mergeable: true, meta: { batch: true, queryCount: queries.length } }] : [], diagnostics: { batch: true, queryCount: queries.length, fallbackEngine: true } };
    }
    const query = queries[0] || fallback;
    const result = await this.runEngineQuery(invocation, query);
    return baseResult(invocation, result.text ? [{ kind: 'text', text: result.text, priority: 10, mergeable: true }] : []);
  }
}

export class PromptCapabilityHandler implements CapabilityHandler {
  constructor(
    private readonly client: ModelClient,
    private readonly getConfig: () => AppConfig,
    private readonly mode: 'enhance' | 'translate',
  ) {}
  async execute(invocation: CapabilityInvocation): Promise<ExecutionResult> {
    const input = stringArg(invocation.step.args, ['prompt', 'text']) || invocation.request.text;
    const cfg = this.getConfig();
    const instruction = this.mode === 'translate'
      ? 'Translate the following prompt into concise English suitable for an image generation model. Output only the translated prompt.'
      : 'Rewrite the following prompt to be more specific and visually descriptive for an image generation model. Output only the improved prompt.';
    const result = await this.client.chat(Number(cfg.llm.chatNodeIndex || 0), {
      model: String(cfg.llm.chatModel || ''),
      messages: [
        { role: 'system', content: instruction },
        { role: 'user', content: input },
      ],
      temperature: 0.3,
      maxTokens: 800,
    });
    const text = String(result.text || '').trim();
    return baseResult(invocation, text ? [{ kind: 'text', text, priority: 10, mergeable: true }] : []);
  }
}

export class TemplateListCapabilityHandler implements CapabilityHandler {
  constructor(private readonly getConfig: () => AppConfig) {}
  async execute(invocation: CapabilityInvocation): Promise<ExecutionResult> {
    const templates = this.getConfig().bot.promptTemplates || [];
    const text = templates.length
      ? ['本地提示词模板：', ...templates.map((item) => `- ${item.id}: ${item.title}`)].join('\n')
      : '本地模板库为空。';
    return baseResult(invocation, [{ kind: 'text', text, priority: 10, mergeable: true }]);
  }
}

export class TtsCapabilityHandler implements CapabilityHandler {
  constructor(private readonly getConfig: () => AppConfig, private readonly logger?: StructuredLogger) {}
  async execute(invocation: CapabilityInvocation): Promise<ExecutionResult> {
    const cfg = this.getConfig().bot.tts;
    if (!cfg.enabled) return { jobId: invocation.plan.planId, stepId: invocation.step.id, status: 'failed', outputs: [], error: 'tts_disabled' };
    // tts.speak 只朗读调用方明确提供的文本；绝不把用户原消息当 TTS 文本。
    // 回复方式的语音开关必须走 reply.presentation(voice=on)，由最终 ReplyPlan 统一朗读。
    const text = stringArg(invocation.step.args, ['text', 'prompt']);
    if (!text) return { jobId: invocation.plan.planId, stepId: invocation.step.id, status: 'failed', outputs: [], error: 'tts_text_required' };
    const audio = await synthesizeSpeech(cfg, text, { logger: this.logger });
    return baseResult(invocation, [{ kind: 'audio', url: audio.file, mime: 'audio/' + audio.format, priority: 10, mergeable: false, meta: { bytes: audio.bytes, spokenText: text, preferredVoice: true, voiceRequested: true, sourceCapability: 'tts.speak' } }]);
  }
}

export class ModelCatalogCapabilityHandler implements CapabilityHandler {
  constructor(private readonly getConfig: () => AppConfig) {}
  async execute(invocation: CapabilityInvocation): Promise<ExecutionResult> {
    const cfg = this.getConfig();
    const llm = cfg.llm;
    const lines: string[] = ['当前可用模型目录：'];
    for (let index = 0; index < llm.apiKeys.length; index += 1) {
      const node = llm.apiKeys[index];
      if (!node?.enabled || node.kind === 'comfyui') continue;
      const models = Array.from(new Set((node.models || []).map((item) => String(item || '').trim()).filter(Boolean))).slice(0, 80);
      lines.push(`- 节点 ${index} ${node.name || '未命名'}: ${models.length ? models.join(', ') : '未列出模型'}`);
    }
    // P0 装配修复：主对话真源是 agent.mainModel（bridge：agent.mainModel || llm.chatModel）——
    // 只列 llm.chatModel 会与 agent enforce 实际用的模型不一致，误导切换判断。
    const mainModel = String((cfg as { agent?: { mainModel?: string; mainNodeIndex?: number } }).agent?.mainModel || llm.chatModel || '');
    const mainNodeIndex = Number((cfg as { agent?: { mainNodeIndex?: number } }).agent?.mainNodeIndex ?? llm.chatNodeIndex ?? 0) || 0;
    const mainNodeName = llm.apiKeys?.[mainNodeIndex]?.name || `节点 ${mainNodeIndex}`;
    lines.push(`当前主对话模型：${mainModel || '未配置'}（${mainNodeName}）`);
    lines.push(`当前聊天模型（旧字段）：${llm.chatModel || '未配置'}`);
    lines.push(`编排 Planner：${cfg.orchestration.planner.model || llm.chatModel || '未配置'}`);
    lines.push(`图片模型：${llm.imageModel || '未配置'}`);
    lines.push(`视频模型：${llm.videoModel || '未配置'}`);
    lines.push(`语音模型：${cfg.bot.tts.model || '未配置'}`);
    return baseResult(invocation, [{ kind: 'text', text: lines.join('\n'), priority: 10, mergeable: true }]);
  }
}

/**
 * P0 装配修复：owner.model.list 的执行体——isOwner 校验（纵深防御）+ 文本生成回调。
 * 校验必须独立于 loadout（模型可见性）：即使工具被意外装配进非 owner 会话，
 * 执行层也会拒绝并留下明确错误；文本生成（buildModelListText 含 ComfyUI 探测）由 start.ts 注入。
 */
export class OwnerModelListCapabilityHandler implements CapabilityHandler {
  constructor(
    private readonly options: {
      getConfig: () => AppConfig;
      isOwnerUser: (userId: string | number | undefined) => boolean;
      buildText: () => Promise<string>;
      logger?: StructuredLogger;
    },
  ) {}
  async execute(invocation: CapabilityInvocation): Promise<ExecutionResult> {
    const userId = invocation.request.user.qq;
    if (!this.options.isOwnerUser(userId)) {
      this.options.logger?.warn('owner.model.list 被非 owner 调用，已拒绝', { userId: String(userId ?? '') });
      return {
        jobId: invocation.plan.planId,
        stepId: invocation.step.id,
        status: 'failed',
        outputs: [],
        error: '仅主人（owner）可查看主人模型列表。',
      };
    }
    const text = await this.options.buildText();
    return baseResult(invocation, [{ kind: 'text', text, priority: 10, mergeable: true, meta: { skipTts: true } }]);
  }
}

/**
 * P1 7b：模型切换工具（model.binding.switch）的执行体。
 * 与 /切换 命令同源（同一个 ModelBindingService）——同一份校验、同一个写入路径、同一份审计。
 * 权限：仅主人（owner）——工具对所有人可见（模型能发现并调用），非 owner 得到结构化拒绝而非静默；
 * 歧义澄清：purpose 缺省或模型名多候选时返回 ambiguous 结构化结果（meta.status），由模型向用户追问后重调。
 */
export class ModelBindingSwitchCapabilityHandler implements CapabilityHandler {
  constructor(
    private readonly options: {
      isOwnerUser: (userId: string | number | undefined) => boolean;
      service: import('./model-binding.js').ModelBindingService;
      logger?: StructuredLogger;
    },
  ) {}
  async execute(invocation: CapabilityInvocation): Promise<ExecutionResult> {
    const userId = invocation.request.user.qq;
    if (!this.options.isOwnerUser(userId)) {
      this.options.logger?.warn('model.binding.switch 被非 owner 调用，已拒绝', { userId: String(userId ?? '') });
      return {
        jobId: invocation.plan.planId,
        stepId: invocation.step.id,
        status: 'failed',
        outputs: [],
        error: 'permission_denied：模型切换仅限主人（owner）。请如实告知用户：该操作需要主人权限，本次尝试已记录。',
      };
    }
    const args = (invocation.step.args || {}) as Record<string, unknown>;
    // P1 第三批：action=lock/unlock → 手动档位锁（方案 §6.3）；缺省 switch = 换模型（原行为）。
    const action = args.action === 'lock' || args.action === 'unlock' ? args.action : 'switch';
    if (action !== 'switch') {
      const rawSlot = String(args.target || '').trim().toLowerCase();
      if (action === 'lock' && !['primary', 'secondary', '主', '备'].includes(rawSlot)) {
        return {
          jobId: invocation.plan.planId, stepId: invocation.step.id, status: 'failed', outputs: [],
          error: '锁定档位需要指明 target=主（primary）或 备（secondary）。',
        };
      }
      const slot = action === 'unlock' ? null : (rawSlot === 'secondary' || rawSlot === '备' ? 'secondary' : 'primary');
      const result = this.options.service.setOverride({ slot, source: 'tool', actorId: String(userId ?? '') });
      return {
        jobId: invocation.plan.planId, stepId: invocation.step.id, status: result.ok ? 'success' : 'failed',
        outputs: result.ok ? [{
          kind: 'text', priority: 10, mergeable: false,
          text: `${result.reply}\n请如实告知用户档位锁定结果。`,
          meta: { status: 'ok', action, slot: slot ?? 'auto' },
        }] : [],
        ...(result.ok ? {} : { error: result.error }),
      };
    }
    const target = String(args.target || '').trim();
    if (!target) {
      return {
        jobId: invocation.plan.planId, stepId: invocation.step.id, status: 'failed', outputs: [],
        error: '缺少目标模型（target）。请先向用户确认要切换到哪个模型。',
      };
    }
    const purpose = String(args.purpose || '').trim();
    // 歧义澄清①：用户只说厂商/系列、用途不明 → 返回各用途当前绑定，由模型追问（禁止猜）。
    if (!purpose) {
      const lines = this.options.service.getStatusText().split('\n').slice(1, -1);
      return {
        jobId: invocation.plan.planId, stepId: invocation.step.id, status: 'success',
        outputs: [{
          kind: 'text', priority: 10, mergeable: false,
          text: `【切换歧义：未指定用途】用户要切换模型，但没说明切换哪个用途。当前各用途绑定：\n${lines.join('\n')}\n请向用户确认要切换哪个用途（主对话/图片/改图/反推/音乐/视频/代码/参数/语音/触发/记忆），确认后带 purpose 参数重新调用本工具。`,
          meta: { status: 'ambiguous', kind: 'purpose' },
        }],
      };
    }
    const slot = args.slot === 'secondary' ? 'secondary' : 'primary';
    const scope = args.scope === 'once' ? 'once' : 'persistent';
    const result = this.options.service.setBinding({ purpose, slot, target, scope, source: 'tool', actorId: String(userId ?? '') });
    if (!result.ok) {
      if (result.kind === 'ambiguous_model' && result.candidates?.length) {
        // 歧义澄清②：模型名多候选 → 列候选，由模型追问（禁止猜）。
        return {
          jobId: invocation.plan.planId, stepId: invocation.step.id, status: 'success',
          outputs: [{
            kind: 'text', priority: 10, mergeable: false,
            text: `【切换歧义：模型名命中多个候选】${result.error}\n- ${result.candidates.join('\n- ')}\n请向用户确认具体要哪个，确认后用完整名称重新调用。`,
            meta: { status: 'ambiguous', kind: 'model', candidates: result.candidates },
          }],
        };
      }
      return {
        jobId: invocation.plan.planId, stepId: invocation.step.id, status: 'failed', outputs: [],
        error: `${result.error}`,
      };
    }
    return baseResult(invocation, [{
      kind: 'text', priority: 10, mergeable: false,
      text: `${result.reply}\n请如实告知用户切换结果与撤销方式（再次 /切换 回原模型即可）。`,
      meta: { status: 'ok', purpose: result.purpose, slot: result.slot, from: result.from, to: result.to },
    }]);
  }
}

/**
 * P0 装配修复：capability.catalog 的目录过滤——只列"装配链完整且对当前上下文可见"的能力，
 * 杜绝"目录里有、工具里没有"的脱节（模型实证 2026-11-03：目录登记了 model.catalog.list /
 * owner.model.list，但工具集里没有调用入口）。过滤规则与 agent loadout 同源：
 * 1. internal 能力不列（Agent 直接持有，无需目录发现）；
 * 2. 无 handler 的不列（连 ToolSpec 都不会生成，列了也调不动）；
 * 3. 对模型不可见的不列（isHiddenFromModel：hidden 恒不列；searchable 且未开
 *    toolRegistry.toolSearchEnabled 时默认 loadout 拿不到，同样不列）——
 *    例外：owner 上下文 + permissions 含 owner 的只读项（本轮仅 owner.model.list）；
 * 4. 有意排除装配的（tts.speak：语音偏好走 reply.presentation，见 start.ts agentToolBindings）不列。
 */
export function filterCatalogDescriptors<T extends { id: string; internal?: boolean; permissions?: string[] }>(
  descriptors: T[],
  options: {
    hasHandler: (id: string) => boolean;
    isHiddenFromModel: (id: string) => boolean;
    isOwnerContext: boolean;
  },
): T[] {
  const OWNER_VISIBLE_READONLY = new Set(['owner.model.list']);
  const INTENTIONALLY_UNASSEMBLED = new Set(['tts.speak']);
  return descriptors.filter((descriptor) => {
    if (descriptor.internal) return false;
    if (!options.hasHandler(descriptor.id)) return false;
    if (INTENTIONALLY_UNASSEMBLED.has(descriptor.id)) return false;
    if (options.isHiddenFromModel(descriptor.id)) {
      return options.isOwnerContext
        && OWNER_VISIBLE_READONLY.has(descriptor.id)
        && Boolean(descriptor.permissions?.includes('owner'));
    }
    return true;
  });
}
export class HelpCapabilityHandler implements CapabilityHandler {
  constructor(private readonly getConfig: () => AppConfig) {}
  async execute(invocation: CapabilityInvocation): Promise<ExecutionResult> {
    return baseResult(invocation, [{ kind: 'text', text: buildHelpText(this.getConfig()), priority: 10, mergeable: true, meta: { skipTts: true, disableVoice: true, help: true } }]);
  }
}
