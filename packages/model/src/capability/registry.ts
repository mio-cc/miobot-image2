import type { ModelOperation } from '../ports.js';
import { CHAT_PROFILE, TEXT_ONLY_PROFILE, inferProfileByName, type ModelProfile } from './profiles.js';

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
}

export class CapabilityRegistry {
  private readonly overrides: CapabilityOverride[];
  private readonly fallback: ModelProfile;

  constructor(options: CapabilityRegistryOptions = {}) {
    this.overrides = options.overrides || [];
    this.fallback = options.fallback || TEXT_ONLY_PROFILE;
  }

  profileOf(model: string): ModelProfile {
    const override = this.matchOverride(model);
    const inferred = inferProfileByName(model);
    if (override) {
      const base = inferred || this.fallback;
      return {
        operations: override.operations ?? base.operations,
        sizes: override.sizes ?? base.sizes,
        supportsSize: override.supportsSize ?? base.supportsSize,
        supportsCount: override.supportsCount ?? base.supportsCount,
        supportsQuality: override.supportsQuality ?? base.supportsQuality,
        supportsMask: override.supportsMask ?? base.supportsMask,
        maxImagesPerRequest: base.maxImagesPerRequest,
      };
    }
    return inferred || this.fallback;
  }

  can(model: string, op: ModelOperation): boolean {
    return this.profileOf(model).operations.includes(op);
  }

  operationsOf(model: string): ModelOperation[] {
    return this.profileOf(model).operations;
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
