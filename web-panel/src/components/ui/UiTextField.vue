<script setup lang="ts">
/**
 * UiTextField —— 统一文本输入（text / password / textarea）。
 * 密码可见性切换带图标 morph；clearable 缩放淡入；error 态描边转 critical。
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue';

const props = withDefaults(defineProps<{
    type?: 'text' | 'password' | 'url' | 'search';
    textarea?: boolean;
    rows?: number;
    autoresize?: boolean;
    label?: string;
    hint?: string;
    error?: string;
    placeholder?: string;
    disabled?: boolean;
    readonly?: boolean;
    clearable?: boolean;
    mono?: boolean;
    size?: 'sm' | 'md' | 'lg';
    maxlength?: number;
    /** 无可见 label 时的无障碍名称 */
    ariaLabel?: string;
}>(), {
    type: 'text',
    textarea: false,
    rows: 3,
    autoresize: false,
    label: '',
    hint: '',
    error: '',
    placeholder: '',
    disabled: false,
    readonly: false,
    clearable: false,
    mono: false,
    size: 'md',
    maxlength: undefined,
    ariaLabel: '',
});

const model = defineModel<string>({ default: '' });
const emit = defineEmits<{ enter: []; focus: []; blur: [] }>();

const revealed = ref(false);
const focused = ref(false);
const taEl = ref<HTMLTextAreaElement | null>(null);

const inputType = computed(() => (props.type === 'password' && revealed.value ? 'text' : props.type));

const length = computed(() => (model.value ?? '').length);
const nearLimit = computed(() => props.maxlength != null && length.value >= props.maxlength * 0.9);

function onInput(e: Event) {
    model.value = (e.target as HTMLInputElement | HTMLTextAreaElement).value;
    if (props.autoresize) resize();
}

function resize() {
    const el = taEl.value;
    if (!el) return;
    el.style.height = 'auto';
    const next = Math.min(el.scrollHeight, 400);
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > 400 ? 'auto' : 'hidden';
}

onMounted(() => { if (props.autoresize) resize(); });
watch(() => model.value, () => { if (props.autoresize) nextTick(resize); });

function clear() {
    model.value = '';
    nextTick(() => { if (props.autoresize) resize(); });
}

function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !props.textarea) emit('enter');
}

function onFocus() { focused.value = true; emit('focus'); }
function onBlur() { focused.value = false; emit('blur'); }
</script>

<template>
  <div class="tfield" :class="[`tfield--${size}`, { 'is-focus': focused, 'is-invalid': !!error, 'is-disabled': disabled }]">
    <label v-if="label" class="tfield__label">{{ label }}</label>

    <div class="tfield__box ui-ctl" :class="[`ui-ctl--${size}`, { 'is-focus': focused, 'is-invalid': !!error, 'is-disabled': disabled }]">
      <slot name="prefix" />

      <textarea
        v-if="textarea"
        ref="taEl"
        class="tfield__input tfield__input--area"
        :class="{ 'is-mono': mono }"
        :rows="rows"
        :value="model"
        :placeholder="placeholder"
        :disabled="disabled"
        :readonly="readonly"
        :maxlength="maxlength"
        :aria-label="ariaLabel || label || undefined"
        :aria-invalid="!!error || undefined"
        @input="onInput"
        @focus="onFocus"
        @blur="onBlur"
        @keydown="onKeydown"
      />
      <input
        v-else
        class="tfield__input"
        :class="{ 'is-mono': mono }"
        :type="inputType"
        :value="model"
        :placeholder="placeholder"
        :disabled="disabled"
        :readonly="readonly"
        :maxlength="maxlength"
        autocomplete="off"
        spellcheck="false"
        :aria-label="ariaLabel || label || undefined"
        :aria-invalid="!!error || undefined"
        @input="onInput"
        @focus="onFocus"
        @blur="onBlur"
        @keydown="onKeydown"
      />

      <button
        v-if="clearable && model && !disabled && !readonly"
        type="button"
        class="tfield__icon tfield__clear"
        aria-label="清空"
        @click="clear"
      >
        <svg viewBox="0 0 12 12" width="10" height="10"><path d="M3 3l6 6M9 3l-6 6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg>
      </button>

      <button
        v-if="type === 'password'"
        type="button"
        class="tfield__icon"
        :aria-label="revealed ? '隐藏密码' : '显示密码'"
        :aria-pressed="revealed"
        @click="revealed = !revealed"
      >
        <svg viewBox="0 0 16 16" width="13" height="13" class="tfield__eye" :class="{ 'is-off': !revealed }">
          <path d="M1.5 8s2.4-4.2 6.5-4.2S14.5 8 14.5 8s-2.4 4.2-6.5 4.2S1.5 8 1.5 8z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />
          <circle cx="8" cy="8" r="1.9" fill="none" stroke="currentColor" stroke-width="1.3" />
          <path v-if="!revealed" d="M3 13L13 3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
        </svg>
      </button>

      <slot name="suffix" />
    </div>

    <div class="tfield__foot">
      <p v-if="error" class="tfield__error">
        <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M6 3.4v3M6 8.2v.1" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
        {{ error }}
      </p>
      <p v-else-if="hint" class="tfield__hint">{{ hint }}</p>
      <span v-else class="tfield__spacer" />
      <span v-if="maxlength" class="tfield__count" :class="{ 'is-near': nearLimit }">{{ length }}/{{ maxlength }}</span>
    </div>
  </div>
</template>

<style scoped>
.tfield { display: grid; gap: 4px; min-width: 0; }

.tfield__label {
  font-size: 11px; font-weight: 600; letter-spacing: 0.06em;
  color: var(--ink-2);
}

.tfield__box { gap: 6px; cursor: text; padding-right: 6px; }
.tfield__box:focus-within { border-color: var(--accent); }
.tfield--sm .tfield__box { min-height: var(--ctl-h-sm); }
.tfield--md .tfield__box { min-height: var(--ctl-h-md); }
.tfield--lg .tfield__box { min-height: var(--ctl-h-lg); }

.tfield__box.is-focus { border-color: var(--accent); box-shadow: var(--focus-ring); }
.tfield__box.is-invalid { border-color: var(--critical); }
.tfield__box.is-invalid.is-focus { box-shadow: var(--focus-ring-crit); }

.tfield__input {
  flex: 1 1 auto;
  min-width: 0;
  width: 100%;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  outline: none;
  padding: 0;
}
.tfield__input::placeholder { color: var(--ink-3); }
.tfield__input:disabled { cursor: not-allowed; }
.tfield__input.is-mono { font-family: var(--mono); font-size: 11.5px; }

.tfield__input--area {
  resize: none;
  line-height: 1.6;
  padding: 6px 0;
  overflow-y: hidden;
}
.tfield__box:has(.tfield__input--area) { align-items: stretch; padding-top: 2px; padding-bottom: 2px; }

.tfield__icon {
  flex: none;
  display: grid;
  place-items: center;
  width: 20px; height: 20px;
  border: 0; border-radius: 5px;
  background: transparent;
  color: var(--ink-3);
  cursor: pointer;
  transition: background var(--dur-1) var(--ease), color var(--dur-1) var(--ease);
}
.tfield__icon:hover { background: var(--surface-2); color: var(--ink); }
.tfield__icon:focus-visible { box-shadow: var(--focus-ring); }

.tfield__clear { animation: ui-pop-in var(--dur-1) var(--ease-out-expo) both; }
.tfield__eye { transition: opacity var(--dur-1) var(--ease); }
.tfield__eye.is-off { opacity: .85; }

.tfield__foot { display: flex; align-items: center; gap: 8px; min-height: 14px; }
.tfield__spacer { flex: 1 1 auto; }
.tfield__hint { margin: 0; font-size: 11px; color: var(--ink-3); line-height: 1.4; flex: 1 1 auto; }
.tfield__error {
  margin: 0; display: flex; align-items: center; gap: 4px;
  font-size: 11px; color: var(--critical); line-height: 1.4; flex: 1 1 auto;
}
.tfield__count {
  margin-left: auto; flex: none;
  font-family: var(--mono); font-size: 10.5px;
  color: var(--ink-3); font-variant-numeric: tabular-nums;
}
.tfield__count.is-near { color: var(--warning); font-weight: 600; }
</style>
