<script lang="ts">
/**
 * AppSelect —— 全站统一自绘下拉（方案 §3.2，后续所有下拉的唯一实现）。
 *
 * 形态：
 * - 触发器复用 .input-field 语义类（同高同边框同聚焦光晕），右侧 chevron；
 * - 面板 Teleport 到 body（position:fixed），杜绝被 overflow/transform 容器裁切；
 *   视口底部不足自动向上翻转，左右钳制 8px；
 * - ≤680px 切换为底部抽屉：遮罩关闭、搜索置顶、选中打勾、触控区 ≥44px、
 *   env(safe-area-inset-bottom)、visualViewport 键盘弹起自适应；
 * - 键盘/a11y：role=combobox + aria-expanded/activedescendant，↑↓/Home/End/Enter/Esc/Tab；
 *   IME composing 期间不筛选不误选；focus-visible 环沿用全局规则。
 * - 搜索逻辑全部来自 utils/fuzzy-search（与节点模型展开共用，不留第二套实现）。
 *
 * 颜色只用宣纸 token，暗色自动跟随。
 */
export interface AppSelectOption {
    value: string | number;
    label: string;
    /** 参与搜索的别名（中文别名 → 拼音首字母索引），如节点下拉带 baseUrl */
    alias?: string;
    /** 选项右侧弱化说明（如「当前用于：主对话」） */
    hint?: string;
    /** 选项行内徽标（如能力标签） */
    badges?: string[];
    /** 分组名（无搜索词时按相邻同组渲染 sticky 组头） */
    group?: string;
}
</script>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { buildSearchIndex, searchIndexed } from '../utils/fuzzy-search';

const props = withDefaults(defineProps<{
    modelValue?: string | number | null;
    options: Array<AppSelectOption | string>;
    /** 搜索开关；缺省 = 选项 ≥8 自动开启（tri-state，必须显式 default:undefined 才能区分“未传”与 false） */
    searchable?: boolean;
    disabled?: boolean;
    placeholder?: string;
    /** 允许输入不在候选里的自定义值（模型名 / profile id 等自由文本场景） */
    allowCustom?: boolean;
    /** 浏览模式：点击选项不选中不关闭，纯展示 + 搜索（节点模型展开用） */
    browse?: boolean;
    /** 触发器与选项使用等宽字体（模型名） */
    mono?: boolean;
    /** 追加到默认触发器的 class */
    triggerClass?: string;
}>(), {
    // Vue 对 Boolean prop 的缺省会 cast 成 false（而非 undefined），
    // `?? 自动开启` 就永远走不到。显式给 default:undefined 退出 boolean casting，
    // 让“未传”回到 undefined，三态才成立（Vue 文档 Boolean Casting 一节）。
    searchable: undefined,
});

const emit = defineEmits<{
    'update:modelValue': [value: string | number];
    change: [value: string | number];
    select: [option: AppSelectOption];
}>();

const RENDER_CAP = 80;
const SEARCH_AUTO_THRESHOLD = 8;
const listboxId = `app-select-lb-${Math.random().toString(36).slice(2, 9)}`;

const open = ref(false);
const query = ref('');
const activeIndex = ref(-1);
const composing = ref(false);
const triggerRef = ref<HTMLButtonElement | null>(null);
const panelRef = ref<HTMLDivElement | null>(null);
const searchRef = ref<HTMLInputElement | null>(null);

/* ── 移动端断点（≤680px 抽屉形态） ── */
const mobileQuery = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(max-width: 680px)') : null;
const isMobile = ref(Boolean(mobileQuery?.matches));
if (mobileQuery) {
    const onMediaChange = (e: MediaQueryListEvent) => {
        isMobile.value = e.matches;
        if (open.value) nextTick(() => { positionPanel(); onViewportResize(); });
    };
    mobileQuery.addEventListener?.('change', onMediaChange);
    onBeforeUnmount(() => mobileQuery.removeEventListener?.('change', onMediaChange));
}

const normalized = computed<AppSelectOption[]>(() =>
    props.options.map(o => (typeof o === 'object' && o !== null ? o : { value: String(o), label: String(o) })));

const searchEnabled = computed(() => props.searchable ?? normalized.value.length >= SEARCH_AUTO_THRESHOLD);

function isSelected(o: AppSelectOption): boolean {
    return props.modelValue != null && String(o.value) === String(props.modelValue);
}

/* ── 搜索索引：随 options 数组重建（computed 缓存），按键期间只做匹配 ── */
const index = computed(() => buildSearchIndex(normalized.value, o => ({ raw: o.label, alias: o.alias })));

interface Row {
    key: string;
    option: AppSelectOption;
    ranges: Array<[number, number]>;
    custom?: boolean;
    selected: boolean;
}

const rows = computed<Row[]>(() => {
    const q = query.value.trim().toLowerCase();
    if (!searchEnabled.value || !q) {
        return normalized.value.map((o, i) => ({ key: `o${i}`, option: o, ranges: [], selected: isSelected(o) }));
    }
    const indexOf = new Map(normalized.value.map((o, i) => [o, i]));
    const hits: Row[] = searchIndexed(index.value, q).map(h => ({
        key: `o${indexOf.get(h.item) ?? 0}`,
        option: h.item,
        ranges: h.ranges,
        selected: isSelected(h.item),
    }));
    // 已选值置顶（§3.3 排序第 4 条）
    const selAt = hits.findIndex(r => r.selected);
    if (selAt > 0) { const [sel] = hits.splice(selAt, 1); hits.unshift(sel); }
    // 自定义值入口：保留旧 input+datalist 的自由输入能力。
    // 放在末尾——有命中时 Enter 应该选真实候选（输入 nem 回车选 nvidia/nemotron…，
    // 而不是把字面量 "nem" 写进配置）；无命中时它是唯一一行，Enter 直接用它。
    const exact = normalized.value.some(o => o.label.toLowerCase() === q);
    if (props.allowCustom && !exact) {
        hits.push({ key: 'custom', option: { value: query.value.trim(), label: query.value.trim() }, ranges: [], custom: true, selected: false });
    }
    return hits;
});

const visibleRows = computed(() => rows.value.slice(0, RENDER_CAP));
const capped = computed(() => rows.value.length > RENDER_CAP);
const noMatch = computed(() => Boolean(query.value.trim()) && !rows.value.length);
const emptyOptions = computed(() => !normalized.value.length);

const selectedOption = computed(() => normalized.value.find(isSelected));
const selectedLabel = computed(() => selectedOption.value?.label
    ?? (props.modelValue != null && String(props.modelValue) !== '' ? String(props.modelValue) : ''));

const activeDescendant = computed(() =>
    open.value && activeIndex.value >= 0 ? `${listboxId}-opt-${activeIndex.value}` : undefined);

type RenderRow =
    | { type: 'group'; key: string; label: string }
    | { type: 'option'; key: string; row: Row; index: number };

/** 搜索时打平按分数排；无搜索词时按相邻同组渲染 sticky 组头。 */
const groupedRows = computed<RenderRow[]>(() => {
    if (query.value.trim()) {
        return visibleRows.value.map((row, index) => ({ type: 'option', key: row.key, row, index }));
    }
    const out: RenderRow[] = [];
    let lastGroup: string | undefined;
    visibleRows.value.forEach((row, index) => {
        const g = row.option.group;
        if (g && g !== lastGroup) out.push({ type: 'group', key: `g-${g}`, label: g });
        lastGroup = g;
        out.push({ type: 'option', key: row.key, row, index });
    });
    return out;
});

/* ── 开关面板 ── */
function openPanel(anchor: 'first' | 'last' | 'selected' = 'selected', prefill = '') {
    if (props.disabled || open.value) return;
    open.value = true;
    query.value = prefill;
    nextTick(() => {
        positionPanel();
        onViewportResize();
        attachListeners();
        const count = visibleRows.value.length;
        if (anchor === 'last') activeIndex.value = count - 1;
        else if (anchor === 'first') activeIndex.value = count ? 0 : -1;
        else {
            const sel = visibleRows.value.findIndex(r => r.selected);
            activeIndex.value = sel >= 0 ? sel : (count ? 0 : -1);
        }
        if (searchEnabled.value) searchRef.value?.focus();
        scrollActiveIntoView();
    });
}

function close(returnFocus = true) {
    if (!open.value) return;
    open.value = false;
    query.value = '';
    activeIndex.value = -1;
    detachListeners();
    if (returnFocus) triggerRef.value?.focus();
}

function toggle() {
    if (open.value) close(true);
    else openPanel('selected');
}

function selectRow(row: Row) {
    if (row.custom) {
        if (!props.browse) {
            emit('update:modelValue', row.option.value);
            emit('change', row.option.value);
        }
        close(true);
        return;
    }
    emit('select', row.option);
    if (props.browse) return; // 浏览模式：不选中、不关闭，继续翻看
    emit('update:modelValue', row.option.value);
    emit('change', row.option.value);
    close(true);
}

function setActive(i: number) {
    if (activeIndex.value !== i) activeIndex.value = i;
}

/* ── 键盘 ── */
function onTriggerKeydown(e: KeyboardEvent) {
    if (props.disabled) return;
    if (open.value) {
        // 非搜索面板焦点仍在触发器上；搜索面板焦点在搜索框（那里另有 handler）
        if (!searchEnabled.value) handleNavKeydown(e);
        return;
    }
    switch (e.key) {
        case 'ArrowDown': case 'ArrowUp': case 'Enter': case ' ':
            e.preventDefault();
            openPanel(e.key === 'ArrowUp' ? 'last' : 'first');
            break;
        case 'Home': e.preventDefault(); openPanel('first'); break;
        case 'End': e.preventDefault(); openPanel('last'); break;
        default:
            // 可打印字符直接开面板并预填（原生 select 的打字跳转习惯）
            if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) openPanel('first', e.key);
    }
}

function onSearchKeydown(e: KeyboardEvent) {
    if (composing.value) return; // IME 拼字：不导航、不响应 Enter
    handleNavKeydown(e);
}

function handleNavKeydown(e: KeyboardEvent) {
    const count = visibleRows.value.length;
    switch (e.key) {
        case 'ArrowDown':
            e.preventDefault();
            if (count) activeIndex.value = (activeIndex.value + 1 + count) % count;
            break;
        case 'ArrowUp':
            e.preventDefault();
            if (count) activeIndex.value = (activeIndex.value - 1 + count) % count;
            break;
        case 'Home': e.preventDefault(); activeIndex.value = count ? 0 : -1; break;
        case 'End': e.preventDefault(); activeIndex.value = count - 1; break;
        case 'Enter': {
            e.preventDefault();
            const row = visibleRows.value[activeIndex.value];
            if (row) selectRow(row);
            break;
        }
        case 'Escape': e.preventDefault(); close(true); break;
        case 'Tab':
            e.preventDefault();
            close(false);
            focusNextControl();
            break;
    }
}

/** Tab 关闭并前进到触发器之后的下一个可聚焦控件（面板已 Teleport 到 body 末尾，需手动找）。 */
function focusNextControl() {
    const trigger = triggerRef.value;
    if (!trigger) return;
    const selector = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const all = Array.from(document.querySelectorAll<HTMLElement>(selector));
    const start = all.indexOf(trigger);
    for (let i = start + 1; i < all.length; i++) {
        const el = all[i];
        if (panelRef.value?.contains(el)) continue;
        if (el.offsetParent !== null) { el.focus(); return; }
    }
    trigger.focus();
}

/* ── 定位（桌面锚定弹层 / 移动端抽屉走 CSS） ── */
function positionPanel() {
    const trigger = triggerRef.value;
    const panel = panelRef.value;
    if (!trigger || !panel) return;
    if (isMobile.value) {
        panel.style.left = ''; panel.style.top = ''; panel.style.width = ''; panel.style.maxHeight = ''; panel.style.bottom = '';
        return;
    }
    const rect = trigger.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = Math.min(Math.max(rect.width, 200), vw - 16);
    let left = rect.left;
    if (left + width > vw - 8) left = vw - 8 - width;
    if (left < 8) left = 8;
    panel.style.left = `${Math.round(left)}px`;
    panel.style.width = `${Math.round(width)}px`;

    const below = vh - rect.bottom - 12;
    const above = rect.top - 12;
    const capTo = (avail: number) => Math.max(160, Math.min(372, avail));
    if (below >= 220 || below >= above) {
        panel.style.maxHeight = `${capTo(below)}px`;
        panel.style.top = `${Math.round(rect.bottom + 4)}px`;
    } else {
        // 向上翻转：先应用 maxHeight 再量实际高度
        panel.style.maxHeight = `${capTo(above)}px`;
        const height = panel.offsetHeight;
        panel.style.top = `${Math.round(Math.max(8, rect.top - height - 4))}px`;
    }
}

/** 移动端键盘弹起：抽屉压到 visualViewport 的 80%，并抬到软键盘上方。 */
function onViewportResize() {
    if (!open.value || !isMobile.value) return;
    const vv = window.visualViewport;
    const panel = panelRef.value;
    if (!vv || !panel) return;
    panel.style.maxHeight = `${Math.round(Math.max(240, vv.height * 0.8))}px`;
    const keyboard = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    panel.style.bottom = `${Math.round(keyboard)}px`;
}

let scrollRaf: number | undefined;
function onDocScroll() {
    if (!open.value) return;
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => { scrollRaf = undefined; positionPanel(); });
}
function onWindowResize() {
    if (!open.value) return;
    positionPanel();
    onViewportResize();
}

let teardown: Array<() => void> = [];
function attachListeners() {
    window.addEventListener('scroll', onDocScroll, true);
    window.addEventListener('resize', onWindowResize);
    window.visualViewport?.addEventListener('resize', onViewportResize);
    teardown = [
        () => window.removeEventListener('scroll', onDocScroll, true),
        () => window.removeEventListener('resize', onWindowResize),
        () => window.visualViewport?.removeEventListener('resize', onViewportResize),
    ];
}
function detachListeners() {
    if (scrollRaf) { cancelAnimationFrame(scrollRaf); scrollRaf = undefined; }
    teardown.forEach(fn => fn());
    teardown = [];
}

function onPanelFocusout(e: FocusEvent) {
    if (!open.value) return;
    const next = e.relatedTarget as Node | null;
    if (next && panelRef.value?.contains(next)) return;
    close(false);
}

function scrollActiveIntoView() {
    if (activeIndex.value < 0) return;
    document.getElementById(`${listboxId}-opt-${activeIndex.value}`)?.scrollIntoView({ block: 'nearest' });
}

watch(activeIndex, () => scrollActiveIntoView());
watch(query, () => { activeIndex.value = visibleRows.value.length ? 0 : -1; });
watch(() => visibleRows.value.length, () => {
    if (open.value) nextTick(positionPanel);
});
onBeforeUnmount(detachListeners);

/** 命中字符高亮分段（ranges 是 Array.from 字符下标口径）。 */
function labelSegments(row: Row): Array<{ text: string; hit: boolean }> {
    const label = row.custom ? `使用「${row.option.label}」` : row.option.label;
    if (!row.ranges.length) return [{ text: label, hit: false }];
    const chars = Array.from(label);
    const hit = new Array<boolean>(chars.length).fill(false);
    for (const [s, e] of row.ranges) {
        for (let i = Math.max(0, s); i < Math.min(e, chars.length); i++) hit[i] = true;
    }
    const out: Array<{ text: string; hit: boolean }> = [];
    let buffer = '';
    let bufferHit = hit[0] ?? false;
    chars.forEach((ch, i) => {
        if (hit[i] === bufferHit) { buffer += ch; return; }
        out.push({ text: buffer, hit: bufferHit });
        buffer = ch;
        bufferHit = hit[i];
    });
    if (buffer) out.push({ text: buffer, hit: bufferHit });
    return out;
}
</script>

<template>
  <div class="min-w-0">
    <!-- 默认触发器：与 .input-field 同高同边框同光晕 -->
    <button v-if="!$slots.trigger" ref="triggerRef" type="button"
      class="input-field app-select-trigger" :class="[triggerClass, mono ? 'font-mono' : '', open ? 'is-open' : '']"
      role="combobox" aria-haspopup="listbox" :aria-expanded="open" :aria-controls="listboxId"
      :aria-activedescendant="activeDescendant"
      :disabled="disabled" :title="selectedLabel || placeholder || ''"
      @click="toggle" @keydown="onTriggerKeydown">
      <span class="app-select-value" :class="{ 'is-placeholder': !selectedLabel }">{{ selectedLabel || placeholder || '—' }}</span>
      <svg class="app-select-chevron" :class="{ 'is-open': open }" width="14" height="14" viewBox="0 0 24 24"
        fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="m6 9 6 6 6-6" />
      </svg>
    </button>
    <!-- 自定义触发器（浏览模式入口：+N 查看 / 表格数字） -->
    <button v-else ref="triggerRef" type="button" class="app-select-bare" :disabled="disabled"
      aria-haspopup="listbox" :aria-expanded="open" :aria-controls="listboxId"
      @click="toggle" @keydown="onTriggerKeydown">
      <slot name="trigger" />
      <svg class="app-select-chevron app-select-chevron-sm" :class="{ 'is-open': open }" width="12" height="12"
        viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="m6 9 6 6 6-6" />
      </svg>
    </button>

    <Teleport to="body">
      <div v-if="open" class="app-select-root" :class="isMobile ? 'is-sheet' : 'is-anchored'">
        <div class="app-select-backdrop" @mousedown="close(true)" />
        <div ref="panelRef" class="app-select-panel" @focusout="onPanelFocusout">
          <div v-if="searchEnabled" class="app-select-search">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
              stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
            </svg>
            <input ref="searchRef" v-model="query" type="text" maxlength="64" autocomplete="off" spellcheck="false"
              role="combobox" aria-expanded="true" :aria-controls="listboxId" :aria-activedescendant="activeDescendant"
              placeholder="搜索（支持拼音首字母 / 子序列）"
              @keydown="onSearchKeydown" @compositionstart="composing = true" @compositionend="composing = false" />
            <button v-if="query" type="button" class="app-select-clear" title="清空搜索" aria-label="清空搜索"
              @click="query = ''">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>

          <!-- @mousedown.prevent：点击选项不移动焦点（焦点留在搜索框/触发器）。否则 mousedown 的
               浏览器默认行为会把焦点夺到 body，搜索框 blur → 面板 @focusout 误判「焦点已出面板」
               立即 close 卸载，mouseup/click 落在已移除的选项上——鼠标点击选不中（键盘不经
               mousedown 故正常）。这也是 ARIA combobox 模式的推荐交互：鼠标交互不移焦点。
               preventDefault 不影响随后派发的 mouseup/click，也不影响触摸合成点击与触摸滚动。 -->
          <ul :id="listboxId" class="app-select-list" role="listbox" :aria-label="placeholder || '选项'" @mousedown.prevent>
            <template v-for="item in groupedRows" :key="item.key">
              <li v-if="item.type === 'group'" class="app-select-group" aria-hidden="true">{{ item.label }}</li>
              <li v-else :id="`${listboxId}-opt-${item.index}`" role="option" :aria-selected="item.row.selected"
                class="app-select-option" :class="{ 'is-active': item.index === activeIndex, 'is-custom': item.row.custom }"
                :title="item.row.option.label"
                @click="selectRow(item.row)" @mousemove="setActive(item.index)">
                <svg v-if="item.row.selected" class="app-select-check" width="14" height="14" viewBox="0 0 24 24"
                  fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M20 6 9 17l-5-5" />
                </svg>
                <span v-else class="app-select-checkpad" aria-hidden="true" />
                <span class="app-select-label" :class="mono ? 'mono' : ''">
                  <template v-for="(seg, si) in labelSegments(item.row)" :key="si">
                    <mark v-if="seg.hit">{{ seg.text }}</mark>
                    <template v-else>{{ seg.text }}</template>
                  </template>
                </span>
                <span v-if="item.row.option.badges?.length" class="app-select-badges">
                  <span v-for="b in item.row.option.badges" :key="b" class="tag">{{ b }}</span>
                </span>
                <span v-if="item.row.option.hint" class="app-select-hint">{{ item.row.option.hint }}</span>
                <span v-if="item.row.selected && query" class="tag-acc app-select-current">当前</span>
              </li>
            </template>
          </ul>

          <div v-if="noMatch" class="app-select-empty" @click="query = ''">无匹配「{{ query }}」 · 点击清空重试</div>
          <div v-else-if="emptyOptions" class="app-select-empty">暂无选项</div>
          <div v-if="capped" class="app-select-more">已显示前 {{ RENDER_CAP }} 项 · 继续输入缩小范围</div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.app-select-trigger {
  display: flex;
  align-items: center;
  gap: 8px;
  text-align: left;
  font: inherit;
  line-height: 1.45;
  cursor: pointer;
  user-select: none;
}
.app-select-trigger:disabled {
  background: var(--off-soft);
  cursor: not-allowed;
}
/* 展开时触发器保持聚焦光晕（焦点已移入搜索框） */
.app-select-trigger.is-open,
.app-select-trigger:focus {
  background: var(--surface);
  border-color: var(--accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 14%, transparent);
}
.app-select-value {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.app-select-value.is-placeholder { color: var(--ink-3); }
.app-select-chevron {
  flex: none;
  color: var(--ink-3);
  transition: transform 0.18s var(--ease), color 0.18s var(--ease);
}
.app-select-chevron.is-open { transform: rotate(180deg); color: var(--accent); }
.app-select-bare {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  background: transparent;
  border: none;
  padding: 0;
  font: inherit;
  color: inherit;
  cursor: pointer;
}
.app-select-bare:disabled { opacity: 0.45; cursor: not-allowed; }
.app-select-chevron-sm { color: var(--ink-3); }

/* ── 面板（桌面锚定；定位由 JS 注入 left/top/width/maxHeight） ── */
.app-select-backdrop {
  position: fixed;
  inset: 0;
  z-index: 9990;
}
.app-select-panel {
  position: fixed;
  z-index: 9991;
  background: var(--surface);
  border: 1px solid var(--hairline-2);
  border-radius: 12px;
  box-shadow: var(--sh-2);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-width: 200px;
  max-width: calc(100vw - 16px);
}
.app-select-search {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--hairline-2);
  background: var(--surface);
  flex: none;
}
.app-select-search svg { color: var(--ink-3); flex: none; }
.app-select-search input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  color: var(--ink);
  font-size: 12.5px;
  padding: 4px 0;
  font-family: inherit;
}
.app-select-search input::placeholder { color: var(--ink-3); }
.app-select-clear {
  flex: none;
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--ink-3);
  cursor: pointer;
}
.app-select-clear:hover { background: var(--surface-2); color: var(--ink); }
.app-select-list {
  list-style: none;
  margin: 0;
  padding: 4px;
  overflow-y: auto;
  min-height: 0;
  flex: 1;
  max-height: 320px;
}
.app-select-group {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--surface);
  padding: 7px 8px 3px;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.06em;
  color: var(--ink-3);
}
.app-select-option {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 12.5px;
  color: var(--ink);
  min-height: 34px;
}
.app-select-option.is-active { background: var(--accent-soft); }
.app-select-option.is-custom .app-select-label { color: var(--accent); font-weight: 500; }
.app-select-check { flex: none; color: var(--accent); }
.app-select-checkpad { flex: none; width: 14px; }
.app-select-label {
  min-width: 0;
  flex: 0 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.app-select-label mark {
  background: var(--accent-soft);
  color: var(--accent);
  border-radius: 2px;
  padding: 0 1px;
}
.app-select-badges { display: inline-flex; gap: 4px; flex: none; }
.app-select-hint {
  margin-left: auto;
  flex: none;
  max-width: 45%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink-3);
  font-size: 11px;
}
.app-select-current { flex: none; }
.app-select-more,
.app-select-empty {
  padding: 10px 12px;
  font-size: 11.5px;
  color: var(--ink-3);
  text-align: center;
  flex: none;
}
.app-select-empty { cursor: pointer; }
.app-select-empty:hover { color: var(--ink); }

/* ── 移动端（≤680px）：底部抽屉 ── */
@media (max-width: 680px) {
  .app-select-backdrop {
    background: color-mix(in srgb, var(--ink) 32%, transparent);
  }
  .app-select-panel {
    left: 0;
    right: 0;
    bottom: 0;
    top: auto;
    width: auto;
    min-width: 0;
    max-width: none;
    border-radius: 16px 16px 0 0;
    border-bottom: none;
    max-height: 72vh;
    max-height: min(72dvh, 560px);
    padding-bottom: env(safe-area-inset-bottom);
  }
  .app-select-search input { min-height: 44px; }
  .app-select-list { max-height: none; }
  .app-select-option {
    min-height: 44px;
    padding: 10px 10px;
  }
  .app-select-hint { max-width: 38%; }
}
</style>
