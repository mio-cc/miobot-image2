import { createHash } from 'node:crypto';
import type { AppConfig } from '../../../packages/config/src/index.js';
import type { StructuredLogger } from '../../../packages/logger/src/index.js';
import { withPurposeFallback, type ModelFallbackController } from './model-fallback.js';
import type { ModelClient } from '../../../packages/model/src/index.js';
import { CONTENT_REJECTION_EXHAUSTED_PREFIX } from './content-repair.js';

/**
 * 错误首诊通道（2026-11-06 二轮拍板）：真失败「第一时间」交副模型（sanitize 用途）产出
 * 用户可读的原因说明；副模型不可处理就返回可读原因，绝不把堆栈/原始错误体甩给用户。
 *
 * 分类表驱动（不散落 if）：内置表 + bot.errorTriage.customRules（正则，优先匹配）。
 * 三类：
 * - progress：进度/排队/心跳/退避/长任务等待（Suno 出歌、ComfyUI 生图、视频、代码画图的
 *   120s 级等待提示）——结果会正常送达，**不是错误**：不进首诊、不触发修复模型、不给用户报错文案。
 * - rule：已知类型（鉴权 401/403、限流 429/配额）——直接规则文案，**零模型调用**。
 * - triage：真失败（网络/5xx/模型不存在/解析/空回复/能力失败/未知）——首诊一次。
 *
 * 顺序兼容：审核耗尽（content_rejection_exhausted 前缀，wrap 层已产出文案+已完成
 * 切备→修复→剥离链）直接透传，不再进首诊；首诊动作限于「文案生成/建议」，
 * 副模型不可改配置/切模型（suggest_config 只出建议文案，由 owner 决定）。
 *
 * 预算与去重：同错误 hash 冷却（默认 10 分钟）内复用首次结论；全局每小时上限（默认 20 次）
 * 超限走规则兜底；副模型自身失败（网络/超时/解析失败）→ 日志 content.repair.self_failed
 * + 推送管理员，用户侧只收规则兜底文案（绝不让用户看到 repair 内部错误）。
 */

export interface TriageContext {
  chatType?: 'group' | 'private';
  groupId?: number | string;
  userId?: number | string;
  /** 当前请求的意图/场景（freeMode/chat/command…），只给副模型场景摘要，不灌对话。 */
  intentKind?: string;
}

export interface ErrorTriage {
  /** 给用户的一句话说明；undefined = 不是错误/不需要回复（progress 类）。 */
  noticeFor(error: unknown, context?: TriageContext): Promise<string | undefined>;
}

type RuleKind = 'progress' | 'rule' | 'triage';

interface TriageRuleDef {
  id: string;
  kind: RuleKind;
  pattern: RegExp;
  notice?: string;
}

/** 内置分类表（顺序即优先级；自定义规则在其前优先匹配）。文案要求：说清「出了什么问题 + 用户能做什么」，无堆栈无错误码原文。 */
export const BUILTIN_TRIAGE_RULES: TriageRuleDef[] = [
  // ── 不进首诊（非错误：进度 / 长任务等待 / 排队 / 心跳 / 退避——结果会正常送达）──
  { id: 'suno-wait', kind: 'progress', pattern: /suno_(?:wait_timeout|wait_aborted)/ },
  { id: 'late-delivery', kind: 'progress', pattern: /迟到投递|late_delivery/ },
  { id: 'queue-heartbeat', kind: 'progress', pattern: /排队中|queued|heartbeat|心跳|backoff|退避|生成中|处理中|重试中|in[_\s]?progress|等待完成/i },
  // ── 规则兜底优先（已知类型，零模型调用）──
  { id: 'auth', kind: 'rule', pattern: /HTTP 40[13]|unauthorized|forbidden|鉴权|invalid[_\s]?api[_\s]?key|无效.{0,6}(?:密钥|key)/i, notice: '模型服务鉴权失败了，像是节点的 API Key 无效或过期。等管理员在后台检查一下节点配置就会恢复。' },
  { id: 'quota', kind: 'rule', pattern: /HTTP 429|rate.?limit|限流|配额|quota|insufficient[_\s]?(?:quota|credits)/i, notice: '上游限流或配额不足了，稍等一会儿再试；经常出现的话需要管理员看看节点额度。' },
  // ── 进首诊（真失败：副模型判断 + 产出可读原因）──
  { id: 'network', kind: 'triage', pattern: /fetch failed|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|network|网络|超时|timeout/i },
  { id: 'server', kind: 'triage', pattern: /HTTP 5\d\d|suno_http_5\d\d|internal[_\s]?error|server[_\s]?error|bad[_\s]?gateway|service[_\s]?unavailable/i },
  { id: 'model-missing', kind: 'triage', pattern: /model.{0,40}(?:not[_\s]?(?:found|exist)|不存在)|no[_\s]?such[_\s]?model/i },
  { id: 'parse', kind: 'triage', pattern: /JSON|解析失败|parse|invalid.{0,12}response|空 choices|empty[_\s]?choices|空回复/i },
  { id: 'capability', kind: 'triage', pattern: /capability.{0,20}fail|能力执行失败|suno_task_failed|工具执行失败|job.{0,20}fail/i },
];

/** 规则兜底通用文案（首诊不可用/超限/自身失败时的用户侧出口）。 */
export const TRIAGE_FALLBACK_NOTICE =
  '刚才处理时出了点问题，这次没能完成；稍后再试一次，还是不行的话请联系管理员看看后台日志。';

/** 首诊输出契约（副模型必须返回的结构化结论）。 */
export const ERROR_TRIAGE_SYSTEM_HINT = [
  '你是机器人后端的错误首诊助手。机器人的一次处理刚刚失败了，你需要基于错误信息判断原因，并生成直接给聊天里用户看的一句话说明。',
  '只输出一个 JSON 对象，格式：{"actionable": true 或 false, "action": "explain" 或 "suggest_user" 或 "suggest_config" 或 "need_human", "userNotice": "…"}',
  '硬性要求：userNotice 用中文口语，不超过 80 字；说清「出了什么问题」和「用户现在能做什么」；',
  '不得出现堆栈、错误码原文、内部字段名、英文技术细节；actionable=false 表示用户无能为力（服务恢复/需管理员处理）。',
  '不得建议用户去改后台配置（那是管理员的事，action 可标 suggest_config 但 userNotice 里只说"需要管理员检查"）。',
  '你不改写任何内容、不执行任何操作，只产出这份说明。',
].join('\n');

function errorHash(message: string): string {
  return createHash('sha256').update(String(message || '').replace(/\d+/g, '#').slice(0, 400)).digest('hex').slice(0, 20);
}

function extractJsonObjectLoose(text: string): Record<string, unknown> | null {
  const raw = String(text || '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const value = JSON.parse(raw.slice(start, end + 1));
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

export function createErrorTriage(options: {
  getConfig: () => AppConfig;
  /** 副模型调用器（createSanitizeCall 产物；sanitizeModel 空 → 返回 null → 首诊关闭）。 */
  sanitize: (input: string, sanitizeOptions?: { systemHint?: string; timeoutMs?: number }) => Promise<string | null>;
  /** 管理员推送（副模型自身失败时；start.ts 注入 problemReporter）。 */
  reportProblem?: (input: { kind: string; error: unknown; message?: string }) => void | Promise<void>;
  logger?: StructuredLogger;
  clock?: () => number;
}): ErrorTriage {
  const { getConfig, sanitize, logger } = options;
  const now = options.clock || (() => Date.now());

  function classify(message: string): { kind: RuleKind; notice?: string; ruleId: string } {
    const cfg = getConfig();
    const custom = cfg.bot.errorTriage?.customRules || [];
    for (const rule of custom) {
      try {
        if (new RegExp(rule.pattern, 'i').test(message)) {
          return { kind: rule.kind, ...(rule.notice ? { notice: rule.notice } : {}), ruleId: `custom:${rule.pattern.slice(0, 24)}` };
        }
      } catch { /* 用户正则坏了 → 跳过该条 */ }
    }
    for (const rule of BUILTIN_TRIAGE_RULES) {
      if (rule.pattern.test(message)) return { kind: rule.kind, ...(rule.notice ? { notice: rule.notice } : {}), ruleId: rule.id };
    }
    return { kind: 'triage', ruleId: 'default' };
  }

  const verdictCache = new Map<string, { notice: string; at: number }>();
  let hourBucket = Math.floor(now() / 3_600_000);
  let hourCount = 0;

  function sanitizeConfigured(): boolean {
    return Boolean(String(getConfig().llm.sanitizeModel || '').trim());
  }

  async function runTriage(error: unknown, context: TriageContext | undefined): Promise<string> {
    const cfg = getConfig().bot.errorTriage;
    const message = String((error as Error)?.message || error).slice(0, 300);
    const hash = errorHash(message);
    const at = now();

    // 小时窗口滚动。
    const bucket = Math.floor(at / 3_600_000);
    if (bucket !== hourBucket) { hourBucket = bucket; hourCount = 0; }

    const cached = verdictCache.get(hash);
    if (cached && at - cached.at < Math.max(1, Number(cfg.cooldownMinutes) || 10) * 60_000) {
      logger?.info('content.repair', { event: 'triage_cache_hit', hash });
      return cached.notice;
    }
    if (hourCount >= Math.max(0, Number(cfg.hourlyLimit) ?? 20)) {
      logger?.warn('content.repair', { event: 'triage_budget_exceeded', hourCount });
      return TRIAGE_FALLBACK_NOTICE;
    }

    // 首诊输入：结构化错误 + 场景摘要（不灌对话，控成本）。
    const status = (error as { status?: unknown })?.status;
    const code = (error as { code?: unknown })?.code;
    const input = [
      `场景：${context?.intentKind ? String(context.intentKind) : '聊天'}（${context?.chatType === 'group' ? '群聊' : '私聊'}）`,
      `错误码：${code !== undefined ? String(code) : '无'}${status !== undefined ? `；HTTP 状态：${String(status)}` : ''}`,
      `错误摘要：${message}`,
    ].join('\n');
    try {
      const out = await sanitize(input, { systemHint: ERROR_TRIAGE_SYSTEM_HINT, timeoutMs: 20_000 });
      hourCount += 1;
      const verdict = out ? extractJsonObjectLoose(out) : null;
      const notice = verdict ? String(verdict.userNotice || '').trim().slice(0, 200) : '';
      if (!notice) throw new Error('triage_verdict_unparseable');
      const fallbackSafe = notice.length >= 4 && !/[{}]|stack|trace/i.test(notice);
      const finalNotice = fallbackSafe ? notice : TRIAGE_FALLBACK_NOTICE;
      verdictCache.set(hash, { notice: finalNotice, at });
      logger?.info('content.repair', {
        event: 'triage_verdict',
        hash,
        actionable: verdict ? Boolean(verdict.actionable) : false,
        action: verdict ? String(verdict.action || '') : '',
        cached: true,
      });
      return finalNotice;
    } catch (triageError) {
      hourCount += 1;
      // 副模型自身失败：绝不给用户看 repair 内部错误——日志 + 推管理员，用户侧走规则兜底。
      const detail = String((triageError as Error)?.message || triageError).slice(0, 300);
      logger?.warn('content.repair', { event: 'self_failed', hash, error: detail });
      try {
        await options.reportProblem?.({ kind: 'triage-self-failed', error: triageError, message: `错误首诊副模型调用失败：${detail}` });
      } catch { /* 推送失败不影响兜底 */ }
      return TRIAGE_FALLBACK_NOTICE;
    }
  }

  return {
    async noticeFor(error, context) {
      const message = String((error as Error)?.message || error);
      // 审核耗尽：wrap 层已产出完整用户文案（切备→修复→剥离链已走完）——直接透传，不重复首诊。
      if (message.startsWith(CONTENT_REJECTION_EXHAUSTED_PREFIX)) {
        return message.slice(CONTENT_REJECTION_EXHAUSTED_PREFIX.length) || TRIAGE_FALLBACK_NOTICE;
      }
      const cfg = getConfig().bot.errorTriage;
      if (!cfg?.enabled) return undefined;
      const { kind, notice, ruleId } = classify(message);
      if (kind === 'progress') {
        logger?.info('content.repair', { event: 'triage_skip_progress', ruleId });
        return undefined;
      }
      if (kind === 'rule') {
        logger?.info('content.repair', { event: 'triage_rule_notice', ruleId });
        return notice || TRIAGE_FALLBACK_NOTICE;
      }
      if (!sanitizeConfigured()) {
        logger?.info('content.repair', { event: 'triage_disabled_no_sanitize' });
        return TRIAGE_FALLBACK_NOTICE;
      }
      return await runTriage(error, context);
    },
  };
}

/** 直连版首诊调用器（与 createSanitizeCall 同源走 sanitize 用途状态机；测试/装配共用）。 */
export function createTriageSanitizeCall(client: ModelClient, getConfig: () => AppConfig, fallback: ModelFallbackController | undefined) {
  return async (input: string, sanitizeOptions?: { systemHint?: string; timeoutMs?: number }): Promise<string | null> => {
    const llm = getConfig().llm;
    const model = String(llm.sanitizeModel || '').trim();
    if (!model) return null;
    const call = (target: { nodeIndex: number; model: string }) => client.chat(target.nodeIndex, {
      model: target.model,
      messages: [
        { role: 'system', content: sanitizeOptions?.systemHint || '' },
        { role: 'user', content: input },
      ],
      temperature: 0.2,
      maxTokens: 500,
      timeoutMs: sanitizeOptions?.timeoutMs ?? 20_000,
    });
    const res = fallback
      ? await withPurposeFallback(fallback, 'sanitize', { nodeIndex: Number(llm.sanitizeNodeIndex) || 0, model }, call)
      : await call({ nodeIndex: Number(llm.sanitizeNodeIndex) || 0, model });
    return String(res.text || '').trim() || null;
  };
}
