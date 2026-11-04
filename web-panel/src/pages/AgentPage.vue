<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import client, { errorMessage } from '../api/client';
import { useConfigStore } from '../stores/config';
import SectionCard from '../components/SectionCard.vue';
import FormField from '../components/FormField.vue';
import ToggleField from '../components/ToggleField.vue';
import ModelPicker from '../components/ModelPicker.vue';
import AppSelect from '../components/AppSelect.vue';
import OrchestrationPanel from '../components/OrchestrationPanel.vue';
import LegacyEnginePanel from '../components/LegacyEnginePanel.vue';

const configStore = useConfigStore();
const config = computed(() => configStore.config);
const agent = computed(() => config.value?.agent);
const tools = computed(() => config.value?.toolRegistry);
const context = computed(() => config.value?.contextPolicy);
// R21 审计补缺：这些 orchestration 子段没有独立页面，全部归 AgentPage。
const orchestration = computed(() => (config.value as any)?.orchestration);
const huggingFace = computed(() => (config.value as any)?.huggingFace);

/* adminQqIds / allowlist 都是 string[]：必须用「文本 ref + 失焦写回」，
 * 不能 v-model 直绑数组（输入框会把整个字段替换成字符串，保存时被归一化丢弃）。 */
const adminQqIdsText = ref('');
watch(() => orchestration.value?.approval?.adminQqIds, (ids) => {
    adminQqIdsText.value = (ids || []).join(', ');
}, { immediate: true });
function commitAdminQqIds() {
    const approval = orchestration.value?.approval;
    if (!approval) return;
    const ids = adminQqIdsText.value.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
    approval.adminQqIds = ids;
    adminQqIdsText.value = ids.join(', ');
}

const allowlistText = ref('');
watch(() => orchestration.value?.externalProviders?.allowlist, (list) => {
    allowlistText.value = (list || []).join(', ');
}, { immediate: true });
function commitAllowlist() {
    const providers = orchestration.value?.externalProviders;
    if (!providers) return;
    const items = allowlistText.value.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
    providers.allowlist = items;
    allowlistText.value = items.join(', ');
}

const exposureEntries = computed(() => Object.entries(tools.value?.exposure || {}) as Array<[string, string]>);
const newExposureId = ref('');
const newExposureMode = ref('searchable');

/* P1 第五批·下拉收尾第一批：AppSelect 选项常量（与原 <option> 列表一一对应，文案零变更）。 */
const agentModeOptions = [
    { value: 'off', label: 'off' },
    { value: 'shadow', label: 'shadow' },
    { value: 'enforce', label: 'enforce' },
];
const toolChoiceOptions = [
    { value: 'auto', label: 'auto' },
    { value: 'required', label: 'required' },
    { value: 'none', label: 'none' },
];
const exposureModeOptions = [
    { value: 'core', label: 'core' },
    { value: 'domain', label: 'domain' },
    { value: 'searchable', label: 'searchable' },
    { value: 'hidden', label: 'hidden' },
];
const approvalFallbackOptions = [
    { value: 'reject', label: '拒绝（安全）' },
    { value: 'allow', label: '放行' },
];
const hfRequestModeOptions = [
    { value: 'openai-chat', label: 'openai-chat' },
    { value: 'router-chat', label: 'router-chat' },
    { value: 'legacy-inference', label: 'legacy-inference' },
];

interface ReplyPreferenceRecord {
    scope: 'session' | 'user';
    key: string;
    preference: Record<string, unknown>;
    updatedAt: string;
    expiresAt?: string;
    expired?: boolean;
}
const preferenceRecords = ref<ReplyPreferenceRecord[]>([]);
const preferenceLoading = ref(false);
const preferenceError = ref('');

async function fetchPreferenceRecords() {
    preferenceLoading.value = true;
    preferenceError.value = '';
    try {
        const response = await client.get('/reply-preferences');
        preferenceRecords.value = response.data?.records || [];
    } catch (error) {
        preferenceError.value = errorMessage(error, '读取回复偏好失败');
    } finally {
        preferenceLoading.value = false;
    }
}

async function deletePreference(record: ReplyPreferenceRecord) {
    try {
        await client.post('/reply-preferences/delete', { scope: record.scope, key: record.key });
        await fetchPreferenceRecords();
    } catch (error) {
        preferenceError.value = errorMessage(error, '删除回复偏好失败');
    }
}

async function clearPreferences(scope?: 'session' | 'user') {
    try {
        await client.post('/reply-preferences/clear', scope ? { scope } : {});
        await fetchPreferenceRecords();
    } catch (error) {
        preferenceError.value = errorMessage(error, '清空回复偏好失败');
    }
}

onMounted(() => { void fetchPreferenceRecords(); });

function addExposure() {
    const id = newExposureId.value.trim();
    if (!id || !tools.value) return;
    tools.value.exposure[id] = newExposureMode.value;
    newExposureId.value = '';
}
function removeExposure(id: string) {
    if (tools.value?.exposure) delete tools.value.exposure[id];
}
</script>

<template>
  <div v-if="config && agent && tools && context">
    <header class="mb-4">
      <h1 class="page-title mb-0.5">Agent 与工具</h1>
      <p class="text-[color:var(--ink-3)] text-xs">
        AgentRuntime、工具注册表和上下文预算。默认 enforce（旧自然语言链路已移除）；enforce 失败会受控终止、不回退旧链；off 模式回退旧引擎、shadow 仅旁路观察不发送。
      </p>
    </header>

    <SectionCard title="Agent 运行时" hint="enforce 会接管 chat/freeMode；精确命令仍由命令网关优先处理" class="mb-4">
      <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
        <ToggleField v-model="agent.enabled" label="启用 Agent Runtime" hint="关闭时旧链路已删除：bot 启动会被配置阻断，请先在后台切到 enforce" />
        <FormField label="运行模式" hint="shadow 只记录，不发送也不执行工具">
          <AppSelect v-model="agent.mode" :options="agentModeOptions" :disabled="!agent.enabled" />
        </FormField>
        <FormField label="工具选择策略">
          <AppSelect v-model="agent.toolChoice" :options="toolChoiceOptions" />
        </FormField>
        <FormField label="主模型" hint="Agent 的主推理模型" class="md:col-span-2">
          <ModelPicker v-model:node-index="agent.mainNodeIndex" v-model:model="agent.mainModel" capability="chat" />
        </FormField>
        <FormField label="Reasoning Effort">
          <input v-model="agent.reasoningEffort" class="input-field" placeholder="high" />
        </FormField>
        <FormField label="Temperature">
          <input v-model.number="agent.temperature" type="number" min="0" max="2" step="0.1" class="input-field" />
        </FormField>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-3 xl:grid-cols-6 gap-4 mt-4 pt-4 border-t border-[color:var(--hairline-2)]">
        <FormField label="最大模型轮次"><input v-model.number="agent.maxModelRounds" type="number" min="1" max="100" class="input-field" /></FormField>
        <FormField label="最大工具轮次"><input v-model.number="agent.maxToolRounds" type="number" min="0" max="200" class="input-field" /></FormField>
        <FormField label="并行工具数"><input v-model.number="agent.maxParallelTools" type="number" min="1" max="32" class="input-field" /></FormField>
        <FormField label="全局并发 Turn 上限" hint="跨群共享的同时执行 Agent turn 上限（0=不限）；1c2g 建议 4"><input v-model.number="agent.maxConcurrentTurns" type="number" min="0" max="256" class="input-field" /></FormField>
        <FormField label="Max Tokens"><input v-model.number="agent.maxTokens" type="number" min="1" max="200000" class="input-field" /></FormField>
        <FormField label="调用超时 (ms)"><input v-model.number="agent.timeoutMs" type="number" min="1000" class="input-field" /></FormField>
        <FormField label="整轮超时 (ms)"><input v-model.number="agent.turnTimeoutMs" type="number" min="1000" class="input-field" /></FormField>
          <FormField label="超时后收口预算 (ms)"><input v-model.number="agent.finalizeTimeoutMs" type="number" min="500" class="input-field" /></FormField>
      </div>

      <div class="mt-4 pt-4 border-t border-[color:var(--hairline-2)]">
        <h3 class="text-xs font-semibold text-[color:var(--ink)] mb-3">输出修复预算</h3>
        <div class="grid grid-cols-1 md:grid-cols-3 xl:grid-cols-6 gap-4">
          <FormField label="协议修复次数"><input v-model.number="agent.repair.maxProtocolRepairs" type="number" min="0" max="20" class="input-field" /></FormField>
          <FormField label="单调用 schema 修复"><input v-model.number="agent.repair.maxSchemaRepairsPerCall" type="number" min="0" max="20" class="input-field" /></FormField>
          <FormField label="总输出修复次数"><input v-model.number="agent.repair.maxTotalOutputRepairs" type="number" min="0" max="40" class="input-field" /></FormField>
          <FormField label="重复错误上限"><input v-model.number="agent.repair.maxRepeatedErrorCount" type="number" min="1" max="20" class="input-field" /></FormField>
          <FormField label="修复温度"><input v-model.number="agent.repair.repairTemperature" type="number" min="0" max="1" step="0.05" class="input-field" /></FormField>
          <div class="self-end"><ToggleField v-model="agent.repair.allowTextFallback" label="允许安全纯文本兜底" /></div>
        </div>
      </div>
    </SectionCard>

    <SectionCard title="工具注册表" hint="工具 schema 预算、并行与默认重试；exposure 可按工具 ID 覆盖" class="mb-4">
      <div class="grid grid-cols-1 md:grid-cols-3 xl:grid-cols-6 gap-4">
        <ToggleField v-model="tools.enabled" label="启用新工具注册表" />
        <FormField label="每轮最多工具" hint="模型每轮最多看到的 schema 数量，范围 1-128；HTTP/插件/MCP 动态工具已默认 core，不会被误裁。"><input v-model.number="tools.maxToolsPerTurn" type="number" min="1" max="128" class="input-field" /></FormField>
        <FormField label="Schema 字节上限"><input v-model.number="tools.maxToolSchemaBytes" type="number" min="1000" class="input-field" /></FormField>
        <FormField label="默认超时 (ms)"><input v-model.number="tools.defaultTimeoutMs" type="number" min="1000" class="input-field" /></FormField>
        <FormField label="默认重试"><input v-model.number="tools.defaultMaxRetries" type="number" min="0" max="10" class="input-field" /></FormField>
        <FormField label="默认并发"><input v-model.number="tools.defaultMaxConcurrency" type="number" min="1" max="64" class="input-field" /></FormField>
      </div>
      <div class="mt-3"><ToggleField v-model="tools.toolSearchEnabled" label="启用 searchable 工具（检索式加载待扩展）" hint="当前启用后把 searchable 工具并入 loadout；独立 tool_search 检索器暂未实现" /></div>

      <div class="mt-4 pt-4 border-t border-[color:var(--hairline-2)]">
        <div class="flex flex-wrap gap-2 items-end mb-3">
          <FormField label="工具 ID" class="flex-1 min-w-[220px]">
            <input v-model="newExposureId" class="input-field font-mono" placeholder="例如 image.generate" @keyup.enter="addExposure" />
          </FormField>
          <FormField label="暴露级别">
            <AppSelect v-model="newExposureMode" :options="exposureModeOptions" />
          </FormField>
          <button class="btn-outline" :disabled="!newExposureId.trim()" @click="addExposure">添加覆盖</button>
        </div>
        <div v-if="exposureEntries.length" class="space-y-2">
          <div v-for="[id] in exposureEntries" :key="id" class="field-box">
            <span class="font-mono text-xs min-w-0 truncate">{{ id }}</span>
            <div class="flex items-center gap-2">
              <!-- 行内紧凑：!w-auto 保持原有自适应宽度 -->
              <AppSelect v-model="tools.exposure[id]" :options="exposureModeOptions" trigger-class="!w-auto" />
              <button class="btn-outline !px-2" title="删除覆盖" @click="removeExposure(id)">×</button>
            </div>
          </div>
        </div>
        <p v-else class="text-xs text-[color:var(--ink-3)]">暂无 exposure 覆盖，使用能力注册表推导的默认级别。</p>
      </div>
    </SectionCard>

    <SectionCard title="上下文策略" hint="历史、群上下文、记忆、工具结果与压缩预算；spillEnabled 大结果落盘、compactionEnabled 摘要裁剪已接线" class="mb-4">
      <div class="grid grid-cols-1 md:grid-cols-3 xl:grid-cols-4 gap-4">
        <FormField label="历史上限轮数"><input v-model.number="context.historyMaxRounds" type="number" min="1" max="200" class="input-field" /></FormField>
        <FormField label="历史字符上限"><input v-model.number="context.historyMaxChars" type="number" min="500" class="input-field" /></FormField>
        <FormField label="群上下文消息数"><input v-model.number="context.groupContextMessages" type="number" min="1" max="500" class="input-field" /></FormField>
        <FormField label="群上下文字符上限"><input v-model.number="context.groupContextMaxChars" type="number" min="200" class="input-field" /></FormField>
        <FormField label="记忆 Top-K"><input v-model.number="context.memoryTopK" type="number" min="1" max="100" class="input-field" /></FormField>
        <FormField label="记忆最低分"><input v-model.number="context.memoryMinScore" type="number" min="0" max="1" step="0.05" class="input-field" /></FormField>
        <FormField label="记忆字符上限"><input v-model.number="context.memoryMaxChars" type="number" min="200" class="input-field" /></FormField>
        <FormField label="工具结果字符上限"><input v-model.number="context.toolResultMaxChars" type="number" min="500" class="input-field" /></FormField>
        <FormField label="压缩阈值 Tokens"><input v-model.number="context.compactionThresholdTokens" type="number" min="1000" class="input-field" /></FormField>
        <FormField label="Pinned Facts 上限"><input v-model.number="context.pinnedFactsMaxItems" type="number" min="1" max="500" class="input-field" /></FormField>
        <ToggleField v-model="context.groupContextEnabled" label="启用群上下文" />
        <ToggleField v-model="context.groupContextSkipForward" label="群上下文跳过合并转发" hint="原 bot.groupContext.skipForward 迁入（唯一真源）" />
        <ToggleField v-model="context.groupContextIncludeImages" label="群上下文带上图片" hint="对话模型不支持视觉时会自动忽略" />
        <ToggleField v-model="context.compactionEnabled" label="启用上下文压缩（摘要裁剪）" />
        <ToggleField v-model="context.spillEnabled" label="溢出工具结果落盘（已接线）" />
      </div>
    </SectionCard>
    <SectionCard title="回复偏好记录" hint="session/user 偏好持久化快照；删除与清空会写入后台审计" class="mb-4">
      <div class="flex flex-wrap gap-2 mb-3">
        <button class="btn-outline" :disabled="preferenceLoading" @click="fetchPreferenceRecords">刷新</button>
        <button class="btn-outline" :disabled="preferenceLoading" @click="clearPreferences('session')">清空 session</button>
        <button class="btn-outline" :disabled="preferenceLoading" @click="clearPreferences('user')">清空 user</button>
        <button class="btn-outline" :disabled="preferenceLoading" @click="clearPreferences()">清空全部</button>
      </div>
      <p v-if="preferenceError" class="text-xs status-crit mb-2">{{ preferenceError }}</p>
      <p v-if="preferenceLoading" class="text-xs text-[color:var(--ink-3)]">读取中…</p>
      <p v-else-if="!preferenceRecords.length" class="text-xs text-[color:var(--ink-3)]">暂无持久化回复偏好。</p>
      <div v-else class="space-y-2">
        <div v-for="record in preferenceRecords" :key="`${record.scope}:${record.key}`" class="field-box items-start">
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-2">
              <span class="tag">{{ record.scope }}</span>
              <span class="font-mono text-xs break-all">{{ record.key }}</span>
              <span v-if="record.expired" class="tag status-crit">已过期</span>
            </div>
            <div class="font-mono text-[11px] text-[color:var(--ink-2)] mt-1 break-all">{{ JSON.stringify(record.preference) }}</div>
            <div class="text-[11px] text-[color:var(--ink-3)] mt-1">
              更新 {{ record.updatedAt }}<span v-if="record.expiresAt"> · 到期 {{ record.expiresAt }}</span>
            </div>
          </div>
          <button class="btn-outline !px-2" title="删除这条偏好" @click="deletePreference(record)">×</button>
        </div>
      </div>
    </SectionCard>

    <!-- ═══ 编排规划器区（执行限制/模式与规划器/多模型协作/提示词优化/版本回滚）：已拆至 components/OrchestrationPanel.vue ═══ -->
    <OrchestrationPanel :orchestration="orchestration" />

    <SectionCard v-if="orchestration?.approval" title="审批流" hint="orchestration.approval · owner 在 QQ 回复审批" class="mb-4">
      <div class="grid grid-cols-1 md:grid-cols-3 xl:grid-cols-4 gap-4">
        <ToggleField v-model="orchestration.approval.enabled" label="启用审批" />
        <FormField label="审批人 QQ" hint="多个用逗号分隔；失焦写回"><input v-model="adminQqIdsText" @blur="commitAdminQqIds" class="input-field font-mono" placeholder="123456, 654321" /></FormField>
        <FormField label="法定人数"><input v-model.number="orchestration.approval.quorum" type="number" min="1" class="input-field" /></FormField>
        <FormField label="审批超时 (ms)"><input v-model.number="orchestration.approval.timeoutMs" type="number" min="5000" class="input-field" /></FormField>
        <FormField label="超时策略">
          <AppSelect v-model="orchestration.approval.fallback" :options="approvalFallbackOptions" />
        </FormField>
        <ToggleField v-model="orchestration.approval.allowGroupReply" label="允许群内审批" />
        <FormField label="每用户待审上限"><input v-model.number="orchestration.approval.maxPendingPerUser" type="number" min="1" class="input-field" /></FormField>
        <ToggleField v-model="orchestration.approval.maskArgs" label="审批时参数打码" />
      </div>
    </SectionCard>

    <SectionCard v-if="orchestration?.externalProviders" title="外部 Provider" hint="orchestration.externalProviders · 允许的外部能力提供方白名单" class="mb-4">
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <ToggleField v-model="orchestration.externalProviders.enabled" label="启用外部 Provider" />
        <FormField label="白名单" hint="多个用逗号分隔，如 suno-official；失焦写回">
          <input v-model="allowlistText" @blur="commitAllowlist" class="input-field font-mono" />
        </FormField>
      </div>
    </SectionCard>

    <!-- ═══ R21: MCP 服务器配置（此前无页面）═══ -->
    <SectionCard title="MCP 服务器" hint="orchestration.mcpServers · Model Context Protocol 外部工具接入" class="mb-4">
      <div v-if="!(orchestration?.mcpServers as any)?.length" class="text-xs text-[color:var(--ink-3)]">
        暂未配置 MCP 服务器。在 config.json 的 orchestration.mcpServers 中添加：
        <pre class="mt-2 p-2 rounded-lg bg-[color:var(--surface-2)] font-mono text-[11px] whitespace-pre-wrap">[{ "id": "server-name", "enabled": true, "url": "https://...", "allowlist": ["tool1"] }]</pre>
      </div>
      <div v-else class="space-y-2">
        <div v-for="(server, idx) in (orchestration as any).mcpServers" :key="idx" class="field-box">
          <div class="min-w-0">
            <span class="font-semibold text-sm">{{ server.id }}</span>
            <span class="ml-2 tag">{{ server.enabled ? '已启用' : '已停用' }}</span>
            <div class="font-mono text-xs text-[color:var(--ink-3)] mt-0.5 truncate">{{ server.url }}</div>
          </div>
          <button class="btn-outline !px-2" @click="(server as any).enabled = !(server as any).enabled">{{ server.enabled ? '停用' : '启用' }}</button>
        </div>
      </div>
    </SectionCard>

    <!-- ═══ R21: HuggingFace 模型接入（此前无页面）═══ -->
    <SectionCard v-if="huggingFace" title="HuggingFace 接入" hint="huggingFace · 免费推理 API 接入" class="mb-4">
      <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
        <ToggleField v-model="huggingFace.enabled" label="启用 HuggingFace" />
        <FormField label="Token"><input v-model="huggingFace.token" type="password" class="input-field font-mono" placeholder="hf_…" /></FormField>
        <FormField label="Base URL"><input v-model="huggingFace.baseUrl" class="input-field font-mono" /></FormField>
        <FormField label="请求模式">
          <AppSelect v-model="huggingFace.requestMode" :options="hfRequestModeOptions" />
        </FormField>
        <FormField label="超时 (ms)"><input v-model.number="huggingFace.timeoutMs" type="number" min="5000" class="input-field" /></FormField>
      </div>
    </SectionCard>

    <!-- ═══ 旧引擎参数（agent.mode=off 时生效）：已拆至 components/LegacyEnginePanel.vue ═══ -->
    <LegacyEnginePanel :config="config" />
  </div>
</template>
