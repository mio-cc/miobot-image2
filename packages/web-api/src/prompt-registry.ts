/**
 * R18 提示词注册表：ID → config 路径映射。
 * 面板通过 GET/POST /api/prompts 读写这些字段。
 * 热重载：bot 的 getConfig() 每条消息前 loadIfChanged，保存即下一轮生效（next_turn）。
 */

export interface PromptEntry {
  id: string;
  title: string;
  description: string;
  /** config.json 中的点分路径（如 "bot.keywordTrigger.triggerIntentPromptTemplate"）；null=代码内置暂不可编辑 */
  configPath: string | null;
  category: 'input' | 'generation' | 'memory' | 'search' | 'presentation' | 'system';
  hotReload: 'next_turn' | 'restart_required';
  /** 渲染变量说明（写进 UI 帮助文本） */
  variables?: string;
  builtin?: boolean;
}

export const PROMPT_REGISTRY: readonly PromptEntry[] = [
  // ── 输入侧（R15 收编） ──
  { id: 'trigger.intent', title: '@ 触发判定', description: '判断群消息用户是否在跟 bot 说话', configPath: 'bot.keywordTrigger.triggerIntentPromptTemplate', category: 'input', hotReload: 'next_turn', variables: '{{words}} {{context}} {{userText}} {{userName}} {{triggerWord}}' },
  { id: 'trigger.continue', title: '续话判定', description: 'autoContinue 窗口内判断是否延续对话', configPath: 'bot.autoContinue.continueIntentPromptTemplate', category: 'input', hotReload: 'next_turn', variables: '{{focusNote}} {{botLastReply}} {{userText}} {{userName}}' },
  // ── 生成侧 ──
  { id: 'suno.composer', title: 'Suno 作曲', description: '歌词与参数规划（含歌名原创最高优先级 override）', configPath: 'orchestration.suno.composerPromptTemplate', category: 'generation', hotReload: 'next_turn', variables: '{{userRequest}} {{intents}} {{context}}' },
  { id: 'image.enhance', title: '提示词润色', description: '用户原始提示词 → 图像生成结构化提示词', configPath: 'llm.enhancePromptTemplate', category: 'generation', hotReload: 'next_turn', variables: '{{rawPrompt}}' },
  { id: 'image.safeRewrite', title: '合规改写', description: '提示词合规改写（保留原始语言）', configPath: 'llm.safeRewritePromptTemplate', category: 'generation', hotReload: 'next_turn', variables: '{{rawPrompt}}' },
  { id: 'image.interrogate', title: '图片反推', description: '图片 → 生成提示词描述', configPath: 'llm.interrogatePromptTemplate', category: 'generation', hotReload: 'next_turn', variables: '(图片输入)' },
  { id: 'interrogate.template', title: '反推成模板', description: '图片 → 可复用提示词模板', configPath: 'canvas.interrogateTemplatePromptTemplate', category: 'generation', hotReload: 'next_turn', variables: '{{prompt}}' },
  { id: 'comfyui.transform', title: 'ComfyUI 参数转化', description: '自然语言 → ComfyUI workflow 参数 JSON', configPath: 'comfyuiTransform.promptTemplate', category: 'generation', hotReload: 'next_turn', variables: '{{userRequest}} {{profileName}} {{parameterKeys}} {{allowedEnums}} {{defaults}} {{constraints}}' },
  { id: 'code.render', title: '代码渲染', description: 'HTML/SVG/Canvas/Three.js 代码生成', configPath: 'codeRender.promptTemplate', category: 'generation', hotReload: 'next_turn', variables: '{{userContent}}' },
  // ── 呈现 ──
  { id: 'tts.preprocess', title: '朗读前改写', description: 'TTS 合成前文本改写（标签穿插）', configPath: 'bot.tts.preprocess.promptTemplate', category: 'presentation', hotReload: 'next_turn', variables: '{{text}}' },
  // ── 搜索 ──
  { id: 'search.query', title: '搜索查询', description: '远程模板库搜索查询生成', configPath: 'promptsChat.searchQueryPromptTemplate', category: 'search', hotReload: 'next_turn', variables: '{{rawPrompt}}' },
  { id: 'search.smart', title: '智能选模板', description: '远程模板库智能选择', configPath: 'promptsChat.smartPromptTemplate', category: 'search', hotReload: 'next_turn', variables: '{{rawPrompt}} {{candidates}}' },
  // ── 系统（代码内置，暂不可编辑） ──
  { id: 'agent.base', title: '主系统提示词', description: 'AgentRuntime 六段基础提示词（agent-host.ts buildAgentSystemPrompt）', configPath: null, category: 'system', hotReload: 'next_turn', builtin: true },
  { id: 'memory.summarize', title: '记忆摘要', description: '聊天记录 → 事实摘要（代码内置，待收编）', configPath: null, category: 'memory', hotReload: 'next_turn', builtin: true },
  { id: 'memory.score', title: '记忆评分', description: '记忆重要性 0-10 批量评分（代码内置，待收编）', configPath: null, category: 'memory', hotReload: 'next_turn', builtin: true },
  { id: 'search.rewrite', title: '搜索改写', description: '空结果查询改写重试（代码内置，待收编）', configPath: null, category: 'search', hotReload: 'next_turn', builtin: true },
];

/** 按点分路径读取 config 值。 */
export function getPromptValue(config: Record<string, unknown>, configPath: string): string {
  const parts = configPath.split('.');
  let current: unknown = config;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') return '';
    current = (current as Record<string, unknown>)[part];
  }
  return String(current ?? '');
}

/** 按点分路径写入 config 值（就地修改嵌套对象）。 */
export function setPromptValue(config: Record<string, unknown>, configPath: string, value: string): void {
  const parts = configPath.split('.');
  let current: Record<string, unknown> = config;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (current[key] === null || current[key] === undefined || typeof current[key] !== 'object') {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
}