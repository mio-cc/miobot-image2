import type { IntentPlan } from './types.js';

export interface CommandPlanInput {
  requestId: string;
  command: string;
  args?: string;
  commandText?: string;
}

interface CommandMapping {
  capability: string;
  argKey?: string;
  mapArgs?: (raw: string) => Record<string, unknown>;
}

const COMMAND_CAPABILITIES: Record<string, CommandMapping> = {
  genImage: { capability: 'image.generate', argKey: 'prompt' },
  img2Img: { capability: 'image.edit', argKey: 'prompt' },
  editImage: { capability: 'image.edit', argKey: 'prompt' },
  interrogate: { capability: 'image.interrogate', argKey: 'prompt' },
  fileList: { capability: 'file.list' },
  fileRead: { capability: 'file.read', argKey: 'file' },
  fileGenerate: { capability: 'file.generate', argKey: 'prompt' },
  webSearch: { capability: 'web.search', argKey: 'query' },
  codeRender: { capability: 'code.render', argKey: 'prompt' },
  webScreenshot: { capability: 'browser.render', argKey: 'url' },
  templateLibrary: { capability: 'template.list' },
  help: { capability: 'help' },
  clear: { capability: 'session.clear' },
  ownerRecall: {
    capability: 'owner.recall',
    mapArgs: (raw) => ({ count: Math.max(1, Math.min(50, Number.parseInt(raw, 10) || 1)) }),
  },  ownerModelList: { capability: 'owner.model.list' },
  ownerSwitchModel: {
    capability: 'config.update',
    mapArgs: (raw) => ({ ownerAction: 'switchModel', code: raw }),
  },
  ownerTtsOn: { capability: 'config.update', mapArgs: () => ({ ownerAction: 'ttsOn' }) },
  ownerTtsOff: { capability: 'config.update', mapArgs: () => ({ ownerAction: 'ttsOff' }) },
  ownerSwitchTtsVoice: {
    capability: 'config.update',
    mapArgs: (raw) => ({ ownerAction: 'switchTtsVoice', index: Math.max(1, Number.parseInt(raw, 10) || 1) }),
  },
  ownerBlacklist: {
    capability: 'permission.update',
    mapArgs: (raw) => ({ ownerAction: 'blacklist', targetUserId: raw }),
  },
  ownerWhitelist: {
    capability: 'permission.update',
    mapArgs: (raw) => ({ ownerAction: 'whitelist', targetUserId: raw }),
  },
};
export function listCommandMappings(): Array<{ command: string; capability: string }> {
  return Object.entries(COMMAND_CAPABILITIES).map(([command, mapping]) => ({ command, capability: mapping.capability }));
}

export function commandCapability(command: string): string | undefined {
  return COMMAND_CAPABILITIES[String(command || '')]?.capability;
}

export function buildCommandIntentPlan(input: CommandPlanInput): IntentPlan | null {
  const mapping = COMMAND_CAPABILITIES[String(input.command || '')];
  if (!mapping) return null;
  const raw = String(input.args || input.commandText || '').trim();
  const args: Record<string, unknown> = mapping.mapArgs
    ? mapping.mapArgs(raw)
    : (mapping.argKey && raw ? { [mapping.argKey]: raw } : {});
  return {
    planId: 'cmd_plan_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    requestId: input.requestId,
    goal: 'command:' + input.command,
    steps: [{ id: 'command_1', capability: mapping.capability, args }],
    budget: { maxSteps: 1 },
    needsClarification: false,
    confidence: 1,
    source: 'command',
  };
}