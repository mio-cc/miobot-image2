import type { CapabilityDescriptor } from './types.js';

export class CapabilityRegistry {
  private readonly capabilities = new Map<string, CapabilityDescriptor>();

  replaceAll(descriptors: CapabilityDescriptor[]): void {
    this.capabilities.clear();
    for (const descriptor of descriptors) this.register(descriptor);
  }

  register(descriptor: CapabilityDescriptor): void {
    const id = String(descriptor.id || '').trim();
    if (!id) throw new Error('capability_id_required');
    if (this.capabilities.has(id)) throw new Error(`capability_duplicate:${id}`);
    this.capabilities.set(id, {
      ...descriptor,
      id,
      version: String(descriptor.version || '0.0.0'),
      enabled: descriptor.enabled !== false,
      aliases: Array.from(new Set((descriptor.aliases || []).map(String).filter(Boolean))),
    });
  }

  unregister(id: string): boolean {
    return this.capabilities.delete(String(id));
  }

  get(id: string): CapabilityDescriptor | undefined {
    return this.capabilities.get(String(id));
  }

  list(options: { enabledOnly?: boolean } = {}): CapabilityDescriptor[] {
    const all = Array.from(this.capabilities.values());
    return options.enabledOnly ? all.filter((item) => item.enabled) : all;
  }

  setEnabled(id: string, enabled: boolean): CapabilityDescriptor {
    const current = this.capabilities.get(String(id));
    if (!current) throw new Error(`capability_not_found:${id}`);
    const next = { ...current, enabled: Boolean(enabled) };
    this.capabilities.set(next.id, next);
    return next;
  }

  snapshot(): CapabilityDescriptor[] {
    return this.list().map((item) => ({
      ...item,
      aliases: item.aliases ? [...item.aliases] : [],
      inputSchema: item.inputSchema ? { ...item.inputSchema } : undefined,
      outputSchema: item.outputSchema ? { ...item.outputSchema } : undefined,
      outputKinds: item.outputKinds ? [...item.outputKinds] : undefined,
    }));
  }
}
