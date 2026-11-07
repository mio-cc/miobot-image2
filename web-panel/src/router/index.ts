import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router';

/**
 * 用 hash 路由：面板挂在 /admin/ 下由静态文件服务器托管，
 * history 模式需要后端配合兜底，hash 模式零配置且刷新不会 404。
 */

export interface NavMeta {
    title: string;
    group: string;
    icon: string;
}

// 声明合并进 RouteMeta，这样模板里 route.meta.title / item.meta.icon 都有类型，
// 不用到处写 (route.meta as any)。注意 meta 字面量不要再加 `as NavMeta`——
// RouteMeta 带索引签名，具名接口反过来不能赋给它。
declare module 'vue-router' {
    interface RouteMeta extends Partial<NavMeta> {}
}

const routes: RouteRecordRaw[] = [
    { path: '/', redirect: '/overview' },
    {
        path: '/overview',
        name: 'overview',
        component: () => import('../pages/OverviewPage.vue'),
        meta: { title: '总览', group: '', icon: 'grid' },
    },
    {
        path: '/access',
        name: 'access',
        component: () => import('../pages/AccessPage.vue'),
        meta: { title: '接入与准入', group: '配置', icon: 'chat' },
    },
    {
        // P1-E（R10 收口）：旧规划器页重定向到 Agent 与工具；P1 技术债收敛：规划器全部字段
        // （orchestration.mode/planner/roles/版本管理/failurePolicy 等）已迁入 AgentPage，
        // /legacy/planner 直达路由与页面一并删除。
        path: '/planner',
        redirect: '/agent',
    },
    {
        path: '/permissions',
        name: 'permissions',
        component: () => import('../pages/PermissionsPage.vue'),
        meta: { title: '权限与审批', group: '配置', icon: 'check' },
    },
    {
        // R16/4.1 能力中心：全部能力卡片网格（搜索+分类）；点击卡片进独立完整配置页。
        path: '/capabilities',
        name: 'capabilities',
        component: () => import('../pages/CapabilitiesPage.vue'),
        meta: { title: '能力中心', group: '运行', icon: 'grid' },
    },
    {
        // 通用能力详情页：注册表里任何 id 都能自动成页（fake capability 验收项）。
        path: '/capabilities/:id',
        name: 'capability-detail',
        component: () => import('../pages/CapabilityDetailPage.vue'),
    },
    {
        // P3-MCP（D27）：单个 MCP 服务器专属配置页——能力中心卡片 / AgentPage「配置」链接进入，不入侧栏。
        path: '/mcp/:serverId',
        name: 'mcp-server',
        component: () => import('../pages/McpServerPage.vue'),
    },
    {
        // R16/4.1：五个能力专页保留为「能力中心 → 卡片 → 完整配置页」的目标页，
        // 从侧边栏导航移除（meta.group 空）但路由可达（能力中心卡片跳进来）。
        path: '/cap-image',
        name: 'cap-image',
        component: () => import('../pages/CapImagePage.vue'),

    },
    {
        path: '/cap-music',
        name: 'cap-music',
        component: () => import('../pages/CapMusicPage.vue'),

    },
    {
        path: '/cap-voice',
        name: 'cap-voice',
        component: () => import('../pages/CapVoicePage.vue'),

    },
    {
        path: '/cap-file',
        name: 'cap-file',
        component: () => import('../pages/CapFilePage.vue'),

    },
    {
        path: '/cap-memory',
        name: 'cap-memory',
        component: () => import('../pages/CapMemoryPage.vue'),

    },


    {
        // R19：模型与节点统一页（节点池 + 用途分配 + 继承链）。
        path: '/models',
        name: 'models',
        component: () => import('../pages/ModelsPage.vue'),
        meta: { title: '模型与节点', group: '配置', icon: 'server' },
    },
    {
        // 旧路由重定向到新统一页
        path: '/nodes',
        redirect: '/models',
    },
    {
        // R16/4.1：/routing 旧路径重定向到模型页；旧页独占字段已全部迁出
        // （freeMode/intent/对话参数/video → AgentPage；capabilityOverrides → ModelsPage；
        // comfyuiTransform 参数 → CapImagePage；提示词 → 提示词注册表）。
        path: '/routing',
        redirect: '/models',
    },
    {
        path: '/agent',
        name: 'agent',
        component: () => import('../pages/AgentPage.vue'),
        meta: { title: 'Agent 与工具', group: '配置', icon: 'route' },
    },
    {
        // P2（R10 收口）：Tools 目录与详情页（动态 ToolSpec 只读视图 + exposure 覆盖）。
        path: '/tools',
        name: 'tools',
        component: () => import('../pages/ToolsPage.vue'),
        meta: { title: '工具与权限', group: '配置', icon: 'grid' },
    },
    {
        path: '/tools/:id',
        name: 'tool-detail',
        component: () => import('../pages/ToolDetailPage.vue'),
    },
    {
        path: '/jobs',
        name: 'jobs',
        component: () => import('../pages/JobsPage.vue'),
        meta: { title: '异步任务', group: '运行', icon: 'check' },
    },
    {
        path: '/prompts',
        name: 'prompts',
        component: () => import('../pages/PromptRegistryPage.vue'),
        meta: { title: '提示词注册表', group: '配置', icon: 'template' },
    },
    {
        path: '/reply',
        name: 'reply',
        component: () => import('../pages/ReplyPage.vue'),
        meta: { title: '回复与呈现', group: '配置', icon: 'chat' },
    },
    {
        path: '/features',
        name: 'features',
        component: () => import('../pages/FeaturesPage.vue'),
        meta: { title: '命令与意图', group: '配置', icon: 'template' },
    },
    {
        path: '/templates',
        name: 'templates',
        component: () => import('../pages/TemplatesPage.vue'),
        meta: { title: '模板', group: '配置', icon: 'template' },
    },
    {
        path: '/search',
        name: 'search',
        component: () => import('../pages/WebSearchPage.vue'),
        // meta 不写：不入侧栏，从能力中心卡片进入。
    },
    {
        path: '/render',
        name: 'render',
        component: () => import('../pages/RenderPage.vue'),
        // meta 不写：不入侧栏，从能力中心卡片进入。
    },
    {
        path: '/voice',
        redirect: '/cap-voice',
    },
    {
        path: '/canvas',
        name: 'canvas',
        component: () => import('../pages/CanvasPage.vue'),
        meta: { title: '画布 / 图库', group: '系统', icon: 'canvas' },
    },
    {
        path: '/observability',
        name: 'observability',
        component: () => import('../pages/ObservabilityPage.vue'),
        meta: { title: '观测中心', group: '运行', icon: 'logs' },
    },
    {
        path: '/settings',
        name: 'settings',
        component: () => import('../pages/SettingsPage.vue'),
        meta: { title: '连接与系统', group: '系统', icon: 'settings' },
    },
    // 旧链接重定向：TR.1 拆页后 /orchestration 的内容分到了 /planner 等页；
    // TR.4 组页后 /bot 并入 /access、/logs 并入 /observability。
    { path: '/orchestration', redirect: '/agent' },
    { path: '/bot', redirect: '/access' },
    { path: '/logs', redirect: '/observability' },
    { path: '/:pathMatch(.*)*', redirect: '/overview' },
];

export const router = createRouter({
    history: createWebHashHistory(),
    routes,
});

/**
 * 路由 chunk 空闲预取（性能优化）：空闲时把全部页面模块拉进浏览器缓存，
 * 之后点侧栏切换不再有「下载 JS → 渲染」的等待（生产环境低带宽/无缓存头时尤为明显）。
 * 模块由打包器缓存，重复 import() 不产生新请求；redirect 路由没有 component，跳过。
 */
{
    const idle: (cb: () => void) => void =
        (window as any).requestIdleCallback || ((cb: () => void) => window.setTimeout(cb, 1500));
    idle(() => {
        for (const route of routes) {
            if (typeof route.component === 'function') void (route.component as () => Promise<unknown>)().catch(() => undefined);
        }
    });
}

/** 侧栏用：只有带 meta 的才是导航项（根重定向和 404 没有 meta）。 */
export const navRoutes = routes.filter(route => route.meta?.title) as Array<
    RouteRecordRaw & { path: string; meta: NavMeta }
>;
