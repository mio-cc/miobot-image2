import type { AppConfig } from '../../../packages/config/src/index.js';
import type { StructuredLogger } from '../../../packages/logger/src/index.js';

export interface TriggerIntentClient {
  chat(nodeIndex: number, req: { model: string; messages: Array<{ role: string; content: string }>; maxTokens?: number; temperature?: number; timeoutMs?: number }): Promise<{ text: string }>;
}

export interface TriggerIntentOptions {
  getConfig: () => AppConfig;
  client: TriggerIntentClient;
  logger?: StructuredLogger;
}

function extractBoolean(text: string, key: string): boolean | undefined {
  const json = text.replace(/\s+/g, ' ').match(new RegExp('"' + key + '"\\s*:\\s*(true|false)', 'i'));
  if (json) return json[1].toLowerCase() === 'true';
  return undefined;
}

/**
 * 触发意图判断器：关键词触发 + 对话延续共用。
 * 一次轻量模型调用（~100 token，5s 超时），判断失败/超时一律视为"无意图"（静默）。
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
    try {
      const result = await this.options.client.chat(nodeIndex, {
        model,
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 50,
        temperature: 0,
        timeoutMs: 5000,
      });
      const intent = extractBoolean(String(result.text || ''), 'intent');
      return intent === true;
    } catch (error) {
      this.options.logger?.warn('关键词意图判断失败（视为无意图）', { error: String((error as Error)?.message || error) });
      return false;
    }
  }

  /** 延续意图："用户是否在继续跟 bot 的对话？" */
  async checkContinueIntent(input: {
    userText: string;
    userName: string;
    botLastReply: string;
  }): Promise<boolean> {
    const { nodeIndex, model } = this.chatNode();
    const cfg = this.options.getConfig();
    if (!cfg.bot.autoContinue?.requireModelCheck) return true;
    const prompt = [
      '你是群聊对话延续判定器。机器人刚回复了用户的消息，用户紧接着又发了一条（没有@机器人）。',
      '判断：用户这条新消息是否是在继续跟机器人的对话？',
      '回应了机器人的回答、追问、补充、表达了看法 → 在继续(true)',
      '换话题跟别人聊天、发表情包、@了其他人 → 不在继续(false)',
      '只输出 JSON：{"continue": true} 或 {"continue": false}',
      '',
      '机器人的回复（摘要）：' + input.botLastReply.slice(0, 300),
      '用户新消息：' + input.userText.slice(0, 500),
      '发送者：' + input.userName,
    ].join('\n');
    try {
      const result = await this.options.client.chat(nodeIndex, {
        model,
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 50,
        temperature: 0,
        timeoutMs: 5000,
      });
      const cont = extractBoolean(String(result.text || ''), 'continue');
      return cont === true;
    } catch (error) {
      this.options.logger?.warn('延续意图判断失败（视为无意图）', { error: String((error as Error)?.message || error) });
      return false;
    }
  }
}
