import type { CapabilityDescriptor, CapabilityEffect } from './types.js';

export function builtinCapabilityDescriptors(): CapabilityDescriptor[] {
  const base = { version: '1.0.0', enabled: true } as const;
  const descriptors: CapabilityDescriptor[] = [
    { ...base, id: 'chat.reply', name: '自然语言对话', description: '直接回答、解释、判断、写作或对话，输出文本。', provider: 'model', mode: 'stream', riskLevel: 'low', mergeable: true, outputKinds: ['text'], inputSchema: { type: 'object', properties: { prompt: { type: 'string' }, question: { type: 'string' } }, additionalProperties: true } },
    { ...base, id: 'help', name: '帮助', description: '返回 Miobot 的完整帮助文本。', provider: 'builtin', mode: 'sync', riskLevel: 'low', mergeable: true, outputKinds: ['text'] },
    { ...base, id: 'model.catalog.list', name: '模型目录', provider: 'builtin', mode: 'sync', riskLevel: 'low', mergeable: true, outputKinds: ['text'] },
    { ...base, id: 'session.clear', name: '新对话', provider: 'builtin', mode: 'sync', riskLevel: 'low', mergeable: true, outputKinds: ['text'] },
    { ...base, id: 'owner.recall', name: '撤回消息', provider: 'napcat', mode: 'sync', riskLevel: 'medium', permissions: ['owner'], mergeable: true, outputKinds: ['text'], inputSchema: { type: 'object', properties: { count: { type: 'number', minimum: 1, maximum: 50 } }, additionalProperties: true } },
    { ...base, id: 'owner.model.list', name: '主人模型列表', provider: 'builtin', mode: 'sync', riskLevel: 'low', permissions: ['owner'], mergeable: true, outputKinds: ['text'] },
    { ...base, id: 'image.generate', name: '图片生成', description: '创建一个或多个新的图片产物。', provider: 'comfyui', mode: 'async_job', queue: 'image', riskLevel: 'medium', mergeable: true, outputKinds: ['image'], inputSchema: { type: 'object', properties: { prompt: { type: 'string', description: '画面内容描述' }, width: { type: 'number', description: '图片宽度像素（可选；512-1536，8 的倍数）', minimum: 256, maximum: 2048 }, height: { type: 'number', description: '图片高度像素（可选；512-1536，8 的倍数）', minimum: 256, maximum: 2048 }, size: { type: 'string', description: '尺寸或比例（如 1024x1024、16:9、竖图；可选，width/height 优先）' }, count: { type: 'number', description: '生成张数', minimum: 1, maximum: 16 }, quality: { type: 'string' } }, additionalProperties: true } },
    { ...base, id: 'image.edit', name: '图片编辑', description: '对已有图片进行视觉转换，生成修改后的图片产物。', provider: 'comfyui', mode: 'async_job', queue: 'image', riskLevel: 'medium', mergeable: true, outputKinds: ['image'], inputSchema: { type: 'object', properties: { prompt: { type: 'string', description: '编辑指令' }, width: { type: 'number', description: '输出宽度像素（可选）', minimum: 256, maximum: 2048 }, height: { type: 'number', description: '输出高度像素（可选）', minimum: 256, maximum: 2048 }, size: { type: 'string' }, quality: { type: 'string' } }, additionalProperties: true } },
    { ...base, id: 'image.interrogate', name: '图片反推', provider: 'model', mode: 'sync', riskLevel: 'low', mergeable: true, outputKinds: ['text'] },
    { ...base, id: 'image.stitch', name: '多图拼接', provider: 'image-compose', mode: 'sync', riskLevel: 'low', mergeable: true, outputKinds: ['image'] },
    { ...base, id: 'video.generate', name: '视频生成', provider: 'model', mode: 'async_job', queue: 'video', riskLevel: 'high', mergeable: true, outputKinds: ['video'], inputSchema: { type: 'object', properties: { prompt: { type: 'string' }, duration: { type: 'number', minimum: 1, maximum: 300 } }, additionalProperties: true } },
    { ...base, id: 'web.search', name: '网页搜索', description: '获取外部信息，返回可用于回答用户的资料。', provider: 'search', mode: 'sync', riskLevel: 'low', mergeable: true, outputKinds: ['text'], inputSchema: { type: 'object', properties: { query: { type: 'string' }, prompt: { type: 'string' } }, additionalProperties: true } },
    { ...base, id: 'file.read', name: '文件读取', provider: 'file-ingest', mode: 'sync', riskLevel: 'medium', mergeable: false, outputKinds: ['text', 'image', 'file'] },
    { ...base, id: 'file.generate', name: '文件生成', provider: 'file-generator', mode: 'async_job', riskLevel: 'medium', mergeable: false, outputKinds: ['file'] },
    { ...base, id: 'file.list', name: '文件列表', provider: 'file-ingest', mode: 'sync', riskLevel: 'low', mergeable: true, outputKinds: ['text'] },
    { ...base, id: 'code.render', name: '代码渲染', description: '用代码（HTML/SVG/Canvas/Three.js）绘制一张图片产物。用户说"用代码画XX""代码画图""SVG/Canvas/Three.js 画"时使用。args 传 userContent（用户想画的内容原话）。', provider: 'browser-render', mode: 'async_job', riskLevel: 'low', mergeable: true, outputKinds: ['image'], inputSchema: { type: 'object', properties: { userContent: { type: 'string', description: '用户想画的内容描述原话（不要自己写代码，系统会调模型生成代码）' } }, additionalProperties: true } },
    { ...base, id: 'browser.render', name: '网页截图', description: '打开指定网页并截取页面截图。用户给出网址或网站名均可。如果用户没给完整 URL，先用 web.search 搜索获取网站 URL，再用本能力截图（两步链式执行）。', provider: 'browser-render', mode: 'async_job', riskLevel: 'medium', mergeable: true, outputKinds: ['image'], inputSchema: { type: 'object', properties: { url: { type: 'string', description: '要截图的网页完整 URL（https://开头）。如果用户只说了网站名，先通过 web.search 搜索获取 URL，再传入本能力。也可以用 {{steps.<搜索步骤id>.outputs[0].text}} 引用搜索结果。' } }, additionalProperties: true } },
    { ...base, id: 'tts.speak', name: '语音合成', provider: 'tts', mode: 'async_job', queue: 'audio', riskLevel: 'low', mergeable: false, outputKinds: ['audio'] },
    { ...base, id: 'voice.current', name: '当前音色', provider: 'fish-audio', mode: 'interactive', riskLevel: 'low', mergeable: true, outputKinds: ['text'] },
    { ...base, id: 'voice.search', name: '搜索音色', provider: 'fish-audio', mode: 'interactive', riskLevel: 'medium', mergeable: true, outputKinds: ['text'], inputSchema: { type: 'object', properties: { title: { type: 'string' }, tags: { type: 'array' }, language: { type: 'array' }, licensedOnly: { type: 'boolean' } }, additionalProperties: true } },
    { ...base, id: 'voice.preview', name: '试听音色', provider: 'fish-audio', mode: 'interactive', queue: 'audio', riskLevel: 'medium', mergeable: false, outputKinds: ['audio', 'text'], inputSchema: { type: 'object', properties: { index: { type: 'number', minimum: 1 }, candidateId: { type: 'string' }, text: { type: 'string' } }, additionalProperties: true } },
    { ...base, id: 'voice.select', name: '选择音色', provider: 'fish-audio', mode: 'interactive', riskLevel: 'medium', mergeable: true, outputKinds: ['text'], inputSchema: { type: 'object', properties: { index: { type: 'number', minimum: 1 }, candidateId: { type: 'string' } }, additionalProperties: true } },
    { ...base, id: 'audio.music.generate', name: 'Suno 音乐生成', provider: 'suno-official', mode: 'async_job', queue: 'audio', riskLevel: 'medium', approvalRequired: false, external: true, mergeable: false, outputKinds: ['audio'], inputSchema: { type: 'object', properties: { request: { type: 'string' }, prompt: { type: 'string' }, lyrics: { type: 'string' }, title: { type: 'string' }, style: { type: 'string' }, instrumental: { type: 'boolean' }, duration: { type: 'number', minimum: 10, maximum: 360 }, negativeTags: { type: 'string' }, vocalGender: { type: 'string', enum: ['m', 'f'] }, language: { type: 'string' }, styleWeight: { type: 'number', minimum: 0, maximum: 1 }, weirdnessConstraint: { type: 'number', minimum: 0, maximum: 1 }, audioWeight: { type: 'number', minimum: 0, maximum: 1 }, variety: { type: 'number', minimum: 0, maximum: 4 }, model: { type: 'string' } }, additionalProperties: true } },
      { ...base, id: 'audio.music.history', name: 'Suno 歌曲历史', description: '列出当前用户在当前会话中生成过的歌曲，返回稳定序号、标题、时间和记录 ID。', provider: 'suno-official', mode: 'sync', riskLevel: 'low', mergeable: true, outputKinds: ['text'], inputSchema: { type: 'object', properties: { limit: { type: 'number', minimum: 1, maximum: 50 } }, additionalProperties: true } },
      { ...base, id: 'audio.music.replay', name: 'Suno 歌曲重发', description: '把历史记录中已经生成的一首歌原样重新发送，不重新生成、不消耗生成额度。', provider: 'suno-official', mode: 'sync', riskLevel: 'low', mergeable: false, outputKinds: ['audio'], inputSchema: { type: 'object', properties: { recordId: { type: 'string' }, sequence: { type: 'number', minimum: 1 }, title: { type: 'string' }, selection: { type: 'string' } }, additionalProperties: true } },
      { ...base, id: 'audio.music.replace_section', name: 'Suno 歌曲局部编辑', description: '基于已生成歌曲替换指定时间段，用新的 prompt/歌词/tags 重新生成该片段。', provider: 'suno-official', mode: 'async_job', queue: 'audio', riskLevel: 'medium', mergeable: false, outputKinds: ['audio'], inputSchema: { type: 'object', properties: { recordId: { type: 'string' }, sequence: { type: 'number', minimum: 1 }, title: { type: 'string' }, change: { type: 'string' }, prompt: { type: 'string' }, lyrics: { type: 'string' }, fullLyrics: { type: 'string' }, tags: { type: 'string' }, startSeconds: { type: 'number' }, endSeconds: { type: 'number' }, negativeTags: { type: 'string' }, vocalGender: { type: 'string', enum: ['m', 'f'] } }, additionalProperties: true } },
    { ...base, id: 'prompt.enhance', name: '提示词增强', provider: 'model', mode: 'sync', riskLevel: 'low', mergeable: true, outputKinds: ['text'] },
    { ...base, id: 'prompt.translate', name: '提示词翻译', provider: 'model', mode: 'sync', riskLevel: 'low', mergeable: true, outputKinds: ['text'] },
    { ...base, id: 'template.list', name: '模板列表', provider: 'builtin', mode: 'sync', riskLevel: 'low', mergeable: true, outputKinds: ['text'] },
    { ...base, id: 'template.use', name: '模板生图', provider: 'builtin', mode: 'async_job', riskLevel: 'low', mergeable: true, outputKinds: ['image'] },
    { ...base, id: 'canvas.gallery', name: '图库', provider: 'canvas', mode: 'sync', riskLevel: 'low', mergeable: true, outputKinds: ['image'] },
    { ...base, id: 'task.schedule', name: '定时提醒', description: '注册一次性提醒：把“在某时刻提醒我做某事”解析为 remindText + at(ISO) 或 inMinutes(分钟数)，到点后原路径发回提醒。', provider: 'builtin', mode: 'sync', riskLevel: 'low', mergeable: true, outputKinds: ['text'], effect: 'notify', inputSchema: { type: 'object', properties: { remindText: { type: 'string' }, at: { type: 'string', description: 'ISO 8601 时间' }, inMinutes: { type: 'number', minimum: 1 } }, required: ['remindText'], additionalProperties: true } },
    { ...base, id: 'file.delete', name: '删除文件', provider: 'builtin', mode: 'sync', riskLevel: 'high', approvalRequired: true, mergeable: false },
    { ...base, id: 'config.update', name: '修改配置', provider: 'admin', mode: 'sync', riskLevel: 'critical', permissions: ['admin', 'owner'], approvalRequired: true, mergeable: false },
    { ...base, id: 'permission.update', name: '修改权限', provider: 'admin', mode: 'sync', riskLevel: 'critical', permissions: ['admin', 'owner'], approvalRequired: true, mergeable: false },
  ];
  const effects: Record<string, CapabilityEffect> = {
    'chat.reply': 'answer',
    'help': 'answer',
    'model.catalog.list': 'retrieve',
    'session.clear': 'control',
    'owner.recall': 'delete',
    'owner.model.list': 'retrieve',
    'image.generate': 'generate',
    'image.edit': 'transform',
    'image.interrogate': 'retrieve',
    'image.stitch': 'transform',
    'video.generate': 'generate',
    'web.search': 'retrieve',
    'file.read': 'retrieve',
    'file.generate': 'generate',
    'file.list': 'retrieve',
    'code.render': 'generate',
    'browser.render': 'generate',
    'tts.speak': 'generate',
    'voice.current': 'retrieve',
    'voice.search': 'retrieve',
    'voice.preview': 'retrieve',
    'voice.select': 'mutate',
    'audio.music.generate': 'generate',
      'audio.music.history': 'retrieve',
      'audio.music.replay': 'retrieve',
      'audio.music.replace_section': 'transform',
    'prompt.enhance': 'transform',
    'prompt.translate': 'transform',
    'template.list': 'retrieve',
    'template.use': 'generate',
    'canvas.gallery': 'retrieve',
    'file.delete': 'delete',
    'config.update': 'mutate',
    'permission.update': 'mutate',
  };
  for (const descriptor of descriptors) descriptor.effect = descriptor.effect || effects[descriptor.id] || 'unknown';
  const inputPropertyDescriptions: Record<string, Record<string, string>> = {
    'audio.music.history': { limit: '最多返回多少首，默认 20。' },
    'audio.music.replay': { recordId: '历史记录中的稳定 recordId，优先使用。', sequence: '历史列表中的稳定序号，例如 #2 传 2。', title: '用户明确说出的历史歌曲标题。', selection: '用户自然语言选择的原话，优先转换成 sequence/title/recordId。' },
    'audio.music.replace_section': { recordId: '历史记录中的稳定 recordId。', sequence: '历史列表中的稳定序号，例如 #2 传 2。', title: '历史歌曲标题。', change: '用户对目标片段的自然语言修改要求。', prompt: '替换片段的音乐/演唱描述。', lyrics: '替换片段的新歌词；只改风格时可省略。', fullLyrics: '修改后的完整歌词；省略时使用原歌词或模型生成结果。', tags: '替换片段的风格标签。', startSeconds: '替换区间开始秒数；省略时根据时间戳歌词推断。', endSeconds: '替换区间结束秒数；省略时根据时间戳歌词推断。' },
  };
  for (const descriptor of descriptors) {
    const schema = descriptor.inputSchema as any;
    for (const [key, description] of Object.entries(inputPropertyDescriptions[descriptor.id] || {})) {
      if (schema?.properties?.[key] && !schema.properties[key].description) schema.properties[key].description = description;
    }
  }
  const descriptions: Record<string, string> = {
    'chat.reply': '直接回答、解释、判断、写作或对话，输出文本。',
    'help': '返回 Miobot 的完整帮助文本。',
    'model.catalog.list': '列出当前配置可用的模型及能力信息。',
    'session.clear': '清空当前会话上下文，开始新的对话。',
    'owner.recall': '撤回当前会话中机器人最近发送的消息。',
    'owner.model.list': '列出当前配置的模型节点和模型。',
    'image.generate': '创建一个或多个新的图片产物。',
    'image.edit': '对已有图片进行视觉转换，生成修改后的图片产物。',
    'image.interrogate': '分析图片内容，返回描述或可用于生成图片的提示词。',
    'image.stitch': '把多张图片合成为一张拼接图。',
    'video.generate': '创建一个新的视频产物。',
    'web.search': '获取外部信息，返回可用于回答用户的资料。',
    'file.read': '读取、解析和提取当前提供文件的内容。',
    'file.generate': '创建并导出一个新的文件产物。',
    'file.list': '列出当前会话可用的文件和索引信息。',
    'code.render': '使用代码生成并渲染一张新的图片产物。',
    'browser.render': '打开指定网页并生成一张新的页面截图。',
    'tts.speak': '把文本合成为语音音频。',
    'voice.current': '返回当前用户或会话使用的音色信息。',
    'voice.search': '搜索并返回可用音色候选。',
    'voice.preview': '为指定音色候选生成试听音频。',
    'voice.select': '把用户选择的音色写入当前音色偏好。',
    'audio.music.generate': '创建一首新的音乐或音频产物。',
      'audio.music.history': '列出当前会话中已生成的歌曲历史，返回稳定序号。',
      'audio.music.replay': '重发历史中已经生成过的一首歌曲；目标不明确时省略选择参数，让执行器返回历史列表并追问。',
      'audio.music.replace_section': '替换已生成歌曲的指定时间段，生成编辑后的新音频；目标不明确时省略选择参数，让执行器返回历史列表并追问。',
    'prompt.enhance': '把用户提示词改写为更完整、可执行的提示词。',
    'prompt.translate': '在保留语义的前提下翻译提示词。',
    'template.list': '列出可用的本地提示词模板。',
    'template.use': '使用指定模板创建一张新的图片产物。',
    'canvas.gallery': '读取并返回图库中的图片信息。',
    'file.delete': '删除指定的文件产物。',
    'config.update': '修改系统配置。',
    'permission.update': '修改用户、角色或能力权限。',
  };
  const requiredContexts: Record<string, CapabilityDescriptor['requiredContext']> = {
    'image.edit': ['image'],
    'image.interrogate': ['image'],
    'image.stitch': ['image'],
    'file.read': ['file'],
    // browser.render 的 url 改为 inputSchema 参数（planner 从用户描述中提取/补全 URL），
    // 不再要求执行前已有 URL 附件——用户说"截屏起点中文网"没有附链接也应能触发。
  };
  const sideEffects: Record<string, CapabilityDescriptor['sideEffects']> = {
    // T2.8 修复：生图/改图/视频是 async_job + 外部提交（ComfyUI prompt_id / 视频任务 id），
    // 漏标 external_call 会让崩溃恢复把它们当可重放步骤直接重跑——双计费。
    'image.generate': ['creates_artifact', 'external_call'],
    'image.edit': ['creates_artifact', 'external_call'],
    'video.generate': ['creates_artifact', 'external_call'],
    'web.search': ['external_call'],
    'browser.render': ['creates_artifact', 'external_call'],
    'audio.music.generate': ['creates_artifact', 'external_call'],
      'audio.music.replay': ['sends_message'],
      'audio.music.replace_section': ['creates_artifact', 'external_call'],
    'prompt.enhance': [],
    'prompt.translate': [],
  };
  const ttsPolicies: Record<string, CapabilityDescriptor['ttsPolicy']> = {
    help: 'skip',
    'model.catalog.list': 'skip',
    'session.clear': 'skip',
    'owner.recall': 'skip',
    'owner.model.list': 'skip',
    'file.list': 'skip',
    'template.list': 'skip',
    'prompt.enhance': 'skip',
    'prompt.translate': 'skip',
    'voice.current': 'skip',
    'voice.search': 'skip',
    'voice.select': 'skip',
      'audio.music.history': 'skip',
    'file.delete': 'skip',
    'config.update': 'skip',
    'permission.update': 'skip',
    'canvas.gallery': 'skip',
  };
  for (const descriptor of descriptors) descriptor.ttsPolicy = ttsPolicies[descriptor.id] || descriptor.ttsPolicy || 'auto';
  for (const descriptor of descriptors) {
    descriptor.description = descriptions[descriptor.id] || descriptor.description || '';
    descriptor.requiredContext = requiredContexts[descriptor.id] || descriptor.requiredContext || [];
    descriptor.sideEffects = sideEffects[descriptor.id] || descriptor.sideEffects;
  }
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
      'audio.music.history': 'free',
      'audio.music.replay': 'free',
      'audio.music.replace_section': 'high',
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
    // Suno 有独立的 enabled 开关和 provider allowlist，不能要求用户再打开 generic externalProviders 总开关。
      if (descriptor.id === 'audio.music.generate' || descriptor.id === 'audio.music.replace_section') {
      const providers = gates.allowlist || [];
      const providerAllowed = providers.length === 0 || providers.includes(descriptor.provider);
      return { ...descriptor, enabled: Boolean(gates.sunoEnabled) && providerAllowed };
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
