/**
 * 用途（ROLES）表 —— ModelsPage（用途分配视图）与节点模型展开（「当前用于」反查）共用。
 *
 * 从 ModelsPage 抽出为共享模块（方案 §4.3）：节点模型浏览弹层要显示
 * 「这个模型当前被哪些用途绑定」，NodesPage / ModelsPage 两处都要反查，不能各养一份表。
 * 只描述 config 结构（section + nodeField + modelField 点分路径），不含 UI 状态。
 */

export interface RoleDef {
    key: string;
    title: string;
    desc: string;
    /** config 路径（section + nodeField + modelField）；main 无独立继承语义。 */
    section: string;
    nodeField: string;
    modelField: string;
    /** 该用途推荐的能力过滤 */
    capability?: string;
    /** 是否允许退回继承（主对话不允许） */
    inheritable: boolean;
}

export const ROLES: RoleDef[] = [
    { key: 'main', title: 'Agent 主对话', desc: '全站默认 · 所有"跟随"的用途继承它', section: 'agent', nodeField: 'mainNodeIndex', modelField: 'mainModel', capability: 'chat', inheritable: false },
    { key: 'image', title: '图片生成', desc: 'image.generate · ComfyUI 工作流或多模态直生', section: 'llm', nodeField: 'imageNodeIndex', modelField: 'imageModel', capability: 'image.generate', inheritable: true },
    { key: 'edit', title: '图片编辑', desc: 'image.edit · 多模态原生理解', section: 'llm', nodeField: 'editNodeIndex', modelField: 'editModel', capability: 'image.edit', inheritable: true },
    { key: 'interrogate', title: '图片反推', desc: 'image.interrogate', section: 'llm', nodeField: 'interrogateNodeIndex', modelField: 'interrogateModel', capability: 'image.interrogate', inheritable: true },
    { key: 'suno', title: 'Suno 作曲', desc: '歌词与参数规划（Composer）', section: 'orchestration.suno', nodeField: 'composerNodeIndex', modelField: 'composerModel', capability: 'chat', inheritable: true },
    { key: 'video', title: '视频生成', desc: 'video.generate', section: 'llm', nodeField: 'videoNodeIndex', modelField: 'videoModel', capability: 'video.generate', inheritable: true },
    { key: 'codeRender', title: '代码渲染', desc: 'code.render · HTML/SVG/Canvas/Three', section: 'codeRender', nodeField: 'nodeIndex', modelField: 'model', capability: 'chat', inheritable: true },
    { key: 'comfyui', title: 'ComfyUI 参数转化', desc: '自然语言 → workflow JSON', section: 'comfyuiTransform', nodeField: 'nodeIndex', modelField: 'model', capability: 'chat', inheritable: true },
    { key: 'tts', title: 'TTS 前处理', desc: '朗读前改写', section: 'bot.tts.preprocess', nodeField: 'nodeIndex', modelField: 'model', capability: 'chat', inheritable: true },
    { key: 'trigger', title: '触发 / 续话判定', desc: '轻量判定 · 建议选快模型；触发与续话共用', section: 'bot.keywordTrigger', nodeField: 'intentNodeIndex', modelField: 'intentModel', capability: 'chat', inheritable: true },
    { key: 'memory', title: '记忆摘要 / 评分', desc: 'memory.* 二级任务', section: 'orchestration.memory', nodeField: 'embeddingNodeIndex', modelField: 'embeddingModel', capability: 'chat', inheritable: true },
];

function sectionOf(config: any, section: string): any {
    let obj = config;
    for (const part of section.split('.')) {
        if (!obj) return null;
        obj = obj[part];
    }
    return obj;
}

/** 判断某用途当前是否在“继承”态（字段为空/未设置）。 */
export function isRoleInherit(config: any, role: RoleDef): boolean {
    if (!role.inheritable) return false;
    const obj = sectionOf(config, role.section);
    if (!obj) return true;
    return !String(obj[role.modelField] || '').trim();
}

/** 获取某用途的 nodeIndex / model 值。 */
export function getRoleNode(config: any, role: RoleDef): number {
    const obj = sectionOf(config, role.section);
    return Number(obj?.[role.nodeField]) || 0;
}

export function getRoleModel(config: any, role: RoleDef): string {
    const obj = sectionOf(config, role.section);
    return String(obj?.[role.modelField] || '');
}

/** 写入某用途的 nodeIndex + model（点分路径逐层兜底建容器）。 */
export function setRoleValue(config: any, role: RoleDef, nodeIndex: number, model: string) {
    const parts = role.section.split('.');
    let obj = config;
    for (const part of parts) {
        if (!obj[part]) obj[part] = {};
        obj = obj[part];
    }
    obj[role.nodeField] = nodeIndex;
    obj[role.modelField] = model;
}

/** 反查：显式绑定到某模型的用途标题列表（含主对话；继承态用途不计）。 */
export function rolesUsingModel(config: any, model: string): string[] {
    const key = String(model || '').trim();
    if (!key) return [];
    return ROLES.filter(role => getRoleModel(config, role) === key).map(role => role.title);
}

/** 节点模型浏览弹层的「当前用于」提示文案；无绑定时返回空串。 */
export function roleUsageHint(config: any, model: string): string {
    const roles = rolesUsingModel(config, model);
    return roles.length ? `当前用于：${roles.join('、')}` : '';
}
