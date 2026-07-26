import { createCapabilityRegistry, describeLearned, healingKey, type ModelOperation } from '../../model/src/index.js';

/**
 * 能力体检：逐项检查「这项能力配的模型能不能干这活」。
 *
 * 用户在真正发消息之前就能看到问题，而不是等群里收到一句看不懂的 400。
 * 判定链是：用户覆盖（llm.capabilityOverrides）→ 按模型 ID 推断的档案。
 */

export interface CapabilityBinding {
  key: string;
  label: string;
  /** 触发方式，展示用。 */
  trigger: string;
  operation: ModelOperation;
  nodeIndex: number;
  nodeName: string;
  model: string;
  enabled: boolean;
  /** 该「节点+模型」解析出的全部能力。 */
  operations: ModelOperation[];
  /** 能力来自用户覆盖还是自动推断。 */
  source: 'override' | 'inferred';
  ok: boolean;
  reason?: string;
  /** 运行期参数自愈学到的东西，用于排障展示。 */
  learned?: { dropped: string[]; renamed: Record<string, string> };
}

export const OPERATION_LABELS: Record<string, string> = {
  chat: '对话',
  vision: '视觉',
  interrogate: '反推',
  'image.generate': '生图',
  'image.edit': '改图',
  'video.generate': '视频',
};

interface BindingSpec {
  key: string;
  label: string;
  trigger: string;
  operation: ModelOperation;
  nodePath: string;
  modelPath: string;
  enabledPath?: string;
  /** enabled 取反（例如没有开关就恒为 true）。 */
  alwaysEnabled?: boolean;
}

const SPECS: BindingSpec[] = [
  { key: 'chat', label: '日常对话', trigger: '@bot / 私聊', operation: 'chat', nodePath: 'llm.chatNodeIndex', modelPath: 'llm.chatModel', enabledPath: 'llm.chatEnabled' },
  { key: 'image', label: '文生图', trigger: '画 / 生图 / draw', operation: 'image.generate', nodePath: 'llm.imageNodeIndex', modelPath: 'llm.imageModel', enabledPath: 'llm.imageEnabled' },
  { key: 'edit', label: '改图 / 图生图', trigger: '改图 / i2i', operation: 'image.edit', nodePath: 'llm.editNodeIndex', modelPath: 'llm.editModel', alwaysEnabled: true },
  { key: 'video', label: '视频生成', trigger: '视频 / video', operation: 'video.generate', nodePath: 'llm.videoNodeIndex', modelPath: 'llm.videoModel', enabledPath: 'llm.videoEnabled' },
  { key: 'interrogate', label: '图片反推', trigger: '反推 / 看图', operation: 'interrogate', nodePath: 'llm.interrogateNodeIndex', modelPath: 'llm.interrogateModel', alwaysEnabled: true },
  { key: 'enhance', label: '提示词润色', trigger: '画 润色 …', operation: 'chat', nodePath: 'llm.enhanceNodeIndex', modelPath: 'llm.enhanceModel', enabledPath: 'llm.enhanceEnabled' },
  { key: 'template', label: '本地模板填充', trigger: 'mb_1!', operation: 'chat', nodePath: 'llm.templateNodeIndex', modelPath: 'llm.templateModel', alwaysEnabled: true },
  { key: 'referencedTemplate', label: '引用模板填充', trigger: '套模板 / rt', operation: 'chat', nodePath: 'llm.referencedTemplateNodeIndex', modelPath: 'llm.referencedTemplateModel', alwaysEnabled: true },
  { key: 'templateConvert', label: 'AI 转模板', trigger: '后台模板库', operation: 'chat', nodePath: 'llm.templateConvertNodeIndex', modelPath: 'llm.templateConvertModel', alwaysEnabled: true },
  { key: 'translation', label: '远程库翻译', trigger: 'pp / spp', operation: 'chat', nodePath: 'llm.translationNodeIndex', modelPath: 'llm.translationModel', alwaysEnabled: true },
  { key: 'freeMode', label: '自由模式规划', trigger: '@bot 直接说话', operation: 'chat', nodePath: 'freeMode.nodeIndex', modelPath: 'freeMode.model', enabledPath: 'freeMode.enabled' },
  { key: 'promptsChat', label: '远程库智能选模板', trigger: 'spp', operation: 'chat', nodePath: 'promptsChat.smartNodeIndex', modelPath: 'promptsChat.smartModel', enabledPath: 'promptsChat.enabled' },
  { key: 'canvasImage', label: '画布文生图', trigger: '画布前台', operation: 'image.generate', nodePath: 'canvas.imageNodeIndex', modelPath: 'canvas.imageModel', enabledPath: 'canvas.enabled' },
  { key: 'canvasEdit', label: '画布改图', trigger: '画布前台', operation: 'image.edit', nodePath: 'canvas.editNodeIndex', modelPath: 'canvas.editModel', enabledPath: 'canvas.enabled' },
  { key: 'canvasInterrogate', label: '画布反推', trigger: '画布前台', operation: 'interrogate', nodePath: 'canvas.interrogateNodeIndex', modelPath: 'canvas.interrogateModel', enabledPath: 'canvas.enabled' },
  // 绑的是朗读前的文本改写模型，不是语音合成本身（合成走 bot.tts 的第三方服务，不是节点里的模型）。
  { key: 'tts', label: '语音文本前处理', trigger: '自动朗读前改写', operation: 'chat', nodePath: 'bot.tts.preprocess.nodeIndex', modelPath: 'bot.tts.preprocess.model', enabledPath: 'bot.tts.enabled' },
];

function getPath(target: unknown, dotted: string): unknown {
  return dotted.split('.').reduce<any>((acc, key) => (acc == null ? acc : acc[key]), target);
}

/** 逐项体检。config 是当前生效的配置（真实值，不是打码版）。 */
export function checkCapabilityBindings(config: unknown): CapabilityBinding[] {
  const cfg = config as any;
  const overrides = Array.isArray(cfg?.llm?.capabilityOverrides) ? cfg.llm.capabilityOverrides : [];
  const registry = createCapabilityRegistry({ overrides });
  const nodes = Array.isArray(cfg?.llm?.apiKeys) ? cfg.llm.apiKeys : [];

  return SPECS.map((spec) => {
    const nodeIndex = Number(getPath(cfg, spec.nodePath) ?? 0) || 0;
    const model = String(getPath(cfg, spec.modelPath) ?? '').trim();
    const enabled = spec.alwaysEnabled ? true : getPath(cfg, spec.enabledPath || '') !== false;
    const node = nodes[nodeIndex];
    const nodeName = node?.name || `节点 ${nodeIndex + 1}`;

    const hasOverride = overrides.some((o: any) => {
      const key = String(o?.model || '').trim();
      if (!key) return false;
      const re = key.match(/^\/(.*)\/(i?)$/);
      if (re) { try { return new RegExp(re[1], re[2]).test(model); } catch { return false; } }
      return key.toLowerCase() === model.toLowerCase();
    });

    const operations = model ? registry.operationsOf(model) : [];
    const base: Omit<CapabilityBinding, 'ok' | 'reason'> = {
      key: spec.key,
      label: spec.label,
      trigger: spec.trigger,
      operation: spec.operation,
      nodeIndex,
      nodeName,
      model,
      enabled,
      operations,
      source: hasOverride ? 'override' : 'inferred',
      learned: describeLearned(healingKey(node, model)),
    };

    if (!model || model === 'none') {
      return { ...base, ok: !enabled, reason: enabled ? '未配置模型' : '未启用' };
    }
    if (!node) return { ...base, ok: false, reason: `节点 ${nodeIndex + 1} 不存在` };
    if (node.enabled === false) return { ...base, ok: false, reason: `节点「${nodeName}」已停用` };
    if (!String(node.baseUrl || '').trim()) return { ...base, ok: false, reason: `节点「${nodeName}」没有填 Base URL` };

    if (!registry.can(model, spec.operation)) {
      return {
        ...base,
        ok: false,
        reason: `${model} 看起来不具备「${OPERATION_LABELS[spec.operation] || spec.operation}」能力。`
          + '如果这是中转/反代且实际支持，可在能力覆盖里手动指定。',
      };
    }

    return { ...base, ok: true };
  });
}

/** 查任意「节点 + 模型」组合的能力，面板改模型时实时展示徽标。 */
export function resolveModelCapabilities(config: unknown, nodeIndex: number, model: string) {
  const cfg = config as any;
  const overrides = Array.isArray(cfg?.llm?.capabilityOverrides) ? cfg.llm.capabilityOverrides : [];
  const registry = createCapabilityRegistry({ overrides });
  return {
    nodeIndex,
    model,
    operations: model ? registry.operationsOf(model) : [],
    learned: describeLearned(healingKey((cfg?.llm?.apiKeys || [])[nodeIndex], model)),
  };
}
