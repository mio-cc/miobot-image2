import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import client, { errorMessage } from '../api/client';
import { useAuthStore } from './auth';

/**
 * 配置的唯一数据源。
 *
 * 两个约定值得记住：
 * 1. **脏标记**——保存前后各存一份快照，用户能看到"哪几块有未保存改动"，
 *    离开页面时也能拦一下。没有这个反馈，改没改过全靠记忆。
 * 2. **不在前端补默认值**——后端 normalizeConfig 已经把整份配置补全了，
 *    前端再补一遍就是两份会各自漂移的真相。这里只对「模板要遍历的数组」
 *    做一层兜底，防止极端情况下渲染报错。
 */

const SECTION_LABELS: Record<string, string> = {
    llm: '模型', bot: 'Bot 行为', canvas: '画布', napcat: 'Napcat',
    promptsChat: '远程模板库', freeMode: '自由模式', huggingFace: 'HuggingFace', panel: '面板',
};

export const useConfigStore = defineStore('config', () => {
    const config = ref<any>(null);
    const savedSnapshot = ref('');
    const defaultPrompts = ref<any>(null);
    const saveStatus = ref('');
    const saving = ref(false);
    const revision = ref(0);

    const loaded = computed(() => Boolean(config.value));
    const dirty = computed(() => loaded.value && JSON.stringify(config.value) !== savedSnapshot.value);

    /** 改动落在哪几个顶层区块，给用户一个"改了什么"的实感。 */
    const dirtySections = computed(() => {
        if (!dirty.value || !savedSnapshot.value) return [];
        const saved = JSON.parse(savedSnapshot.value);
        return Object.keys(SECTION_LABELS)
            .filter(key => JSON.stringify(config.value?.[key]) !== JSON.stringify(saved?.[key]))
            .map(key => SECTION_LABELS[key]);
    });

    /** 只兜底数组/对象容器，真正的默认值由后端 normalizeConfig 负责。 */
    function guardShape() {
        const c = config.value;
        if (!c) return;
        c.llm ||= {};
        c.llm.apiKeys ||= [];
        c.llm.modelLimits ||= [];
        c.llm.capabilityOverrides ||= [];
        c.bot ||= {};
        c.bot.commands ||= {};
        c.bot.promptTemplates ||= [];
        c.bot.tts ||= {};
        c.bot.tts.preprocess ||= {};
        c.bot.groupContext ||= {};
        c.bot.replyStrategies ||= {};
        c.bot.triggerModes ||= {};
        c.bot.textReply ||= {};
        c.bot.imageCompression ||= {};
        c.canvas ||= {};
        c.canvas.logs ||= {};
        c.canvas.brand ||= {};
        c.freeMode ||= {};
        c.promptsChat ||= {};
        c.napcat ||= {};
        c.panel ||= {};
        c.huggingFace ||= {};
    }

    function markSaved() {
        savedSnapshot.value = JSON.stringify(config.value);
    }

    function applyServerConfig(payload: any) {
        config.value = payload?.config ?? payload;
        if (typeof payload?.revision === 'number') revision.value = payload.revision;
        guardShape();
        markSaved();
        // 改密码后派生出的 token 会变，服务端在同一响应里给了新的，直接换掉，
        // 免得用户刚保存完就被踢回登录页。
        const nextToken = payload?.auth?.token;
        if (nextToken) useAuthStore().setToken(nextToken);
    }

    async function fetchConfig() {
        const res = await client.get('/config');
        applyServerConfig(res.data);
        if (!defaultPrompts.value) await fetchDefaultPrompts();
        return config.value;
    }

    async function fetchDefaultPrompts() {
        try {
            const res = await client.get('/default-prompts');
            defaultPrompts.value = res.data?.prompts || null;
        } catch { /* 默认提示词取不到不影响主流程 */ }
    }

    async function save() {
        saving.value = true;
        saveStatus.value = '保存中...';
        try {
            const res = await client.post('/config', config.value);
            applyServerConfig(res.data);
            saveStatus.value = res.data?.message || '已保存并热重载';
            window.setTimeout(() => {
                if (saveStatus.value === (res.data?.message || '已保存并热重载')) saveStatus.value = '';
            }, 4000);
            return { ok: true, hotReload: res.data?.hotReload };
        } catch (error: any) {
            saveStatus.value = `保存失败：${errorMessage(error)}`;
            return { ok: false, hotReload: undefined };
        } finally {
            saving.value = false;
        }
    }

    async function importConfig(payload: any) {
        const res = await client.post('/config/import', payload);
        applyServerConfig(res.data);
        return res.data?.importResult;
    }

    async function exportConfig() {
        const res = await client.get('/config/export');
        return res.data?.export ?? res.data;
    }

    function reset() {
        config.value = null;
        savedSnapshot.value = '';
        saveStatus.value = '';
    }

    /** 启用中的节点，供所有节点下拉框使用。 */
    const nodeOptions = computed(() =>
        (config.value?.llm?.apiKeys || [])
            .map((node: any, idx: number) => ({ node, idx }))
            .filter((item: any) => item.node?.enabled !== false));

    function modelsForNode(nodeIndex: number | string, currentValue = '', extra: string[] = []) {
        const node = config.value?.llm?.apiKeys?.[Number(nodeIndex)];
        const list = [...extra, ...(node?.models || [])];
        if (currentValue && !list.includes(currentValue)) list.unshift(currentValue);
        return list;
    }

    /** 点分路径读写，能力分工页按配置路径批量绑定时用。 */
    function get(path: string) {
        return path.split('.').reduce((acc: any, key) => acc?.[key], config.value);
    }
    function set(path: string, value: any) {
        const keys = path.split('.');
        const last = keys.pop() as string;
        const parent = keys.reduce((acc: any, key) => acc?.[key], config.value);
        if (parent) parent[last] = value;
    }

    /** 把某个提示词字段恢复成后端给的默认值。 */
    function resetPrompt(configPath: string, defaultKey: string) {
        const value = defaultPrompts.value?.[defaultKey];
        if (value) set(configPath, value);
    }

    return {
        config, defaultPrompts, saveStatus, saving, revision, loaded, dirty, dirtySections,
        nodeOptions, modelsForNode, get, set, resetPrompt,
        fetchConfig, fetchDefaultPrompts, save, importConfig, exportConfig, reset, applyServerConfig, markSaved,
    };
});
