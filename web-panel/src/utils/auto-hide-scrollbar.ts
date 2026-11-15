/**
 * useAutoHideScrollbar —— 滚动条「滚动时出现、静止后消失」。
 *
 * 为什么需要 JS：CSS 只能做「悬停显示」，做不到「滚动结束后 N 秒自动隐藏」。
 * 主流控制台（Linear / Notion / SnowLuma 的 Radix ScrollArea）都是这个行为：
 * 滚动条是 transient 的反馈，而不是常驻的装饰。
 *
 * 实现要点：
 * - 在容器上切 class（is-scrolling），样式在 CSS 里控制 thumb 的可见性。
 * - 滚动中不断重置计时器；停止 1.2s 后移除 class。
 * - 容器自身悬停时保持可见（用户可能想拖滚动条），移开后重新计时。
 * - 尊重 prefers-reduced-motion：不改变行为，但过渡由 CSS 侧降级。
 * - 自动清理：卸载时移除监听与计时器。
 */
import { onBeforeUnmount, ref, watch, type Ref } from 'vue';

export interface AutoHideScrollbarOptions {
    /** 停止滚动后多久隐藏（ms） */
    idleMs?: number;
    /**
     * 容器悬停时是否保持可见。默认 false ——
     * 需求是「只有滚动时才出现」，鼠标停在里面不该让滚动条常驻，
     * 否则指针一进入内容区滚动条就再也不消失了。
     * （早期版本默认 true，正是这个导致「鼠标放在里面就一直存在」。）
     */
    showOnHover?: boolean;
}

export function useAutoHideScrollbar(
    elRef: Ref<HTMLElement | null>,
    options: AutoHideScrollbarOptions = {},
) {
    const { idleMs = 1200, showOnHover = false } = options;

    const scrolling = ref(false);
    const hovering = ref(false);
    /** 真正决定是否显示滚动条：滚动中，或（允许时）悬停中 */
    const visible = ref(false);

    let timer: number | null = null;
    let bound: HTMLElement | null = null;

    function sync() {
        visible.value = scrolling.value || (showOnHover && hovering.value);
    }

    function clearTimer() {
        if (timer != null) {
            window.clearTimeout(timer);
            timer = null;
        }
    }

    function onScroll() {
        scrolling.value = true;
        sync();
        clearTimer();
        timer = window.setTimeout(() => {
            scrolling.value = false;
            sync();
        }, idleMs);
    }

    function onEnter() {
        if (!showOnHover) return;
        hovering.value = true;
        sync();
    }

    function onLeave() {
        if (!showOnHover) return;
        hovering.value = false;
        sync();
    }

    function bind(el: HTMLElement | null) {
        if (bound === el) return;
        unbind();
        if (!el) return;
        bound = el;
        el.addEventListener('scroll', onScroll, { passive: true });
        // 只有显式要求「悬停保持可见」时才挂指针事件，否则纯滚动驱动
        if (showOnHover) {
            el.addEventListener('pointerenter', onEnter);
            el.addEventListener('pointerleave', onLeave);
        }
    }

    function unbind() {
        if (!bound) return;
        bound.removeEventListener('scroll', onScroll);
        bound.removeEventListener('pointerenter', onEnter);
        bound.removeEventListener('pointerleave', onLeave);
        bound = null;
    }

    watch(elRef, (el) => bind(el), { immediate: true });

    onBeforeUnmount(() => {
        clearTimer();
        unbind();
    });

    return { visible, scrolling };
}
