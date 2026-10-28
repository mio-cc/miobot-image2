import type { AppConfig } from '../../../packages/config/src/index.js';
import type { StructuredLogger } from '../../../packages/logger/src/index.js';

export interface TriggerIntentClient {
  chat(nodeIndex: number, req: { model: string; messages: Array<{ role: string; content: string }>; maxTokens?: number; temperature?: number; timeoutMs?: number }): Promise<{ text: string }>;
}

export interface TriggerIntentOptions {
  getConfig: () => AppConfig;
  client: TriggerIntentClient;
  logger?: StructuredLogger;
  /** trace 回调（与 enforce 共用同一 trace 通道，面板可观测性页可见）。 */
  trace?: (trace: { id: string; timestamp: string; requestId: string; stage: string; summary: string; data: Record<string, unknown> }) => void;
  /** 当前 requestId（由 runtime 传入，用于 trace 关联）。 */
  getRequestId?: () => string;
}

function renderTriggerTemplate(template: string, vars: Record<string, string>): string {
  return String(template || '').replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? '');
}

function extractBoolean(text: string, key: string): boolean | undefined {
  const json = text.replace(/\s+/g, ' ').match(new RegExp('"' + key + '"\\s*:\\s*(true|false)', 'i'));
  if (json) return json[1].toLowerCase() === 'true';
  return undefined;
}

/**
 * 触发意图判断器：关键词触发 + 对话延续共用。
 * 一次轻量模型调用（小 maxTokens + 短超时），判断失败/超时一律视为"无意图"（静默）。
 * maxTokens 必须给足（≥400）：推理模型（deepseek-R 系列等）的思维链也计入输出预算，
 * 给 50 会被思维链耗尽导致 JSON 没输出就截断——延续判断 fail-closed 直接静默失效。
 */
export class TriggerIntentChecker {
  constructor(private readonly options: TriggerIntentOptions) {}

  private chatNode(): { nodeIndex: number; model: string } {
    const cfg = this.options.getConfig();
    const kt = cfg.bot.keywordTrigger;
    // 实测 bug：intentNodeIndex 默认 0（非 null），?? 不穿透到 chatNodeIndex
    // → 意图判断打到 node 0（可能没有 chat 模型）→ API 静默失败 → 永远 false。
    // 修正：intentModel 为空 = 用户没单独配 → 节点和模型都跟 chat 走。
    if (!String(kt?.intentModel || '').trim()) {
      return { nodeIndex: Number(cfg.llm.chatNodeIndex ?? 0), model: String(cfg.llm.chatModel || '') };
    }
    return { nodeIndex: Number(kt?.intentNodeIndex ?? cfg.llm.chatNodeIndex ?? 0), model: String(kt.intentModel) };
  }

  /** 关键词触发意图："这个用户是否在跟 bot 说话？" */
  async checkKeywordIntent(input: {
    userText: string;
    userName: string;
    context: string;
    triggerWord: string;
    allTriggerWords?: string[];
  }): Promise<boolean> {
    const { nodeIndex, model } = this.chatNode();
    const words = (input.allTriggerWords && input.allTriggerWords.length ? input.allTriggerWords : [input.triggerWord]).join('、');
    // R15/#8：触发判定提示词收编——模板与超时来自后台配置（原为代码硬编码）。
    const kt = this.options.getConfig().bot.keywordTrigger;
    const prompt = renderTriggerTemplate(kt.triggerIntentPromptTemplate, {
      words,
      context: input.context || '（无上下文）',
      userText: input.userText.slice(0, 500),
      userName: input.userName,
      triggerWord: input.triggerWord,
    });
    const t0 = Date.now();
    try {
      const result = await this.options.client.chat(nodeIndex, {
        model,
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 400,
        temperature: 0,
        timeoutMs: Math.max(1000, Math.trunc(Number(kt.triggerTimeoutMs) || 5000)),
      });
      const raw = String(result.text || '');
      const intent = extractBoolean(raw, 'intent');
      // 模型调用 trace（面板 → 可观测性 → 按 requestId 查看）。
      this.options.trace?.({
        id: `trace_intent_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        timestamp: new Date().toISOString(),
        requestId: this.options.getRequestId?.() || '',
        stage: 'model_call',
        summary: `意图判断 ${model}@node${nodeIndex} → ${intent === undefined ? 'unparseable(默认触发)' : String(intent)}`,
        data: {
          type: 'keyword_intent',
          node: nodeIndex,
          model,
          durationMs: Date.now() - t0,
          promptPreview: prompt.replace(/\s+/g, ' ').slice(0, 600),
          responsePreview: raw.replace(/\s+/g, ' ').slice(0, 300),
          parsed: intent === undefined ? 'unparseable' : String(intent),
        },
      });
      // 触发词已命中 → 模型明确说 false 才不触发；
      // 模型输出解析不出 true/false → 默认触发。
      return intent !== false;
    } catch (error) {
      this.options.trace?.({
        id: `trace_intent_err_${Date.now()}`,
        timestamp: new Date().toISOString(),
        requestId: this.options.getRequestId?.() || '',
        stage: 'model_call',
        summary: `意图判断调用失败(默认触发)`,
        data: { type: 'keyword_intent', error: String((error as Error)?.message || error), node: nodeIndex, model, durationMs: Date.now() - t0 },
      });
      return true;
    }
  }

  /** 延续意图："用户是否在继续跟 bot 的对话？" */
  async checkContinueIntent(input: {
    userText: string;
    userName: string;
    botLastReply: string;
    groupContext?: string;
    focusMode?: boolean;
    isOriginalUser?: boolean;
  }): Promise<boolean> {
    const { nodeIndex, model } = this.chatNode();
    const cfg = this.options.getConfig();
    if (!cfg.bot.autoContinue?.requireModelCheck) return true;
    // R15/#8：延续判定提示词收编——模板与超时来自后台配置（原为代码硬编码）。
    // focusMode 的窗口语义说明作为 {{focusNote}} 注入模板；非 focus 模式为空。
    const ac = cfg.bot.autoContinue;
    const focusNote = input.focusMode ? [
      '这是显式触发 bot 后的群级关注窗口。发送者不一定是刚才被回复的人；可能是群里的另一个用户。',
      '只有在消息明显是在接机器人/当前话题时返回 true；对群里其他人的闲聊、玩梗或独立话题返回 false。',
      '群聊上下文：' + String(input.groupContext || '（无）').slice(0, 1200),
      '发送者是否为刚才的触发者：' + String(input.isOriginalUser === true),
    ].join('\n') : '';
    const prompt = renderTriggerTemplate(ac.continueIntentPromptTemplate, {
      focusNote,
      botLastReply: input.botLastReply.slice(0, 300),
      userText: input.userText.slice(0, 500),
      userName: input.userName,
    });
    const t0 = Date.now();
    try {
      const result = await this.options.client.chat(nodeIndex, {
        model,
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 400,
        temperature: 0,
        // 400 token 思维链 + JSON 输出，超时跟后台配置（默认 8s，原为硬编码）。
        timeoutMs: Math.max(1000, Math.trunc(Number(ac.continueTimeoutMs) || 8000)),
      });
      const cont = extractBoolean(String(result.text || ''), 'continue');
      this.options.trace?.({
        id: `trace_cont_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        timestamp: new Date().toISOString(),
        requestId: this.options.getRequestId?.() || '',
        stage: 'model_call',
        summary: `延续判断 ${model}@node${nodeIndex} → ${cont === undefined ? 'unparseable' : String(cont)}`,
        data: {
          type: 'continue_intent',
          node: nodeIndex,
          model,
          durationMs: Date.now() - t0,
          promptPreview: prompt.replace(/\s+/g, ' ').slice(0, 500),
          responsePreview: String(result.text || '').replace(/\s+/g, ' ').slice(0, 300),
          parsed: cont === undefined ? 'unparseable' : String(cont),
        },
      });
      return cont === true;
    } catch (error) {
      this.options.trace?.({
        id: `trace_cont_err_${Date.now()}`,
        timestamp: new Date().toISOString(),
        requestId: this.options.getRequestId?.() || '',
        stage: 'model_call',
        summary: `延续判断调用失败`,
        data: { type: 'continue_intent', error: String((error as Error)?.message || error), durationMs: Date.now() - t0 },
      });
      return false;
    }
  }
}
