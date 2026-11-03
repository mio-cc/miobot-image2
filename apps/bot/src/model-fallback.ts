import type { AppConfig } from '../../../packages/config/src/index.js';
import type { StructuredLogger } from '../../../packages/logger/src/index.js';

/**
 * 备用模型状态机（方案 §6，P1 第三批）：主失败 → 立即切备重试本次 → 下次回主；
 * 连续两个请求级主失败 → 粘滞到备；粘滞解除 = 主模型一次成功即回切 + 120s 冷却窗口
 * 借真实请求试探（试探失败不计数）。优先级：手动 override > sticky > 自动。
 *
 * 计数口径：按用途（purpose）独立、进程级内存态——故障是"节点+模型"级的，不是会话级的；
 * 跨会话/群共享同一份状态，重启归零（不落盘：避免重启后粘在坏模型上）。
 *
 * 与 ModelBindingService 同源：手动切换模型 / 档位锁定经 onBindingChanged 回调清零计数，
 * 自动逻辑永远不写配置（切备是请求级的，agent.mainModel 不动）。
 */

export const FALLBACK_STICKY_THRESHOLD = 2;
export const FALLBACK_COOLDOWN_MS = 120_000;
export const FALLBACK_PROBE_TIMEOUT_MS = 8_000;
/** 连续失败计数的时间衰减：距上次失败超过该窗口即归零（防偶发抖动长期累积）。 */
export const FALLBACK_DECAY_MS = 10 * 60_000;

export type FallbackSlot = 'primary' | 'secondary';
export type ModelOverrideValue = 'primary' | 'secondary';

export interface FallbackSecondaryBinding {
  model: string;
  nodeIndex: number;
}

export type FallbackDecisionMode =
  /** 无备用：状态机整体旁路（零行为变化——回归重点） */
  | 'bypass'
  /** 自动态：主模型首试（失败计数 + 立即切备重试本次） */
  | 'auto'
  /** 非 turn 调用（repair/safe-text）：跟随当前档位，不决策不计数 */
  | 'follow'
  /** 粘滞：直接用备 */
  | 'sticky'
  /** 粘滞冷却期满：借本次真实调用试探主模型（短超时，失败不计数） */
  | 'probe'
  /** 手动锁定主：从主开始（忽略粘滞），主失败按自动规则（方案 §6.2 括号语义） */
  | 'locked-primary'
  /** 手动锁定备：直接用备，失败不切不计数不试探 */
  | 'locked-secondary';

export interface FallbackDecision {
  purpose: string;
  slot: FallbackSlot;
  mode: FallbackDecisionMode;
  secondary: FallbackSecondaryBinding | null;
  /** probe 模式的短超时上限 */
  probeTimeoutMs?: number;
}

interface PurposeRuntimeState {
  consecutivePrimaryFailures: number;
  stickyOnSecondary: boolean;
  stickySince: number;
  lastFailureAt: number;
}

/**
 * 错误分类（方案 §6.2 表）：网络/超时/5xx/429/404 → 换备且计数；
 * 401/403 鉴权、400/422 与内容审核类（validation）→ 换备无意义，直接失败。
 * ModelError 携带 category/retryable/status；未知错误（裸网络异常）偏保守视为可换备。
 */
export function isFailoverWorthyError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return true;
  const record = error as { status?: unknown; category?: unknown };
  const status = Number(record.status || 0);
  if (status === 401 || status === 403) return false;
  if (status === 400 || status === 422) return false;
  if (String(record.category || '') === 'validation') return false;
  return true;
}

/** 读取某用途的备用绑定与手动档位锁（实时读配置——热重载后下一请求即生效）。 */
export function fallbackBindingOf(config: AppConfig, purpose: string): {
  secondary: FallbackSecondaryBinding | null;
  override: ModelOverrideValue | undefined;
} {
  if (purpose !== 'main') return { secondary: null, override: undefined };
  const agent = (config as { agent?: { fallbackModel?: unknown; fallbackNodeIndex?: unknown; modelOverride?: unknown } }).agent || {};
  const model = String(agent.fallbackModel || '').trim();
  const nodeIndex = Number(agent.fallbackNodeIndex ?? 0) || 0;
  const override = agent.modelOverride === 'primary' || agent.modelOverride === 'secondary' ? agent.modelOverride : undefined;
  return { secondary: model ? { model, nodeIndex } : null, override };
}

export function createModelFallbackController(options: {
  getConfig: () => AppConfig;
  logger?: StructuredLogger;
  clock?: () => number;
  cooldownMs?: number;
  probeTimeoutMs?: number;
}) {
  const { getConfig, logger } = options;
  const now = options.clock || (() => Date.now());
  const cooldownMs = Math.max(1_000, Number(options.cooldownMs) || FALLBACK_COOLDOWN_MS);
  const probeTimeoutMs = Math.max(500, Number(options.probeTimeoutMs) || FALLBACK_PROBE_TIMEOUT_MS);
  const states = new Map<string, PurposeRuntimeState>();

  function state(purpose: string): PurposeRuntimeState {
    let st = states.get(purpose);
    if (!st) {
      st = { consecutivePrimaryFailures: 0, stickyOnSecondary: false, stickySince: 0, lastFailureAt: 0 };
      states.set(purpose, st);
    }
    return st;
  }

  function log(event: string, data: Record<string, unknown>): void {
    // 单一事件名 model.failover，event 字段区分子类——ObservabilityPage 日志流可按名过滤。
    logger?.info('model.failover', { event, ...data });
  }

  /**
   * 每次模型调用前选档。turn=true 才做决策（计数/粘滞/试探都发生在请求级首调用）；
   * repair/safe-text 等后续调用只跟随当前档位。
   */
  function selectSlot(purpose: string, turn: boolean): FallbackDecision {
    const binding = fallbackBindingOf(getConfig(), purpose);
    const base = { purpose, secondary: binding.secondary };
    if (!binding.secondary) return { ...base, slot: 'primary', mode: 'bypass' };

    const st = state(purpose);
    // 计数衰减：距上次失败太久 → 归零（偶发抖动不长期累积）。
    if (st.consecutivePrimaryFailures > 0 && !st.stickyOnSecondary && now() - st.lastFailureAt > FALLBACK_DECAY_MS) {
      st.consecutivePrimaryFailures = 0;
    }

    if (binding.override === 'secondary') return { ...base, slot: 'secondary', mode: 'locked-secondary' };

    if (!turn) {
      // 跟随态：粘滞（或锁定主忽略粘滞）在非 turn 调用上同样生效，但不试探不计数。
      if (binding.override === 'primary') return { ...base, slot: 'primary', mode: 'locked-primary' };
      return { ...base, slot: st.stickyOnSecondary ? 'secondary' : 'primary', mode: 'follow' };
    }

    if (binding.override === 'primary') {
      // 手动锁定主：忽略粘滞，仍从主开始；主失败按自动规则（切备救本次 + 计数）。
      return { ...base, slot: 'primary', mode: 'locked-primary' };
    }
    if (st.stickyOnSecondary) {
      if (now() - st.stickySince >= cooldownMs) {
        return { ...base, slot: 'primary', mode: 'probe', probeTimeoutMs };
      }
      return { ...base, slot: 'secondary', mode: 'sticky' };
    }
    if (st.consecutivePrimaryFailures >= FALLBACK_STICKY_THRESHOLD) {
      // 惰性转粘滞：连续两个请求级失败后，下一次请求开始粘滞（方案伪代码口径）。
      st.stickyOnSecondary = true;
      st.stickySince = now();
      log('sticky', { purpose, consecutiveFailures: st.consecutivePrimaryFailures, retryInMs: cooldownMs });
      return { ...base, slot: 'secondary', mode: 'sticky' };
    }
    return { ...base, slot: 'primary', mode: 'auto' };
  }

  /** 主模型调用成功：回切（粘滞解除）+ 计数清零。返回是否发生了回切。 */
  function onPrimarySuccess(decision: FallbackDecision): boolean {
    if (decision.mode === 'bypass' || decision.mode === 'follow') return false;
    const st = state(decision.purpose);
    const recovered = st.stickyOnSecondary;
    if (recovered || st.consecutivePrimaryFailures > 0) {
      st.stickyOnSecondary = false;
      st.stickySince = 0;
      st.consecutivePrimaryFailures = 0;
      log('recover', {
        purpose: decision.purpose,
        viaProbe: decision.mode === 'probe',
        ...(decision.secondary ? { from: decision.secondary.model } : {}),
        reason: decision.mode === 'probe' ? 'probe_success' : 'primary_success',
      });
    }
    return recovered;
  }

  /**
   * 主模型调用失败（可换备类）。自动/锁定主/试探路径返回 retryWithSecondary=true
   * （立即切备重试本次）；试探失败不增加惩罚计数，只重置冷却窗口。
   */
  function onPrimaryFailure(decision: FallbackDecision, error: unknown): { retryWithSecondary: boolean } {
    if (decision.mode === 'bypass' || decision.mode === 'follow') return { retryWithSecondary: false };
    const st = state(decision.purpose);
    const reason = String((error as Error)?.message || error).slice(0, 300);
    if (decision.mode === 'probe') {
      // 试探失败：不加计（防抖动），粘滞保持，冷却重新计时，落到备完成本次。
      st.stickySince = now();
      log('probe_failed', { purpose: decision.purpose, reason, retryInMs: cooldownMs });
      return { retryWithSecondary: true };
    }
    st.consecutivePrimaryFailures += 1;
    st.lastFailureAt = now();
    log('failover', {
      purpose: decision.purpose,
      ...(decision.secondary ? { to: decision.secondary.model, toNodeIndex: decision.secondary.nodeIndex } : {}),
      reason,
      consecutiveFailures: st.consecutivePrimaryFailures,
      stickyNext: st.consecutivePrimaryFailures >= FALLBACK_STICKY_THRESHOLD,
    });
    return { retryWithSecondary: true };
  }

  /** 手动切换模型 / 档位锁定 / 解锁时清零（ModelBindingService onBindingChanged 回调）。 */
  function reset(purpose?: string): void {
    if (purpose && purpose !== 'main') return; // 本轮仅主对话链有状态
    if (purpose) {
      states.delete(purpose);
    } else {
      states.clear();
    }
    log('reset', { ...(purpose ? { purpose } : { all: true }) });
  }

  /** /切换 状态 与 /模型 尾注的运行时档位描述。 */
  function describe(purpose: string): string {
    const binding = fallbackBindingOf(getConfig(), purpose);
    if (!binding.secondary) return '（未配置备用模型，自动切换关闭）';
    if (binding.override === 'secondary') return '（手动锁定：备用）';
    const st = state(purpose);
    if (binding.override === 'primary') return st.stickyOnSecondary ? '（手动锁定：主模型，粘滞记录已忽略）' : '（手动锁定：主模型）';
    if (st.stickyOnSecondary) {
      const nextProbeIn = Math.max(0, cooldownMs - (now() - st.stickySince));
      return `（当前生效：备用（粘滞中，连续失败 ${st.consecutivePrimaryFailures}），约 ${Math.ceil(nextProbeIn / 1000)}s 后试探主模型）`;
    }
    return st.consecutivePrimaryFailures > 0
      ? `（当前生效：主模型，近期失败 ${st.consecutivePrimaryFailures} 次）`
      : '（当前生效：主模型）';
  }

  function snapshot(purpose: string): PurposeRuntimeState & { override?: ModelOverrideValue; hasSecondary: boolean } {
    const binding = fallbackBindingOf(getConfig(), purpose);
    const st = state(purpose);
    return {
      consecutivePrimaryFailures: st.consecutivePrimaryFailures,
      stickyOnSecondary: st.stickyOnSecondary,
      stickySince: st.stickySince,
      lastFailureAt: st.lastFailureAt,
      ...(binding.override ? { override: binding.override } : {}),
      hasSecondary: Boolean(binding.secondary),
    };
  }

  return { selectSlot, onPrimarySuccess, onPrimaryFailure, reset, describe, snapshot };
}

export type ModelFallbackController = ReturnType<typeof createModelFallbackController>;
