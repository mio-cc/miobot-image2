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
    const text = stringArg(invocation.step.args, ['text', 'prompt']) || invocation.request.text;
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
    lines.push(`当前聊天模型：${llm.chatModel || '未配置'}`);
    lines.push(`编排 Planner：${cfg.orchestration.planner.model || llm.chatModel || '未配置'}`);
    lines.push(`图片模型：${llm.imageModel || '未配置'}`);
    lines.push(`视频模型：${llm.videoModel || '未配置'}`);
    lines.push(`语音模型：${cfg.bot.tts.model || '未配置'}`);
    return baseResult(invocation, [{ kind: 'text', text: lines.join('\n'), priority: 10, mergeable: true }]);
  }
}
export class HelpCapabilityHandler implements CapabilityHandler {
  constructor(private readonly getConfig: () => AppConfig) {}
  async execute(invocation: CapabilityInvocation): Promise<ExecutionResult> {
    return baseResult(invocation, [{ kind: 'text', text: buildHelpText(this.getConfig()), priority: 10, mergeable: true, meta: { skipTts: true, disableVoice: true, help: true } }]);
  }
}
