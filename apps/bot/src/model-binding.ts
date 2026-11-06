import type { AppConfig } from '../../../packages/config/src/index.js';
import type { StructuredLogger } from '../../../packages/logger/src/index.js';
import type { ConfigStore } from '../../../packages/storage/src/index.js';

/**
 * 模型绑定同源服务（方案 7a/7b）：硬编码命令（/切换）与模型工具（model.binding.switch）
 * 共用同一份校验、同一个写入路径与同一份审计——杜绝双写不一致。
 *
 * 纯本地解析 + 配置写入，不经过 LLM（命令路径在主模型故障时仍可用）。
 * 权限：调用方各自把关（命令 owner 通道天然 owner-only；工具执行层 isOwner 校验）。
 */

export type BindingSlot = 'primary' | 'secondary';
export type BindingScope = 'persistent' | 'once';

export interface PurposeDef {
  key: string;
  label: string;
  /** 命令里的中文/英文触发词（/切换 {词} X）。 */
  keywords: string[];
  /** config 点分路径前缀（null = 根级字段，如 main 的 agent.*）。 */
  section: string | null;
  nodeField: string;
  modelField: string;
  /** 备用绑定落点（同容器内字段名；方案 6-P2：11 用途各配一个，字段见各段 normalize）。 */
  fallbackNodeField: string;
  fallbackModelField: string;
  /** 第二模型（备用）结构是否已就绪——P2 起全部用途就绪。 */
  supportsSecondary: boolean;
}

export const MODEL_BINDING_PURPOSES: PurposeDef[] = [
  { key: 'main', label: '主对话', keywords: ['主对话', '主模型', 'main', '聊天', '对话'], section: 'agent', nodeField: 'mainNodeIndex', modelField: 'mainModel', fallbackNodeField: 'fallbackNodeIndex', fallbackModelField: 'fallbackModel', supportsSecondary: true },
  { key: 'enhance', label: '提示词润色', keywords: ['润色', '提示词润色', 'enhance'], section: 'llm', nodeField: 'enhanceNodeIndex', modelField: 'enhanceModel', fallbackNodeField: 'fallbackEnhanceNodeIndex', fallbackModelField: 'fallbackEnhanceModel', supportsSecondary: true },
  { key: 'image', label: '图片生成', keywords: ['图片', '生图', '画图', 'image'], section: 'llm', nodeField: 'imageNodeIndex', modelField: 'imageModel', fallbackNodeField: 'fallbackImageNodeIndex', fallbackModelField: 'fallbackImageModel', supportsSecondary: true },
  { key: 'edit', label: '图片编辑', keywords: ['改图', '编辑', 'edit'], section: 'llm', nodeField: 'editNodeIndex', modelField: 'editModel', fallbackNodeField: 'fallbackEditNodeIndex', fallbackModelField: 'fallbackEditModel', supportsSecondary: true },
  { key: 'interrogate', label: '图片反推', keywords: ['反推', '看图', 'interrogate'], section: 'llm', nodeField: 'interrogateNodeIndex', modelField: 'interrogateModel', fallbackNodeField: 'fallbackInterrogateNodeIndex', fallbackModelField: 'fallbackInterrogateModel', supportsSecondary: true },
  { key: 'suno', label: 'Suno 作曲', keywords: ['音乐', '作曲', 'suno'], section: 'orchestration.suno', nodeField: 'composerNodeIndex', modelField: 'composerModel', fallbackNodeField: 'fallbackComposerNodeIndex', fallbackModelField: 'fallbackComposerModel', supportsSecondary: true },
  { key: 'video', label: '视频生成', keywords: ['视频', 'video'], section: 'llm', nodeField: 'videoNodeIndex', modelField: 'videoModel', fallbackNodeField: 'fallbackVideoNodeIndex', fallbackModelField: 'fallbackVideoModel', supportsSecondary: true },
  { key: 'codeRender', label: '代码渲染', keywords: ['代码', '代码渲染', 'code'], section: 'codeRender', nodeField: 'nodeIndex', modelField: 'model', fallbackNodeField: 'fallbackNodeIndex', fallbackModelField: 'fallbackModel', supportsSecondary: true },
  { key: 'comfyui', label: 'ComfyUI 参数转化', keywords: ['参数', '参数转化', 'comfyui'], section: 'comfyuiTransform', nodeField: 'nodeIndex', modelField: 'model', fallbackNodeField: 'fallbackNodeIndex', fallbackModelField: 'fallbackModel', supportsSecondary: true },
  { key: 'tts', label: 'TTS 前处理', keywords: ['语音', 'tts'], section: 'bot.tts.preprocess', nodeField: 'nodeIndex', modelField: 'model', fallbackNodeField: 'fallbackNodeIndex', fallbackModelField: 'fallbackModel', supportsSecondary: true },
  { key: 'trigger', label: '触发判定', keywords: ['触发', '触发判定', 'trigger'], section: 'bot.keywordTrigger', nodeField: 'intentNodeIndex', modelField: 'intentModel', fallbackNodeField: 'fallbackIntentNodeIndex', fallbackModelField: 'fallbackIntentModel', supportsSecondary: true },
  { key: 'memory', label: '记忆摘要', keywords: ['记忆', 'memory'], section: 'orchestration.memory', nodeField: 'embeddingNodeIndex', modelField: 'embeddingModel', fallbackNodeField: 'fallbackEmbeddingNodeIndex', fallbackModelField: 'fallbackEmbeddingModel', supportsSecondary: true },
  // 方案 D（2026-11-06 拍板）：审核修复用途——主/备绑定走既有机制；主模型空 = 不启用修复（仅占位剥离+登记）。
  { key: 'sanitize', label: '审核修复', keywords: ['审核修复', '修复', 'sanitize'], section: 'llm', nodeField: 'sanitizeNodeIndex', modelField: 'sanitizeModel', fallbackNodeField: 'fallbackSanitizeNodeIndex', fallbackModelField: 'fallbackSanitizeModel', supportsSecondary: true },
];

export function findPurposeByKeyOrAlias(input: string): PurposeDef | undefined {
  const key = String(input || '').trim().toLowerCase();
  if (!key) return undefined;
  // 键比较同样走小写：camelCase 键（codeRender）必须能被工具层按原样命中（P2 表驱动全用途通）。
  return MODEL_BINDING_PURPOSES.find((p) => p.key.toLowerCase() === key || p.keywords.some((w) => w.toLowerCase() === key));
}

export interface ModelCandidate {
  model: string;
  nodeIndex: number;
  /** 精确 > 后缀 > 包含——排序权重。 */
  rank: number;
}

/** 全节点扫描目标模型：精确/后缀/包含三级匹配，多候选时交由上层澄清（禁止猜）。 */
export function findModelCandidates(config: AppConfig, target: string): ModelCandidate[] {
  const norm = (s: string) => String(s || '').toLowerCase().replace(/_/g, '.');
  const key = norm(target);
  if (!key) return [];
  const out: ModelCandidate[] = [];
  const nodes = config.llm.apiKeys || [];
  for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex += 1) {
    for (const model of nodes[nodeIndex].models || []) {
      const nm = norm(model);
      const rank = nm === key ? 0 : nm.endsWith(key) ? 1 : nm.includes(key) ? 2 : -1;
      if (rank >= 0) out.push({ model, nodeIndex, rank });
    }
  }
  // 精确命中优先；同级保留多候选（歧义交上层），同节点同名去重。
  out.sort((a, b) => a.rank - b.rank || a.model.localeCompare(b.model) || a.nodeIndex - b.nodeIndex);
  const seen = new Set<string>();
  return out.filter((item) => {
    const id = `${item.model}@${item.nodeIndex}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

export type SetBindingResult =
  | { ok: true; purpose: string; purposeLabel: string; slot: BindingSlot; from: string; to: string; nodeIndex: number; reply: string }
  | { ok: false; kind: 'unknown_purpose' | 'not_found' | 'ambiguous_model' | 'unsupported_secondary' | 'unsupported_once'; error: string; candidates?: string[] };

export interface SetBindingInput {
  purpose: string;
  slot?: BindingSlot;
  target: string;
  scope?: BindingScope;
  /** 审计用：命令 or 工具。 */
  source: 'command' | 'tool';
  /** 审计用：操作者 QQ。 */
  actorId: string;
}

function sectionOf(config: AppConfig, section: string | null): Record<string, unknown> | null {
  if (!section) return config as unknown as Record<string, unknown>;
  let obj: unknown = config;
  for (const part of section.split('.')) {
    if (!obj || typeof obj !== 'object') return null;
    obj = (obj as Record<string, unknown>)[part];
  }
  return obj && typeof obj === 'object' ? obj as Record<string, unknown> : null;
}

export function createModelBindingService(options: {
  getConfig: () => AppConfig;
  /** 可选：磁盘配置仓储（防竞态重放，与 Web 面板并发保存互不覆盖）。 */
  store?: ConfigStore<AppConfig>;
  logger?: StructuredLogger;
  /** P1 第三批：绑定/档位变更回调——手动切换后清零状态机计数（同源联动，方案 §6.3）。 */
  onBindingChanged?: (purpose: string, slot: BindingSlot | 'override') => void;
  /** P1 第三批：运行时档位描述（粘滞/锁定状态，来自备用模型状态机）。 */
  runtimeStateText?: (purpose: string) => string;
}) {
  const { getConfig, store, logger } = options;
  const notifyChanged = (purpose: string, slot: BindingSlot | 'override') => {
    try { options.onBindingChanged?.(purpose, slot); } catch { /* 回调失败不影响切换 */ }
  };

  /** 静态读某配置里某用途的绑定对（reconcile 对账用；currentBinding 走实时 getConfig）。 */
  function bindingOf(config: AppConfig, purpose: PurposeDef, slot: BindingSlot): { model: string; nodeIndex: number } {
    // P2 通用化：备用与主绑定同容器读写（main 的备用落点 = agent.fallback*，与旧特判逐字节等价）。
    const obj = sectionOf(config, purpose.section);
    const nodeField = slot === 'secondary' ? purpose.fallbackNodeField : purpose.nodeField;
    const modelField = slot === 'secondary' ? purpose.fallbackModelField : purpose.modelField;
    return {
      model: String(obj?.[modelField] || ''),
      nodeIndex: Number(obj?.[nodeField] ?? 0) || 0,
    };
  }

  function currentBinding(purpose: PurposeDef, slot: BindingSlot): { model: string; nodeIndex: number } {
    return bindingOf(getConfig(), purpose, slot);
  }

  /**
   * 方案 B（2026-11-06 拍板）：外部写入（面板保存 → 热重载）后对账——某用途的主绑定或备用绑定
   * **真的变了**，才经 onBindingChanged 通知（→ 状态机按用途清零计数，切完立即生效，不等 120s 探测）。
   * 与 /切换 命令 / model.binding.switch 工具走**同一条通知通道**；其它字段变化不误清计数。
   * 调用方只需在配置引用更替（loadIfChanged 返回新对象）时传入前后两份。
   */
  function reconcileConfigChange(previous: AppConfig, next: AppConfig): void {
    for (const purpose of MODEL_BINDING_PURPOSES) {
      for (const slot of ['primary', 'secondary'] as const) {
        const before = bindingOf(previous, purpose, slot);
        const after = bindingOf(next, purpose, slot);
        if (before.model !== after.model || before.nodeIndex !== after.nodeIndex) {
          notifyChanged(purpose.key, slot);
        }
      }
    }
  }

  function setBinding(input: SetBindingInput): SetBindingResult {
    const purpose = findPurposeByKeyOrAlias(input.purpose);
    if (!purpose) {
      return {
        ok: false,
        kind: 'unknown_purpose',
        error: `未知用途「${input.purpose}」。可用用途：${MODEL_BINDING_PURPOSES.map((p) => p.label).join('、')}。`,
      };
    }
    const slot: BindingSlot = input.slot || 'primary';
    const scope: BindingScope = input.scope || 'persistent';
    if (scope === 'once') {
      // once = 请求级 override，依赖第 6 条状态机（本轮仅结构预留，未实现）——明确拒绝而非假装生效。
      return { ok: false, kind: 'unsupported_once', error: '「仅本次」切换依赖备用模型状态机（方案 6-P1），尚未实现；请使用持久切换（默认）。' };
    }
    if (slot === 'secondary' && !purpose.supportsSecondary) {
      // P2 起 11 用途全部支持备用；分支保留作为未来用途扩展的防御位。
      return { ok: false, kind: 'unsupported_secondary', error: `「${purpose.label}」暂不支持第二模型（备用）。` };
    }

    const config = getConfig();
    const candidates = findModelCandidates(config, input.target);
    if (!candidates.length) {
      return { ok: false, kind: 'not_found', error: `未找到模型：${input.target}（在已配置节点的模型列表里没有匹配）。可先在后台「模型与节点」拉取模型列表。` };
    }
    // 同名模型可能出现在多个节点：rank 最优组内多于一个 → 歧义（列出 候选@节点 让上层澄清）。
    const best = candidates[0];
    const bestGroup = candidates.filter((c) => c.model === best.model);
    if (bestGroup.length > 1) {
      const nodeNames = (config.llm.apiKeys || []).map((n, i) => n.name || `节点 ${i + 1}`);
      return {
        ok: false,
        kind: 'ambiguous_model',
        error: `「${input.target}」命中 ${bestGroup.length} 个节点上的同名模型，请指明节点。`,
        candidates: bestGroup.map((c) => `${c.model} @ ${nodeNames[c.nodeIndex] || `节点 ${c.nodeIndex + 1}`}`),
      };
    }
    if (best.rank === 2) {
      // 包含级模糊命中多个不同模型 → 歧义，列出候选（禁止猜）。
      const fuzzy = candidates.filter((c) => c.rank === 2).slice(0, 8);
      if (fuzzy.length > 1) {
        return { ok: false, kind: 'ambiguous_model', error: `「${input.target}」模糊命中多个模型，请明确完整名称：`, candidates: fuzzy.map((c) => c.model) };
      }
    }

    const from = currentBinding(purpose, slot);
    const targetNodeIndex = best.nodeIndex;

    // 变更闭包可重放：与面板并发保存时按磁盘最新配置重放同一变更（T2.6 防竞态模式）。
    const mutate = (c: AppConfig): string => {
      const root = c as unknown as Record<string, unknown>;
      const obj = sectionOf(c, purpose.section);
      if (!obj) return `配置路径 ${purpose.section || '(root)'} 不存在，切换失败。`;
      if (slot === 'secondary') {
        obj[purpose.fallbackNodeField] = targetNodeIndex;
        obj[purpose.fallbackModelField] = best.model;
      } else {
        obj[purpose.nodeField] = targetNodeIndex;
        obj[purpose.modelField] = best.model;
        if (purpose.key === 'main') {
          // 主对话双写旧字段：兼容所有仍读 llm.chatModel 的链路（修复旧命令只写旧字段被 agent.mainModel 短路的反向问题）。
          const llm = (root.llm = (root.llm as Record<string, unknown>) || {});
          llm.chatModel = best.model;
          llm.chatNodeIndex = targetNodeIndex;
        }
      }
      const slotLabel = slot === 'secondary' ? '备用模型' : '模型';
      return `已切换「${purpose.label}」${slotLabel}为 ${best.model}（原 ${from.model || '未设置'}）· 下一轮生效。`;
    };

    let reply: string;
    const mutated = mutate(config);
    if (mutated.includes('失败')) return { ok: false, kind: 'unknown_purpose', error: mutated };
    reply = mutated;
    if (store) {
      try {
        const fresh = store.loadIfChanged();
        if (fresh !== config) {
          mutate(fresh as AppConfig);
          try { store.save(fresh as AppConfig); } catch (error) {
            return { ok: false, kind: 'unknown_purpose', error: `配置保存失败：${String((error as Error)?.message || error)}` };
          }
          logger?.info('model.binding.switch 审计', {
            source: input.source, actorId: String(input.actorId || ''), purpose: purpose.key, slot,
            from: from.model || '', fromNodeIndex: from.nodeIndex, to: best.model, toNodeIndex: targetNodeIndex, scope,
          });
          notifyChanged(purpose.key, slot);
          return { ok: true, purpose: purpose.key, purposeLabel: purpose.label, slot, from: from.model, to: best.model, nodeIndex: targetNodeIndex, reply };
        }
      } catch { /* 重读失败按已变更的本份配置保存 */ }
      try { store.save(config); } catch (error) {
        return { ok: false, kind: 'unknown_purpose', error: `配置保存失败：${String((error as Error)?.message || error)}` };
      }
    }
    logger?.info('model.binding.switch 审计', {
      source: input.source, actorId: String(input.actorId || ''), purpose: purpose.key, slot,
      from: from.model || '', fromNodeIndex: from.nodeIndex, to: best.model, toNodeIndex: targetNodeIndex, scope,
    });
    notifyChanged(purpose.key, slot);
    return { ok: true, purpose: purpose.key, purposeLabel: purpose.label, slot, from: from.model, to: best.model, nodeIndex: targetNodeIndex, reply };
  }

  /**
   * P1 第三批（方案 §6.3）：手动档位锁。slot='secondary' 锁定备用（自动切换/试探完全让位）；
   * slot='primary' 或 null 解除锁定并清零失败计数（"手动切回主模型"）。
   * 仅主对话支持；锁定备用前必须已配置备用模型。与 setBinding 同一写入路径（防竞态重放 + 审计）。
   */
  function setOverride(input: { slot: 'primary' | 'secondary' | null; source: 'command' | 'tool'; actorId: string }): { ok: true; reply: string } | { ok: false; error: string } {
    const config = getConfig();
    const agent = (config as unknown as { agent?: Record<string, unknown> }).agent || {};
    const hasSecondary = Boolean(String(agent.fallbackModel || '').trim());
    if (input.slot === 'secondary' && !hasSecondary) {
      return { ok: false, error: '尚未配置备用模型（agent.fallbackModel 为空），无法锁定备用。请先用 /切换 备 {模型名} 配置。' };
    }
    const mutate = (c: AppConfig): string => {
      const root = c as unknown as { agent?: Record<string, unknown> };
      const target = (root.agent = root.agent || {});
      if (input.slot === 'secondary') {
        target.modelOverride = 'secondary';
        return '已手动锁定备用模型：自动切换与试探让位，请求直接走备用。用 /切换 锁定 主 或 /切换 解锁 可恢复自动。';
      }
      delete target.modelOverride;
      return '已解除档位锁定并清零失败计数：恢复自动切换（主模型优先，失败自动切备）。';
    };
    const reply = mutate(config);
    if (store) {
      try {
        const fresh = store.loadIfChanged();
        if (fresh !== config) mutate(fresh as AppConfig);
        store.save(fresh === config ? config : (fresh as AppConfig));
      } catch {
        try { store.save(config); } catch { /* best-effort：与 setBinding 同语义 */ }
      }
    }
    logger?.info('model.binding.override 审计', {
      source: input.source, actorId: String(input.actorId || ''), purpose: 'main',
      slot: input.slot ?? 'auto', scope: 'persistent',
    });
    notifyChanged('main', 'override');
    return { ok: true, reply };
  }

  /** 各用途当前绑定 + 档位状态（命令 /切换 状态 与 /模型 共用）。 */
  function getStatusText(): string {
    const config = getConfig();
    const lines: string[] = ['【模型绑定状态】'];
    for (const purpose of MODEL_BINDING_PURPOSES) {
      const primary = currentBinding(purpose, 'primary');
      const nodeNames = (config.llm.apiKeys || []).map((n, i) => n.name || `节点 ${i + 1}`);
      const primaryText = primary.model ? `${primary.model} @ ${nodeNames[primary.nodeIndex] || `节点 ${primary.nodeIndex + 1}`}` : '（未设置）';
      if (purpose.supportsSecondary) {
        const secondary = currentBinding(purpose, 'secondary');
        const secondaryText = secondary.model ? `${secondary.model} @ ${nodeNames[secondary.nodeIndex] || `节点 ${secondary.nodeIndex + 1}`}` : '（未设置）';
        // P1 第三批：附运行时档位状态（粘滞/锁定，来自状态机注入）。
        const runtimeText = safeRuntimeText(purpose.key);
        lines.push(`- ${purpose.label}：主 ${primaryText}｜备 ${secondaryText}${runtimeText}`);
      } else {
        lines.push(`- ${purpose.label}：${primaryText}`);
      }
    }
    lines.push('提示：/切换 {用途} {模型名} 切换主模型；/切换 {用途} 备 {模型名} 设备用；/切换 锁定 备|主 或 /切换 解锁 手动档位（仅主对话）；/切换 状态 查看本页。');
    return lines.join('\n');
  }

  function safeRuntimeText(purposeKey: string): string {
    try { return options.runtimeStateText?.(purposeKey) || ''; } catch { return ''; }
  }

  return { setBinding, setOverride, getStatusText, currentBinding, reconcileConfigChange };
}

export type ModelBindingService = ReturnType<typeof createModelBindingService>;
