import { ToolRuntimeError } from './tool-errors.js';
import { resolveToolLoadout, type ToolLoadoutRequest, type ToolLoadoutResult } from './tool-loadout.js';
import { normalizeToolSpec, type ToolSpec } from './tool-spec.js';

export interface ToolRegistryListOptions {
  enabledOnly?: boolean;
  exposure?: ToolSpec['exposure'][];
}

/**
 * In-memory source of truth for V2 tool contracts. Persistence and admin
 * exposure metadata are layered on in later phases; the registry API is stable.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, ToolSpec>();
  private readonly order: string[] = [];

  register(spec: ToolSpec): ToolSpec {
    const normalized = normalizeToolSpec(spec);
    if (this.tools.has(normalized.name)) {
      throw new ToolRuntimeError({
        code: 'invalid_envelope',
        message: `Duplicate tool registration: ${normalized.name}`,
        toolName: normalized.name,
        path: '$.name',
      });
    }
    this.tools.set(normalized.name, normalized);
    this.order.push(normalized.name);
    return normalized;
  }

  /** Validate the complete batch before replacing, so bad input cannot half-apply. */
  replaceAll(specs: ToolSpec[]): void {
    const next = new Map<string, ToolSpec>();
    const nextOrder: string[] = [];
    for (const input of specs) {
      const spec = normalizeToolSpec(input);
      if (next.has(spec.name)) {
        throw new ToolRuntimeError({
          code: 'invalid_envelope',
          message: `Duplicate tool registration: ${spec.name}`,
          toolName: spec.name,
          path: '$.name',
        });
      }
      next.set(spec.name, spec);
      nextOrder.push(spec.name);
    }
    this.tools.clear();
    this.order.splice(0, this.order.length, ...nextOrder);
    for (const [name, spec] of next) this.tools.set(name, spec);
  }

  unregister(name: string): boolean {
    const removed = this.tools.delete(String(name));
    if (removed) {
      const index = this.order.indexOf(String(name));
      if (index >= 0) this.order.splice(index, 1);
    }
    return removed;
  }

  get(name: string): ToolSpec | undefined {
    return this.tools.get(String(name));
  }

  require(name: string): ToolSpec {
    const spec = this.get(name);
    if (!spec) {
      throw new ToolRuntimeError({ code: 'unknown_tool', message: `Unknown tool: ${name}`, toolName: String(name) });
    }
    return spec;
  }

  setEnabled(name: string, enabled: boolean): ToolSpec {
    const current = this.require(name);
    const next = normalizeToolSpec({ ...current, enabled: Boolean(enabled) });
    this.tools.set(next.name, next);
    return next;
  }

  list(options: ToolRegistryListOptions = {}): ToolSpec[] {
    const exposure = options.exposure ? new Set(options.exposure) : undefined;
    return this.order
      .map((name) => this.tools.get(name))
      .filter((spec): spec is ToolSpec => Boolean(spec))
      .filter((spec) => !options.enabledOnly || spec.enabled !== false)
      .filter((spec) => !exposure || exposure.has(spec.exposure || 'domain'));
  }

  resolveLoadout(request: ToolLoadoutRequest = {}): ToolLoadoutResult {
    return resolveToolLoadout(this.list({ enabledOnly: true }), request);
  }

  snapshot(): ToolSpec[] {
    return this.list().map((spec) => structuredClone(spec));
  }
}

export function createToolRegistry(specs: ToolSpec[] = []): ToolRegistry {
  const registry = new ToolRegistry();
  registry.replaceAll(specs);
  return registry;
}
