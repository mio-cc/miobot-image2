import type { AppConfig } from '../../../packages/config/src/index.js';
import type { FeatureSetting } from '../../../packages/shared/src/features.js';
import { KeyedConcurrencyGate, QueueGateTimeoutError } from './queue-gate.js';

export interface FeatureGateContext {
  featureId: string;
  chatType?: 'group' | 'private';
  groupId?: string | number;
  userId?: string | number;
  promptChars?: number;
}

export class FeatureLimitError extends Error {
  readonly featureId: string;
  constructor(featureId: string, message: string) {
    super(message);
    this.name = 'FeatureLimitError';
    this.featureId = featureId;
  }
}

type Release = () => void;

function dateKey(now = Date.now()): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 并发名额最长等待：超时给用户「当前请求过多」，而不是无限挂住。 */
const CONCURRENCY_WAIT_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 统一执行功能限额：冷却、用户/群每日上限、最大输入字符、并发。
 * 状态只在内存中；bot 重启会清零，避免把临时限流状态写进配置文件。
 */
export class FeatureGate {
  private readonly getConfig: () => AppConfig;
  private readonly now: () => number;
  private readonly resolveDefaultSetting?: (featureId: string) => FeatureSetting | undefined;
  private readonly cooldowns = new Map<string, number>();
  private readonly daily = new Map<string, number>();
  private readonly concurrencyGate = new KeyedConcurrencyGate('feature-gate');

  constructor(options: { getConfig: () => AppConfig; now?: () => number; resolveDefaultSetting?: (featureId: string) => FeatureSetting | undefined }) {
    this.getConfig = options.getConfig;
    this.now = options.now || Date.now;
    this.resolveDefaultSetting = options.resolveDefaultSetting;
  }

  private setting(featureId: string): FeatureSetting | undefined {
    // T0.2：编排能力未在 bot.features 显式配置时，回退到能力默认配额
    //（按 costClass 映射，仅副作用类能力），面板显式配置永远优先。
    return (this.getConfig().bot.features as Record<string, FeatureSetting> | undefined)?.[featureId]
      ?? this.resolveDefaultSetting?.(featureId);
  }

  private targetKey(featureId: string, context: FeatureGateContext): string {
    const chat = context.chatType || 'private';
    const target = chat === 'group' ? `g:${String(context.groupId ?? '')}` : `u:${String(context.userId ?? '')}`;
    return `${featureId}:${chat}:${target}`;
  }

  async acquire(context: FeatureGateContext): Promise<Release> {
    const { featureId } = context;
    const setting = this.setting(featureId);
    if (!setting?.enabled) return () => undefined;
    const limits = setting.limits || {};
    const maxPromptChars = Number(limits.maxPromptChars || 0);
    if (maxPromptChars > 0 && Number(context.promptChars || 0) > maxPromptChars) {
      throw new FeatureLimitError(featureId, `输入太长：${context.promptChars} 字符，超过该功能上限 ${maxPromptChars} 字符。`);
    }

    const key = this.targetKey(featureId, context);
    const now = this.now();
    const cooldownMs = Math.max(0, Number(limits.cooldownSec || 0)) * 1000;
    const until = this.cooldowns.get(key) || 0;
    if (cooldownMs > 0 && now < until) {
      throw new FeatureLimitError(featureId, `操作太快，请 ${Math.ceil((until - now) / 1000)} 秒后再试。`);
    }

    const day = dateKey(now);
    const userDaily = Math.max(0, Number(limits.userDailyLimit || 0));
    const groupDaily = Math.max(0, Number(limits.groupDailyLimit || 0));
    if (userDaily > 0) {
      const userKey = `${day}:${featureId}:u:${String(context.userId ?? '')}`;
      if ((this.daily.get(userKey) || 0) >= userDaily) throw new FeatureLimitError(featureId, `今天这个功能的使用次数已达用户上限（${userDaily} 次）。`);
    }
    if (groupDaily > 0 && context.chatType === 'group') {
      const groupKey = `${day}:${featureId}:g:${String(context.groupId ?? '')}`;
      if ((this.daily.get(groupKey) || 0) >= groupDaily) throw new FeatureLimitError(featureId, `今天这个功能的使用次数已达本群上限（${groupDaily} 次）。`);
    }

    // 三级并发（2026-11-19）：原来只有全局 featureId 一级，
    // 「每群同时最多 1 个生图」表达不出来。层级从粗到细依次占用，失败按相反顺序回滚。
    const releases: Release[] = [];
    const acquireLevel = async (gateKey: string, limit: number) => {
      const cap = Math.max(0, Number(limit || 0));
      if (cap <= 0) return;
      try {
        releases.push(await this.concurrencyGate.acquire(gateKey, cap, { timeoutMs: CONCURRENCY_WAIT_MS }));
      } catch (error) {
        if (error instanceof QueueGateTimeoutError) {
          throw new FeatureLimitError(featureId, '当前请求过多，请稍后再试。');
        }
        throw error;
      }
    };
    try {
      await acquireLevel(`feature:${featureId}`, Number(limits.concurrency || 0));
      if (context.chatType === 'group') {
        await acquireLevel(`feature:${featureId}:g:${String(context.groupId ?? '')}`, Number(limits.concurrencyPerGroup || 0));
      }
      await acquireLevel(`feature:${featureId}:u:${String(context.userId ?? '')}`, Number(limits.concurrencyPerUser || 0));
    } catch (error) {
      for (const release of releases.reverse()) release();
      throw error;
    }

    this.cooldowns.set(key, now + cooldownMs);
    if (userDaily > 0) {
      const userKey = `${day}:${featureId}:u:${String(context.userId ?? '')}`;
      this.daily.set(userKey, (this.daily.get(userKey) || 0) + 1);
    }
    if (groupDaily > 0 && context.chatType === 'group') {
      const groupKey = `${day}:${featureId}:g:${String(context.groupId ?? '')}`;
      this.daily.set(groupKey, (this.daily.get(groupKey) || 0) + 1);
    }
    return () => {
      // 释放顺序与占用相反；release 本身幂等，重复调用安全。
      for (const release of releases.reverse()) release();
    };
  }

  sendDelayMs(featureId: string): number {
    return Math.max(0, Number(this.setting(featureId)?.limits?.sendDelayMs || 0));
  }
}
