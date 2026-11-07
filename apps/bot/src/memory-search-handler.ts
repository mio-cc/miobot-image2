import type { AppConfig } from '../../../packages/config/src/index.js';
import type { CapabilityHandler, CapabilityInvocation, ExecutionResult } from '../../../packages/orchestration/src/index.js';
import type { ChatMemoryService } from './memory-service.js';

export interface MemorySearchHandlerOptions {
  memoryService: Pick<ChatMemoryService, 'retrieve'>;
  getConfig: () => AppConfig;
  /** Bot 自身 QQ（服务端绑定）；不传则从 config.bot.botQqId 解析。 */
  resolveBotId?: () => string;
}

/**
 * memory.search 内部技能 handler（Harness Memory Layer §5）。
 *
 * 作用域只认服务端上下文：botId/会话类型/群号/QQ 一律取 request.chat / request.user，
 * 模型传入的 groupId/userId/botId 参数一律 forbidden_scope，不返回其他作用域的
 * 数量、摘要或错误细节（无侧信道）。记忆结果保留服务端的"外部事实"安全声明。
 */
export function createMemorySearchHandler(options: MemorySearchHandlerOptions): CapabilityHandler {
  return {
    async execute(invocation: CapabilityInvocation): Promise<ExecutionResult> {
      const startedAt = Date.now();
      const args = (invocation.step?.args || {}) as Record<string, unknown>;
      const chat = invocation.request?.chat;
      const user = invocation.request?.user;
      const chatType: 'group' | 'private' = chat?.type === 'private' ? 'private' : 'group';
      const groupId = chat?.groupId;
      const userId = String(user?.qq || chat?.userId || '');
      const botId = String(options.resolveBotId?.() || options.getConfig().bot.botQqId || 'unknown');
      const base = { jobId: invocation.plan?.planId || invocation.request?.requestId || 'memory.search', stepId: invocation.step?.id };
      const fail = (error: string): ExecutionResult => ({ ...base, status: 'failed', outputs: [], error, durationMs: Date.now() - startedAt });
      if (!userId) return fail('memory_search_context_missing');
      // 双保险：inputSchema additionalProperties:false 挡一层，这里对越权参数再拒一层。
      if (args.groupId !== undefined || args.userId !== undefined || args.botId !== undefined) return fail('forbidden_scope');
      // 私聊里要求群作用域 = 越权。
      if (chatType === 'private' && (args.scope === 'group' || args.scope === 'group_user')) return fail('forbidden_scope');
      const memoryCfg = options.getConfig().orchestration.memory;
      if (!memoryCfg.enabled) {
        return {
          ...base, status: 'success',
          outputs: [{ kind: 'text', text: '（长期记忆未启用，无法检索历史。）', priority: 10 }],
          durationMs: Date.now() - startedAt,
        };
      }
      const scope = String(args.scope || 'auto');
      // scope 语义（服务端解析，模型只表达意图）：group=仅群共享；group_user=群共享+当前用户；
      // auto=当前群全部可见 namespace（群共享+当前用户+可选跨群画像）。
      const scopeFilter = scope === 'group'
        ? ['group_shared' as const]
        : scope === 'group_user'
          ? ['group_shared' as const, 'personal_group_user' as const]
          : undefined;
      const limitRaw = Number(args.limit);
      const topK = Number.isFinite(limitRaw) && limitRaw > 0
        ? Math.max(1, Math.min(20, Math.trunc(limitRaw)))
        : options.getConfig().contextPolicy.memoryTopK;
      const result = await options.memoryService.retrieve({
        botId,
        chatType,
        groupId: chatType === 'group' ? String(groupId ?? '') : undefined,
        userId,
        query: String(args.query || ''),
        topK,
        minScore: options.getConfig().contextPolicy.memoryMinScore,
        maxContextChars: options.getConfig().contextPolicy.memoryMaxChars,
        ...(scopeFilter ? { scopeFilter } : {}),
      });
      const text = (result.context || '（当前作用域内没有找到相关记忆。）')
        + (result.degraded ? '\n（记忆检索降级：向量服务不可用，结果改走全文匹配。）' : '');
      return {
        ...base, status: 'success',
        outputs: [{ kind: 'text', text, priority: 10, mergeable: true }],
        durationMs: Date.now() - startedAt,
        diagnostics: { scope, namespaces: result.namespaces, hits: result.hits.length, degraded: result.degraded },
      };
    },
  };
}
