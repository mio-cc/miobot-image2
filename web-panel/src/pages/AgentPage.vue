<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import client, { errorMessage } from '../api/client';
import { useConfigStore } from '../stores/config';
import SectionCard from '../components/SectionCard.vue';
import FormField from '../components/FormField.vue';
import ToggleField from '../components/ToggleField.vue';
import ModelPicker from '../components/ModelPicker.vue';

const configStore = useConfigStore();
const config = computed(() => configStore.config);
const agent = computed(() => config.value?.agent);
const tools = computed(() => config.value?.toolRegistry);
const context = computed(() => config.value?.contextPolicy);

const exposureEntries = computed(() => Object.entries(tools.value?.exposure || {}) as Array<[string, string]>);
const newExposureId = ref('');
const newExposureMode = ref('searchable');

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
          <select v-model="agent.mode" class="input-field" :disabled="!agent.enabled">
            <option value="off">off</option>
            <option value="shadow">shadow</option>
            <option value="enforce">enforce</option>
          </select>
        </FormField>
        <FormField label="工具选择策略">
          <select v-model="agent.toolChoice" class="input-field">
            <option value="auto">auto</option>
            <option value="required">required</option>
            <option value="none">none</option>
          </select>
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
        <FormField label="Fallback 节点索引" hint="留空或 -1 表示未设置">
          <input v-model.number="agent.fallbackNodeIndex" type="number" min="0" class="input-field" />
        </FormField>
        <FormField label="Fallback 模型" hint="主模型失败时的备用模型">
          <input v-model="agent.fallbackModel" class="input-field font-mono" placeholder="可选" />
        </FormField>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-3 xl:grid-cols-6 gap-4 mt-4 pt-4 border-t border-[color:var(--hairline-2)]">
        <FormField label="最大模型轮次"><input v-model.number="agent.maxModelRounds" type="number" min="1" max="100" class="input-field" /></FormField>
        <FormField label="最大工具轮次"><input v-model.number="agent.maxToolRounds" type="number" min="0" max="200" class="input-field" /></FormField>
        <FormField label="并行工具数"><input v-model.number="agent.maxParallelTools" type="number" min="1" max="32" class="input-field" /></FormField>
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
        <FormField label="每轮最多工具" hint="这里是 schema 露出上限；建议 >= 12。设得太小会把 code.render、browser.render 等 domain 工具裁掉。"><input v-model.number="tools.maxToolsPerTurn" type="number" min="1" max="200" class="input-field" /></FormField>
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
            <select v-model="newExposureMode" class="input-field">
              <option value="core">core</option><option value="domain">domain</option><option value="searchable">searchable</option><option value="hidden">hidden</option>
            </select>
          </FormField>
          <button class="btn-outline" :disabled="!newExposureId.trim()" @click="addExposure">添加覆盖</button>
        </div>
        <div v-if="exposureEntries.length" class="space-y-2">
          <div v-for="[id] in exposureEntries" :key="id" class="field-box">
            <span class="font-mono text-xs min-w-0 truncate">{{ id }}</span>
            <div class="flex items-center gap-2">
              <select v-model="tools.exposure[id]" class="input-field !w-auto">
                <option value="core">core</option><option value="domain">domain</option><option value="searchable">searchable</option><option value="hidden">hidden</option>
              </select>
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
  </div>
</template>
