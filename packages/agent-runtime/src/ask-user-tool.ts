import { normalizeToolSpec, type ToolSpec } from '../../tool-runtime/src/index.js';

export const ASK_USER_TOOL_NAME = 'ask_user';

export const ASK_USER_TOOL_SPEC: ToolSpec = normalizeToolSpec({
  name: ASK_USER_TOOL_NAME,
  title: 'Ask the user one concrete question',
  description: 'Ask only when a concrete task is missing a required argument or a small set of concrete options must be chosen. Never ask the user to choose a capability or enumerate tools.',
  version: '1.0.0',
  provider: 'builtin',
  enabled: true,
  inputSchema: {
    type: 'object',
    properties: {
      question: { type: 'string', minLength: 1, maxLength: 1000 },
      missingFields: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 10 },
      options: { type: 'array', items: { type: 'string' }, maxItems: 10 },
    },
    required: ['question', 'missingFields'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: { question: { type: 'string' }, missingFields: { type: 'array' }, options: { type: 'array' } },
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

export function createAskUserToolCall(id: string, question: string, missingFields: string[], options?: string[]): { id: string; name: string; arguments: Record<string, unknown> } {
  return {
    id,
    name: ASK_USER_TOOL_NAME,
    arguments: {
      question: String(question || ''),
      missingFields: missingFields.map(String).filter(Boolean),
      ...(options?.length ? { options: options.map(String).filter(Boolean).slice(0, 10) } : {}),
    },
  };
}
