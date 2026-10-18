export type FeatureCategory = 'basic' | 'image' | 'file' | 'video' | 'template' | 'web' | 'render' | 'system';
export type FeatureScope = 'private' | 'group';
export type FeatureGroupActivation = 'direct' | 'mention' | 'reply' | 'mention-or-reply';
export interface FeatureLimitField {
  key: string;
  label: string;
  min: number;
  max: number;
  default: number;
  unit?: string;
}

export type FeatureLimits = Record<string, number>;

export const COMMON_FEATURE_LIMIT_FIELDS: FeatureLimitField[] = [
  { key: 'cooldownSec', label: '冷却时间', min: 0, max: 3600, default: 0, unit: '秒' },
  { key: 'userDailyLimit', label: '用户每日上限', min: 0, max: 10000, default: 0, unit: '次（0=不限）' },
  { key: 'groupDailyLimit', label: '群每日上限', min: 0, max: 10000, default: 0, unit: '次（0=不限）' },
  { key: 'maxPromptChars', label: '最大输入字符', min: 0, max: 50000, default: 0, unit: '字符（0=不限）' },
  { key: 'sendDelayMs', label: '发送延迟', min: 0, max: 30000, default: 0, unit: '毫秒' },
  { key: 'concurrency', label: '并发上限', min: 0, max: 16, default: 0, unit: '0=不限' },
];

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
  | 'interrogate'
  | 'fileList'
  | 'fileRead'
  | 'fileGenerate'
  | 'webSearch'
  | 'codeRender'
  | 'webScreenshot';

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
  /** 是否默认允许自然语言意图模型路由到该功能；命令-only 的功能也可开启。 */
  defaultNaturalLanguage?: boolean;
  defaultAliases: string[];
  defaultScopes: FeatureScope[];
  defaultGroupActivation: FeatureGroupActivation;
  /** 功能专属限额字段；公共字段见 COMMON_FEATURE_LIMIT_FIELDS。 */
  limitFields?: FeatureLimitField[];
  defaultLimits?: FeatureLimits;
}

export interface FeatureSetting {
  enabled: boolean;
  aliases: string[];
  scopes: FeatureScope[];
  groupActivation: FeatureGroupActivation;
  naturalLanguage: boolean;
  limits: FeatureLimits;
}

export type FeatureSettings = Record<string, FeatureSetting>;

const BOTH: FeatureScope[] = ['private', 'group'];

export const FEATURE_DEFINITIONS: FeatureDefinition[] = [
  {
    id: 'help', label: '帮助', category: 'basic', implemented: true, defaultNaturalLanguage: true,
    legacyCommand: 'help', defaultAliases: ['/help', 'help', '帮助', '使用方法'],
    defaultScopes: BOTH, defaultGroupActivation: 'direct',
  },
  {
    id: 'clear', label: '新对话', category: 'basic', implemented: true, defaultNaturalLanguage: true,
    legacyCommand: 'clear', defaultAliases: ['/clear', '新对话', '清除对话', '清空对话', 'clear'],
    defaultScopes: BOTH, defaultGroupActivation: 'direct',
  },
  {
    id: 'image.generate', label: '文生图', category: 'image', implemented: true,
    description: '自然语言生图；支持 ComfyUI 或其它图像模型，MOSS-Image / Krea 2 会自动使用对应的提示词策略，参数由后台转化模型处理，多图默认拼接成一张。',
    legacyCommand: 'genImage', intentKind: 'image.generate',
    defaultAliases: ['生图', '画', 'draw'],
    defaultScopes: BOTH, defaultGroupActivation: 'mention-or-reply',
    limitFields: [{ key: 'maxCount', label: '最大生成张数', min: 1, max: 4, default: 4, unit: '张' }],
    defaultLimits: { maxCount: 4 },
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
    id: 'template.library', label: '本地模板库', category: 'template', implemented: true, defaultNaturalLanguage: true,
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
    id: 'file.list', label: '文件列表', category: 'file', implemented: true, defaultNaturalLanguage: true,
    legacyCommand: 'fileList', defaultAliases: ['文件列表', '最近文件'],
    defaultScopes: BOTH, defaultGroupActivation: 'mention-or-reply',
  },
  {
    id: 'file.read', label: '读取文件', category: 'file', implemented: true, defaultNaturalLanguage: true,
    legacyCommand: 'fileRead', defaultAliases: ['读取文件', '分析文件'],
    defaultScopes: BOTH, defaultGroupActivation: 'mention-or-reply',
  },
  {
    id: 'file.generate', label: '生成文件', category: 'file', implemented: true, defaultNaturalLanguage: true,
    legacyCommand: 'fileGenerate', defaultAliases: ['生成文件', '生成文档', '导出文件'],
    defaultScopes: BOTH, defaultGroupActivation: 'mention-or-reply',
  },
  {
    id: 'search.web', label: '联网搜索', category: 'web', implemented: true, defaultNaturalLanguage: true,
    legacyCommand: 'webSearch', defaultAliases: ['搜索', '联网搜索', '查一下', '搜一下', 'websearch'],
    defaultScopes: BOTH, defaultGroupActivation: 'mention-or-reply',
  },
  {
    id: 'code.render', label: '代码画图', category: 'render', implemented: true,
    legacyCommand: 'codeRender', defaultNaturalLanguage: true,
    defaultAliases: ['代码画图', 'HTML画图', 'SVG画图', 'Canvas画图', 'Three画图', 'codeart'],
    defaultScopes: BOTH, defaultGroupActivation: 'mention-or-reply',
  },
  {
    id: 'web.screenshot', label: '网页截屏', category: 'render', implemented: true,
    legacyCommand: 'webScreenshot', defaultNaturalLanguage: true,
    defaultAliases: ['网页截屏', '网页截图', '截屏', '截图网页', 'screenshot'],
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

export function featureLimitFields(def: FeatureDefinition): FeatureLimitField[] {
  return [...COMMON_FEATURE_LIMIT_FIELDS, ...(def.limitFields || [])];
}

function normalizeFeatureLimits(def: FeatureDefinition, raw: unknown): FeatureLimits {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const out: FeatureLimits = {};
  for (const field of featureLimitFields(def)) {
    const fallback = def.defaultLimits?.[field.key] ?? field.default;
    const n = Number(source[field.key] ?? fallback);
    out[field.key] = Number.isFinite(n) ? Math.min(field.max, Math.max(field.min, Math.trunc(n))) : fallback;
  }
  return out;
}

export function defaultFeatureSettings(): FeatureSettings {
  const out: FeatureSettings = {};
  for (const def of FEATURE_DEFINITIONS) {
    out[def.id] = {
      enabled: def.implemented,
      aliases: parseFeatureAliases(def.defaultAliases),
      scopes: [...def.defaultScopes],
      groupActivation: def.defaultGroupActivation,
      naturalLanguage: Boolean(def.implemented && (def.intentKind || def.defaultNaturalLanguage)),
      limits: normalizeFeatureLimits(def, undefined),
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
    if (raw && raw.naturalLanguage !== undefined) setting.naturalLanguage = Boolean(raw.naturalLanguage) && Boolean(def.intentKind || def.defaultNaturalLanguage);
    setting.limits = normalizeFeatureLimits(def, raw?.limits);
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