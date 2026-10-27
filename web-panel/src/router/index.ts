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
        meta: { title: '接入与准入', group: '接入', icon: 'chat' },
    },
    {
        // P1-E（R10 收口）：旧规划器页重定向到 Agent 与工具；旧组件保留在仓库供回滚，
        // 不再注册可导航路由（普通消息热路径已由 AgentRuntime 唯一接管）。
        path: '/planner',
        redirect: '/agent',
    },
    {
        path: '/permissions',
        name: 'permissions',
        component: () => import('../pages/PermissionsPage.vue'),
        meta: { title: '权限与审批', group: '编排', icon: 'check' },
    },
    {
        path: '/cap-image',
        name: 'cap-image',
        component: () => import('../pages/CapImagePage.vue'),
        meta: { title: '图片生成', group: '能力中心', icon: 'canvas' },
    },
    {
        path: '/cap-music',
        name: 'cap-music',
        component: () => import('../pages/CapMusicPage.vue'),
        meta: { title: '音乐（Suno）', group: '能力中心', icon: 'voice' },
    },
    {
        path: '/cap-voice',
        name: 'cap-voice',
        component: () => import('../pages/CapVoicePage.vue'),
        meta: { title: '语音', group: '能力中心', icon: 'voice' },
    },
    {
        path: '/cap-file',
        name: 'cap-file',
        component: () => import('../pages/CapFilePage.vue'),
        meta: { title: '文件', group: '能力中心', icon: 'template' },
    },
    {
        path: '/cap-memory',
        name: 'cap-memory',
        component: () => import('../pages/CapMemoryPage.vue'),
        meta: { title: '记忆', group: '能力中心', icon: 'grid' },
    },
    {
        // 通用能力详情页：注册表里任何 id 都能自动成页（fake capability 验收项）。
        path: '/capabilities/:id',
        name: 'capability-detail',
        component: () => import('../pages/CapabilityDetailPage.vue'),
    },
    {
        // P1-E（R10 收口）：能力分工并入 Agent 与工具页。
        path: '/routing',
        redirect: '/agent',
    },
    {
        path: '/nodes',
        name: 'nodes',
        component: () => import('../pages/NodesPage.vue'),
        meta: { title: 'API 节点', group: '模型', icon: 'server' },
    },
    {
        path: '/agent',
        name: 'agent',
        component: () => import('../pages/AgentPage.vue'),
        meta: { title: 'Agent 与工具', group: 'Agent', icon: 'route' },
    },
    {
        // P2（R10 收口）：Tools 目录与详情页（动态 ToolSpec 只读视图 + exposure 覆盖）。
        path: '/tools',
        name: 'tools',
        component: () => import('../pages/ToolsPage.vue'),
        meta: { title: '工具目录', group: 'Agent', icon: 'grid' },
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
        meta: { title: '异步任务', group: 'Agent', icon: 'check' },
    },
    {
        path: '/prompts',
        name: 'prompts',
        component: () => import('../pages/PromptRegistryPage.vue'),
        meta: { title: '提示词注册表', group: 'Agent', icon: 'template' },
    },
    {
        path: '/reply',
        name: 'reply',
        component: () => import('../pages/ReplyPage.vue'),
        meta: { title: '回复与发送', group: '对话体验', icon: 'chat' },
    },
    {
        path: '/features',
        name: 'features',
        component: () => import('../pages/FeaturesPage.vue'),
        meta: { title: '命令与意图', group: '对话体验', icon: 'template' },
    },
    {
        path: '/templates',
        name: 'templates',
        component: () => import('../pages/TemplatesPage.vue'),
        meta: { title: '提示词模板', group: '对话体验', icon: 'template' },
    },
    {
        path: '/search',
        name: 'search',
        component: () => import('../pages/WebSearchPage.vue'),
        meta: { title: '联网搜索', group: '能力中心', icon: 'search' },
    },
    {
        path: '/render',
        name: 'render',
        component: () => import('../pages/RenderPage.vue'),
        meta: { title: '代码与网页渲染', group: '能力中心', icon: 'canvas' },
    },
    {
        path: '/voice',
        redirect: '/cap-voice',
    },
    {
        path: '/canvas',
        name: 'canvas',
        component: () => import('../pages/CanvasPage.vue'),
        meta: { title: '画布 / 图库', group: '媒体', icon: 'canvas' },
    },
    {
        path: '/observability',
        name: 'observability',
        component: () => import('../pages/ObservabilityPage.vue'),
        meta: { title: '观测中心', group: '观测', icon: 'logs' },
    },
    {
        path: '/settings',
        name: 'settings',
        component: () => import('../pages/SettingsPage.vue'),
        meta: { title: '系统设置', group: '系统', icon: 'settings' },
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

/** 侧栏用：只有带 meta 的才是导航项（根重定向和 404 没有 meta）。 */
export const navRoutes = routes.filter(route => route.meta?.title) as Array<
    RouteRecordRaw & { path: string; meta: NavMeta }
>;
