<script setup lang="ts">
/**
 * UiModal —— 模态框。
 * Teleport 到 body；遮罩 blur 淡入；内容 translateY+scale 入场；Esc 关闭；
 * 焦点陷阱（Tab 循环）；打开时锁 body 滚动并补偿滚动条宽度；关闭后焦点归还触发元素。
 */
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';

const props = withDefaults(defineProps<{
    title?: string;
    description?: string;
    size?: 'sm' | 'md' | 'lg';
    closable?: boolean;
    /** 点遮罩不关闭 */
    persistent?: boolean;
}>(), {
    title: '',
    description: '',
    size: 'md',
    closable: true,
    persistent: false,
});

const open = defineModel<boolean>('modelValue', { default: false });
const emit = defineEmits<{ close: []; opened: [] }>();

const panelEl = ref<HTMLElement | null>(null);
let lastFocused: HTMLElement | null = null;
let prevOverflow = '';
let prevPaddingRight = '';

function lockScroll() {
    const body = document.body;
    prevOverflow = body.style.overflow;
    prevPaddingRight = body.style.paddingRight;
    const gap = window.innerWidth - document.documentElement.clientWidth;
    body.style.overflow = 'hidden';
    if (gap > 0) body.style.paddingRight = `${gap}px`;
}

function unlockScroll() {
    document.body.style.overflow = prevOverflow;
    document.body.style.paddingRight = prevPaddingRight;
}

function close() {
    if (!props.closable) return;
    open.value = false;
    emit('close');
}

function onMaskClick() {
    if (!props.persistent) close();
}

function focusables(): HTMLElement[] {
    const root = panelEl.value;
    if (!root) return [];
    return Array.from(root.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )).filter(el => el.offsetParent !== null);
}

function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key !== 'Tab') return;
    const list = focusables();
    if (!list.length) return;
    const first = list[0];
    const last = list[list.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

watch(open, async (v) => {
    if (v) {
        lastFocused = document.activeElement as HTMLElement | null;
        lockScroll();
        await nextTick();
        (focusables()[0] ?? panelEl.value)?.focus();
        emit('opened');
    } else {
        unlockScroll();
        lastFocused?.focus?.();
        lastFocused = null;
    }
});

onBeforeUnmount(() => { if (open.value) unlockScroll(); });
</script>

<template>
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="open" class="modal" role="presentation" @keydown="onKeydown">
        <div class="modal__mask" @click="onMaskClick" />
        <div
          ref="panelEl"
          class="modal__panel"
          :class="`modal__panel--${size}`"
          role="dialog"
          aria-modal="true"
          :aria-label="title || undefined"
          :aria-describedby="description ? 'ui-modal-desc' : undefined"
          tabindex="-1"
        >
          <header v-if="title || $slots.header || closable" class="modal__head">
            <slot name="header">
              <div class="min-w-0">
                <h2 v-if="title" class="modal__title">{{ title }}</h2>
                <p v-if="description" id="ui-modal-desc" class="modal__desc">{{ description }}</p>
              </div>
            </slot>
            <button v-if="closable" type="button" class="modal__x" aria-label="关闭" @click="close">
              <svg viewBox="0 0 14 14" width="12" height="12"><path d="M3.5 3.5l7 7M10.5 3.5l-7 7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg>
            </button>
          </header>

          <div class="modal__body"><slot /></div>

          <footer v-if="$slots.footer" class="modal__foot"><slot name="footer" /></footer>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.modal {
  position: fixed;
  inset: 0;
  z-index: 200;
  display: grid;
  place-items: center;
  padding: 20px;
}

.modal__mask {
  position: absolute;
  inset: 0;
  background: rgba(18, 19, 16, .32);
  backdrop-filter: blur(4px);
}

.modal__panel {
  position: relative;
  display: flex;
  flex-direction: column;
  width: 100%;
  max-height: calc(100dvh - 40px);
  border: 1px solid var(--hairline-2);
  border-radius: 14px;
  background: var(--surface);
  box-shadow: var(--sh-pop);
  outline: none;
  overflow: hidden;
}
.modal__panel--sm { max-width: 380px; }
.modal__panel--md { max-width: 540px; }
.modal__panel--lg { max-width: 760px; }

.modal__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--hairline-2);
  flex: none;
}
.modal__title { margin: 0; font-family: var(--serif); font-size: 14px; font-weight: 600; color: var(--ink); }
.modal__desc { margin: 3px 0 0; font-size: 11.5px; color: var(--ink-3); line-height: 1.5; }

.modal__x {
  flex: none;
  display: grid;
  place-items: center;
  width: 24px; height: 24px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--ink-3);
  cursor: pointer;
  transition: background var(--dur-1) var(--ease), color var(--dur-1) var(--ease), border-color var(--dur-1) var(--ease);
}
.modal__x:hover { background: var(--surface-2); border-color: var(--hairline-2); color: var(--ink); }
.modal__x:focus-visible { box-shadow: var(--focus-ring); }

.modal__body { padding: 16px; overflow-y: auto; min-height: 0; flex: 1 1 auto; }

.modal__foot {
  display: flex; justify-content: flex-end; gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--hairline-2);
  background: var(--surface-2);
  flex: none;
}

/* 进出场：遮罩淡入，面板位移+缩放入场（--ease-out-expo 300ms） */
.modal-enter-active .modal__mask, .modal-leave-active .modal__mask {
  transition: opacity var(--dur-3) var(--ease-swift);
}
.modal-enter-from .modal__mask, .modal-leave-to .modal__mask { opacity: 0; }

.modal-enter-active .modal__panel { transition: opacity var(--dur-3) var(--ease-out-expo), transform var(--dur-3) var(--ease-out-expo); }
.modal-leave-active .modal__panel { transition: opacity var(--dur-2) var(--ease-swift), transform var(--dur-2) var(--ease-swift); }
.modal-enter-from .modal__panel { opacity: 0; transform: translateY(8px) scale(.98); }
.modal-leave-to .modal__panel { opacity: 0; transform: translateY(-4px) scale(.99); }

@media (prefers-reduced-motion: reduce) {
  .modal-enter-active .modal__mask, .modal-leave-active .modal__mask,
  .modal-enter-active .modal__panel, .modal-leave-active .modal__panel { transition: none; }
}
</style>
