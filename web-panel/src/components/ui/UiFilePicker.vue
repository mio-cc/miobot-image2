<script setup lang="ts">
/**
 * UiFilePicker —— 文件选择（替代裸 input[type=file] + 自绘按钮）。
 * 内部封装隐藏 input；dropzone 变体支持拖放（drag 时描边转 accent、图标上浮）。
 */
import { computed, ref } from 'vue';

const props = withDefaults(defineProps<{
    accept?: string;
    disabled?: boolean;
    label?: string;
    hint?: string;
    multiple?: boolean;
    variant?: 'button' | 'dropzone';
    /** 已选文件名回显（受控时由外部传入） */
    fileName?: string;
    ariaLabel?: string;
}>(), {
    accept: '',
    disabled: false,
    label: '选择文件',
    hint: '',
    multiple: false,
    variant: 'button',
    fileName: '',
    ariaLabel: '',
});

const emit = defineEmits<{
    select: [file: File];
    change: [files: FileList];
    clear: [];
}>();

const inputEl = ref<HTMLInputElement | null>(null);
const pickedName = ref('');
const pickedSize = ref(0);
const dragging = ref(false);

const shownName = computed(() => props.fileName || pickedName.value);
const shownSize = computed(() => {
    const n = pickedSize.value;
    if (!n) return '';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
});

function open() {
    if (props.disabled) return;
    inputEl.value?.click();
}

function adopt(files: FileList | null) {
    if (!files || !files.length) return;
    const first = files[0];
    pickedName.value = props.multiple && files.length > 1
        ? `${first.name} 等 ${files.length} 个文件`
        : first.name;
    pickedSize.value = Array.from(files).reduce((n, f) => n + f.size, 0);
    emit('select', first);
    emit('change', files);
}

function onChange(e: Event) {
    const input = e.target as HTMLInputElement;
    adopt(input.files);
    // 允许再次选择同一文件
    input.value = '';
}

function onDrop(e: DragEvent) {
    dragging.value = false;
    if (props.disabled) return;
    adopt(e.dataTransfer?.files ?? null);
}

function clear(ev?: Event) {
    ev?.stopPropagation();
    pickedName.value = '';
    pickedSize.value = 0;
    emit('clear');
}
</script>

<template>
  <div class="picker" :class="[`picker--${variant}`, { 'is-disabled': disabled, 'is-dragging': dragging }]">
    <input
      ref="inputEl"
      class="picker__native"
      type="file"
      :accept="accept"
      :multiple="multiple"
      :disabled="disabled"
      tabindex="-1"
      aria-hidden="true"
      @change="onChange"
    />

    <!-- button 变体：紧凑按钮 + 已选回显 -->
    <template v-if="variant === 'button'">
      <button
        type="button"
        class="picker__btn btn-outline"
        :disabled="disabled"
        :aria-label="ariaLabel || label"
        @click="open"
      >
        <svg viewBox="0 0 14 14" width="12" height="12" aria-hidden="true">
          <path d="M7 9.5V2.5M4 5.2L7 2.2l3 3M2.2 11.4h9.6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        {{ label }}
      </button>
      <span v-if="shownName" class="picker__chip">
        <span class="picker__chip-name" :title="shownName">{{ shownName }}</span>
        <span v-if="shownSize" class="picker__chip-size">{{ shownSize }}</span>
        <button type="button" class="picker__chip-x" aria-label="清除已选文件" @click="clear">
          <svg viewBox="0 0 10 10" width="8" height="8"><path d="M2.5 2.5l5 5M7.5 2.5l-5 5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></svg>
        </button>
      </span>
    </template>

    <!-- dropzone 变体：整块可点可拖 -->
    <button
      v-else
      type="button"
      class="picker__zone"
      :disabled="disabled"
      :aria-label="ariaLabel || label"
      @click="open"
      @dragenter.prevent="dragging = true"
      @dragover.prevent="dragging = true"
      @dragleave.prevent="dragging = false"
      @drop.prevent="onDrop"
    >
      <span class="picker__zone-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="22" height="22">
          <path d="M12 16V4M7 9l5-5 5 5M4 19.5h16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </span>
      <span class="picker__zone-label">{{ shownName || label }}</span>
      <span class="picker__zone-hint">{{ shownName ? shownSize : (hint || '点击选择，或把文件拖到这里') }}</span>
      <span v-if="shownName" class="picker__zone-clear" role="button" tabindex="0" aria-label="清除已选文件" @click.stop="clear" @keydown.enter.stop.prevent="clear">移除</span>
    </button>
  </div>
</template>

<style scoped>
.picker { display: flex; align-items: center; gap: 8px; min-width: 0; flex-wrap: wrap; }
.picker.is-disabled { opacity: .55; }

/* 隐藏原生 input：点击由按钮代理，避免「未美化控件」露出 */
.picker__native { display: none; }

.picker__btn { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }

.picker__chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  max-width: 100%;
  padding: 3px 4px 3px 9px;
  border: 1px solid var(--accent-line);
  border-radius: 7px;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 11px;
}
.picker__chip-name {
  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-family: var(--mono);
}
.picker__chip-size { flex: none; color: var(--ink-3); font-family: var(--mono); font-size: 10px; }
.picker__chip-x {
  flex: none; display: grid; place-items: center;
  width: 16px; height: 16px;
  border: 0; border-radius: 4px;
  background: transparent; color: currentColor; cursor: pointer;
  transition: background var(--dur-1) var(--ease);
}
.picker__chip-x:hover { background: color-mix(in srgb, var(--accent) 18%, transparent); }

.picker__zone {
  display: grid;
  justify-items: center;
  gap: 3px;
  width: 100%;
  padding: 18px 14px;
  border: 1px dashed var(--hairline-3);
  border-radius: 10px;
  background: var(--surface);
  color: var(--ink-2);
  cursor: pointer;
  text-align: center;
  transition: border-color var(--dur-2) var(--ease), background var(--dur-2) var(--ease), color var(--dur-2) var(--ease);
}
.picker__zone:hover:not(:disabled) { border-color: var(--accent); background: var(--accent-soft); }
.picker__zone:focus-visible { box-shadow: var(--focus-ring); border-color: var(--accent); }
.picker__zone:disabled { cursor: not-allowed; }

.picker.is-dragging .picker__zone {
  border-color: var(--accent);
  border-style: solid;
  background: var(--accent-soft);
  color: var(--accent);
}
.picker.is-dragging .picker__zone-icon { transform: translateY(-3px); }

.picker__zone-icon {
  color: var(--ink-3);
  transition: transform var(--dur-2) var(--ease-out-expo), color var(--dur-2) var(--ease);
}
.picker.is-dragging .picker__zone-icon,
.picker__zone:hover .picker__zone-icon { color: var(--accent); }

.picker__zone-label { font-size: 12px; font-weight: 600; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.picker__zone-hint { font-size: 11px; color: var(--ink-3); }
.picker__zone-clear { font-size: 10.5px; color: var(--critical); text-decoration: underline; cursor: pointer; }

@media (prefers-reduced-motion: reduce) {
  .picker__zone, .picker__zone-icon { transition: none; }
}
</style>
