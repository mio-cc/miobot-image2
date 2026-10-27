import { normalizeToolSpec, type ToolSpec } from '../../tool-runtime/src/index.js';

export const UPDATE_PLAN_TOOL_NAME = 'update_plan';

export const UPDATE_PLAN_TOOL_SPEC: ToolSpec = normalizeToolSpec({
  name: UPDATE_PLAN_TOOL_NAME,
  title: 'Update a complex task plan',
  description: 'Maintain a plan only for genuinely complex multi-step tasks. Do not use it for casual chat or single-step requests.',
  version: '1.0.0',
  provider: 'builtin',
  enabled: true,
  inputSchema: {
    type: 'object',
    properties: {
      goal: { type: 'string', minLength: 1, maxLength: 2000 },
      steps: {
        type: 'array',
        minItems: 1,
        maxItems: 50,
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', minLength: 1, maxLength: 100 },
            description: { type: 'string', minLength: 1, maxLength: 1000 },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'blocked'] },
          },
          required: ['id', 'description', 'status'],
          additionalProperties: false,
        },
      },
    },
    required: ['goal', 'steps'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: { goal: { type: 'string' }, steps: { type: 'array' } },
  },
  sideEffects: [],
  riskLevel: 'low',
  timeoutMs: 1000,
  maxRetries: 0,
  queue: 'default',
  outputKinds: ['text'],
  idempotency: 'none',
  exposure: 'core',
  requiredContext: [],
  metadata: { migrationStatus: 'native' },
});

export interface AgentPlanStep {
  id: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'blocked';
}

export interface AgentPlanUpdate {
  goal: string;
  steps: AgentPlanStep[];
}

export function createUpdatePlanToolCall(id: string, plan: AgentPlanUpdate): { id: string; name: string; arguments: Record<string, unknown> } {
  return {
    id,
    name: UPDATE_PLAN_TOOL_NAME,
    arguments: {
      goal: String(plan.goal || ''),
      steps: (plan.steps || []).slice(0, 50).map((step) => ({
        id: String(step.id || ''),
        description: String(step.description || ''),
        status: step.status,
      })),
    },
  };
}
