<script setup lang="ts">
/**
 * 控制台外壳：仿 SnowLuma 的「自动收缩侧边栏 + 纸页画布」布局。
 *
 * 侧栏核心机制（对齐 SnowLuma packages/webui/components/layout/main-layout.tsx）：
 *  - 默认收起为 64px 图标栏；悬停或键盘 focus-visible 时临时展开到 248px。
 *  - **固定宽度内层 + 外层裁剪**：内层永远按 248px 布局，<aside> 只动画 width。
 *    这样图标不位移、文字不折行，只是被 reveal/clip —— 这是丝滑的关键，
 *    如果让内层跟着重排，过渡期间文字会跳动、图标会横向漂移。
 *  - 鼠标点击导航也会 focus 到链接，所以 peek 判定必须是 :focus-visible，
 *    否则点完菜单焦点残留，侧栏会一直卡在展开态。
 *  - 「钉住」后常驻展开，悬停不再收起（持久化到 localStorage）。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { navRoutes } from '../router';
import { useAuthStore } from '../stores/auth';
import { useConfigStore } from '../stores/config';
import { useCapabilityStore } from '../stores/capabilities';
import AppIcon from './AppIcon.vue';
import UiTooltip from './ui/UiTooltip.vue';
import UiFilePicker from './ui/UiFilePicker.vue';
import UiProgress from './ui/UiProgress.vue';
import UiSwitch from './ui/UiSwitch.vue';
import UiToastHost from './ui/UiToastHost.vue';
import { pushToast } from './ui/useToast';
import { useAutoHideScrollbar } from '../utils/auto-hide-scrollbar';
import '../decor/decor-mist.css';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const configStore = useConfigStore();
const capabilities = useCapabilityStore();

const theme = ref<'auto' | 'light' | 'dark'>((localStorage.getItem('miobot_theme') as any) || 'auto');
/* 氛围层（光斑/纸纹）开关——低配设备或嫌晃时可关；reduced-motion 只停动画不停渲染。 */
const atmosphere = ref(localStorage.getItem('miobot_atmosphere') !== 'off');

/* ── 滚动条自动隐藏：只在滚动时出现，停手约 1.2s 后消失 ──
   刻意不开 showOnHover：指针停在内容区里不该让滚动条常驻。 */
const navScrollEl = ref<HTMLElement | null>(null);
const mainScrollEl = ref<HTMLElement | null>(null);
const navScrollbar = useAutoHideScrollbar(navScrollEl, { idleMs: 1100, showOnHover: false });
const mainScrollbar = useAutoHideScrollbar(mainScrollEl, { idleMs: 1200, showOnHover: false });

/* 自动保存相关状态（Pinia setup store 已解包，这里转成模板可用的 computed） */
const autoSave = computed(() => configStore.autoSave);
const saveTone = computed(() => configStore.saveTone);
const saveConflict = computed(() => configStore.saveConflict);

/* ── 侧栏：收起 / 悬停展开 / 钉住 ── */
const isMobile = ref(false);
const mobileOpen = ref(false);
const pinned = ref(localStorage.getItem('miobot_sidebar_pinned') === '1');
const hovered = ref(false);
const focused = ref(false);
/** 过渡期间禁止文字被选中，避免拖选时误选到正在 reveal 的标签 */
const transitioning = ref(false);

const peeking = computed(() => hovered.value || focused.value);
/** 收起态：桌面 + 未钉住 + 未在 peek */
const collapsed = computed(() => !isMobile.value && !pinned.value && !peeking.value);

function onRailEnter() {
    if (isMobile.value) return;
    hovered.value = true;
}

function onRailLeave() {
    if (isMobile.value) return;
    hovered.value = false;
}

function onRailFocusIn(e: FocusEvent) {
    if (isMobile.value) return;
    // 只有键盘焦点才展开：鼠标点击链接也会触发 focus，但不会匹配 :focus-visible
    const target = e.target as HTMLElement | null;
    if (target?.matches?.(':focus-visible')) focused.value = true;
}

function onRailFocusOut(e: FocusEvent) {
    const next = e.relatedTarget as Node | null;
    if (!(e.currentTarget as HTMLElement).contains(next)) focused.value = false;
}

function togglePin() {
    pinned.value = !pinned.value;
    localStorage.setItem('miobot_sidebar_pinned', pinned.value ? '1' : '0');
    if (pinned.value) { hovered.value = false; focused.value = false; }
}

/* ── 响应式：≤860px 走抽屉 ── */
let mq: MediaQueryList | null = null;
function syncMobile(e?: MediaQueryListEvent) {
    isMobile.value = e ? e.matches : Boolean(mq?.matches);
    if (!isMobile.value) mobileOpen.value = false;
}

function closeMobile() { mobileOpen.value = false; }

function onWindowKey(e: KeyboardEvent) {
    if (e.key === 'Escape' && mobileOpen.value) closeMobile();
}

/* ── 路由切换进度条 ── */
const routeLoading = ref(false);
let routeTimer: number | null = null;
router.beforeEach(() => {
    // 切页前把待提交的改动落盘，避免「改完立刻点别的页面」丢改动
    void configStore.flushSave();
    routeLoading.value = true;
    if (routeTimer != null) window.clearTimeout(routeTimer);
    // 兜底：即使 afterEach 因异常没触发，也不能让进度条永久挂着
    routeTimer = window.setTimeout(() => { routeLoading.value = false; }, 4000);
});
router.afterEach(() => {
    if (routeTimer != null) window.clearTimeout(routeTimer);
    // 稍作停留再淡出，避免极快切换时闪一下
    routeTimer = window.setTimeout(() => { routeLoading.value = false; }, 140);
});

/* ── 纸面氛围（纯 CSS：光斑 + 纸纹）──
   Phase-UI 2：去掉了原来的「山雾」JS 装饰（decor-mist / 185KB SVG 山水）。
   它假设的是「整页长滚动、大图落在分页下方空白带」的老布局；
   现在外壳是固定视口 + 内层滚动，那幅图会被裁成一大片糊在内容上的水印，
   在能力中心这类留白多的页面上尤其脏。留 CSS 光斑 + 纸纹已经够给到纸感。
   ✨ 按钮仍然控制这一层（no-atmosphere）。 */

onMounted(() => {
    mq = window.matchMedia('(max-width: 860px)');
    syncMobile();
    mq.addEventListener?.('change', syncMobile);
    window.addEventListener('keydown', onWindowKey);
    // 页面转入后台（切标签 / 最小化）时立刻落盘，避免关标签丢改动
    document.addEventListener('visibilitychange', onVisibilityChange);
});

onBeforeUnmount(() => {
    mq?.removeEventListener?.('change', syncMobile);
    window.removeEventListener('keydown', onWindowKey);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    if (routeTimer != null) window.clearTimeout(routeTimer);
});

function onVisibilityChange() {
    if (document.visibilityState === 'hidden') void configStore.flushSave();
}

/* 收起时给 shell 打 data-rail，供 .ui-rail-hide 原子判断 */
watch(collapsed, (v) => {
    transitioning.value = true;
    window.setTimeout(() => { transitioning.value = false; }, 300);
    document.documentElement.dataset.rail = v ? 'collapsed' : 'open';
}, { immediate: true });

applyTheme();

function applyTheme() {
    if (theme.value === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme.value);
    localStorage.setItem('miobot_theme', theme.value);
}

function cycleTheme() {
    theme.value = theme.value === 'auto' ? 'light' : theme.value === 'light' ? 'dark' : 'auto';
    applyTheme();
}

function toggleAtmosphere() {
    atmosphere.value = !atmosphere.value;
    localStorage.setItem('miobot_atmosphere', atmosphere.value ? 'on' : 'off');
}

/** 侧栏按分组展示，同组的路由排在一起。 */
const groupedNav = computed(() => {
    const groups: Array<{ name: string; items: typeof navRoutes }> = [];
    for (const item of navRoutes) {
        const groupName = item.meta.group || '';
        let group = groups.find(g => g.name === groupName);
        if (!group) { group = { name: groupName, items: [] }; groups.push(group); }
        group.items.push(item);
    }
    return groups;
});

const themeLabel = computed(() => (theme.value === 'auto' ? '跟随系统' : theme.value === 'light' ? '浅色' : '深色'));

/**
 * 面包屑：多层页面（详情/专属配页）带可点击父级，最后一项（当前页）加粗。
 * 浅层页只有「控制台 / 页名」，与原来的静态文字一致。
 */
interface Crumb { label: string; to: string }

// 不入侧栏的页面也要有标题，否则面包屑只剩「控制台 /」，用户没有返回路径（死胡同）。
// 能力专页与几个从能力中心进入的配置页都在这里兜底。
const OFF_NAV_TITLES: Record<string, string> = {
    'cap-image': '图片生成',
    'cap-music': '音乐（Suno）',
    'cap-voice': '语音',
    'cap-file': '文件',
    'cap-memory': '记忆与 Qdrant',
    search: '联网搜索',
    render: '网页渲染',
};

const crumbs = computed<Crumb[]>(() => {
    const path = route.path;
    const current = (label: string): Crumb[] => [{ label, to: path }];
    const label = String(route.meta?.title || '');
    const backToCenter = { label: '能力中心', to: '/capabilities' };

    // 详情页：/capabilities/<id>、/tools/<id>——父级分别是能力中心、工具与权限
    if (path.startsWith('/capabilities/')) {
        return [backToCenter, ...current(String(route.params.id || label))];
    }
    if (path.startsWith('/tools/')) {
        return [{ label: '工具与权限', to: '/tools' }, ...current(String(route.params.id || label))];
    }

    /* Phase-UI 2（信息架构）：MCP 与记忆/Qdrant 已归入能力中心，
       所以它们的父级是「能力中心」，而不是像以前那样自成一级。 */
    if (path === '/mcp') {
        return [backToCenter, ...current('MCP 服务器')];
    }
    if (path.startsWith('/mcp/')) {
        const serverId = String(route.params.serverId || '');
        const registered = (capabilities.registry as Array<{ id?: string; name?: string }> | null)?.find?.((item) => item?.id === `mcp.${serverId}`);
        return [
            backToCenter,
            { label: 'MCP 服务器', to: '/mcp' },
            ...current(String(registered?.name || serverId)),
        ];
    }

    // 能力专页 / 能力中心卡片进入的配置页：父级挂回能力中心
    const offNav = OFF_NAV_TITLES[path.slice(1)];
    if (offNav) {
        return [backToCenter, ...current(offNav)];
    }

    // 无标题路由（重定向跳转瞬间等）不渲染空屑，避免「控制台 / 」尾巴
    return label ? current(label) : [];
});

/** 有父级时给顶栏一个明确的「返回」按钮（面包屑之外的第二条退路）。 */
const backTarget = computed<Crumb | null>(() => {
    const list = crumbs.value;
    if (list.length < 2) return null;
    return list[list.length - 2];
});

async function handleSave() {
    const result = await configStore.save();
    // 保存会改变配置/能力覆盖状态 → 体检与注册表强刷绕过 60s TTL。
    if (result.ok) {
        const msg = configStore.saveStatus || '已保存并热重载';
        pushToast(msg, msg.includes('失败') ? 'crit' : 'good');
        capabilities.refresh(true);
        capabilities.refreshRegistry(true);
    } else if (!result.conflict) {
        pushToast(configStore.saveStatus || '保存失败', 'crit');
    }
}

async function handleRetrySave() {
    const result = await configStore.retrySave();
    if (result.ok) {
        pushToast('已重新保存并热重载', 'good');
        capabilities.refresh(true);
        capabilities.refreshRegistry(true);
    } else {
        pushToast(configStore.saveStatus || '仍然保存失败', 'crit');
    }
}

function toggleAutoSave(next?: boolean | Event) {
    const target = typeof next === 'boolean' ? next : !autoSave.value;
    if (target === autoSave.value) return;
    configStore.setAutoSave(target);
    pushToast(
        target ? '已开启自动保存：改动后自动落盘并热重载' : '已关闭自动保存：请手动点「保存并热重载」',
        target ? 'good' : 'warn',
    );
}

async function handleExport() {
    try {
        const payload = await configStore.exportConfig();
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `miobot-config-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        configStore.saveStatus = '配置已导出';
        pushToast('配置已导出为 JSON 文件', 'good');
    } catch (error: any) {
        const msg = `导出失败：${error?.message || error}`;
        configStore.saveStatus = msg;
        pushToast(msg, 'crit');
    }
}

/** UiFilePicker 回传 File 后走原逻辑（含 window.confirm 二次确认）。 */
async function handleImportFile(file: File) {
    if (!window.confirm('导入配置会覆盖当前配置，建议先导出备份。确定继续？')) return;
    configStore.saveStatus = '导入中...';
    try {
        const result = await configStore.importConfig(JSON.parse(await file.text()));
        const migrated = result?.migrations?.length ? `，已迁移 ${result.migrations.length} 项旧字段` : '';
        configStore.saveStatus = `配置已导入并热重载${migrated}`;
        pushToast(`配置已导入并热重载${migrated}`, 'good');
        capabilities.refresh();
    } catch (error: any) {
        const msg = `导入失败：${error?.response?.data?.error || error?.message || error}`;
        configStore.saveStatus = msg;
        pushToast(msg, 'crit');
    }
}

function handleLogout() {
    auth.logout();
    configStore.reset();
    capabilities.reset();
    pushToast('已退出登录', 'info');
    router.push('/overview');
}
</script>

<template>
  <!-- 桌面层：四周留白，纸页浮在桌面上；680 断点收窄到 8px -->
  <div class="h-screen p-2 lg:p-6 xl:p-8 bg-[color:var(--desk)] overflow-hidden" :class="{ 'no-atmosphere': !atmosphere }">
    <!-- 纸页外壳：大圆角 + 细描边 + 桌面投影，整页摊在桌面上 -->
    <div
      class="shell relative h-full flex rounded-[14px] border border-[color:var(--hairline-2)] bg-[color:var(--page)] overflow-hidden"
      style="box-shadow: var(--shell-shadow);"
    >
      <!-- 宣纸氛围层：极淡双色光斑 + 纸纹颗粒（纯装饰，不拦截交互） -->
      <div class="aurora a" aria-hidden="true"></div>
      <div class="aurora b" aria-hidden="true"></div>
      <div class="paper-grain" aria-hidden="true"></div>

      <!-- 移动端抽屉遮罩 -->
      <Transition name="scrim">
        <button
          v-if="isMobile && mobileOpen"
          type="button"
          class="rail-scrim"
          aria-label="关闭导航"
          @click="closeMobile"
        />
      </Transition>

      <!-- ═══ 侧栏：外层只动画宽度，内层固定 248px ═══ -->
      <aside
        class="rail"
        :class="{ 'is-collapsed': collapsed, 'is-mobile-open': mobileOpen, 'is-mobile': isMobile }"
        :data-rail="collapsed ? 'collapsed' : 'open'"
        @mouseenter="onRailEnter"
        @mouseleave="onRailLeave"
        @focusin="onRailFocusIn"
        @focusout="onRailFocusOut"
      >
        <div class="rail__inner">
          <!-- 品牌区：图标固定 48px 列居中，文字随收起淡出（不 unmount） -->
          <div class="rail__brand">
            <span class="rail__mark">
              <span class="rail__mark-badge">
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M5 12h4M13 5h6a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-6z" />
                  <path d="M4 18h3a3 3 0 0 0 3-3V9a3 3 0 0 0-3-3H4z" />
                </svg>
              </span>
            </span>
            <span class="rail__brand-text ui-rail-hide">
              <span class="rail__brand-name">Miobot</span>
              <span class="rail__brand-sub">管理控制台 v2</span>
            </span>
          </div>

          <!-- 导航 -->
          <nav
            ref="navScrollEl"
            class="rail__nav"
            :class="{ 'is-scrolling': navScrollbar.visible.value }"
            :data-collapsed="collapsed"
          >
            <template v-for="group in groupedNav" :key="group.name">
              <div
                v-if="group.name"
                class="rail__group-label ui-rail-hide"
                aria-hidden="true"
              >{{ group.name }}</div>

              <UiTooltip
                v-for="item in group.items"
                :key="item.path"
                :content="String(item.meta.title)"
                :placement="collapsed ? 'right' : 'top'"
                :disabled="!collapsed"
                class="rail__tip"
              >
                <RouterLink
                  :to="item.path"
                  :class="['rail__item', route.path === item.path ? 'is-active' : '']"
                  :aria-current="route.path === item.path ? 'page' : undefined"
                  :aria-label="String(item.meta.title)"
                  @click="closeMobile"
                >
                  <!-- 活动指示：绝对定位，收起时是居中圆角方块，展开时是全宽胶囊 -->
                  <span
                    v-if="route.path === item.path"
                    class="rail__active-bg"
                    aria-hidden="true"
                  />
                  <span class="rail__icon">
                    <AppIcon :name="item.meta.icon" :size="15" />
                  </span>
                  <span class="rail__label ui-rail-hide">{{ item.meta.title }}</span>
                  <span
                    v-if="item.path === '/models' && capabilities.brokenCount"
                    class="rail__dot dot dot-crit"
                    :title="`${capabilities.brokenCount} 项能力配置有问题`"
                  />
                </RouterLink>
              </UiTooltip>
            </template>
          </nav>

          <!-- 底部：退出 + 钉住 -->
          <div class="rail__foot">
            <UiTooltip content="退出登录" :placement="collapsed ? 'right' : 'top'" :disabled="!collapsed">
              <button
                type="button"
                class="rail__item rail__item--danger"
                aria-label="退出登录"
                @click="handleLogout"
              >
                <span class="rail__icon"><AppIcon name="logout" :size="15" /></span>
                <span class="rail__label ui-rail-hide">退出登录</span>
              </button>
            </UiTooltip>
          </div>
        </div>
      </aside>

      <!-- ═══ 主列：纸面画布 ═══ -->
      <div class="canvas-col flex flex-col overflow-hidden">
        <!-- 顶栏 -->
        <header class="topbar">
          <button
            v-if="isMobile"
            type="button"
            class="topbar__icon-btn"
            aria-label="打开导航"
            @click="mobileOpen = true"
          >
            <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
              <path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
            </svg>
          </button>

          <!-- 返回：有父级层级时给一条明确的退路（面包屑之外的第二个出口） -->
          <button
            v-if="backTarget"
            type="button"
            class="topbar__back"
            :aria-label="`返回${backTarget.label}`"
            :title="`返回${backTarget.label}`"
            @click="router.push(backTarget.to)"
          >
            <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
              <path d="M9.5 3.5L5 8l4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </button>

          <!-- 面包屑：父级可点击返回上层，当前页加粗不可点 -->
          <nav class="crumbs" aria-label="面包屑">
            <RouterLink to="/overview" class="crumbs__link">控制台</RouterLink>
            <template v-for="(crumb, i) in crumbs" :key="crumb.to">
              <span class="crumbs__sep">/</span>
              <RouterLink
                v-if="i < crumbs.length - 1"
                :to="crumb.to"
                class="crumbs__link crumbs__link--trunc"
              >{{ crumb.label }}</RouterLink>
              <b v-else class="crumbs__cur">{{ crumb.label }}</b>
            </template>
          </nav>

          <span class="flex-1"></span>

          <!-- 保存状态：自动保存开启时只显示状态（无感），冲突时给手动重试 -->
          <span
            class="save-chip"
            :data-tone="saveConflict ? 'error' : saveTone"
            :title="configStore.saveStatus || undefined"
          >
            <span class="save-chip__dot" aria-hidden="true" />
            <span class="save-chip__text">
              <template v-if="saveConflict">保存冲突</template>
              <template v-else-if="configStore.saving">保存中…</template>
              <template v-else-if="configStore.dirty">未保存</template>
              <template v-else-if="saveTone === 'error'">{{ configStore.saveStatus || '保存失败' }}</template>
              <template v-else>已保存</template>
            </span>
          </span>

          <button
            v-if="saveConflict"
            type="button"
            class="btn-outline topbar__text-btn"
            @click="handleRetrySave"
          >重试保存</button>

          <!-- 自动保存开关：用真开关（滑块会动、开/关底色不同），不用图标按钮 -->
          <UiTooltip
            :content="autoSave ? '自动保存已开启：改动后自动落盘并热重载' : '自动保存已关闭：需要手动点「保存并热重载」'"
            placement="bottom"
          >
            <label class="autosave" :class="{ 'is-on': autoSave }">
              <UiSwitch
                :model-value="autoSave"
                size="sm"
                tone="good"
                label="自动保存"
                @update:model-value="toggleAutoSave"
              />
              <span class="autosave__text">自动保存</span>
            </label>
          </UiTooltip>

          <UiFilePicker
            class="topbar__import"
            accept="application/json,.json"
            label="导入"
            aria-label="导入配置文件"
            @select="handleImportFile"
          />
          <button type="button" class="btn-outline topbar__text-btn" @click="handleExport">导出</button>

          <UiTooltip :content="`主题：${themeLabel}`" placement="bottom">
            <button
              type="button"
              class="btn-outline topbar__icon-btn"
              :aria-label="`切换主题，当前：${themeLabel}`"
              @click="cycleTheme"
            >
              <AppIcon name="moon" :size="14" />
            </button>
          </UiTooltip>

          <UiTooltip :content="`氛围效果：${atmosphere ? '开' : '关'}`" placement="bottom">
            <button
              type="button"
              class="btn-outline topbar__icon-btn"
              :aria-label="`切换氛围效果（纸纹与光斑），当前：${atmosphere ? '开启' : '关闭'}`"
              :aria-pressed="atmosphere"
              @click="toggleAtmosphere"
            >
              <AppIcon name="sparkle" :size="14" />
            </button>
          </UiTooltip>

          <!-- 钉住侧栏（仅桌面）：钉住后常驻展开 -->
          <UiTooltip v-if="!isMobile" :content="pinned ? '取消钉住（恢复悬停展开）' : '钉住侧栏（保持展开）'" placement="bottom">
            <button
              type="button"
              class="btn-outline topbar__icon-btn"
              :class="{ 'is-on': pinned }"
              :aria-label="pinned ? '取消钉住侧栏' : '钉住侧栏'"
              :aria-pressed="pinned"
              @click="togglePin"
            >
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                <template v-if="pinned">
                  <path d="M6 2h4l-.6 4 2.1 1.8V9H4.5v-1.2L6.6 6z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />
                  <path d="M8 9v4.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
                </template>
                <template v-else>
                  <path d="M6 2h4l-.6 4 2.1 1.8V9H4.5v-1.2L6.6 6z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />
                  <path d="M8 9v4.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
                  <path d="M2.5 13.5l11-11" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
                </template>
              </svg>
            </button>
          </UiTooltip>

          <button
            v-if="!autoSave"
            type="button"
            class="btn-primary topbar__save"
            :disabled="configStore.saving || !configStore.dirty"
            @click="handleSave"
          >
            {{ configStore.saving ? '保存中…' : '保存并热重载' }}
          </button>
        </header>

        <!-- 路由切换进度条 -->
        <Transition name="rprog">
          <UiProgress v-if="routeLoading" :indeterminate="true" :height="2" class="route-progress" label="页面加载中" />
        </Transition>

        <!-- 内容区：路由过渡 -->
        <main
          ref="mainScrollEl"
          class="main-scroll"
          :class="{ 'is-scrolling': mainScrollbar.visible.value }"
        >
          <div class="main-inner">
            <RouterView v-slot="{ Component }">
              <Transition name="route" mode="out-in">
                <component :is="Component" :key="route.path" />
              </Transition>
            </RouterView>
          </div>
        </main>
      </div>
    </div>

    <!-- 全局 toast 宿主（保存/导入/导出等短反馈） -->
    <UiToastHost />
  </div>
</template>

<style scoped>
/* ═══ 侧栏：宽度动画的核心 ═══ */
.rail {
  position: relative;
  z-index: 20;
  flex: none;
  height: 100%;
  width: var(--sidebar-w-open);
  overflow: hidden;
  background: var(--sidebar-bg);
  border-right: 1px solid var(--hairline-2);
  transition: width var(--dur-3) var(--ease-struct);
  will-change: width;
}
.rail.is-collapsed { width: var(--sidebar-w-rail); }

/* 内层永远按展开宽度布局 —— 收起时只是被外层 clip，不重排 */
.rail__inner {
  display: flex;
  flex-direction: column;
  width: var(--sidebar-w-open);
  height: 100%;
  min-height: 0;
}

/* 品牌区高度必须与右侧 .topbar 一致（共用 --shell-topbar-h），
   这样两条 border-bottom 连成一条横线，不会有 6px 的错位台阶。 */
.rail__brand {
  display: flex;
  align-items: center;
  flex: none;
  height: var(--shell-topbar-h);
  padding: 0 8px;
  border-bottom: 1px solid var(--hairline-2);
}
/* 48px 宽的固定列（= 64px 栏宽 - 左右各 8px 内距），徽标在其中居中，
   收起/展开时位置不变 —— 与导航项的 48px 图标列对齐。 */
.rail__mark {
  display: grid;
  place-items: center;
  flex: none;
  width: 48px;
}
.rail__mark-badge {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border-radius: 9px;
  background: var(--accent);
  color: var(--accent-ink);
  box-shadow: 0 2px 8px color-mix(in srgb, var(--accent) 28%, transparent);
}
.rail__brand-text {
  display: grid;
  gap: 1px;
  min-width: 0;
  padding-left: 6px;
  white-space: nowrap;
  overflow: hidden;
}
.rail__brand-name {
  font-family: var(--serif);
  font-size: 15px;
  font-weight: 700;
  color: var(--ink);
  line-height: 1.15;
}
.rail__brand-sub { font-size: 10.5px; color: var(--ink-3); }

.rail__nav {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 1px;

  /* 滚动条：默认完全隐形；只有「正在滚动」或「指针在导航区」时才出现。
     这正是 SnowLuma 用 Radix ScrollArea / Linear / Notion 的 overlay 行为 ——
     滚动条是瞬时反馈，不是常驻装饰。
     注意：Firefox 走 scrollbar-color（放在下方 @supports 里），
     Chrome 走 ::-webkit-scrollbar —— 两者不能同时声明，否则 Chrome 会忽略伪元素。 */
  overscroll-behavior: contain;
}

/* Firefox 分支：不支持 ::-webkit-scrollbar 时才用 scrollbar-color 控制显隐 */
@supports not selector(::-webkit-scrollbar) {
  .rail__nav { scrollbar-width: thin; scrollbar-color: transparent transparent; }
  .rail__nav.is-scrolling { scrollbar-color: color-mix(in srgb, var(--ink-3) 38%, transparent) transparent; }
  .main-scroll { scrollbar-width: thin; scrollbar-color: transparent transparent; }
  .main-scroll.is-scrolling { scrollbar-color: color-mix(in srgb, var(--ink-3) 34%, transparent) transparent; }
}

.rail__nav::-webkit-scrollbar { width: 6px; }
.rail__nav::-webkit-scrollbar-track { background: transparent; }
.rail__nav::-webkit-scrollbar-thumb {
  background: transparent;
  border-radius: 99px;
  background-clip: content-box;
  border: 1px solid transparent;
}
.rail__nav.is-scrolling::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--ink-3) 36%, transparent);
  background-clip: content-box;
}
.rail__nav.is-scrolling::-webkit-scrollbar-thumb:hover {
  background: color-mix(in srgb, var(--ink-3) 60%, transparent);
  background-clip: content-box;
}

/* 分组标题：收起时保持占位（不 display:none，否则布局跳动）。
   内距压到最小，尽量让 21 个导航项少滚一点。 */
.rail__group-label {
  padding: 8px 10px 3px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  color: var(--ink-3);
  white-space: nowrap;
  flex: none;
}
.rail__group-label:first-child { padding-top: 1px; }

/* Tooltip 包裹层必须撑满宽度，否则链接宽度塌成图标宽 */
.rail__tip { display: flex; width: 100%; }
.rail__tip :deep(.tt-anchor) { display: flex; width: 100%; }

.rail__item {
  position: relative;
  display: flex;
  align-items: center;
  width: 100%;
  height: 34px;
  border: 0;
  border-radius: 9px;
  background: transparent;
  color: var(--ink-2);
  font-size: 13px;
  font-weight: 500;
  text-align: left;
  text-decoration: none;
  cursor: pointer;
  outline: none;
  padding: 0;
  flex: none;
  transition: color var(--dur-1) var(--ease);
}
.rail__item:focus-visible { box-shadow: var(--focus-ring); }
.rail__item:hover { color: var(--ink); }

/* 活动项背景：收起 = 居中 40px 圆角方块；展开 = 全宽胶囊。
   两者都绝对定位，只改几何，不触发任何 reflow。 */
.rail__active-bg {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  right: 0;
  border-radius: 9px;
  background: var(--surface);
  border: 1px solid var(--hairline-2);
  box-shadow: 0 1px 3px rgba(30, 28, 20, .07);
  transition: left var(--dur-3) var(--ease-struct),
              right var(--dur-3) var(--ease-struct),
              border-radius var(--dur-3) var(--ease-struct);
}
.rail.is-collapsed .rail__active-bg {
  left: 8px;
  right: 8px;
  border-radius: 9px;
}

.rail__icon {
  position: relative;
  z-index: 1;
  display: grid;
  place-items: center;
  flex: none;
  width: 48px;
  color: inherit;
  transition: color var(--dur-1) var(--ease);
}
.rail__item:hover .rail__icon { color: var(--ink); }
.rail__item.is-active .rail__icon { color: var(--accent); }
.rail__item.is-active { color: var(--accent); font-weight: 600; }

.rail__label {
  position: relative;
  z-index: 1;
  min-width: 0;
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding-right: 10px;
}

.rail__dot { position: relative; z-index: 1; margin-right: 12px; flex: none; }

.rail__foot {
  flex: none;
  padding: 6px 8px 10px;
  border-top: 1px solid var(--hairline-2);
}
.rail__item--danger { color: var(--critical); }
.rail__item--danger:hover { color: var(--critical); }
.rail__item--danger:hover .rail__active-bg { background: var(--critical-soft); }

/* 移动端：抽屉 + 遮罩 */
.rail.is-mobile {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: var(--sidebar-w-open);
  transform: translateX(-100%);
  transition: transform var(--dur-3) var(--ease-out-expo);
  box-shadow: var(--sh-2);
  z-index: 60;
}
.rail.is-mobile.is-mobile-open { transform: none; }

.rail-scrim {
  position: absolute;
  inset: 0;
  z-index: 55;
  border: 0;
  background: rgba(18, 19, 16, .3);
  backdrop-filter: blur(2px);
  cursor: pointer;
}
.scrim-enter-active, .scrim-leave-active { transition: opacity var(--dur-2) var(--ease-swift); }
.scrim-enter-from, .scrim-leave-to { opacity: 0; }

/* ═══ 主列 ═══ */
/* 主列：不再自己铺底色。
   纸色由外层 .shell 提供，这样 .aurora / .paper-grain / 山雾才透得出来 ——
   否则它们全被这层不透明背景挡住，氛围开关等于失效。
   卡片本身是不透明白，所以文字可读性不受影响。 */
.canvas-col {
  position: relative;
  z-index: 2;
  min-width: 0;
  flex: 1 1 auto;
  background: transparent;
  box-shadow: 0 0 18px -6px rgba(0, 0, 0, .14);
}

.topbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
  height: var(--shell-topbar-h);
  padding: 0 14px 0 18px;
  border-bottom: 1px solid var(--hairline-2);
  background: var(--topbar-bg);
  backdrop-filter: blur(12px) saturate(1.05);
}

.topbar__icon-btn {
  flex: none;
  display: inline-grid;
  place-items: center;
  width: 30px;
  min-height: 30px;
  padding: 0;
  border-radius: 7px;
}
.topbar__icon-btn.is-on {
  background: var(--accent-soft);
  border-color: var(--accent-line);
  color: var(--accent);
}

/* ── 自动保存开关：胶囊外壳 + 真滑块，开/关在底色、文字色、滑块位置三处同时变化 ── */
.autosave {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: none;
  height: 28px;
  padding: 0 10px 0 7px;
  border: 1px solid var(--hairline-2);
  border-radius: 999px;
  background: var(--surface);
  cursor: pointer;
  user-select: none;
  transition: background var(--dur-2) var(--ease), border-color var(--dur-2) var(--ease),
              color var(--dur-2) var(--ease);
}
.autosave:hover { border-color: var(--hairline-3); background: var(--surface-2); }
.autosave.is-on {
  border-color: var(--accent-line);
  background: var(--accent-soft);
}
.autosave.is-on:hover { background: color-mix(in srgb, var(--accent-soft) 70%, var(--surface)); }

.autosave__text {
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
  color: var(--ink-3);
  transition: color var(--dur-2) var(--ease);
}
.autosave.is-on .autosave__text { color: var(--accent); }

/* 顶栏空间紧张时只留开关本体（文字隐藏，语义由 tooltip + aria 兜住） */
@media (max-width: 1240px) {
  .autosave__text { display: none; }
  .autosave { padding: 0 6px; }
}
.topbar__text-btn { flex: none; }
.topbar__import { flex: none; }
.topbar__import :deep(.picker__chip) { display: none; }

.topbar__save { flex: none; white-space: nowrap; }

.topbar__status {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  font-size: 11.5px;
}
.topbar__status--dirty { color: var(--ink-2); }
.topbar__status--saved { color: var(--ink-3); }

/* ── 保存状态胶囊：自动保存开启时它是唯一的保存反馈 ── */
.save-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: none;
  height: 22px;
  padding: 0 9px;
  border: 1px solid var(--hairline-2);
  border-radius: 999px;
  background: var(--surface);
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
  color: var(--ink-3);
  transition: color var(--dur-2) var(--ease), border-color var(--dur-2) var(--ease),
              background var(--dur-2) var(--ease);
}
.save-chip__dot {
  width: 6px;
  height: 6px;
  flex: none;
  border-radius: 50%;
  background: currentColor;
  opacity: .75;
}

.save-chip[data-tone='saving'] {
  border-color: var(--accent-line);
  background: var(--accent-soft);
  color: var(--accent);
}
.save-chip[data-tone='saving'] .save-chip__dot { animation: save-pulse 1s var(--ease-swift) infinite; }

.save-chip[data-tone='success'] {
  border-color: color-mix(in srgb, var(--good) 34%, var(--hairline-2));
  background: var(--good-soft);
  color: var(--good-text);
}
.save-chip[data-tone='warning'] {
  border-color: var(--warning-soft);
  background: var(--warning-soft);
  color: var(--warning);
}
.save-chip[data-tone='error'] {
  border-color: color-mix(in srgb, var(--critical) 34%, var(--hairline-2));
  background: var(--critical-soft);
  color: var(--critical);
}

@keyframes save-pulse {
  0%, 100% { opacity: .35; }
  50% { opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
  .save-chip[data-tone='saving'] .save-chip__dot { animation: none; }
}

.crumbs {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: 12.5px;
}

/* 返回按钮：只在有父级层级时出现，跟面包屑同高，弱化处理不抢「保存」 */
.topbar__back {
  flex: none;
  display: inline-grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border: 1px solid var(--hairline-2);
  border-radius: 6px;
  background: var(--surface);
  color: var(--ink-2);
  cursor: pointer;
  transition: background var(--dur-2) var(--ease), color var(--dur-2) var(--ease),
              border-color var(--dur-2) var(--ease);
}
.topbar__back:hover {
  border-color: var(--accent-line);
  background: var(--accent-soft);
  color: var(--accent);
}
.topbar__back:focus-visible { box-shadow: var(--focus-ring); }
.crumbs__link {
  color: var(--ink-3);
  text-decoration: none;
  transition: color var(--dur-1) var(--ease);
}
.crumbs__link:hover { color: var(--accent); }
.crumbs__link--trunc { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 180px; }
.crumbs__sep { color: var(--hairline-3); }
.crumbs__cur {
  color: var(--ink);
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 240px;
}

/* 进度条贴在顶栏下沿（高度跟 --shell-topbar-h 走） */
.route-progress { position: absolute; top: var(--shell-topbar-h); left: 0; right: 0; z-index: 30; }
.rprog-enter-active, .rprog-leave-active { transition: opacity var(--dur-2) var(--ease-swift); }
.rprog-enter-from, .rprog-leave-to { opacity: 0; }

.main-scroll {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 18px;

  /* 内容区滚动条：默认完全隐形，滚动时才浮出（overlay 行为）。
     scrollbar-gutter: stable 让「长页 / 短页」切换时内容宽度不跳（切路由时很明显）。 */
  scrollbar-gutter: stable;
  overscroll-behavior: contain;
}
.main-scroll::-webkit-scrollbar { width: 10px; }
.main-scroll::-webkit-scrollbar-track { background: transparent; }
.main-scroll::-webkit-scrollbar-thumb {
  background: transparent;
  border-radius: 99px;
  border: 3px solid transparent;
  background-clip: content-box;
}
.main-scroll.is-scrolling::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--ink-3) 34%, transparent);
  background-clip: content-box;
}
.main-scroll.is-scrolling::-webkit-scrollbar-thumb:hover {
  background: color-mix(in srgb, var(--ink-3) 62%, transparent);
  background-clip: content-box;
}
.main-inner { position: relative; max-width: 1280px; margin: 0 auto; }

/* 路由过渡：进入上浮淡入，离开上飘淡出（class 定义在 style.css） */
.route-enter-active { transition: opacity var(--dur-3) var(--ease-out-expo), transform var(--dur-3) var(--ease-out-expo); }
.route-leave-active { transition: opacity var(--dur-1) var(--ease-swift), transform var(--dur-1) var(--ease-swift); }
.route-enter-from { opacity: 0; transform: translateY(8px); }
.route-leave-to { opacity: 0; transform: translateY(-4px); }

@media (max-width: 860px) {
  .topbar { padding: 0 10px; gap: 6px; }
  .main-scroll { padding: 12px; }
  .crumbs { font-size: 12px; }
}

@media (prefers-reduced-motion: reduce) {
  .rail, .rail__active-bg, .rail.is-mobile,
  .route-enter-active, .route-leave-active,
  .scrim-enter-active, .scrim-leave-active { transition: none; }
  .rail__active-bg { transition: none; }
}
</style>
