import { toolSchemaByteLength } from './tool-schema.js';
import type { ToolExposure, ToolRequiredContext, ToolSpec } from './tool-spec.js';

export interface ToolLoadoutRequest {
  /** Defaults to core + domain. Searchable tools must be explicitly requested. */
  exposures?: ToolExposure[];
  enabledToolNames?: string[];
  disabledToolNames?: string[];
  /** If provided, every required context on a tool must be present. */
  availableContext?: ToolRequiredContext[];
  maxTools?: number;
  maxSchemaBytes?: number;
  includeHidden?: boolean;
}

export interface ToolLoadoutResult {
  tools: ToolSpec[];
  omitted: Array<{ name: string; reason: 'disabled' | 'exposure' | 'context' | 'max_tools' | 'schema_budget' }>;
  schemaBytes: number;
}

const EXPOSURE_RANK: Record<ToolExposure, number> = {
  core: 0,
  domain: 1,
  searchable: 2,
  hidden: 3,
};

export function resolveToolLoadout(specs: ToolSpec[], request: ToolLoadoutRequest = {}): ToolLoadoutResult {
  const exposures = new Set<ToolExposure>(request.exposures || ['core', 'domain']);
  if (request.includeHidden) exposures.add('hidden');
  const enabled = request.enabledToolNames ? new Set(request.enabledToolNames) : undefined;
  const disabled = new Set(request.disabledToolNames || []);
  const context = request.availableContext ? new Set(request.availableContext) : undefined;
  const maxTools = request.maxTools && request.maxTools > 0 ? Math.max(1, Math.trunc(request.maxTools)) : Number.MAX_SAFE_INTEGER;
  const maxSchemaBytes = request.maxSchemaBytes && request.maxSchemaBytes > 0 ? Math.max(1, Math.trunc(request.maxSchemaBytes)) : Number.MAX_SAFE_INTEGER;
  const omitted: ToolLoadoutResult['omitted'] = [];
  const candidates: ToolSpec[] = [];
  for (const spec of specs) {
    if (spec.enabled === false || disabled.has(spec.name) || (enabled && !enabled.has(spec.name))) {
      omitted.push({ name: spec.name, reason: 'disabled' });
      continue;
    }
    const exposure = spec.exposure || 'domain';
    if (!exposures.has(exposure)) {
      omitted.push({ name: spec.name, reason: 'exposure' });
      continue;
    }
    if ((spec.requiredContext || []).some((required) => !context?.has(required))) {
      omitted.push({ name: spec.name, reason: 'context' });
      continue;
    }
    candidates.push(spec);
  }
  candidates.sort((a, b) => {
    const rank = EXPOSURE_RANK[a.exposure || 'domain'] - EXPOSURE_RANK[b.exposure || 'domain'];
    return rank !== 0 ? rank : a.name.localeCompare(b.name);
  });
  const tools: ToolSpec[] = [];
  let schemaBytes = 0;
  for (const spec of candidates) {
    if (tools.length >= maxTools) {
      omitted.push({ name: spec.name, reason: 'max_tools' });
      continue;
    }
    const bytes = toolSchemaByteLength({ inputSchema: spec.inputSchema, outputSchema: spec.outputSchema });
    if (schemaBytes + bytes > maxSchemaBytes) {
      omitted.push({ name: spec.name, reason: 'schema_budget' });
      continue;
    }
    tools.push(spec);
    schemaBytes += bytes;
  }
  return { tools, omitted, schemaBytes };
}
