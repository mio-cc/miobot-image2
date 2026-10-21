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
import { normalizeCapabilityArgs, validationQuestion, type ArgsNormalizationWarning } from './validation.js';

export interface CapabilityInvocation {
  request: UserRequest;
  plan: IntentPlan;
  step: IntentStep;
  dependencyResults: Record<string, ExecutionResult>;
  validationWarnings?: ArgsNormalizationWarning[];
  /** 步骤级取消信号；支持长任务的 handler 应在副作用结束后检查或监听 abort。 */
  signal?: AbortSignal;
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

export class CapabilityDispatcher {
  private readonly handlers = new Map<string, CapabilityHandler>();

  constructor(
    private readonly registry: CapabilityRegistry,
    private readonly permissionPolicy: PermissionPolicy,
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
          diagnostics: { validationIssues: argsNormalization.issues, question: validationQuestion(argsNormalization.issues) },
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
    options: { approvalGranted?: boolean; signal?: AbortSignal } = {},
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
    try {
      const result = await handler.execute({ request, plan, step: effectiveStep, dependencyResults, validationWarnings: authorization.validationWarnings, signal: options.signal });
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
    }
  }
}