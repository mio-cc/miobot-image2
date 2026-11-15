/**
 * 全局 toast 通知（无依赖，模块级单例）。
 *
 * 为什么不用第三方：控制台只需要「保存成功 / 导入失败 / 已复制」这类短反馈，
 * 引入一个 toast 库只为这点功能不划算，而且样式还得跟宣纸主题对齐。
 *
 * 用法：
 *   import { pushToast } from '../components/ui/useToast';
 *   pushToast('配置已保存', 'good');
 *   pushToast('导入失败：格式不合法', 'crit', { duration: 6000 });
 *
 * 渲染：由 <UiToastHost /> 负责（AppShell 里挂一次即可）。
 */
import { readonly, ref } from 'vue';

export type ToastTone = 'good' | 'crit' | 'warn' | 'info';

export interface ToastItem {
    id: number;
    message: string;
    tone: ToastTone;
    /** 毫秒；0 = 不自动消失 */
    duration: number;
    /** 可选单行动作，如「撤销」 */
    actionLabel?: string;
    action?: () => void;
}

const items = ref<ToastItem[]>([]);
let seq = 0;

/** 同时最多保留 4 条，超出丢弃最旧的，避免刷屏盖住界面。 */
const MAX_VISIBLE = 4;

export function pushToast(
    message: string,
    tone: ToastTone = 'info',
    options: { duration?: number; actionLabel?: string; action?: () => void } = {},
): number {
    const id = ++seq;
    const item: ToastItem = {
        id,
        message,
        tone,
        duration: options.duration ?? (tone === 'crit' ? 6000 : 3200),
        actionLabel: options.actionLabel,
        action: options.action,
    };
    items.value = [...items.value, item];
    if (items.value.length > MAX_VISIBLE) {
        items.value = items.value.slice(items.value.length - MAX_VISIBLE);
    }
    return id;
}

export function dismissToast(id: number) {
    items.value = items.value.filter(t => t.id !== id);
}

export function clearToasts() {
    items.value = [];
}

/** 只读视图，给 UiToastHost 用；外部不应直接改数组。 */
export const toastItems = readonly(items);
