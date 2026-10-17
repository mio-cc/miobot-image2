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
        path: '/routing',
        name: 'routing',
        component: () => import('../pages/RoutingPage.vue'),
        meta: { title: '能力分工', group: '模型', icon: 'route' },
    },
    {
        path: '/nodes',
        name: 'nodes',
        component: () => import('../pages/NodesPage.vue'),
        meta: { title: 'API 节点', group: '模型', icon: 'server' },
    },
    {
        path: '/bot',
        name: 'bot',
        component: () => import('../pages/BotPage.vue'),
        meta: { title: '对话与触发', group: '对话', icon: 'chat' },
    },
    {
        path: '/voice',
        name: 'voice',
        component: () => import('../pages/VoicePage.vue'),
        meta: { title: '语音 / TTS', group: '媒体', icon: 'voice' },
    },
    {
        path: '/templates',
        name: 'templates',
        component: () => import('../pages/TemplatesPage.vue'),
        meta: { title: '提示词模板', group: '对话', icon: 'template' },
    },
    {
        path: '/canvas',
        name: 'canvas',
        component: () => import('../pages/CanvasPage.vue'),
        meta: { title: '画布 / 图库', group: '媒体', icon: 'canvas' },
    },
    {
        path: '/logs',
        name: 'logs',
        component: () => import('../pages/LogsPage.vue'),
        meta: { title: '运行日志', group: '系统', icon: 'logs' },
    },
    {
        path: '/settings',
        name: 'settings',
        component: () => import('../pages/SettingsPage.vue'),
        meta: { title: '系统设置', group: '系统', icon: 'settings' },
    },
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
