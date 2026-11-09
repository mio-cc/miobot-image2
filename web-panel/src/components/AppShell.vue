<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { navRoutes } from '../router';
import { useAuthStore } from '../stores/auth';
import { useConfigStore } from '../stores/config';
import { useCapabilityStore } from '../stores/capabilities';
import AppIcon from './AppIcon.vue';
import '../decor/decor-mist.css';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const configStore = useConfigStore();
const capabilities = useCapabilityStore();

const importInput = ref<HTMLInputElement | null>(null);
const theme = ref<'auto' | 'light' | 'dark'>((localStorage.getItem('miobot_theme') as any) || 'auto');
/* P15：氛围层（光斑/纸纹）用户开关——低配设备或嫌晃时可关闭；reduced-motion 只停动画不停渲染。 */
const atmosphere = ref(localStorage.getItem('miobot_atmosphere') !== 'off');

/* 山雾装饰：纸页外壳的懒加载挂载点（只读开关初值，不新增状态）。 */
const shellEl = ref<HTMLElement | null>(null);
let mist: { destroy(): void } | null = null;

onMounted(() => {
    const start = () => {
        import('../decor/decor-mist').then(({ mountMist }) => {
            if (!shellEl.value) return;
            mist = mountMist({ host: shellEl.value, sidebar: '.sidebar', scroller: 'main' });
        });
    };
    if (atmosphere.value) {
        // 空闲后再拉装饰包，首屏不参与
        (window as any).requestIdleCallback
            ? (window as any).requestIdleCallback(start, { timeout: 2000 })
            : setTimeout(start, 400);
    }
});

onBeforeUnmount(() => { mist?.destroy(); mist = null; });

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
 * R21-g 面包屑导航：多层页面（详情/专属配页）带可点击父级，最后一项（当前页）加粗。
 * 浅层页只有「控制台 / 页名」，与原来的静态文字一致。
 */
interface Crumb { label: string; to: string }

// 五个能力专页路由没有 meta.title（刻意不入侧栏），用页面原标题兜底。
const CAP_TITLES: Record<string, string> = {
    'cap-image': '图片生成',
    'cap-music': '音乐（Suno）',
    'cap-voice': '语音',
    'cap-file': '文件',
    'cap-memory': '向量记忆',
};

const crumbs = computed<Crumb[]>(() => {
    const path = route.path;
    const current = (label: string): Crumb[] => [{ label, to: path }];
    const label = String(route.meta?.title || '');
    // 详情页：/capabilities/<id>、/tools/<id>——父级分别是能力中心、工具与权限
    if (path.startsWith('/capabilities/')) {
        return [{ label: '能力中心', to: '/capabilities' }, ...current(String(route.params.id || label))];
    }
    if (path.startsWith('/tools/')) {
        return [{ label: '工具与权限', to: '/tools' }, ...current(String(route.params.id || label))];
    }
    // P4-MCP：/mcp 已成为主导航一级模块（不再挂在能力中心下）——详情页父级是 MCP 列表。
    if (path === '/mcp') {
        return current('MCP 服务器');
    }
    if (path.startsWith('/mcp/')) {
        const serverId = String(route.params.serverId || '');
        const registered = (capabilities.registry as Array<{ id?: string; name?: string }> | null)?.find?.((item) => item?.id === `mcp.${serverId}`);
        return [
            { label: 'MCP 服务器', to: '/mcp' },
            ...current(String(registered?.name || serverId)),
        ];
    }
    // 能力中心卡片进入的专属配置页：面包屑挂回能力中心
    if (CAP_TITLES[path.slice(1)]) {
        return [{ label: '能力中心', to: '/capabilities' }, ...current(CAP_TITLES[path.slice(1)])];
    }
    // 无标题路由（重定向跳转瞬间等）不渲染空屑，避免「控制台 / 」尾巴
    return label ? current(label) : [];
});

async function handleSave() {
    const result = await configStore.save();
    // 保存会改变配置/能力覆盖状态 → 体检与注册表强刷绕过 60s TTL。
    if (result.ok) { capabilities.refresh(true); capabilities.refreshRegistry(true); }
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
    } catch (error: any) {
        configStore.saveStatus = `导出失败：${error?.message || error}`;
    }
}

async function handleImportFile(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (!window.confirm('导入配置会覆盖当前配置，建议先导出备份。确定继续？')) return;
    configStore.saveStatus = '导入中...';
    try {
        const result = await configStore.importConfig(JSON.parse(await file.text()));
        const migrated = result?.migrations?.length ? `，已迁移 ${result.migrations.length} 项旧字段` : '';
        configStore.saveStatus = `配置已导入并热重载${migrated}`;
        capabilities.refresh();
    } catch (error: any) {
        configStore.saveStatus = `导入失败：${error?.response?.data?.error || error?.message || error}`;
    }
}

function handleLogout() {
    auth.logout();
    configStore.reset();
    capabilities.reset();
    router.push('/overview');
}
</script>

<template>
  <!-- 桌面层：四周留白（原型量级 + 一档：桌面 24~32px），680 断点收窄到 8px，纸页浮在桌面上 -->
  <div class="h-screen p-2 lg:p-6 xl:p-8 bg-[color:var(--desk)] overflow-hidden" :class="{ 'no-atmosphere': !atmosphere }">
    <!-- 纸页外壳（原型 .win）：大圆角 + 细描边 + 桌面投影，整页摊在桌面上 -->
    <div ref="shellEl" class="relative h-full grid grid-cols-[224px_1fr] max-[860px]:grid-cols-[62px_1fr] rounded-[14px] border border-[color:var(--hairline-2)] bg-[color:var(--page)] overflow-hidden"
      style="box-shadow: var(--shell-shadow);">
    <!-- 宣纸氛围层：极淡双色光斑 + 纸纹颗粒（纯装饰，不拦截交互） -->
    <div class="aurora a" aria-hidden="true"></div>
    <div class="aurora b" aria-hidden="true"></div>
    <div class="paper-grain" aria-hidden="true"></div>
    <aside class="sidebar overflow-y-auto">
      <div class="px-4 py-4 border-b border-[color:var(--hairline-2)] flex items-center gap-3">
        <div class="flex-none w-[30px] h-[30px] rounded-[9px] grid place-items-center text-[color:var(--accent-ink)] shadow-sm"
          style="background: var(--accent); box-shadow: 0 2px 8px color-mix(in srgb, var(--accent) 30%, transparent);">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M5 12h4M13 5h6a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-6z"/><path d="M4 18h3a3 3 0 0 0 3-3V9a3 3 0 0 0-3-3H4z"/>
          </svg>
        </div>
        <div class="min-w-0 max-[860px]:hidden">
          <div class="brand-title text-[15px] tracking-wide text-[color:var(--ink)]">Miobot</div>
          <div class="text-[color:var(--ink-3)] text-[10.5px] mt-0.5">管理控制台 v2</div>
        </div>
      </div>

      <nav class="flex-1 p-2.5">
        <template v-for="group in groupedNav" :key="group.name">
          <div v-if="group.name" class="text-[10.5px] font-semibold tracking-wider text-[color:var(--ink-3)] uppercase px-2.5 pt-3.5 pb-1.5 max-[860px]:hidden">
            {{ group.name }}
          </div>
          <RouterLink v-for="item in group.items" :key="item.path" :to="item.path"
            :class="['sidebar-item', route.path === item.path ? 'sidebar-item-active' : 'sidebar-item-inactive']">
            <span class="flex-none" :class="route.path === item.path ? '' : 'text-[color:var(--ink-3)]'">
              <AppIcon :name="item.meta.icon" />
            </span>
            <span class="max-[860px]:hidden">{{ item.meta.title }}</span>
            <span v-if="item.path === '/models' && capabilities.brokenCount"
              class="ml-auto dot dot-crit max-[860px]:ml-0" :title="`${capabilities.brokenCount} 项能力配置有问题`"></span>
          </RouterLink>
        </template>
      </nav>

      <div class="p-2.5 border-t border-[color:var(--hairline-2)]">
        <button class="sidebar-item sidebar-item-inactive w-full" @click="handleLogout">
          <AppIcon name="logout" />
          <span class="max-[860px]:hidden">退出登录</span>
        </button>
      </div>
    </aside>

    <div class="mb-content flex flex-col overflow-hidden">
      <header class="flex items-center gap-3 px-5 h-[54px] flex-none border-b border-[color:var(--hairline-2)] bg-[color:var(--topbar-bg)] backdrop-blur-md">
        <!-- R21-g 面包屑：父级可点击返回上层，当前页加粗不可点 -->
        <nav class="text-[13px] flex items-center gap-1.5 max-sm:hidden min-w-0" aria-label="面包屑">
          <RouterLink to="/overview" class="text-[color:var(--ink-3)] hover:text-[color:var(--accent)] transition-colors">控制台</RouterLink>
          <template v-for="(crumb, i) in crumbs" :key="crumb.to">
            <span class="text-[color:var(--hairline-3)]">/</span>
            <RouterLink v-if="i < crumbs.length - 1" :to="crumb.to"
              class="text-[color:var(--ink-3)] hover:text-[color:var(--accent)] transition-colors truncate max-w-[220px]">{{ crumb.label }}</RouterLink>
            <b v-else class="text-[color:var(--ink)] font-semibold truncate max-w-[260px]">{{ crumb.label }}</b>
          </template>
        </nav>
        <span class="flex-1"></span>

        <span v-if="configStore.saveStatus" class="text-xs truncate max-w-[36vw]" :title="configStore.saveStatus"
          :class="configStore.saveStatus.includes('失败') ? 'status-crit' : 'status-good'">
          {{ configStore.saveStatus }}
        </span>
        <span v-else-if="configStore.dirty" class="flex items-center gap-1.5 min-w-0" :title="`未保存的分区：${configStore.dirtySections.join('、')}`">
          <span class="dot dot-warn flex-none"></span>
          <span class="text-xs status-warn flex-none">未保存</span>
          <span v-for="section in configStore.dirtySections.slice(0, 3)" :key="section" class="tag tag-warn max-sm:hidden">{{ section }}</span>
          <span v-if="configStore.dirtySections.length > 3" class="text-xs text-[color:var(--ink-3)] max-sm:hidden">+{{ configStore.dirtySections.length - 3 }}</span>
        </span>
        <span v-else-if="configStore.loaded" class="text-xs flex items-center gap-1.5 text-[color:var(--ink-3)]">
          <span class="dot dot-good"></span>已保存
        </span>

        <input ref="importInput" type="file" accept="application/json,.json" class="hidden" @change="handleImportFile" />
        <button class="btn-outline max-lg:hidden" @click="handleExport">导出</button>
        <button class="btn-outline max-lg:hidden" @click="importInput?.click()">导入</button>
        <button class="btn-outline !px-2" :title="`主题：${themeLabel}`" :aria-label="`切换主题，当前：${themeLabel}`" @click="cycleTheme">
          <AppIcon name="moon" :size="14" />
        </button>
        <button class="btn-outline !px-2" :title="`氛围效果：${atmosphere ? '开' : '关'}`"
          :aria-label="`切换氛围效果（纸纹与光斑），当前：${atmosphere ? '开启' : '关闭'}`"
          :aria-pressed="atmosphere" @click="toggleAtmosphere">
          <AppIcon name="sparkle" :size="14" />
        </button>
        <button class="btn-primary" :disabled="configStore.saving || !configStore.dirty" @click="handleSave">
          {{ configStore.saving ? '保存中...' : '保存并热重载' }}
        </button>
      </header>

      <main class="flex-1 overflow-y-auto p-5">
        <div class="max-w-[1280px] mx-auto">
          <RouterView v-slot="{ Component }">
            <component :is="Component" class="animate-fadein" />
          </RouterView>
        </div>
      </main>
    </div>
    </div>
  </div>
</template>
