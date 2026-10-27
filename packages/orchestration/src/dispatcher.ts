import type {
  CapabilityDescriptor,
  ExecutionResult,
  IntentPlan,
  IntentStep,
  UserRequest,
} from './types.js';
import type { PermissionPolicy } from './permissions.js';
import { resolvePermission } from './permissions.js';
import { CapabilityRegistry } from './capabilities.js';
import { normalizeCapabilityArgs, type ArgsNormalizationWarning } from './validation.js';

export interface CapabilityInvocation {
  request: UserRequest;
  plan: IntentPlan;
  step: IntentStep;
  dependencyResults: Record<string, ExecutionResult>;
  validationWarnings?: ArgsNormalizationWarning[];
  /** 步骤级取消信号；支持长任务的 handler 应在副作用结束后检查或监听 abort。 */
  signal?: AbortSignal;
  /**
   * T2.8：外部异步任务 taskId 上报旁路。handler 在远端任务提交成功后立即调用
   * （如 Suno create 返回 taskId 时），executor 经 onExternalTask 落盘进 Job 记录，
   * 供崩溃恢复时对账（查远端成功则补投递，防双计费不重放）。
   */
  reportExternalTask?: (taskId: string) => void;
}

/**
 * T1.1：步骤输出引用模板。Planner 可以在后续步骤的 args 字符串里引用依赖步骤的输出：
 *   {{steps.<stepId>.outputs[0].text}} / {{steps.<stepId>.outputs[1].url}}
 * dispatcher 在 handler 执行前递归渲染（字符串/数组/普通对象）；
 * 引用了不存在或无输出的步骤 → 该步返回 needs_input（结构化事实），交由模型修复轮/追问处理。
 */
const STEP_REFERENCE_PATTERN = /\{\{steps\.([A-Za-z0-9_-]+)\.outputs\[(\d+)\]\.(text|url)\}\}/g;

export function renderStepReferences(value: unknown, dependencyResults: Record<string, ExecutionResult>): { value: unknown; missing: string[] } {
  const missing: string[] = [];
  const renderString = (input: string): string =>
    input.replace(STEP_REFERENCE_PATTERN, (whole: string, stepId: string, index: string, field: string) => {
      const outputs = dependencyResults[stepId]?.outputs || [];
      const target = outputs[Number(index)];
      const resolved = field === 'text' ? target?.text : target?.url;
      if (resolved === undefined || resolved === null || String(resolved) === '') {
        missing.push(whole);
        return '';
      }
      return String(resolved);
    });
  const walk = (current: unknown): unknown => {
    if (typeof current === 'string') return renderString(current);
    if (Array.isArray(current)) return current.map(walk);
    if (current && typeof current === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(current as Record<string, unknown>)) out[key] = walk(item);
      return out;
    }
    return current;
  };
  return { value: walk(value), missing };
}

export interface CapabilityHandler {
  execute(invocation: CapabilityInvocation): Promise<ExecutionResult>;
}

export interface DispatchAuthorization {
  result?: ExecutionResult;
  normalizedStep?: IntentStep;
  validationWarnings?: ArgsNormalizationWarning[];
  permission?: ReturnType<typeof resolvePermission>;
  capability?: CapabilityDescriptor;
}

export interface DispatchResult {
  result: ExecutionResult;
  permission?: ReturnType<typeof resolvePermission>;
  capability?: CapabilityDescriptor;
}

export interface CapabilityRateGateContext {
  featureId: string;
  chatType?: string;
  groupId?: string | number;
  userId?: string | number;
}

/**
 * T0.2：能力级限流闸。dispatcher 在权限校验通过后、handler 执行前统一 acquire，
 * 34 个内置能力（含编排路径）一次全覆盖；抛错即限流触发。
 */
export interface CapabilityRateGate {
  acquire(context: CapabilityRateGateContext): Promise<() => void>;
}

export class CapabilityDispatcher {
  private readonly handlers = new Map<string, CapabilityHandler>();

  constructor(
    private readonly registry: CapabilityRegistry,
    private readonly permissionPolicy: PermissionPolicy,
    private readonly rateGate?: CapabilityRateGate,
  ) {}

  setPermissionPolicy(policy: PermissionPolicy): void {
    (this as unknown as { permissionPolicy: PermissionPolicy }).permissionPolicy = policy;
  }

  registerHandler(capabilityId: string, handler: CapabilityHandler): void {
    this.handlers.set(String(capabilityId), handler);
  }

  getCapability(capabilityId: string): CapabilityDescriptor | undefined {
    return this.registry.get(String(capabilityId));
  }
  unregisterHandler(capabilityId: string): boolean {
    return this.handlers.delete(String(capabilityId));
  }
  hasHandler(capabilityId: string): boolean {
    return this.handlers.has(String(capabilityId));
  }

  getHandler(capabilityId: string): CapabilityHandler | undefined {
    return this.handlers.get(String(capabilityId));
  }

  authorize(
    request: UserRequest,
    plan: IntentPlan,
    step: IntentStep,
    options: { approvalGranted?: boolean } = {},
  ): DispatchAuthorization {
    const capability = this.registry.get(step.capability);
    if (!capability || !capability.enabled) {
      return {
        capability,
        result: {
          jobId: plan.planId,
          stepId: step.id,
          status: 'failed',
          outputs: [],
          error: capability ? 'capability_disabled:' + step.capability : 'capability_not_found:' + step.capability,
          retryable: false,
        },
      };
    }
    if (capability.permissions?.length && !capability.permissions.includes(request.user.role)) {
      const permission = {
        decision: 'deny' as const,
        reason: '能力角色白名单不允许该用户角色执行',
        matchedRule: 'capability.permissions',
        hardDenied: false,
        policyVersion: this.permissionPolicy.version,
      };
      return {
        permission,
        capability,
        result: {
          jobId: plan.planId,
          stepId: step.id,
          status: 'denied',
          outputs: [],
          diagnostics: { permission },
          error: permission.reason,
          retryable: false,
        },
      };
    }
    const argsNormalization = normalizeCapabilityArgs(capability.inputSchema, step.args);
    if (!argsNormalization.ok) {
      return {
        capability,
        result: {
          jobId: plan.planId,
          stepId: step.id,
          status: 'needs_input',
          outputs: [],
          diagnostics: { validationIssues: argsNormalization.issues },
          retryable: false,
        },
      };
    }
    const normalizedStep: IntentStep = { ...step, args: argsNormalization.args as Record<string, unknown> };
    const declaredRisk = capability.riskLevel || 'medium';
    const approvalRequired = Boolean(capability.approvalRequired || normalizedStep.approvalRequired);
    const effectiveRisk = approvalRequired && request.user.role !== 'owner' && (declaredRisk === 'low' || declaredRisk === 'medium')
      ? 'high'
      : declaredRisk;
    const permission = resolvePermission({
      capability: capability.id,
      provider: capability.provider,
      riskLevel: effectiveRisk,
      user: request.user,
      chat: request.chat,
      params: normalizedStep.args,
      estimatedCost: Number(normalizedStep.estimatedCost) || undefined,
    }, this.permissionPolicy);
    if (permission.decision === 'deny') {
      return {
        permission,
        capability,
        result: {
          jobId: plan.planId,
          stepId: step.id,
          status: 'denied',
          outputs: [],
          diagnostics: { permission },
          error: permission.reason,
          retryable: false,
        },
      };
    }
    if (permission.decision === 'ask_admin' && !options.approvalGranted) {
      return {
        permission,
        capability,
        result: {
          jobId: plan.planId,
          stepId: step.id,
          status: 'waiting_approval',
          outputs: [],
          diagnostics: { permission },
          retryable: false,
        },
      };
    }
    if (!this.handlers.has(capability.id)) {
      return {
        permission,
        capability,
        result: {
          jobId: plan.planId,
          stepId: step.id,
          status: 'failed',
          outputs: [],
          diagnostics: { permission },
          error: 'capability_handler_missing:' + capability.id,
          retryable: false,
        },
      };
    }
    return { permission, capability, normalizedStep, validationWarnings: argsNormalization.warnings };
  }
  async dispatch(
    request: UserRequest,
    plan: IntentPlan,
    step: IntentStep,
    dependencyResults: Record<string, ExecutionResult> = {},
    options: { approvalGranted?: boolean; signal?: AbortSignal; reportExternalTask?: (taskId: string) => void } = {},
  ): Promise<DispatchResult> {
    const authorization = this.authorize(request, plan, step, options);
    if (authorization.result) {
      return {
        result: authorization.result,
        permission: authorization.permission,
        capability: authorization.capability,
      };
    }
    const effectiveStep = authorization.normalizedStep || step;
    const handler = this.handlers.get(String(effectiveStep.capability));
    if (!handler) {
      return {
        permission: authorization.permission,
        capability: authorization.capability,
        result: {
          jobId: plan.planId,
          stepId: step.id,
          status: 'failed',
          outputs: [],
          diagnostics: { permission: authorization.permission },
          error: 'capability_handler_missing:' + step.capability,
          retryable: false,
        },
      };
    }
    // T1.1：执行前渲染依赖输出引用（{{steps.<id>.outputs[n].text|url}}）；
    // 引用缺失（含引用了不存在/无输出的步骤）按 needs_input 返回结构化事实（模型修复轮/追问），
    // 不执行 handler、不消耗限流额度。无引用的 args 原样通过，零开销。
    let stepForExecution = effectiveStep;
    {
      const rendered = renderStepReferences(effectiveStep.args, dependencyResults || {});
      if (rendered.missing.length) {
        return {
          permission: authorization.permission,
          capability: authorization.capability,
          result: {
            jobId: plan.planId,
            stepId: step.id,
            status: 'needs_input',
            outputs: [],
            diagnostics: { validationIssues: [{ code: 'missing_step_reference', refs: rendered.missing }] },
            retryable: false,
          },
        };
      }
      stepForExecution = { ...effectiveStep, args: rendered.value as Record<string, unknown> };
    }
    // T0.2：执行前统一过限流闸（冷却/日限额/并发）；限流触发按确定性失败处理，
    // 不重试（静默降级原则：上层 partial + problem 上报，用户侧不刷提示）。
    let releaseGate: (() => void) | undefined;
    if (this.rateGate) {
      try {
        releaseGate = await this.rateGate.acquire({
          featureId: authorization.capability!.id,
          chatType: request.chat.type,
          groupId: request.chat.groupId,
          userId: request.user.qq,
        });
      } catch (error) {
        return {
          permission: authorization.permission,
          capability: authorization.capability,
          result: {
            jobId: plan.planId,
            stepId: step.id,
            status: 'failed',
            outputs: [],
            diagnostics: { rateLimited: true, reason: String((error as Error)?.message || error) },
            error: 'feature_rate_limited:' + authorization.capability!.id,
            retryable: false,
          },
        };
      }
    }
    try {
      const result = await handler.execute({ request, plan, step: stepForExecution, dependencyResults, validationWarnings: authorization.validationWarnings, signal: options.signal, reportExternalTask: options.reportExternalTask });
      return {
        permission: authorization.permission,
        capability: authorization.capability,
        result: {
          ...result,
          jobId: result.jobId || plan.planId,
          stepId: result.stepId || effectiveStep.id,
          diagnostics: {
            ...(result.diagnostics || {}),
            ...(authorization.validationWarnings?.length ? { validationWarnings: authorization.validationWarnings } : {}),
          },
        },
      };
    } catch (error) {
      return {
        permission: authorization.permission,
        capability: authorization.capability,
        result: {
          jobId: plan.planId,
          stepId: step.id,
          status: 'failed',
          outputs: [],
          diagnostics: { permission: authorization.permission },
          error: String((error as Error)?.message || error),
          retryable: true,
        },
      };
    } finally {
      releaseGate?.();
    }
  }
}