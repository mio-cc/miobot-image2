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
    intentRecognition: '意图识别', browserRender: '浏览器渲染', codeRender: '代码画图',
    comfyuiTransform: 'ComfyUI 参数转化', search: '联网搜索', orchestration: '智能编排',
};

export const useConfigStore = defineStore('config', () => {
    const config = ref<any>(null);
    const savedSnapshot = ref('');
    const defaultPrompts = ref<any>(null);
    const saveStatus = ref('');
    const saving = ref(false);
    const revision = ref(0);

    /** 保存那一刻每个顶层区块的序列化快照。 */
    const savedSections = ref<Record<string, string>>({});

    const loaded = computed(() => Boolean(config.value));

    /**
     * 改动落在哪几个顶层区块。
     *
     * 只按区块比，不再每次按键把整份配置 stringify 一遍、再 parse 一遍——
     * 顶栏一直在读这两个 computed，等于每敲一个字符就把几百 KB 的配置
     * 序列化两次，节点和模板多了以后输入会明显发涩。
     */
    const dirtySections = computed(() => {
        if (!loaded.value || !savedSnapshot.value) return [];
        return Object.keys(SECTION_LABELS)
            .filter(key => JSON.stringify(config.value?.[key]) !== savedSections.value[key])
            .map(key => SECTION_LABELS[key]);
    });

    // savedSnapshot 为空串时 dirty 恒为 true：这既覆盖「还没加载完」，
    // 也覆盖「保存了但没落盘」——后者必须继续显示未保存，不能骗用户。
    const dirty = computed(() => {
        if (!loaded.value) return false;
        if (!savedSnapshot.value) return true;
        return dirtySections.value.length > 0;
    });

    /** 只兜底数组/对象容器，真正的默认值由后端 normalizeConfig 负责。 */
    function guardShape() {
        const c = config.value;
        if (!c) return;
        c.llm ||= {};
        c.llm.apiKeys ||= [];
        c.llm.capabilityOverrides ||= [];
        c.bot ||= {};
        c.bot.commands ||= {};
        c.bot.features ||= {};
        c.bot.files ||= {};
        c.bot.promptTemplates ||= [];
        c.bot.tts ||= {};
        c.bot.tts.preprocess ||= {};
        c.bot.groupContext ||= {};
        c.bot.progress ||= {};
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
        c.search ||= {};
        if (c.bot) c.bot.textImage ||= {};
        c.intentRecognition ||= {};
        c.browserRender ||= {};
        c.codeRender ||= {};
        c.comfyuiTransform ||= {};
        c.orchestration ||= {};
        c.orchestration.execution ||= {};
        c.orchestration.externalProviders ||= {};
        c.orchestration.memory ||= {};
        c.orchestration.voice ||= {};
        c.orchestration.planner ||= {};
        c.orchestration.roles ||= {};
        c.orchestration.permissions ||= {};
        c.orchestration.permissions.rules ||= [];
        c.orchestration.approval ||= {};
        c.orchestration.reply ||= {};
        c.orchestration.promptOptimization ||= {};
        c.orchestration.promptOptimization.versions ||= [];
        c.orchestration.suno ||= {};
        c.orchestration.audit ||= {};
    }

    function markSaved() {
        savedSnapshot.value = 'saved';
        savedSections.value = Object.fromEntries(
            Object.keys(SECTION_LABELS).map(key => [key, JSON.stringify(config.value?.[key])]),
        );
    }

    /**
     * 用服务端返回的配置替换本地。
     * markSaved 只在**确实落盘**时才做——服务端 persisted:false 表示改动只在内存里，
     * 重启就没了。这时候还去清脏标记，等于骗用户「已保存」。
     */
    function applyServerConfig(payload: any) {
        config.value = payload?.config ?? payload;
        if (typeof payload?.revision === 'number') revision.value = payload.revision;
        guardShape();
        if (payload?.persisted === false) {
            savedSnapshot.value = '';  // 保持脏状态，顶栏继续显示「未保存」
        } else {
            markSaved();
        }
        // 改密码后派生出的 token 会变，服务端在同一响应里给了新的，直接换掉，
        // 免得用户刚保存完就被踢回登录页。
        const auth = useAuthStore();
        const nextToken = payload?.auth?.token;
        if (nextToken) auth.setToken(nextToken);
        // 默认密码的判断只能由后端做——前端手里的 passwordSeed 是打码值。
        if (typeof payload?.auth?.usingDefaultPassword === 'boolean') {
            auth.usingDefaultPassword = payload.auth.usingDefaultPassword;
        }
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
            const persisted = res.data?.persisted !== false;
            const message = res.data?.message || '已保存并热重载';
            saveStatus.value = persisted ? message : `保存失败：${message}`;
            // 落盘失败的提示不自动消失——用户必须看见它。
            if (persisted) {
                window.setTimeout(() => { if (saveStatus.value === message) saveStatus.value = ''; }, 4000);
            }
            return { ok: persisted, hotReload: res.data?.hotReload };
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

    /* ── TR.5 开关单源：能力启停 = orchestration.capabilityOverrides ──
       别名字段本地同步（服务端归一化也会回填），保证 v2 链路与 FeatureGate 看到一致状态。 */

    const CAPABILITY_LEGACY_SWITCHES: Record<string, { llmField?: string; featureId?: string; section?: 'codeRender' }> = {
        'chat.reply': { llmField: 'chatEnabled' },
        'image.generate': { llmField: 'imageEnabled', featureId: 'image.generate' },
        'video.generate': { llmField: 'videoEnabled', featureId: 'video.generate' },
        'code.render': { section: 'codeRender', featureId: 'code.render' },
        'help': { featureId: 'help' },
        'session.clear': { featureId: 'clear' },
        'image.edit': { featureId: 'image.edit' },
        'image.interrogate': { featureId: 'image.interrogate' },
        'audio.music.generate': { featureId: 'audio.music.generate' },
        'audio.music.history': { featureId: 'audio.music.history' },
        'audio.music.replay': { featureId: 'audio.music.replay' },
        'audio.music.replace_section': { featureId: 'audio.music.replace_section' },
        'file.list': { featureId: 'file.list' },
        'file.read': { featureId: 'file.read' },
        'file.generate': { featureId: 'file.generate' },
        'web.search': { featureId: 'search.web' },
        'browser.render': { featureId: 'web.screenshot' },
    };

    /** 能力当前启停：显式 override 优先，否则回退旧开关（与归一化语义一致）。 */
    function capabilityEnabled(capabilityId: string): boolean {
        const c = config.value;
        if (!c) return true;
        const explicit = c.orchestration?.capabilityOverrides?.[capabilityId]?.enabled;
        if (typeof explicit === 'boolean') return explicit;
        const alias = CAPABILITY_LEGACY_SWITCHES[capabilityId];
        if (alias?.llmField) return (c.llm as any)?.[alias.llmField] !== false;
        if (alias?.section === 'codeRender') return (c as any).codeRender?.enabled !== false;
        if (alias?.featureId) return (c.bot?.features as any)?.[alias.featureId]?.enabled !== false;
        return true;
    }

    /** 写能力开关（单源 override + 别名本地同步）。 */
    function setCapabilityEnabled(capabilityId: string, value: boolean) {
        const c = config.value;
        if (!c) return;
        c.orchestration ||= {} as any;
        (c.orchestration as any).capabilityOverrides ||= {};
        const overrides = (c.orchestration as any).capabilityOverrides;
        overrides[capabilityId] = { ...(overrides[capabilityId] || {}), enabled: value };
        const alias = CAPABILITY_LEGACY_SWITCHES[capabilityId];
        if (alias?.llmField && c.llm) (c.llm as any)[alias.llmField] = value;
        if (alias?.section === 'codeRender') (c as any).codeRender.enabled = value;
        if (alias?.featureId) {
            const features = c.bot?.features as any;
            if (features?.[alias.featureId]) features[alias.featureId].enabled = value;
        }
    }

    return {
        config, defaultPrompts, saveStatus, saving, revision, loaded, dirty, dirtySections,
        nodeOptions, modelsForNode, get, set, resetPrompt, capabilityEnabled, setCapabilityEnabled,
        fetchConfig, fetchDefaultPrompts, save, importConfig, exportConfig, reset, applyServerConfig, markSaved,
    };
});
