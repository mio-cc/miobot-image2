<script setup lang="ts">
/**
 * UiNumberField —— 自研数字步进器（替代全站 198 处原生 input[type=number]）。
 *
 * 为什么不用原生：原生数字框在 Chrome/Safari/Firefox 上步进箭头样式各异、无法统一
 * 触控目标、不能 clamp 到业务区间，且 spinner 会随 hover 才浮现，是「AI 拼装感」的典型来源。
 *
 * 交互契约（对齐 UI-KIT-SPEC §3.1）：
 * - 内部用 input[type=text] + inputmode="decimal"，绝不使用 type=number（核查脚本会判失败）。
 * - 右侧上下 chevron：单击 ±step；按住 400ms 后连发（20ms/次并逐步加速）。
 * - 键盘：↑/↓ ±step，Shift+↑/↓ 与 PageUp/PageDown ±step*10，Home/End 跳到 min/max。
 * - blur 归一化：clamp(min,max) → 对齐 step → 固定 precision；空串发 null。
 * - 越界（超出 min/max）时抖动一次，给用户「被挡住了」的物理反馈。
 *
 * Phase-UI 追加（替代可见滑动条，参考 Blender / Figma / Rive 的 value field）：
 * - `scrub`（默认开）：在框内左右拖动即微调数值。拖满 240px 走完整个 min..max 区间。
 *   只在精细指针（鼠标/触控笔）上启用，触屏仍走系统滚动，避免误触。
 * - `meter`：在框底铺一层极淡的范围填充，表示当前值在区间中的位置 ——
 *   用「底纹」而不是「滑轨」，所以不占额外空间、不打断表单的纵向节奏。
 *   这两个能力合起来就是「看起来是普通数字框，用起来是滑动条」。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue';

const props = withDefaults(defineProps<{
    min?: number;
    max?: number;
    step?: number;
    precision?: number;
    disabled?: boolean;
    readonly?: boolean;
    suffix?: string;
    prefix?: string;
    size?: 'sm' | 'md' | 'lg';
    align?: 'left' | 'right';
    placeholder?: string;
    invalid?: boolean;
    /** 在框内左右拖动即微调（精细指针设备）；默认开启 */
    scrub?: boolean;
    /** 在框底显示范围填充，表示当前值在 min..max 中的位置 */
    meter?: boolean;
    /**
     * 宽度策略。数字框不该一律撑满整行 —— 端口、次数、毫秒、温度的信息量差别很大。
     * - `auto`（默认）：按 min/max/placeholder 的字符数自动收窄到合适宽度
     * - `xs|sm|md|lg`：固定档位（72 / 96 / 140 / 220px）
     * - `fill`：占满容器（仅在需要与整行对齐时用）
     */
    width?: 'auto' | 'xs' | 'sm' | 'md' | 'lg' | 'fill';
    /** 小数分隔符后允许的最大位数；默认由 step 推导 */
}>(), {
    min: undefined,
    max: undefined,
    step: 1,
    precision: undefined,
    disabled: false,
    readonly: false,
    suffix: '',
    prefix: '',
    size: 'md',
    align: 'left',
    placeholder: '',
    invalid: false,
    scrub: true,
    meter: false,
    width: 'auto',
});

const model = defineModel<number | null>({ default: null });

const emit = defineEmits<{ change: [value: number | null] }>();

const inputEl = ref<HTMLInputElement | null>(null);
const draft = ref('');
const focused = ref(false);
const shaking = ref(false);

/** step 为小数时自动推导精度（0.1 → 1 位），否则按整数。 */
const decimals = computed(() => {
    if (props.precision != null) return props.precision;
    const s = String(props.step ?? 1);
    const dot = s.indexOf('.');
    return dot >= 0 ? s.length - dot - 1 : 0;
});

function clamp(v: number): number {
    let out = v;
    if (props.min != null && out < props.min) out = props.min;
    if (props.max != null && out > props.max) out = props.max;
    return out;
}

/** 对齐到 step 网格（以 min 为原点，避免出现 0.30000000000000004）。 */
function snap(v: number): number {
    const step = props.step || 1;
    const origin = props.min ?? 0;
    const steps = Math.round((v - origin) / step);
    return origin + steps * step;
}

function fmt(v: number | null): string {
    if (v == null || Number.isNaN(v)) return '';
    return decimals.value > 0 ? v.toFixed(decimals.value) : String(v);
}

watch(model, (v) => {
    if (!focused.value) draft.value = fmt(v);
}, { immediate: true });

function onFocus() {
    focused.value = true;
    draft.value = fmt(model.value);
}

function commit(raw: string, notify = true) {
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed === '-' || trimmed === '.') {
        model.value = null;
        if (notify) emit('change', null);
        draft.value = '';
        return;
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
        draft.value = fmt(model.value);
        return;
    }
    const snapped = clamp(snap(parsed));
    model.value = snapped;
    draft.value = fmt(snapped);
    if (notify) emit('change', snapped);
}

function onInput(e: Event) {
    draft.value = (e.target as HTMLInputElement).value;
}

function onBlur() {
    focused.value = false;
    commit(draft.value);
}

function nudge(direction: 1 | -1, multiplier = 1) {
    if (props.disabled || props.readonly) return;
    const base = model.value ?? (props.min ?? 0);
    const next = snap(base + direction * (props.step || 1) * multiplier);

    // 越界检测：只有真的被 clamp 挡住才抖，避免正常步进也抖
    const outOfRange = (props.max != null && next > props.max) || (props.min != null && next < props.min);
    const clamped = clamp(next);
    model.value = clamped;
    draft.value = fmt(clamped);
    emit('change', clamped);
    if (outOfRange) triggerShake();
}

function triggerShake() {
    shaking.value = false;
    // 强制重排，保证同一帧内重复触发也能重放动画
    requestAnimationFrame(() => {
        shaking.value = true;
        window.setTimeout(() => { shaking.value = false; }, 420);
    });
}

/* ── 长按连发：400ms 后启动，间隔从 60ms 逐步降到 20ms ── */
let holdTimer: number | null = null;
let repeatTimer: number | null = null;
let repeatDelay = 60;

function stopRepeat() {
    if (holdTimer != null) { window.clearTimeout(holdTimer); holdTimer = null; }
    if (repeatTimer != null) { window.clearTimeout(repeatTimer); repeatTimer = null; }
    repeatDelay = 60;
}

function startRepeat(direction: 1 | -1) {
    if (props.disabled || props.readonly) return;
    nudge(direction);
    stopRepeat();
    holdTimer = window.setTimeout(() => {
        const tick = () => {
            nudge(direction);
            repeatDelay = Math.max(20, repeatDelay - 6);
            repeatTimer = window.setTimeout(tick, repeatDelay);
        };
        tick();
    }, 400);
}

function onKeydown(e: KeyboardEvent) {
    if (props.disabled || props.readonly) return;
    const big = e.shiftKey ? 10 : 1;
    switch (e.key) {
        case 'ArrowUp': e.preventDefault(); nudge(1, big); break;
        case 'ArrowDown': e.preventDefault(); nudge(-1, big); break;
        case 'PageUp': e.preventDefault(); nudge(1, 10); break;
        case 'PageDown': e.preventDefault(); nudge(-1, 10); break;
        case 'Home':
            if (props.min != null) { e.preventDefault(); model.value = props.min; draft.value = fmt(props.min); emit('change', props.min); }
            break;
        case 'End':
            if (props.max != null) { e.preventDefault(); model.value = props.max; draft.value = fmt(props.max); emit('change', props.max); }
            break;
        case 'Enter': e.preventDefault(); commit(draft.value); inputEl.value?.blur(); break;
    }
}

/* ── 宽度策略：数字框按内容收窄，不无脑撑满整行 ──
   1ch 在 tabular-nums 下就是一位数字宽，所以直接用「最大值的字符数」定宽最准。
   额外的 +px 留给左右内距、前后缀和步进器。 */
const FIXED_WIDTH: Record<string, string> = {
    xs: '72px',
    sm: '96px',
    md: '140px',
    lg: '220px',
};

const widthStyle = computed(() => {
    if (props.width === 'fill') return { width: '100%', maxWidth: 'none' };
    if (props.width !== 'auto') {
        const w = FIXED_WIDTH[props.width] ?? FIXED_WIDTH.md;
        return { width: w, maxWidth: w };
    }
    /* auto：取「可能出现的最长字符数」作为上限。
       必须把**当前值**也算进去 —— 很多字段没有声明 max（如超时毫秒），
       只看 min/max 会算出 1~2 个字符宽，把 120000 裁掉尾巴。
       再兜一个 4 位下限，避免个位数被压成一条缝。 */
    const candidates = [
        fmt(model.value),
        props.max != null ? fmt(props.max) : '',
        props.min != null ? fmt(props.min) : '',
        props.placeholder || '',
        '0000',
    ];
    const chars = Math.max(4, ...candidates.map(s => s.length));
    const affix = (props.prefix?.length || 0) + (props.suffix?.length || 0);
    // ch 按字符算，再补内距 + 步进器 + 前后缀的像素
    const px = 30 + (props.disabled || props.readonly ? 0 : 18) + affix * 7;
    return { width: `calc(${chars}ch + ${px}px)`, maxWidth: '100%' };
});

onBeforeUnmount(stopRepeat);

const ariaNow = computed(() => (model.value == null ? undefined : model.value));

/* ── 范围底纹：当前值在 min..max 中的百分比 ── */
const meterPct = computed(() => {
    if (!props.meter || props.min == null || props.max == null || props.max <= props.min) return null;
    const v = model.value;
    if (v == null) return 0;
    return Math.min(100, Math.max(0, ((v - props.min) / (props.max - props.min)) * 100));
});

/* ── 拖动微调（scrub）──
   参考 Blender / Figma 的数值控件：按下后左右拖动改值，不显示滑轨。
   要点：
   1) 位移小于 3px 视为「点击」，不进入拖动，保证正常点击可以定位光标。
   2) 只在 (pointer: fine) 上启用，触屏交给系统滚动，避免拖动页面时误改数值。
   3) 拖动中给根节点加 .is-scrubbing（user-select:none），否则会把数字拖成蓝色选区。 */
const SCRUB_SPAN_PX = 240;
const finePointer = typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(pointer: fine)').matches
    : true;

const scrubbing = ref(false);
const canScrub = computed(() => props.scrub && finePointer && !props.disabled && !props.readonly);
let scrubStartX = 0;
let scrubStartVal = 0;
let scrubMoved = false;

function onPointerDown(e: PointerEvent) {
    if (props.disabled || props.readonly) return;
    // 点哪都能聚焦输入框（包括左右内距区域），保持「点击即编辑」的手感
    inputEl.value?.focus();
    if (!canScrub.value || e.button !== 0) return;
    scrubStartX = e.clientX;
    scrubStartVal = model.value ?? props.min ?? 0;
    scrubMoved = false;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
}

function onPointerMove(e: PointerEvent) {
    if (!canScrub.value || !(e.buttons & 1)) return;
    const dx = e.clientX - scrubStartX;
    if (!scrubMoved) {
        if (Math.abs(dx) < 3) return;
        scrubMoved = true;
        scrubbing.value = true;
        inputEl.value?.setSelectionRange(0, 0);
    }
    const span = (props.max ?? 100) - (props.min ?? 0);
    const perPx = span / SCRUB_SPAN_PX;
    const next = clamp(snap(scrubStartVal + dx * perPx));
    if (next !== model.value) {
        model.value = next;
        draft.value = fmt(next);
    }
}

function onPointerUp(e: PointerEvent) {
    if (!canScrub.value) return;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    if (scrubMoved) {
        scrubMoved = false;
        scrubbing.value = false;
        emit('change', model.value);
    }
}
</script>

<template>
  <div
    class="numfield ui-ctl"
    :class="[
      `ui-ctl--${size}`,
      {
        'is-disabled': disabled,
        'is-focus': focused,
        'is-invalid': invalid,
        'is-scrubbable': canScrub,
        'is-scrubbing': scrubbing,
        'ui-shake': shaking,
      },
    ]"
    :style="widthStyle"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
  >
    <!-- 范围底纹：用极淡填充表示值在区间中的位置（替代可见滑轨） -->
    <span
      v-if="meterPct !== null"
      class="numfield__meter"
      :style="{ width: `${meterPct}%` }"
      aria-hidden="true"
    />

    <span v-if="prefix" class="numfield__affix">{{ prefix }}</span>

    <input
      ref="inputEl"
      class="numfield__input"
      :class="[align === 'right' ? 'is-right' : '']"
      type="text"
      inputmode="decimal"
      autocomplete="off"
      spellcheck="false"
      :value="draft"
      :placeholder="placeholder"
      :disabled="disabled"
      :readonly="readonly"
      role="spinbutton"
      :aria-valuenow="ariaNow"
      :aria-valuemin="min"
      :aria-valuemax="max"
      :aria-disabled="disabled || undefined"
      @input="onInput"
      @focus="onFocus"
      @blur="onBlur"
      @keydown="onKeydown"
    />

    <span v-if="suffix" class="numfield__affix numfield__affix--suffix">{{ suffix }}</span>

    <span v-if="!disabled && !readonly" class="numfield__steppers">
      <button
        type="button"
        class="numfield__step"
        tabindex="-1"
        aria-label="增加"
        @mousedown.stop.prevent="startRepeat(1)"
        @mouseup="stopRepeat"
        @mouseleave="stopRepeat"
        @touchstart.stop.prevent="startRepeat(1)"
        @touchend="stopRepeat"
      >
        <svg viewBox="0 0 10 10" width="9" height="9" aria-hidden="true"><path d="M2 6.5L5 3.5l3 3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <button
        type="button"
        class="numfield__step"
        tabindex="-1"
        aria-label="减少"
        @mousedown.stop.prevent="startRepeat(-1)"
        @mouseup="stopRepeat"
        @mouseleave="stopRepeat"
        @touchstart.stop.prevent="startRepeat(-1)"
        @touchend="stopRepeat"
      >
        <svg viewBox="0 0 10 10" width="9" height="9" aria-hidden="true"><path d="M2 3.5L5 6.5l3-3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
    </span>
  </div>
</template>

<style scoped>
.numfield {
  position: relative;
  overflow: hidden;
  gap: 4px;
  padding-right: 2px;
  cursor: text;
  min-width: 0;
}

/* 范围底纹：只铺到当前值的位置，颜色极淡，不抢文字 */
.numfield__meter {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  background: color-mix(in srgb, var(--accent) 13%, transparent);
  transition: width var(--dur-2) var(--ease-out-expo);
  pointer-events: none;
}

/* 底纹之上的一切（输入、前后缀、步进器）都要抬一层 */
.numfield > *:not(.numfield__meter) {
  position: relative;
  z-index: 1;
}

/* 可拖动时给「横向可拖」的光标提示；聚焦后回到文本光标，编辑手感不变 */
.numfield.is-scrubbable { cursor: ew-resize; }
.numfield.is-scrubbable .numfield__input { cursor: ew-resize; }
.numfield.is-scrubbable.is-focus .numfield__input { cursor: text; }

/* 拖动中禁止选中，否则数字会被拖成蓝色选区 */
.numfield.is-scrubbing { user-select: none; }
.numfield.is-scrubbing .numfield__meter { transition: none; }

.numfield__input {
  flex: 1 1 auto;
  min-width: 0;
  width: 100%;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  font-variant-numeric: tabular-nums;
  outline: none;
  padding: 0 2px;
  text-align: left;
}
.numfield__input.is-right { text-align: right; }
.numfield__input::placeholder { color: var(--ink-3); }
.numfield__input:disabled { cursor: not-allowed; }

/* 隐藏原生 spinner 兜底（即使某些浏览器对 text 也渲染） */
.numfield__input::-webkit-outer-spin-button,
.numfield__input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }

.numfield__affix {
  flex: none;
  color: var(--ink-3);
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.02em;
  user-select: none;
}
.numfield__affix--suffix { padding-right: 1px; }

.numfield__steppers {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 1px;
  align-self: stretch;
  padding: 3px 0;
  opacity: 0;
  transition: opacity var(--dur-1) var(--ease);
}
.numfield:hover .numfield__steppers,
.numfield.is-focus .numfield__steppers { opacity: 1; }

.numfield__step {
  flex: 1 1 0;
  display: grid;
  place-items: center;
  width: 18px;
  min-height: 0;
  border: 0;
  border-radius: 3px;
  background: transparent;
  color: var(--ink-3);
  cursor: pointer;
  padding: 0;
  transition: background var(--dur-1) var(--ease), color var(--dur-1) var(--ease);
}
.numfield__step:hover { background: var(--surface-2); color: var(--accent); }
.numfield__step:active { background: var(--accent-soft); color: var(--accent); }

/* 触控设备上箭头常显，否则根本点不到 */
@media (pointer: coarse) {
  .numfield__steppers { opacity: 1; }
  .numfield__step { width: 26px; }
}
</style>
