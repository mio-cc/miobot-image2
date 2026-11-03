<script setup lang="ts">
import { computed, ref } from 'vue';
import client from '../api/client';
import { useConfigStore } from '../stores/config';
import SectionCard from '../components/SectionCard.vue';
import FormField from '../components/FormField.vue';
import ToggleField from '../components/ToggleField.vue';
import ModelPicker from '../components/ModelPicker.vue';
import AppSelect from '../components/AppSelect.vue';

/**
 * 记忆与上下文中心（Harness Memory Layer）。
 * 卡片：存储与索引 / 观察与写入 / 保留与清理 / 记忆管理与内部技能状态。
 * 真源约定：自动上下文注入预算（contextPolicy.memory* 与 groupContext*）唯一在 Agent 页配置，
 * 本页不再重复展示；orchestration.memory.topK/minScore/maxContextChars 仅作管理检索兜底。
 */

const configStore = useConfigStore();
const config = computed(() => configStore.config);
const orch = computed(() => config.value?.orchestration);

const memoryActionType = ref<'list' | 'search' | 'clear_group' | 'clear_user' | 'retention_now' | 'observer_stats'>('list');
const memoryBotId = ref('');
const memoryChatType = ref<'group' | 'private'>('group');
const memoryGroupId = ref('');
const memoryUserId = ref('');
const memoryQuery = ref('');
const memoryDryRun = ref(true);
const memoryActionResult = ref<any>(null);

/* P1 最后一批·下拉收尾：AppSelect 选项（memoryActionType/memoryChatType 均为本地 UI 状态，
   非配置字段；memoryActionType 驱动下方表单条件渲染，v-model 绑定 ref 原样保留）。 */
const memoryActionOptions = [
    { value: 'list', label: '列出 namespace' },
    { value: 'search', label: '检索测试' },
    { value: 'clear_group', label: '清理群记忆' },
    { value: 'clear_user', label: '清理用户记忆' },
    { value: 'retention_now', label: '立即执行保留清理' },
    { value: 'observer_stats', label: '观察/清理状态' },
];
const memoryChatTypeOptions = [
    { value: 'group', label: '群聊' },
    { value: 'private', label: '私聊' },
];

async function runMemoryAction() {
    try {
        memoryActionResult.value = { status: 'queued' };
        const res = await client.post('/orchestration/memory/actions', {
            type: memoryActionType.value,
            botId: memoryBotId.value || undefined,
            chatType: memoryChatType.value,
            groupId: memoryGroupId.value || undefined,
            userId: memoryUserId.value || undefined,
            query: memoryQuery.value || undefined,
            dryRun: memoryDryRun.value,
        });
        const actionId = String(res.data?.actionId || '');
        if (!actionId) throw new Error('memory action id missing');
        for (let attempt = 0; attempt < 30; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 500));
            try {
                const result = await client.get('/orchestration/memory/actions/' + encodeURIComponent(actionId));
                if (result.data?.result) { memoryActionResult.value = result.data.result; return; }
            } catch { /* keep polling */ }
        }
        memoryActionResult.value = { status: 'timeout' };
    } catch (error: any) {
        memoryActionResult.value = { status: 'error', error: error?.response?.data?.error || String(error?.message || error) };
    }
}
</script>

<template>
  <div v-if="config && orch && orch.memory">
    <header class="mb-4">
      <h1 class="page-title mb-0.5">记忆与上下文</h1>
      <p class="text-[color:var(--ink-3)] text-xs">
        Harness Memory Layer：所有消息先观察入库、再触发路由；模型可经内部技能 memory.search 自主检索当前作用域记忆（用户不可见、不可直接调用）。
      </p>
    </header>

    <SectionCard title="存储与索引" hint="Orama 本地索引；群聊、私聊、群内用户按物理 namespace 隔离" class="mb-4">
      <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        <div class="md:col-span-2 xl:col-span-1"><ToggleField v-model="orch.memory.enabled" label="启用长期记忆" /></div>
        <div class="md:col-span-2 xl:col-span-1"><ToggleField v-model="orch.memory.autoIngest" label="自动写入消息" /></div>
        <div class="md:col-span-2 xl:col-span-1"><ToggleField v-model="orch.memory.hybridSearch" label="向量 + 全文混合检索" /></div>
        <div class="md:col-span-2 xl:col-span-1"><ToggleField v-model="orch.memory.userGlobalProfileEnabled" label="允许跨群用户画像" hint="默认关闭，保持群隔离" /></div>
        <div class="md:col-span-2 xl:col-span-1"><ToggleField v-model="orch.memory.memoryFirstGroupContext" label="记忆库优先（灰度）" hint="记忆命中时跳过 Napcat 群历史拉取；为空/降级仍兜底" /></div>
        <FormField label="Embedding 节点与模型" hint="生成向量的模型；不过滤能力（embedding 模型通常不在对话清单）">
          <ModelPicker
            :node-index="Number(orch.memory.embeddingNodeIndex) || 0" :model="orch.memory.embeddingModel || ''"
            placeholder="text-embedding-3-small"
            @update:node-index="orch.memory.embeddingNodeIndex = $event"
            @update:model="orch.memory.embeddingModel = $event" />
        </FormField>
        <FormField label="向量维度"><input v-model.number="orch.memory.embeddingDimensions" type="number" min="1" class="input-field" /></FormField>
        <FormField label="最近工作集条数" hint="Orama recent 窗口（orchestration.memory.recentTurns）"><input v-model.number="orch.memory.recentTurns" type="number" min="0" max="20" class="input-field" /></FormField>
        <FormField label="摘要间隔" hint="滚动摘要阈值（每 N 条生成一次）"><input v-model.number="orch.memory.summarizeEvery" type="number" min="2" class="input-field" /></FormField>
        <FormField label="数据目录" hint="留空使用 bot dataDir/memory"><input v-model="orch.memory.dataDir" class="input-field font-mono" /></FormField>
      </div>
      <p class="text-[color:var(--ink-3)] text-xs mt-3">
        每次回复自动注入的记忆预算（TopK / 最低分 / 字符上限 / 群上下文）唯一在「Agent」页配置（contextPolicy）；模型可在预算之上经内部技能 memory.search 自主检索更多。
      </p>
    </SectionCard>

    <SectionCard title="观察与写入" hint="持续监听所有聊天：未被 @、未命中命令、重连补发的消息也入库；附件只存引用与元数据" class="mb-4">
      <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        <div class="md:col-span-2 xl:col-span-1"><ToggleField v-model="orch.memory.observation.enabled" label="启用观察链路" hint="关闭则退回旧的『触发才记录』模式" /></div>
        <div class="md:col-span-2 xl:col-span-1"><ToggleField v-model="orch.memory.observation.includeGroupMessages" label="观察群聊消息" /></div>
        <div class="md:col-span-2 xl:col-span-1"><ToggleField v-model="orch.memory.observation.includePrivateMessages" label="观察私聊消息" /></div>
        <div class="md:col-span-2 xl:col-span-1"><ToggleField v-model="orch.memory.observation.includeAssistantReplies" label="观察 Bot 回复" /></div>
        <div class="md:col-span-2 xl:col-span-1"><ToggleField v-model="orch.memory.observation.includeAttachments" label="记录附件元数据" hint="只存 URL/文件名引用，不存内容" /></div>
        <FormField label="单条正文上限" hint="超长消息截断后再入库"><input v-model.number="orch.memory.observation.maxTextCharsPerMessage" type="number" min="200" class="input-field" /></FormField>
        <FormField label="连发合并窗口 (ms)" hint="触发后等待并收集同会话相邻消息（卡头/中间/结尾带触发的连发场景）；0 = 关闭"><input v-model.number="orch.memory.observation.coalesceWindowMs" type="number" min="0" max="2000" step="50" class="input-field" /></FormField>
      </div>
    </SectionCard>

    <SectionCard title="保留与清理" hint="每 cleanupIntervalDays 天执行一次，滚动保留 retentionDays 个自然日桶（默认 3 天/3 天）；删除前自动备份，重启不重复执行" class="mb-4">
      <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        <FormField label="保留天数" hint="滚动窗口大小；设 1 = 只保留最近一天"><input v-model.number="orch.memory.retentionDays" type="number" min="1" class="input-field" /></FormField>
        <FormField label="清理间隔（天）"><input v-model.number="orch.memory.retention.cleanupIntervalDays" type="number" min="1" class="input-field" /></FormField>
        <FormField label="清理时刻" hint="每天该时刻检查一次是否到期">
          <div class="flex gap-2">
            <input v-model.number="orch.memory.retention.cleanupHour" type="number" min="0" max="23" class="input-field" />
            <input v-model.number="orch.memory.retention.cleanupMinute" type="number" min="0" max="59" class="input-field" />
          </div>
        </FormField>
      </div>
    </SectionCard>

    <SectionCard title="记忆管理与内部技能状态" hint="管理员检索、清理和压缩 Orama 物理索引；清理群会同时删除该群的 personal 索引；内部技能 memory.search 只对 Agent 暴露" class="mb-4">
      <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        <FormField label="操作">
          <AppSelect v-model="memoryActionType" :options="memoryActionOptions" />
        </FormField>
        <FormField v-if="memoryActionType === 'retention_now'" label="试运行 (dry-run)" hint="只统计将被删除的条数，不实际删除">
          <ToggleField v-model="memoryDryRun" label="dry-run" />
        </FormField>
        <FormField label="Bot QQ"><input v-model="memoryBotId" class="input-field font-mono" placeholder="默认当前 bot" /></FormField>
        <FormField v-if="memoryActionType === 'search' || memoryActionType === 'list'" label="会话类型"><AppSelect v-model="memoryChatType" :options="memoryChatTypeOptions" /></FormField>
        <FormField v-if="memoryActionType === 'search' || memoryActionType === 'clear_group' || memoryActionType === 'list'" label="群号"><input v-model="memoryGroupId" class="input-field font-mono" /></FormField>
        <FormField v-if="memoryActionType === 'search' || memoryActionType === 'clear_user'" label="用户 QQ"><input v-model="memoryUserId" class="input-field font-mono" /></FormField>
        <FormField v-if="memoryActionType === 'search'" label="检索语义"><input v-model="memoryQuery" class="input-field" placeholder="例如：和泉纱雾海报" /></FormField>
        <div class="flex items-end"><button class="btn-primary" type="button" @click="runMemoryAction">执行</button></div>
      </div>
      <pre v-if="memoryActionResult" class="mt-3 text-xs bg-black/20 p-3 rounded max-h-[260px] overflow-auto">{{ JSON.stringify(memoryActionResult, null, 2) }}</pre>
    </SectionCard>
  </div>
</template>
