export type FeatureCategory = 'basic' | 'image' | 'file' | 'video' | 'template' | 'system';
export type FeatureScope = 'private' | 'group';
export type FeatureGroupActivation = 'direct' | 'mention' | 'reply' | 'mention-or-reply';
export type FeatureLegacyCommand =
  | 'help'
  | 'clear'
  | 'originalImage'
  | 'templateLibrary'
  | 'referencedTemplateImage'
  | 'remotePromptSearch'
  | 'remotePromptSmartImage'
  | 'genImage'
  | 'editImage'
  | 'img2Img'
  | 'interrogate';

export type FeatureIntentKind =
  | 'chat'
  | 'image.generate'
  | 'image.edit'
  | 'image.interrogate'
  | 'video.generate';

export interface FeatureDefinition {
  id: string;
  label: string;
  description?: string;
  category: FeatureCategory;
  implemented: boolean;
  /** Legacy BotRouter command name. Undefined means natural-language only until a handler exists. */
  legacyCommand?: FeatureLegacyCommand;
  /** Planner intent exposed by this feature. Undefined means command-only. */
  intentKind?: FeatureIntentKind;
  defaultAliases: string[];
  defaultScopes: FeatureScope[];
  defaultGroupActivation: FeatureGroupActivation;
}

export interface FeatureSetting {
  enabled: boolean;
  aliases: string[];
  scopes: FeatureScope[];
  groupActivation: FeatureGroupActivation;
  naturalLanguage: boolean;
}

export type FeatureSettings = Record<string, FeatureSetting>;

const BOTH: FeatureScope[] = ['private', 'group'];

export const FEATURE_DEFINITIONS: FeatureDefinition[] = [
  {
    id: 'help', label: '帮助', category: 'basic', implemented: true,
    legacyCommand: 'help', defaultAliases: ['/help', 'help', '帮助', '使用方法'],
    defaultScopes: BOTH, defaultGroupActivation: 'direct',
  },
  {
    id: 'clear', label: '新对话', category: 'basic', implemented: true,
    legacyCommand: 'clear', defaultAliases: ['/clear', '新对话', '清除对话', '清空对话', 'clear'],
    defaultScopes: BOTH, defaultGroupActivation: 'direct',
  },
  {
    id: 'image.generate', label: '文生图', category: 'image', implemented: true,
    legacyCommand: 'genImage', intentKind: 'image.generate',
    defaultAliases: ['生图', '画', 'draw'],
    defaultScopes: BOTH, defaultGroupActivation: 'mention-or-reply',
  },
  {
    id: 'image.edit', label: '改图', category: 'image', implemented: true,
    legacyCommand: 'editImage', intentKind: 'image.edit',
    defaultAliases: ['改图', '编辑', 'edit'],
    defaultScopes: BOTH, defaultGroupActivation: 'direct',
  },
  {
    id: 'image.img2img', label: '图生图', category: 'image', implemented: true,
    legacyCommand: 'img2Img', intentKind: 'image.edit',
    defaultAliases: ['图生图', '参考图', '垫图', 'i2i'],
    defaultScopes: BOTH, defaultGroupActivation: 'direct',
  },
  {
    id: 'image.interrogate', label: '图片反推', category: 'image', implemented: true,
    legacyCommand: 'interrogate', intentKind: 'image.interrogate',
    defaultAliases: ['反推', '看图', '描述', 'prompt'],
    defaultScopes: BOTH, defaultGroupActivation: 'mention-or-reply',
  },
  {
    id: 'image.original', label: '原图', category: 'image', implemented: false,
    legacyCommand: 'originalImage',
    defaultAliases: ['原图', 'original', 'rawpic'],
    defaultScopes: BOTH, defaultGroupActivation: 'direct',
  },
  {
    id: 'template.library', label: '本地模板库', category: 'template', implemented: true,
    legacyCommand: 'templateLibrary',
    defaultAliases: ['本地模板库', '本地模板', '模板库', '模板', 'mb'],
    defaultScopes: BOTH, defaultGroupActivation: 'direct',
  },
  {
    id: 'template.referenced', label: '引用模板生图', category: 'template', implemented: false,
    legacyCommand: 'referencedTemplateImage',
    defaultAliases: ['套模板', '引用模板生图', '模板填充生图', 'rt'],
    defaultScopes: BOTH, defaultGroupActivation: 'direct',
  },
  {
    id: 'template.remoteSearch', label: '远程模板库', category: 'template', implemented: false,
    legacyCommand: 'remotePromptSearch',
    defaultAliases: ['pp', '远程模板库', '远程模板'],
    defaultScopes: BOTH, defaultGroupActivation: 'direct',
  },
  {
    id: 'template.remoteSmartImage', label: '远程模板生图', category: 'template', implemented: false,
    legacyCommand: 'remotePromptSmartImage',
    defaultAliases: ['spp', '远程模板生图', '智能远程模板'],
    defaultScopes: BOTH, defaultGroupActivation: 'direct',
  },
  {
    id: 'video.generate', label: '视频生成', category: 'video', implemented: true,
    intentKind: 'video.generate', defaultAliases: [],
    defaultScopes: BOTH, defaultGroupActivation: 'mention-or-reply',
  },
  {
    id: 'file.list', label: '文件列表', category: 'file', implemented: false,
    defaultAliases: ['文件列表', '最近文件'],
    defaultScopes: BOTH, defaultGroupActivation: 'mention-or-reply',
  },
  {
    id: 'file.read', label: '读取文件', category: 'file', implemented: false,
    defaultAliases: ['读取文件', '分析文件'],
    defaultScopes: BOTH, defaultGroupActivation: 'mention-or-reply',
  },
  {
    id: 'file.generate', label: '生成文件', category: 'file', implemented: false,
    defaultAliases: ['生成文件', '生成文档'],
    defaultScopes: BOTH, defaultGroupActivation: 'mention-or-reply',
  },
];

export function parseFeatureAliases(raw: unknown): string[] {
  const items = Array.isArray(raw) ? raw : String(raw || '').split(/[,，、;；|\n]/);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const alias = String(item || '').replace(/\s+/g, ' ').trim();
    if (!alias) continue;
    const key = alias.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(alias);
  }
  return out.sort((a, b) => b.length - a.length);
}

export function defaultFeatureSettings(): FeatureSettings {
  const out: FeatureSettings = {};
  for (const def of FEATURE_DEFINITIONS) {
    out[def.id] = {
      enabled: def.implemented,
      aliases: parseFeatureAliases(def.defaultAliases),
      scopes: [...def.defaultScopes],
      groupActivation: def.defaultGroupActivation,
      naturalLanguage: Boolean(def.implemented && def.intentKind),
    };
  }
  return out;
}

function normalizeScopes(raw: unknown, fallback: FeatureScope[]): FeatureScope[] {
  const items = Array.isArray(raw) ? raw : fallback;
  const out = items.map((item) => String(item).toLowerCase()).filter((item): item is FeatureScope => item === 'private' || item === 'group');
  return Array.from(new Set(out)).length ? Array.from(new Set(out)) : [...fallback];
}

function normalizeActivation(raw: unknown, fallback: FeatureGroupActivation): FeatureGroupActivation {
  const value = String(raw || '').trim();
  return value === 'direct' || value === 'mention' || value === 'reply' || value === 'mention-or-reply'
    ? value
    : fallback;
}

export function normalizeFeatureSettings(
  input: unknown,
  legacyCommands?: Record<string, unknown>,
): FeatureSettings {
  const outgoing = defaultFeatureSettings();
  const source = input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : undefined;

  for (const def of FEATURE_DEFINITIONS) {
    const raw = source && source[def.id] && typeof source[def.id] === 'object'
      ? source[def.id] as Record<string, unknown>
      : undefined;
    const setting = outgoing[def.id];
    if (!setting) continue;
    if (!def.implemented) {
      setting.enabled = false;
    } else if (raw && raw.enabled !== undefined) {
      setting.enabled = Boolean(raw.enabled);
    }
    if (raw && raw.aliases !== undefined) setting.aliases = parseFeatureAliases(raw.aliases);
    if (raw && raw.scopes !== undefined) setting.scopes = normalizeScopes(raw.scopes, def.defaultScopes);
    if (raw && raw.groupActivation !== undefined) setting.groupActivation = normalizeActivation(raw.groupActivation, def.defaultGroupActivation);
    if (raw && raw.naturalLanguage !== undefined) setting.naturalLanguage = Boolean(raw.naturalLanguage) && Boolean(def.intentKind);
  }

  // First install / old config: inherit the legacy command aliases.
  if (!source && legacyCommands && typeof legacyCommands === 'object') {
    for (const def of FEATURE_DEFINITIONS) {
      if (!def.legacyCommand) continue;
      const legacy = (legacyCommands as Record<string, unknown>)[def.legacyCommand];
      if (legacy === undefined) continue;
      const aliases = parseFeatureAliases(legacy);
      if (aliases.length) outgoing[def.id]!.aliases = aliases;
    }
  }

  return outgoing;
}

/** Returns human-readable alias collisions between enabled features. */
export function featureAliasCollisions(settings: FeatureSettings): Array<{ alias: string; featureIds: string[] }> {
  const owners = new Map<string, string[]>();
  for (const def of FEATURE_DEFINITIONS) {
    const setting = settings[def.id];
    if (!setting?.enabled) continue;
    for (const alias of setting.aliases) {
      const key = alias.toLowerCase();
      const list = owners.get(key) || [];
      list.push(def.id);
      owners.set(key, list);
    }
  }
  return Array.from(owners.entries())
    .filter(([, ids]) => ids.length > 1)
    .map(([alias, featureIds]) => ({ alias, featureIds }));
}