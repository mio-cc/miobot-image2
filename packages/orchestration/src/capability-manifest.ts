import type { CapabilityDescriptor, CapabilityEffect, CapabilitySideEffect, OutputKind } from './types.js';

export interface CapabilityManifestEntry {
  id: string;
  name: string;
  description: string;
  effect: CapabilityEffect;
  inputSchema: Record<string, unknown>;
  requiredContext: string[];
  outputKinds: OutputKind[];
  mode: 'sync' | 'async_job' | 'stream' | 'interactive';
  sideEffects: CapabilitySideEffect[];
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  approvalRequired: boolean;
  costClass: 'free' | 'low' | 'medium' | 'high';
  expectedLatency?: 'fast' | 'medium' | 'slow';
}

export interface CapabilityManifest {
  schemaVersion: 1;
  version: string;
  capabilities: CapabilityManifestEntry[];
}

function derivedSideEffects(effect: CapabilityEffect): CapabilitySideEffect[] {
  if (effect === 'generate' || effect === 'transform') return ['creates_artifact'];
  if (effect === 'mutate' || effect === 'control') return ['modifies_state'];
  if (effect === 'delete') return ['deletes_data'];
  if (effect === 'notify') return ['sends_message'];
  return [];
}

/**
 * 能力清单只暴露能力正向事实：能做什么、结果类型、参数、前置上下文、输出和客观副作用。
 * 不包含 notFor、关键词、领域路由规则或能力适用性的负向判断。
 */
function manifestHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return 'cm_' + hash.toString(16).padStart(8, '0');
}

export function buildCapabilityManifest(
  capabilities: CapabilityDescriptor[],
  descriptionOverrides: Record<string, string> = {},
): CapabilityManifest {
  const entries: CapabilityManifestEntry[] = capabilities.filter((item) => item.enabled).map((item) => ({
      id: item.id,
      name: item.name,
      description: String(descriptionOverrides[item.id] || item.description || '').trim(),
      effect: item.effect || 'unknown',
      inputSchema: item.inputSchema || {},
      requiredContext: item.requiredContext || [],
      outputKinds: item.outputKinds || [],
      mode: item.mode || 'sync',
      sideEffects: Array.isArray(item.sideEffects) ? item.sideEffects : derivedSideEffects(item.effect || 'unknown'),
      riskLevel: item.riskLevel || 'medium',
      approvalRequired: Boolean(item.approvalRequired),
      costClass: item.costClass || 'medium',
      ...(item.expectedLatency ? { expectedLatency: item.expectedLatency } : {}),
    }));
  return { schemaVersion: 1, version: manifestHash(JSON.stringify(entries)), capabilities: entries };
}