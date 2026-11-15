import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
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
    freeMode: '自由模式', huggingFace: 'HuggingFace', panel: '面板',
    intentRecognition: '意图识别', browserRender: '浏览器渲染', codeRender: '代码画图',
    comfyuiTransform: 'ComfyUI 参数转化', search: '联网搜索', orchestration: '智能编排',
    agent: 'Agent 运行时', toolRegistry: '工具注册表', replyPolicy: '回复策略', contextPolicy: '上下文策略',
};

export const useConfigStore = defineStore('config', () => {
    const config = ref<any>(null);
    const savedSnapshot = ref('');
    const saveStatus = ref('');
    const saving = ref(false);
    const revision = ref(0);

    /* ── 无感自动保存（参考 SnowLuma 的 debounce auto-save）──
       改动 → 防抖 650ms → 落盘 + 热重载。顶栏只显示状态，不需要点按钮。
       正确性靠三件事兜住：串行化、编辑期间不覆盖、冲突即停。 */
    const AUTOSAVE_DEBOUNCE_MS = 650;
    /** 自动保存开关（持久化；关掉后回到手动「保存并热重载」） */
    const autoSave = ref(localStorage.getItem('miobot_autosave') !== '0');
    /** 语义化状态，供顶栏着色 */
    const saveTone = ref<'idle' | 'saving' | 'success' | 'warning' | 'error'>('idle');
    /** 409 版本冲突：停止自动重试，等用户手动处理 */
    const saveConflict = ref(false);

    let debounceTimer: number | null = null;
    /** 是否有请求在飞（同一时刻只允许一个） */
    let inFlight = false;
    /** 飞行期间又有改动 → 结束后再跑一轮 */
    let pendingSave = false;
    let statusTimer: number | null = null;

    function clearDebounce() {
        if (debounceTimer != null) { window.clearTimeout(debounceTimer); debounceTimer = null; }
    }

    function clearStatusTimer() {
        if (statusTimer != null) { window.clearTimeout(statusTimer); statusTimer = null; }
    }

    /** 成功/警告态 3s 后自动回到 idle（失败与冲突不自动清，必须让用户看见） */
    function scheduleStatusClear(ms = 3000) {
        clearStatusTimer();
        statusTimer = window.setTimeout(() => {
            statusTimer = null;
            if (saveTone.value === 'success' || saveTone.value === 'warning') {
                saveTone.value = 'idle';
                saveStatus.value = '';
            }
        }, ms);
    }

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
        c.orchestration.suno ||= {};
        c.orchestration.audit ||= {};
        c.agent ||= {};
        c.agent.repair ||= {};
        c.toolRegistry ||= {};
        c.toolRegistry.exposure ||= {};
        c.replyPolicy ||= {};
        c.contextPolicy ||= {};
    }

    function markSaved() {
        savedSnapshot.value = 'saved';
        savedSections.value = sectionSignature();
    }

    /** 当前每个顶层区块的序列化快照（用于「飞行期间是否又被改过」的比对）。 */
    function sectionSignature(): Record<string, string> {
        return Object.fromEntries(
            Object.keys(SECTION_LABELS).map(key => [key, JSON.stringify(config.value?.[key])]),
        );
    }

    function sameSections(a: Record<string, string>, b: Record<string, string>): boolean {
        const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
        for (const k of keys) if (a[k] !== b[k]) return false;
        return true;
    }

    /** 只吸收响应里的 revision / 鉴权信息，不动本地配置（用户正在编辑时用）。 */
    function absorbMetaOnly(payload: any) {
        if (typeof payload?.revision === 'number') revision.value = payload.revision;
        const auth = useAuthStore();
        const nextToken = payload?.auth?.token;
        if (nextToken) auth.setToken(nextToken);
        if (typeof payload?.auth?.usingDefaultPassword === 'boolean') {
            auth.usingDefaultPassword = payload.auth.usingDefaultPassword;
        }
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
        // ?meta=1 让服务端把 revision 一起带回来，乐观锁才有正确的起点。
        // 服务端若不支持（老版本），返回的是裸 config，这里按裸 config 兼容处理。
        const res = await client.get('/config?meta=1');
        applyServerConfig(res.data);
        return config.value;
    }

    /** 冲突后重新对齐 revision（不改本地配置）。 */
    async function refreshRevision(): Promise<boolean> {
        try {
            const res = await client.get('/config?meta=1');
            if (typeof res.data?.revision === 'number') {
                revision.value = res.data.revision;
                return true;
            }
        } catch { /* 拿不到就保持原样 */ }
        return false;
    }

    /**
     * 真正发请求的那一层。调用方负责 inFlight 记账。
     *
     * 关键：请求发出前记一份区块快照；响应回来时若本地又被改过，
     * **绝不能**用服务端返回整体覆盖 config（那会把用户飞行期间的输入吞掉），
     * 只吸收 revision/鉴权，并置 pendingSave 让下一轮继续落盘。
     */
    async function saveInternal() {
        saving.value = true;
        saveTone.value = 'saving';
        saveStatus.value = '保存中…';
        const sentSig = sectionSignature();
        try {
            // 带 revision 乐观锁：提示词注册表 / 导入 / 回滚等旁路保存会递增服务端 revision，
            // 陈旧快照提交会被 409 拒绝，防止详细页保存把注册表等旁路改动悄悄覆盖回旧值。
            const res = await client.post('/config', { revision: revision.value, config: config.value });

            const editedDuringFlight = !sameSections(sentSig, sectionSignature());
            if (editedDuringFlight) {
                absorbMetaOnly(res.data);
                // 本地仍是脏的，紧接着再来一轮
                pendingSave = true;
                saveTone.value = 'warning';
                saveStatus.value = '已保存较早的改动，继续提交中…';
                return { ok: true, hotReload: res.data?.hotReload };
            }

            applyServerConfig(res.data);
            const persisted = res.data?.persisted !== false;
            const message = res.data?.message || '已保存并热重载';
            if (persisted) {
                saveTone.value = 'success';
                saveStatus.value = message;
                scheduleStatusClear();
            } else {
                // 落盘失败：保持脏状态 + 明确报错，不能骗用户「已保存」
                saveTone.value = 'error';
                saveStatus.value = `保存失败：${message}`;
            }
            return { ok: persisted, hotReload: res.data?.hotReload };
        } catch (error: any) {
            if (error?.response?.status === 409) {
                // 版本冲突：停止自动重试，避免死循环刷接口
                saveConflict.value = true;
                clearDebounce();
                saveTone.value = 'error';
                saveStatus.value = `保存冲突：${errorMessage(error)}`;
                return { ok: false, hotReload: undefined, conflict: true };
            }
            saveTone.value = 'error';
            saveStatus.value = `保存失败：${errorMessage(error)}`;
            return { ok: false, hotReload: undefined };
        } finally {
            saving.value = false;
        }
    }

    /** 串行化执行：飞行中再来就排到下一轮。 */
    async function performSave(): Promise<{ ok: boolean; hotReload?: any; conflict?: boolean }> {
        if (inFlight) { pendingSave = true; return { ok: true }; }
        inFlight = true;
        try {
            let result = await saveInternal();

            /* 409 多数情况不是「真的被别人改了」，而是本地 revision 起点不对
               （服务端被别的入口保存过 / 服务重启过）。先对齐 revision 再重试一次，
               成功就当无事发生；仍失败才真正进入冲突态、停止自动重试。 */
            if (result.conflict) {
                const synced = await refreshRevision();
                if (synced) {
                    saveConflict.value = false;
                    result = await saveInternal();
                }
            }
            return result;
        } finally {
            inFlight = false;
            if (pendingSave) {
                pendingSave = false;
                if (autoSave.value && !saveConflict.value) {
                    scheduleAutoSave();
                }
            }
        }
    }

    /** 立即保存（手动按钮、增删改等需要马上落盘的操作）。 */
    async function save() {
        clearDebounce();
        if (saveConflict.value) saveConflict.value = false;
        return performSave();
    }

    /** 排一轮防抖保存。dirty 变化时由 watcher 调用。 */
    function scheduleAutoSave() {
        if (!autoSave.value || saveConflict.value) return;
        if (!loaded.value || !dirty.value) return;
        clearDebounce();
        debounceTimer = window.setTimeout(() => {
            debounceTimer = null;
            void performSave();
        }, AUTOSAVE_DEBOUNCE_MS);
    }

    /** 立刻把待提交的改动落盘（切页 / 关闭前调用）。 */
    async function flushSave() {
        clearDebounce();
        if (!dirty.value) return { ok: true };
        return performSave();
    }

    /** 冲突后手动重试：清掉冲突标记再存一次。 */
    async function retrySave() {
        saveConflict.value = false;
        return save();
    }

    function setAutoSave(next: boolean) {
        autoSave.value = next;
        localStorage.setItem('miobot_autosave', next ? '1' : '0');
        if (next) {
            /* 重新开启时必须做两件事，否则会出现「关掉再打开就存不上」：
               1) 清掉历史冲突标记 —— 否则 scheduleAutoSave() 会因 saveConflict 直接 return，
                  自动保存静默失效，用户以为开了其实没在存。
               2) 立刻把待提交的改动存掉（而不是只排一个防抖）——
                  关闭期间积累的改动应该马上落盘，不用再等下一次编辑。 */
            saveConflict.value = false;
            void flushSave();
        } else {
            clearDebounce();
        }
    }

    // dirty 由 false 变 true 时排一轮保存。
    // 注意：保存成功会把它打回 false；飞行期间继续编辑不会再次触发
    // （dirty 一直为 true），那条路径由 saveInternal 的 pendingSave 兜住。
    watch(dirty, (isDirty) => {
        if (isDirty) scheduleAutoSave();
    });

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
        clearDebounce();
        clearStatusTimer();
        config.value = null;
        savedSnapshot.value = '';
        saveStatus.value = '';
        saveTone.value = 'idle';
        saveConflict.value = false;
        pendingSave = false;
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
        config, saveStatus, saving, revision, loaded, dirty, dirtySections,
        nodeOptions, modelsForNode, get, set, capabilityEnabled, setCapabilityEnabled,
        fetchConfig, save, importConfig, exportConfig, reset, applyServerConfig, markSaved,
        // 无感自动保存
        autoSave, saveTone, saveConflict,
        scheduleAutoSave, flushSave, retrySave, setAutoSave,
    };
});
