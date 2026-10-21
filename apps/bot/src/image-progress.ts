export type ImageProgressKind = 'image.generate' | 'image.edit' | 'image.interrogate' | 'video.generate' | 'audio.music.generate';

export interface ImageProgressOptions {
  kind?: ImageProgressKind;
  /** 历史平均耗时（毫秒）；为空表示还没有样本。 */
  averageMs?: number;
  /** 自定义进度文本；支持 {action} 和 {eta} 占位符。 */
  text?: string;
  /** 发送进度文本；失败不应影响主任务。 */
  send: (text: string) => Promise<unknown> | unknown;
  /** 长时间未完成时提醒一次；默认 60 秒，0 关闭。 */
  reminderAfterMs?: number;
  now?: () => number;
  logger?: { info(message: string, data?: Record<string, unknown>): void; warn(message: string, data?: Record<string, unknown>): void };
}

export interface ImageProgressHandle {
  done(): void;
}

const LABELS: Record<ImageProgressKind, string> = {
  'image.generate': '图片生成',
  'image.edit': '图片处理',
  'image.interrogate': '图片分析',
  'video.generate': '视频生成',
  'audio.music.generate': '音乐生成',
};

export function imageProgressLabel(kind: ImageProgressKind = 'image.generate'): string {
  return LABELS[kind] || LABELS['image.generate'];
}

/** 把历史平均耗时变成适合聊天展示的预估区间。 */
export function formatImageEta(averageMs?: number): string {
  if (!averageMs || !Number.isFinite(averageMs) || averageMs < 5_000) return '';
  const low = Math.max(5, Math.round((averageMs * 0.7) / 1000));
  const high = Math.max(low + 3, Math.round((averageMs * 1.35) / 1000));
  return `，通常约 ${low}-${high} 秒`;
}

/** 慢任务提醒；只提醒一次，结束时取消。 */
export function renderImageProgressText(template: string, kind: ImageProgressKind, averageMs?: number): string {
  const label = imageProgressLabel(kind);
  const eta = formatImageEta(averageMs);
  let text = String(template || '').trim() || '收到，正在{action}{eta}，请稍候…';
  text = text.replaceAll('{action}', label);
  if (eta) {
    text = text.replaceAll('{eta}', eta);
  } else {
    text = text
      .replace(/[，,]?\s*(?:大概|大约|预计|通常)?\s*\{eta\}/g, '')
      .replace(/\{eta\}/g, '')
      .replace(/(?:大概|大约|预计|通常)\s*([，,。！？!?]?)$/g, '$1');
  }
  text = text.replace(/[，,]\s*([。！？!?])/g, '$1').replace(/[，,]{2,}/g, '，').replace(/\s{2,}/g, ' ').trim();
  if (!text || /^(?:大概|大约|预计|通常)$/.test(text)) text = '收到，正在' + label + '，请稍候…';
  else if (!/[。！？!?…]$/.test(text)) text += '，请稍候…';
  return text;
}
export function createImageProgress(options: ImageProgressOptions): ImageProgressHandle {
  const kind = options.kind || 'image.generate';
  const label = imageProgressLabel(kind);
  const startedAt = (options.now || Date.now)();
  const template = String(options.text || '').trim() || '收到，正在{action}{eta}，请稍候…';
  const initial = renderImageProgressText(template, kind, options.averageMs);

  let done = false;
  void Promise.resolve(options.send(initial)).catch((error) => {
    options.logger?.warn('生图进度消息发送失败', { error: String((error as Error)?.message || error) });
  });

  const reminderAfterMs = Math.max(0, Math.trunc(options.reminderAfterMs ?? 60_000));
  const timer = reminderAfterMs > 0
    ? setTimeout(() => {
        if (done) return;
        const elapsed = Math.max(1, Math.round(((options.now || Date.now)() - startedAt) / 1000));
        const remaining = options.averageMs && options.averageMs > elapsed * 1000
          ? `，预计还需约 ${Math.max(5, Math.round((options.averageMs - elapsed * 1000) / 1000))} 秒`
          : '';
        void Promise.resolve(options.send(`还在${label}中，已等待 ${elapsed} 秒${remaining}，请稍候…`)).catch((error) => {
          options.logger?.warn('生图进度提醒发送失败', { error: String((error as Error)?.message || error) });
        });
      }, reminderAfterMs)
    : undefined;
  timer?.unref?.();

  return {
    done() {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
    },
  };
}
