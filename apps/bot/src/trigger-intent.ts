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
    const prompt = [
      '你是群聊消息意图判定器。判断下面这条消息的用户是否有在跟机器人沟通的意图。',
      '',
      '以下触发词都是用户给机器人起的昵称或称呼：' + words,
      '用户在消息中使用这些词就是在叫机器人。由你根据上下文语义判断用户是否真的在跟机器人说话。',
      '',
      '只输出 JSON：{"intent": true} 或 {"intent": false}',
      '',
      '群聊上下文（最近几条）：',
      input.context || '（无上下文）',
      '',
      '要判断的消息：' + input.userText.slice(0, 500),
      '发送者：' + input.userName,
      '命中的触发词：' + input.triggerWord,
    ].join('\n');
    const t0 = Date.now();
    try {
      const result = await this.options.client.chat(nodeIndex, {
        model,
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 400,
        temperature: 0,
        timeoutMs: 5000,
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
    const prompt = [
      '你是群聊消息判定器。机器人刚回复过这个用户，用户紧接着又发了一条消息（没有@机器人）。',
      '背景事实：这个用户刚跟机器人有过一轮交互，机器人回复了他。现在他发了新消息。',
      ...(input.focusMode ? [
        '这是显式触发 bot 后的群级关注窗口。发送者不一定是刚才被回复的人；可能是群里的另一个用户。',
        '只有在消息明显是在接机器人/当前话题时返回 true；对群里其他人的闲聊、玩梗或独立话题返回 false。',
        '群聊上下文：' + String(input.groupContext || '（无）').slice(0, 1200),
        '发送者是否为刚才的触发者：' + String(input.isOriginalUser === true),
      ] : []),
      '',
      '由你根据消息语义和上下文判断：用户这条消息是否是在跟机器人说话？',
      '',
      '只输出 JSON：{"continue": true} 或 {"continue": false}',
      '',
      '机器人的回复（摘要）：' + input.botLastReply.slice(0, 300),
      '用户新消息：' + input.userText.slice(0, 500),
      '发送者：' + input.userName,
    ].join('\n');
    const t0 = Date.now();
    try {
      const result = await this.options.client.chat(nodeIndex, {
        model,
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 400,
        temperature: 0,
        // 400 token 思维链 + JSON 输出，5s 边缘场景会超时误杀，放宽到 8s。
        timeoutMs: 8000,
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
