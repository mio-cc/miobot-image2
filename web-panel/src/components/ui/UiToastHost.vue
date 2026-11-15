<script setup lang="ts">
/**
 * UiToastHost —— toast 渲染宿主（Teleport 到 body，堆叠在右上角）。
 *
 * 交互细节：
 * - 进场从右侧滑入 + 淡入；离场淡出 + 轻微右移（不抢视线）。
 * - 底部有倒计时进度条（duration=0 时不显示），悬停暂停 —— 用户想看时不会溜走。
 * - 单条可手动关闭；点动作按钮后立即消失。
 * - aria-live="polite"：读屏会播报，但不打断当前朗读。
 */
import { onBeforeUnmount, ref, watch } from 'vue';
import { dismissToast, toastItems, type ToastItem } from './useToast';

/** 每条 toast 的剩余时间与暂停状态（按 id 记录，避免污染 toast 数据本身）。 */
const timers = new Map<number, { handle: number; remaining: number; startedAt: number }>();
const paused = ref(new Set<number>());

function schedule(item: ToastItem) {
    if (item.duration <= 0 || timers.has(item.id)) return;
    const startedAt = Date.now();
    const handle = window.setTimeout(() => {
        timers.delete(item.id);
        dismissToast(item.id);
    }, item.duration);
    timers.set(item.id, { handle, remaining: item.duration, startedAt });
}

/** 新 toast 进场即开始倒计时；已消失的清掉计时器（防止泄漏）。 */
watch(
    () => toastItems.value.map((t: ToastItem) => t.id),
    (ids: number[]) => {
        for (const item of toastItems.value) {
            if (ids.includes(item.id)) schedule(item);
        }
        for (const id of [...timers.keys()]) {
            if (!ids.includes(id)) {
                window.clearTimeout(timers.get(id)!.handle);
                timers.delete(id);
            }
        }
    },
    { immediate: true, deep: false },
);

function pause(item: ToastItem) {
    const t = timers.get(item.id);
    if (!t) return;
    window.clearTimeout(t.handle);
    t.remaining = Math.max(0, t.remaining - (Date.now() - t.startedAt));
    paused.value = new Set(paused.value).add(item.id);
}

function resume(item: ToastItem) {
    const t = timers.get(item.id);
    if (!t) return;
    const next = new Set(paused.value);
    next.delete(item.id);
    paused.value = next;
    t.startedAt = Date.now();
    t.handle = window.setTimeout(() => {
        timers.delete(item.id);
        dismissToast(item.id);
    }, t.remaining);
}

function close(item: ToastItem) {
    const t = timers.get(item.id);
    if (t) window.clearTimeout(t.handle);
    timers.delete(item.id);
    dismissToast(item.id);
}

function runAction(item: ToastItem) {
    item.action?.();
    close(item);
}

onBeforeUnmount(() => {
    for (const t of timers.values()) window.clearTimeout(t.handle);
    timers.clear();
});
</script>

<template>
  <Teleport to="body">
    <div class="toasts" aria-live="polite" aria-atomic="false">
      <TransitionGroup name="toast">
        <div
          v-for="item in toastItems"
          :key="item.id"
          class="toast"
          :class="`toast--${item.tone}`"
          role="status"
          @mouseenter="pause(item)"
          @mouseleave="resume(item)"
        >
          <span class="toast__icon" aria-hidden="true">
            <svg v-if="item.tone === 'good'" viewBox="0 0 14 14" width="13" height="13"><path d="M2.5 7.4l3 3 6-6.4" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>
            <svg v-else-if="item.tone === 'crit'" viewBox="0 0 14 14" width="13" height="13"><circle cx="7" cy="7" r="5.4" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M7 4v3.6M7 9.8v.1" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>
            <svg v-else-if="item.tone === 'warn'" viewBox="0 0 14 14" width="13" height="13"><path d="M7 1.8l5.6 9.8H1.4z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M7 5.6v2.6M7 9.8v.1" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
            <svg v-else viewBox="0 0 14 14" width="13" height="13"><circle cx="7" cy="7" r="5.4" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M7 6.2v3.4M7 4.2v.1" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>
          </span>

          <span class="toast__msg">{{ item.message }}</span>

          <button
            v-if="item.actionLabel"
            type="button"
            class="toast__action"
            @click="runAction(item)"
          >{{ item.actionLabel }}</button>

          <button type="button" class="toast__x" aria-label="关闭提示" @click="close(item)">
            <svg viewBox="0 0 10 10" width="8" height="8"><path d="M2.5 2.5l5 5M7.5 2.5l-5 5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
          </button>

          <span
            v-if="item.duration > 0"
            class="toast__bar"
            :class="{ 'is-paused': paused.has(item.id) }"
            :style="{ animationDuration: `${item.duration}ms` }"
            aria-hidden="true"
          />
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>

<style scoped>
.toasts {
  position: fixed;
  top: 14px;
  right: 14px;
  z-index: 400;
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: min(360px, calc(100vw - 28px));
  pointer-events: none;
}

.toast {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 9px 10px 10px;
  border: 1px solid var(--hairline-2);
  border-radius: 10px;
  background: var(--surface);
  box-shadow: var(--sh-2);
  color: var(--ink);
  font-size: 12px;
  line-height: 1.5;
  overflow: hidden;
  pointer-events: auto;
}

.toast__icon { flex: none; margin-top: 1px; color: var(--ink-3); }
.toast--good .toast__icon { color: var(--good); }
.toast--crit .toast__icon { color: var(--critical); }
.toast--warn .toast__icon { color: var(--warning); }
.toast--info .toast__icon { color: var(--accent); }

.toast--good { border-color: color-mix(in srgb, var(--good) 30%, var(--hairline-2)); }
.toast--crit { border-color: color-mix(in srgb, var(--critical) 30%, var(--hairline-2)); }
.toast--warn { border-color: color-mix(in srgb, var(--warning) 30%, var(--hairline-2)); }

.toast__msg { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }

.toast__action {
  flex: none;
  border: 0;
  background: transparent;
  color: var(--accent);
  font-size: 11.5px;
  font-weight: 600;
  cursor: pointer;
  padding: 0 2px;
  border-radius: 4px;
}
.toast__action:hover { text-decoration: underline; }
.toast__action:focus-visible { box-shadow: var(--focus-ring); }

.toast__x {
  flex: none;
  display: grid;
  place-items: center;
  width: 16px; height: 16px;
  margin-top: 1px;
  border: 0; border-radius: 4px;
  background: transparent;
  color: var(--ink-3);
  cursor: pointer;
  transition: background var(--dur-1) var(--ease), color var(--dur-1) var(--ease);
}
.toast__x:hover { background: var(--surface-2); color: var(--ink); }
.toast__x:focus-visible { box-shadow: var(--focus-ring); }

/* 倒计时条：贴在底边，颜色跟随语义 */
.toast__bar {
  position: absolute;
  left: 0;
  bottom: 0;
  height: 2px;
  width: 100%;
  transform-origin: left center;
  background: var(--accent);
  animation: toast-countdown linear forwards;
}
.toast--good .toast__bar { background: var(--good); }
.toast--crit .toast__bar { background: var(--critical); }
.toast--warn .toast__bar { background: var(--warning); }
.toast__bar.is-paused { animation-play-state: paused; }

@keyframes toast-countdown {
  from { transform: scaleX(1); }
  to { transform: scaleX(0); }
}

/* 进出场：右侧滑入，离场轻微右移淡出 */
.toast-enter-active { transition: opacity var(--dur-3) var(--ease-out-expo), transform var(--dur-3) var(--ease-out-expo); }
.toast-leave-active { transition: opacity var(--dur-2) var(--ease-swift), transform var(--dur-2) var(--ease-swift); position: absolute; right: 0; width: 100%; }
.toast-enter-from { opacity: 0; transform: translateX(16px); }
.toast-leave-to { opacity: 0; transform: translateX(12px); }
.toast-move { transition: transform var(--dur-3) var(--ease-out-expo); }

@media (prefers-reduced-motion: reduce) {
  .toast-enter-active, .toast-leave-active, .toast-move { transition: none; }
  .toast__bar { animation: none; transform: scaleX(1); opacity: .35; }
}
</style>
