/** 主人(owner)命令——独立的 owner-only 通道。纯解析,无 I/O,可单测。 */
export type OwnerCommand =
  | { command: 'modelList' }
  | { command: 'switchModel'; code: string; purpose: string; slot: 'primary' | 'secondary' }
  | { command: 'switchModelStatus' }
  /** P1 第三批：手动档位锁（方案 §6.3）——slot='primary' 表示解锁/切回主（清零计数）。 */
  | { command: 'switchModelLock'; slot: 'primary' | 'secondary' }
  | { command: 'ttsOn' }
  | { command: 'ttsOff' }
  | { command: 'switchTtsVoice'; index: number }
  | { command: 'recall'; count: number }
  | { command: 'blacklist'; targetUserId: string }
  | { command: 'whitelist'; targetUserId: string }
  /** T3.7：高危命令的二次确认指令（/ok 或 /确认）。 */
  | { command: 'confirm' };

export interface OwnerParseContext {
  chatType: 'group' | 'private';
  /** 被 @ 的 QQ 列表(用于群里 拉黑/拉白 选目标、判断是否点名 bot)。 */
  mentions?: string[];
  botId?: string | number;
}

export function isOwner(userId: string | number | undefined, ownerQQs: Array<string | number> = []): boolean {
  const id = String(userId ?? '').trim();
  if (!id) return false;
  return ownerQQs.map((o) => String(o ?? '').trim()).filter(Boolean).includes(id);
}

/** /切换 命令的用途触发词（与 model-binding.ts MODEL_BINDING_PURPOSES 的 keywords 同源子集，解析层独立于服务层）。 */
export const MODEL_SWITCH_PURPOSE_WORDS = [
  '主对话', '主模型', 'main', '聊天', '对话',
  '润色', '提示词润色', 'enhance',
  '图片', '生图', '画图', 'image',
  '改图', '编辑', 'edit',
  '反推', '看图', 'interrogate',
  '音乐', '作曲', 'suno',
  '视频', 'video',
  '代码', '代码渲染', 'code',
  '参数', '参数转化', 'comfyui',
  '语音', 'tts',
  '触发', '触发判定', 'trigger',
  '记忆', 'memory',
];

/** 解析主人命令(沿用旧脚本语义:/拉黑 /拉白 /撤回 /ttsk /ttsg /tts.N /模型 /切换X)。 */
export function parseOwnerCommand(text: string, ctx: OwnerParseContext): OwnerCommand | undefined {
  const t = String(text || '').trim();
  const botQq = String(ctx.botId ?? '').trim();
  const mentions = (ctx.mentions || []).map((m) => String(m ?? '').trim());
  const addressedToBot = ctx.chatType === 'private' || (Boolean(botQq) && mentions.includes(botQq));

  const listMatch = t.match(/(?:^|\s)\/\s*(拉黑|拉白)(?:\s|$)/i);
  if (listMatch) {
    const target = mentions.find((id) => id && id !== botQq) || '';
    return { command: listMatch[1] === '拉黑' ? 'blacklist' : 'whitelist', targetUserId: target };
  }

  if (!addressedToBot) return undefined;

  // ch：撤回当前聊天最近一条机器人消息；plch [n]：撤回最近 n 条，默认 5 条。斜杠必需，避免句中独立的 ch/plch 单词误触发。
  const ch = t.match(/(?:^|\s)\/ch(?:\s|$)/i);
  if (ch) return { command: 'recall', count: 1 };
  const plch = t.match(/(?:^|\s)\/plch(?:\s+(\d{1,3}))?(?:\s|$)/i);
  if (plch) return { command: 'recall', count: Math.max(1, Math.min(50, Number.parseInt(plch[1] || '5', 10) || 5)) };

  const recall = t.match(/(?:^|\s)\/\s*(?:撤回|c)\s*(\d+)?(?:\s|$)/i);
  if (recall) return { command: 'recall', count: Math.max(1, Math.min(20, Number.parseInt(recall[1] || '1', 10) || 1)) };

  const ttsToggle = t.match(/(?:^|\s)\/\s*(ttsk|ttsg)(?:\s|$)/i);
  if (ttsToggle) return { command: ttsToggle[1].toLowerCase() === 'ttsk' ? 'ttsOn' : 'ttsOff' };

  const ttsVoice = t.match(/(?:^|\s)\/\s*tts\.(\d{1,2})(?:\s|$)/i);
  if (ttsVoice) return { command: 'switchTtsVoice', index: Math.max(1, Number.parseInt(ttsVoice[1], 10) || 1) };

  const modelList = t.match(/(?:^|\s)\/\s*(?:模型|模型列表|models?|model\s+list)(?:\s|$)/i);
  if (modelList) return { command: 'modelList' };

  // 模型切换（旧项目 slash+关键词风格，owner-only 通道，不进 LEGACY_DIRECT_GROUP_COMMANDS）：
  //   /切换 状态                      → 查看各用途绑定与档位
  //   /切换 X                        → 主对话主模型（旧语法兼容，默认用途）
  //   /切换 备 X                     → 主对话备用模型（agent.fallbackModel）
  //   /切换 {用途} X                  → 指定用途主模型（用途词见 MODEL_SWITCH_PURPOSE_WORDS）
  //   /切换 {用途} 备 X               → 指定用途备用模型（P2 起全部用途支持；档位锁定仍仅主对话）
  //   /切换 锁定 备|主 / /切换 解锁    → 手动档位锁（P1 第三批，仅主对话；锁主/解锁 = 清零计数回自动）
  const switchMatch = t.match(/(?:^|\s)\/\s*(?:切换|q)\s+(.+?)\s*$/i);
  if (switchMatch) {
    const rest = String(switchMatch[1] || '').trim();
    if (rest === '状态' || rest.toLowerCase() === 'status') return { command: 'switchModelStatus' };
    // 档位锁定要在通用 token 解析之前：否则「锁定 备」会被拆成 target=锁定 + slot=备。
    if (rest === '解锁' || rest.toLowerCase() === 'unlock') return { command: 'switchModelLock', slot: 'primary' };
    const lockMatch = rest.match(/^(?:锁定|锁|lock)\s+(主|备|primary|secondary|backup)$/i);
    if (lockMatch) {
      const slot = /^(备|secondary|backup)$/i.test(lockMatch[1]) ? 'secondary' as const : 'primary' as const;
      return { command: 'switchModelLock', slot };
    }
    const tokens = rest.split(/\s+/);
    // 识别用途词与"备"档位（词序：[用途] [备] 目标 —— 兼容 /切换 备 X 与 /切换 {用途} 备 X）。
    let purpose = 'main';
    let slot: 'primary' | 'secondary' = 'primary';
    const targetTokens: string[] = [];
    for (const token of tokens) {
      if (token === '备' || token.toLowerCase() === 'secondary' || token.toLowerCase() === 'backup') { slot = 'secondary'; continue; }
      const matched = MODEL_SWITCH_PURPOSE_WORDS.find((word) => word.toLowerCase() === token.toLowerCase());
      if (matched && !targetTokens.length) { purpose = token; continue; }
      targetTokens.push(token);
    }
    if (!targetTokens.length) {
      // 只有用途词没有目标 → 不猜，交由上层回用法提示。
      return { command: 'switchModel', code: '', purpose, slot };
    }
    return { command: 'switchModel', code: targetTokens.join(' ').toLowerCase().replace(/_/g, '.'), purpose, slot };
  }

  // T3.7：高危命令二次确认指令。
  const confirm = t.match(/(?:^|\s)\/\s*(?:ok|确认)(?:\s|$)/i);
  if (confirm) return { command: 'confirm' };

  return undefined;
}
