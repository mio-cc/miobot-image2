import type { AgentMessage } from './types.js';

export type PromptSectionStatus = 'draft' | 'canary' | 'active' | 'retired';
export type PromptSectionScope = 'global' | 'group' | 'user' | 'role';

export interface PromptSection {
  id: string;
  title: string;
  content: string;
  version: string;
  status: PromptSectionStatus;
  order: number;
  tokenLimit?: number;
  scope?: PromptSectionScope;
  createdAt?: string;
  updatedAt?: string;
}

export interface PromptBuildResult {
  sections: PromptSection[];
  content: string;
  estimatedTokens: number;
}

export class PromptRegistry {
  private readonly sections = new Map<string, PromptSection>();

  register(section: PromptSection): PromptSection {
    const id = String(section?.id || '').trim();
    if (!id) throw new Error('prompt_section_id_required');
    if (this.sections.has(id)) throw new Error(`prompt_section_duplicate:${id}`);
    const normalized: PromptSection = {
      ...section,
      id,
      title: String(section.title || id).trim() || id,
      content: String(section.content || '').slice(0, 200_000),
      version: String(section.version || '1').trim() || '1',
      status: (['draft', 'canary', 'active', 'retired'] as const).includes(section.status) ? section.status : 'draft',
      order: Number.isFinite(section.order) ? Math.trunc(section.order) : 0,
      tokenLimit: Number.isFinite(section.tokenLimit) ? Math.max(1, Math.trunc(section.tokenLimit as number)) : undefined,
      scope: section.scope || 'global',
    };
    this.sections.set(id, normalized);
    return structuredClone(normalized);
  }

  unregister(id: string): boolean {
    return this.sections.delete(String(id));
  }

  get(id: string): PromptSection | undefined {
    const section = this.sections.get(String(id));
    return section ? structuredClone(section) : undefined;
  }

  list(options: { status?: PromptSectionStatus[] } = {}): PromptSection[] {
    const status = options.status ? new Set(options.status) : undefined;
    return [...this.sections.values()]
      .filter((section) => !status || status.has(section.status))
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
      .map((section) => structuredClone(section));
  }

  build(options: { ids?: string[]; includeCanary?: boolean } = {}): PromptBuildResult {
    const requested = options.ids ? new Set(options.ids) : undefined;
    const sections = this.list({ status: options.includeCanary ? ['active', 'canary'] : ['active'] })
      .filter((section) => !requested || requested.has(section.id));
    const content = sections.map((section) => section.content).filter(Boolean).join('\n\n---\n\n');
    return { sections, content, estimatedTokens: estimateTokens(content) };
  }
}

export function buildSystemMessage(result: PromptBuildResult): AgentMessage | undefined {
  const content = String(result.content || '').trim();
  return content ? { role: 'system', content } : undefined;
}

export function estimateTokens(value: string): number {
  const text = String(value || '');
  if (!text) return 0;
  // Conservative multilingual estimate: CJK codepoints often tokenize near 1:1,
  // while ASCII prose averages ~4 chars/token.
  let cjk = 0;
  for (const char of text) if (/[\u3400-\u9fff\uf900-\ufaff]/u.test(char)) cjk += 1;
  return Math.ceil(cjk + (text.length - cjk) / 4);
}

export function createPromptRegistry(sections: PromptSection[] = []): PromptRegistry {
  const registry = new PromptRegistry();
  for (const section of sections) registry.register(section);
  return registry;
}
