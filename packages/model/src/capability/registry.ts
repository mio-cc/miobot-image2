import type { ModelOperation } from '../ports.js';
import { CHAT_PROFILE, TEXT_ONLY_PROFILE, inferProfileByName, type ModelProfile } from './profiles.js';
import {
  ALL_OPERATIONS,
  capabilityKey,
  mergeOperations,
  revokeOperation,
  type CapabilityMemory,
  type CapabilityNodeRef,
  type CapabilitySource,
  type LearnedCapability,
} from './memory.js';

/**
 * 未知模型的档案：给「不认识」留一档，而不是直接当成「只会 chat」。
 *
 * 历史语义（到 2026-11-16）是 inferProfileByName 认不出 → TEXT_ONLY，于是 ModelClient
 * 在本地 can() 就被拒，请求从不发出。用户把网关自带的新模型填进生图位时，表现为
 * 「开关全开、节点可用、就是不出图」，且没有任何上游错误可查。
 *
 * 现在未知 = 我们不知道，不是模型不能。参数整形取最宽松档（全部照发），
 * 由上游或参数自愈来决定收敛，结论随后记进能力记忆。
 */
export const UNKNOWN_PROFILE: ModelProfile = {
  // operations 留空 = 「已知能力为零」，不要让 UI / 主脑以为未知模型全能。
  operations: [],
  sizes: [],
  supportsSize: true, supportsCount: true, supportsQuality: true, supportsMask: true, maxImagesPerRequest: 4,
};

/** 用户覆盖：把某模型名（或正则字符串）映射到自定义档案/能力。 */
export interface CapabilityOverride {
  model: string;            // 精确名或 /regex/ 形式
  operations?: ModelOperation[];
  sizes?: string[];
  supportsSize?: boolean;
  supportsCount?: boolean;
  supportsQuality?: boolean;
  supportsMask?: boolean;
}

export interface CapabilityRegistryOptions {
  overrides?: CapabilityOverride[];
  /** 推断不到档案时的兜底（默认保守：纯文本对话，避免误调 vision API）。 */
  fallback?: ModelProfile;
  /** 运行时学习到的事实（上游实测 / 大脑判定）。不传 = 只按名字启发，行为与旧版一致。 */
  memory?: CapabilityMemory;
}

export class CapabilityRegistry {
  private readonly overrides: CapabilityOverride[];
  private readonly fallback: ModelProfile;
  private readonly memory?: CapabilityMemory;

  constructor(options: CapabilityRegistryOptions = {}) {
    this.overrides = options.overrides || [];
    this.fallback = options.fallback || TEXT_ONLY_PROFILE;
    if (options.memory) this.memory = options.memory;
  }

  /**
   * 能力判定四级：用户覆盖 > 运行时学习 > 名字启发 > 未知。
   *
   * 学习结论优先于名字启发：名字启发只是猜，学习是实测（同一个 baseUrl 上的事实），
   * 猜错时必须以实测为准——否则网关把某个名字相近的模型换掉后，会永远按猜的走。
   */
  resolve(model: string, node?: CapabilityNodeRef): { profile: ModelProfile; operations: ModelOperation[]; source: CapabilitySource; evidence?: string } {
    const override = this.matchOverride(model);
    const learned = node ? this.memory?.get(capabilityKey(node, model)) : undefined;
    const inferred = inferProfileByName(model);

    if (override) {
      const base = learned
        ? { ...(inferred || this.fallback), operations: learned.operations }
        : (inferred || this.fallback);
      return {
        source: 'user-override',
        operations: override.operations ?? base.operations,
        profile: {
          operations: override.operations ?? base.operations,
          sizes: override.sizes ?? base.sizes,
          supportsSize: override.supportsSize ?? base.supportsSize,
          supportsCount: override.supportsCount ?? base.supportsCount,
          supportsQuality: override.supportsQuality ?? base.supportsQuality,
          supportsMask: override.supportsMask ?? base.supportsMask,
          maxImagesPerRequest: base.maxImagesPerRequest,
        },
      };
    }

    if (learned) {
      const base = inferred || UNKNOWN_PROFILE;
      const source: CapabilitySource = learned.source === 'learned-llm' ? 'learned-llm' : learned.source;
      return {
        source,
        operations: learned.operations,
        ...(learned.evidence ? { evidence: learned.evidence } : {}),
        profile: { ...base, operations: learned.operations },
      };
    }

    if (inferred) {
      return { source: 'builtin-hint', operations: inferred.operations, profile: inferred };
    }

    return { source: 'unknown', operations: UNKNOWN_PROFILE.operations, profile: UNKNOWN_PROFILE };
  }

  profileOf(model: string): ModelProfile {
    return this.resolve(model).profile;
  }

  /**
   * 是否**已知**支持某操作（严格语义）。
   *
   * 未知模型一律 false——这是「已知能力清单」，不能把不知道说成能。
   * 想知道「该不该发一次试试」用 shouldAttempt()，两者刻意分开：
   * 前者给 UI / 主脑看事实，后者给执行层决定是否放行。
   */
  can(model: string, op: ModelOperation, node?: CapabilityNodeRef): boolean {
    const resolved = this.resolve(model, node);
    return resolved.source !== 'unknown' && resolved.operations.includes(op);
  }

  /**
   * 是否允许真的发出该操作的请求。
   *
   * 未知 = 我们没有证据说它不行 → 允许尝试，由上游回答，结论自动学进能力记忆。
   * 已知不支持 → 拒绝（快速失败，省一次上游往返）。
   * 这是「不替用户猜」的唯一出口：新增模型不需要改代码。
   */
  shouldAttempt(model: string, op: ModelOperation, node?: CapabilityNodeRef): boolean {
    const resolved = this.resolve(model, node);
    if (resolved.source === 'unknown') return true;
    return resolved.operations.includes(op);
  }

  /** 已知能力清单；未知模型返回空数组（不是「全能」）。 */
  operationsOf(model: string, node?: CapabilityNodeRef): ModelOperation[] {
    const resolved = this.resolve(model, node);
    return resolved.source === 'unknown' ? [] : resolved.operations;
  }

  /** 记录「这个模型确实能做这个」——成功调用后的正向证据。 */
  learnSupported(node: CapabilityNodeRef | undefined, model: string, op: ModelOperation): void {
    if (!this.memory || !node) return;
    const key = capabilityKey(node, model);
    const previous = this.memory.get(key);
    const resolved = this.resolve(model, node);
    const base = previous?.operations ?? (resolved.source === 'unknown' ? [] : resolved.operations);
    this.memory.set(key, {
      operations: mergeOperations(base, [op]),
      source: 'learned-call',
      ...(previous?.evidence ? { evidence: previous.evidence } : {}),
      updatedAt: new Date().toISOString(),
    });
  }

  /** 记录「这个模型不支持这个」——上游明确拒绝后的负向证据。 */
  learnUnsupported(node: CapabilityNodeRef | undefined, model: string, op: ModelOperation, evidence: string): void {
    if (!this.memory || !node) return;
    const key = capabilityKey(node, model);
    const previous = this.memory.get(key);
    const resolved = this.resolve(model, node);
    const base = previous?.operations ?? (resolved.source === 'unknown' ? [] : resolved.operations);
    this.memory.set(key, {
      operations: revokeOperation(base, op),
      source: previous?.source === 'learned-llm' ? 'learned-llm' : 'learned-rejected',
      evidence,
      updatedAt: new Date().toISOString(),
    });
  }

  /** 大脑判定结果落库（model.capability.classify 调用）。 */
  rememberJudgement(node: CapabilityNodeRef | undefined, model: string, operations: ModelOperation[], evidence?: string): void {
    if (!this.memory || !node) return;
    this.memory.set(capabilityKey(node, model), {
      operations: mergeOperations([], operations),
      source: 'learned-llm',
      ...(evidence ? { evidence } : {}),
      updatedAt: new Date().toISOString(),
    });
  }

  listLearned(): Array<{ key: string } & LearnedCapability> {
    return this.memory?.list() || [];
  }

  forget(node: CapabilityNodeRef | undefined, model: string): void {
    if (!this.memory || !node) return;
    this.memory.delete(capabilityKey(node, model));
  }

  private matchOverride(model: string): CapabilityOverride | undefined {
    const name = String(model || '').trim();
    if (!name) return undefined;
    return this.overrides.find((o) => {
      const key = String(o.model || '').trim();
      if (!key) return false;
      const re = key.match(/^\/(.*)\/(i?)$/);
      if (re) { try { return new RegExp(re[1], re[2]).test(name); } catch { return false; } }
      return key.toLowerCase() === name.toLowerCase();
    });
  }
}

export function createCapabilityRegistry(options: CapabilityRegistryOptions = {}): CapabilityRegistry {
  return new CapabilityRegistry(options);
}

/**
 * 随配置热重载的能力注册表。
 *
 * 每次访问都重建太浪费（注册表要编译一堆正则），所以按 overrides 的内容做记忆化：
 * 内容没变就复用同一个实例，变了才重建。
 */
export function createReloadableRegistry(
  getOverrides: () => CapabilityOverride[] | undefined,
  /** 能力记忆是可变状态，不参与记忆化 key——覆盖或记忆变了都走同一个 registry 实例。 */
  options?: { memory?: CapabilityMemory },
): () => CapabilityRegistry {
  let cachedKey: string | undefined;
  let cached: CapabilityRegistry | undefined;
  return () => {
    const overrides = getOverrides() || [];
    let key: string;
    try {
      key = JSON.stringify(overrides);
    } catch {
      key = String(overrides.length);
    }
    if (!cached || key !== cachedKey) {
      cachedKey = key;
      cached = createCapabilityRegistry({ overrides, ...(options?.memory ? { memory: options.memory } : {}) });
    }
    return cached;
  };
}
