import type { CapabilityDescriptor } from './types.js';

export function builtinCapabilityDescriptors(): CapabilityDescriptor[] {
  const base = { version: '1.0.0', enabled: true } as const;
  const descriptors: CapabilityDescriptor[] = [
    { ...base, id: 'chat.reply', name: '自然语言对话', provider: 'model', mode: 'stream', riskLevel: 'low', mergeable: false },
    { ...base, id: 'help', name: '帮助', provider: 'builtin', mode: 'sync', riskLevel: 'low', mergeable: true },
    { ...base, id: 'model.catalog.list', name: '模型目录', provider: 'builtin', mode: 'sync', riskLevel: 'low', mergeable: true, outputKinds: ['text'] },
    { ...base, id: 'session.clear', name: '新对话', provider: 'builtin', mode: 'sync', riskLevel: 'low', mergeable: true, outputKinds: ['text'] },
    { ...base, id: 'owner.recall', name: '撤回消息', provider: 'napcat', mode: 'sync', riskLevel: 'medium', permissions: ['owner'], mergeable: true, outputKinds: ['text'], inputSchema: { type: 'object', properties: { count: { type: 'number', minimum: 1, maximum: 50 } }, additionalProperties: true } },
    { ...base, id: 'owner.model.list', name: '主人模型列表', provider: 'builtin', mode: 'sync', riskLevel: 'low', permissions: ['owner'], mergeable: true, outputKinds: ['text'] },
    { ...base, id: 'image.generate', name: '图片生成', provider: 'comfyui', mode: 'async_job', queue: 'image', riskLevel: 'medium', mergeable: true, outputKinds: ['image'], inputSchema: { type: 'object', properties: { prompt: { type: 'string' }, size: { type: 'string' }, count: { type: 'number', minimum: 1, maximum: 16 }, quality: { type: 'string' } }, additionalProperties: true } },
    { ...base, id: 'image.edit', name: '图片编辑', provider: 'comfyui', mode: 'async_job', queue: 'image', riskLevel: 'medium', mergeable: true, outputKinds: ['image'], inputSchema: { type: 'object', properties: { prompt: { type: 'string' }, size: { type: 'string' }, quality: { type: 'string' } }, additionalProperties: true } },
    { ...base, id: 'image.interrogate', name: '图片反推', provider: 'model', mode: 'sync', riskLevel: 'low', mergeable: true, outputKinds: ['text'] },
    { ...base, id: 'image.stitch', name: '多图拼接', provider: 'image-compose', mode: 'sync', riskLevel: 'low', mergeable: true, outputKinds: ['image'] },
    { ...base, id: 'video.generate', name: '视频生成', provider: 'model', mode: 'async_job', queue: 'video', riskLevel: 'high', mergeable: true, outputKinds: ['video'], inputSchema: { type: 'object', properties: { prompt: { type: 'string' }, duration: { type: 'number', minimum: 1, maximum: 300 } }, additionalProperties: true } },
    { ...base, id: 'web.search', name: '网页搜索', provider: 'search', mode: 'sync', riskLevel: 'low', mergeable: true, outputKinds: ['text'], inputSchema: { type: 'object', properties: { query: { type: 'string' }, prompt: { type: 'string' } }, additionalProperties: true } },
    { ...base, id: 'file.read', name: '文件读取', provider: 'file-ingest', mode: 'sync', riskLevel: 'medium', mergeable: false, outputKinds: ['text', 'image', 'file'] },
    { ...base, id: 'file.generate', name: '文件生成', provider: 'file-generator', mode: 'async_job', riskLevel: 'medium', mergeable: false, outputKinds: ['file'] },
    { ...base, id: 'file.list', name: '文件列表', provider: 'file-ingest', mode: 'sync', riskLevel: 'low', mergeable: true, outputKinds: ['text'] },
    { ...base, id: 'code.render', name: '代码渲染', provider: 'browser-render', mode: 'async_job', riskLevel: 'low', mergeable: true, outputKinds: ['image'] },
    { ...base, id: 'browser.render', name: '网页截图', provider: 'browser-render', mode: 'async_job', riskLevel: 'medium', mergeable: true, outputKinds: ['image'] },
    { ...base, id: 'tts.speak', name: '语音合成', provider: 'tts', mode: 'async_job', queue: 'audio', riskLevel: 'low', mergeable: false, outputKinds: ['audio'] },
    { ...base, id: 'voice.current', name: '当前音色', provider: 'fish-audio', mode: 'interactive', riskLevel: 'low', mergeable: true, outputKinds: ['text'] },
    { ...base, id: 'voice.search', name: '搜索音色', provider: 'fish-audio', mode: 'interactive', riskLevel: 'medium', mergeable: true, outputKinds: ['text'], inputSchema: { type: 'object', properties: { title: { type: 'string' }, tags: { type: 'array' }, language: { type: 'array' }, licensedOnly: { type: 'boolean' } }, additionalProperties: true } },
    { ...base, id: 'voice.preview', name: '试听音色', provider: 'fish-audio', mode: 'interactive', queue: 'audio', riskLevel: 'medium', mergeable: false, outputKinds: ['audio', 'text'], inputSchema: { type: 'object', properties: { index: { type: 'number', minimum: 1 }, candidateId: { type: 'string' }, text: { type: 'string' } }, additionalProperties: true } },
    { ...base, id: 'voice.select', name: '选择音色', provider: 'fish-audio', mode: 'interactive', riskLevel: 'medium', mergeable: true, outputKinds: ['text'], inputSchema: { type: 'object', properties: { index: { type: 'number', minimum: 1 }, candidateId: { type: 'string' } }, additionalProperties: true } },
    { ...base, id: 'audio.music.generate', name: 'Suno 音乐生成', provider: 'suno-official', mode: 'async_job', queue: 'audio', riskLevel: 'medium', approvalRequired: false, external: true, mergeable: false, outputKinds: ['audio', 'image'], inputSchema: { type: 'object', properties: { request: { type: 'string' }, prompt: { type: 'string' }, lyrics: { type: 'string' }, title: { type: 'string' }, style: { type: 'string' }, instrumental: { type: 'boolean' }, duration: { type: 'number', minimum: 10, maximum: 360 }, negativeTags: { type: 'string' }, vocalGender: { type: 'string', enum: ['m', 'f'] }, styleWeight: { type: 'number', minimum: 0, maximum: 1 }, weirdnessConstraint: { type: 'number', minimum: 0, maximum: 1 }, audioWeight: { type: 'number', minimum: 0, maximum: 1 }, variety: { type: 'number', minimum: 0, maximum: 4 }, model: { type: 'string' } }, additionalProperties: true } },
    { ...base, id: 'prompt.enhance', name: '提示词增强', provider: 'model', mode: 'sync', riskLevel: 'low', mergeable: true, outputKinds: ['text'] },
    { ...base, id: 'prompt.translate', name: '提示词翻译', provider: 'model', mode: 'sync', riskLevel: 'low', mergeable: true, outputKinds: ['text'] },
    { ...base, id: 'template.list', name: '模板列表', provider: 'builtin', mode: 'sync', riskLevel: 'low', mergeable: true, outputKinds: ['text'] },
    { ...base, id: 'template.use', name: '模板生图', provider: 'builtin', mode: 'async_job', riskLevel: 'low', mergeable: true, outputKinds: ['image'] },
    { ...base, id: 'canvas.gallery', name: '图库', provider: 'canvas', mode: 'sync', riskLevel: 'low', mergeable: true, outputKinds: ['image'] },
    { ...base, id: 'file.delete', name: '删除文件', provider: 'builtin', mode: 'sync', riskLevel: 'high', approvalRequired: true, mergeable: false },
    { ...base, id: 'config.update', name: '修改配置', provider: 'admin', mode: 'sync', riskLevel: 'critical', permissions: ['admin', 'owner'], approvalRequired: true, mergeable: false },
    { ...base, id: 'permission.update', name: '修改权限', provider: 'admin', mode: 'sync', riskLevel: 'critical', permissions: ['admin', 'owner'], approvalRequired: true, mergeable: false },
  ];
  const costs: Record<string, CapabilityDescriptor['costClass']> = {
    'chat.reply': 'low',
    'help': 'free',
    'model.catalog.list': 'free',
    'session.clear': 'free',
    'owner.recall': 'free',
    'owner.model.list': 'free',
    'image.generate': 'medium',
    'image.edit': 'medium',
    'image.interrogate': 'low',
    'image.stitch': 'low',
    'video.generate': 'high',
    'web.search': 'low',
    'file.read': 'low',
    'file.generate': 'medium',
    'file.list': 'free',
    'code.render': 'low',
    'browser.render': 'low',
    'tts.speak': 'medium',
    'audio.music.generate': 'high',
    'prompt.enhance': 'low',
    'prompt.translate': 'low',
    'template.list': 'free',
    'template.use': 'medium',
    'canvas.gallery': 'free',
    'file.delete': 'free',
    'config.update': 'free',
    'permission.update': 'free',
  };
  const modelRounds: Record<string, number> = {
    'chat.reply': 1,
    'image.generate': 1,
    'image.edit': 1,
    'image.interrogate': 1,
    'video.generate': 1,
    'web.search': 1,
    'prompt.enhance': 1,
    'prompt.translate': 1,
    'template.use': 1,
  };
  return descriptors.map((descriptor) => ({
    ...descriptor,
    costClass: costs[descriptor.id],
    ...(modelRounds[descriptor.id] === undefined ? {} : { modelRounds: modelRounds[descriptor.id] }),
  }));
}

export function applyCapabilityOverrides(
  descriptors: CapabilityDescriptor[],
  overrides: Record<string, { enabled?: boolean; approvalRequired?: boolean; riskLevel?: CapabilityDescriptor['riskLevel'] }> = {},
): CapabilityDescriptor[] {
  return descriptors.map((descriptor) => {
    const override = overrides[descriptor.id];
    if (!override) return descriptor;
    return {
      ...descriptor,
      ...(override.enabled === undefined ? {} : { enabled: override.enabled }),
      ...(override.approvalRequired === undefined ? {} : { approvalRequired: override.approvalRequired }),
      ...(override.riskLevel === undefined ? {} : { riskLevel: override.riskLevel }),
    };
  });
}

export function applyRuntimeCapabilityGates(
  descriptors: CapabilityDescriptor[],
  gates: { sunoEnabled?: boolean; externalEnabled?: boolean; allowlist?: string[] } = {},
): CapabilityDescriptor[] {
  return descriptors.map((descriptor) => {
    if (descriptor.id === 'audio.music.generate' && !gates.sunoEnabled) {
      return { ...descriptor, enabled: false };
    }
    if (descriptor.external) {
      const providers = gates.allowlist || [];
      if (!gates.externalEnabled || (providers.length > 0 && !providers.includes(descriptor.provider))) {
        return { ...descriptor, enabled: false };
      }
    }
    return descriptor;
  });
}
