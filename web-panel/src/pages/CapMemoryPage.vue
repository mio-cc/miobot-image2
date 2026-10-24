<script setup lang="ts">
import { computed, ref } from 'vue';
import client from '../api/client';
import { useConfigStore } from '../stores/config';
import SectionCard from '../components/SectionCard.vue';
import FormField from '../components/FormField.vue';
import ToggleField from '../components/ToggleField.vue';
import ModelPicker from '../components/ModelPicker.vue';

/**
 * 记忆能力页。
 * 由原 OrchestrationPage 的「向量记忆」「记忆管理」两卡迁入。
 */

const configStore = useConfigStore();
const config = computed(() => configStore.config);
const orch = computed(() => config.value?.orchestration);

const memoryActionType = ref<'list' | 'search' | 'clear_group' | 'clear_user' | 'prune'>('list');
const memoryBotId = ref('');
const memoryChatType = ref<'group' | 'private'>('group');
const memoryGroupId = ref('');
const memoryUserId = ref('');
const memoryQuery = ref('');
const memoryActionResult = ref<any>(null);

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
  <div v-if="config && orch">
    <header class="mb-4">
      <h1 class="page-title mb-0.5">记忆</h1>
      <p class="text-[color:var(--ink-3)] text-xs">
        Orama 本地向量记忆：群聊、私聊、用户按物理 namespace 隔离。
      </p>
    </header>

    <SectionCard title="向量记忆" hint="Orama 本地索引；群聊、私聊、用户按物理 namespace 隔离" class="mb-4">
      <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        <div class="md:col-span-2 xl:col-span-1"><ToggleField v-model="orch.memory.enabled" label="启用长期记忆" /></div>
        <div class="md:col-span-2 xl:col-span-1"><ToggleField v-model="orch.memory.autoIngest" label="自动写入消息" /></div>
        <div class="md:col-span-2 xl:col-span-1"><ToggleField v-model="orch.memory.hybridSearch" label="向量 + 全文混合检索" /></div>
        <div class="md:col-span-2 xl:col-span-1"><ToggleField v-model="orch.memory.userGlobalProfileEnabled" label="允许跨群用户画像" hint="默认关闭，保持群隔离" /></div>
        <FormField label="Embedding 节点与模型" hint="生成向量的模型；不过滤能力（embedding 模型通常不在对话清单）">
          <ModelPicker
            :node-index="Number(orch.memory.embeddingNodeIndex) || 0" :model="orch.memory.embeddingModel || ''"
            placeholder="text-embedding-3-small"
            @update:node-index="orch.memory.embeddingNodeIndex = $event"
            @update:model="orch.memory.embeddingModel = $event" />
        </FormField>
        <FormField label="向量维度"><input v-model.number="orch.memory.embeddingDimensions" type="number" min="1" class="input-field" /></FormField>
        <FormField label="语义 TopK"><input v-model.number="orch.memory.topK" type="number" min="1" max="100" class="input-field" /></FormField>
        <FormField label="最低分数"><input v-model.number="orch.memory.minScore" type="number" min="0" max="1" step="0.01" class="input-field" /></FormField>
        <FormField label="最近工作集条数"><input v-model.number="orch.memory.recentTurns" type="number" min="0" max="20" class="input-field" /></FormField>
        <FormField label="最大上下文字符"><input v-model.number="orch.memory.maxContextChars" type="number" min="200" class="input-field" /></FormField>
        <FormField label="保留天数"><input v-model.number="orch.memory.retentionDays" type="number" min="1" class="input-field" /></FormField>
        <FormField label="摘要间隔" hint="预留滚动摘要阈值"><input v-model.number="orch.memory.summarizeEvery" type="number" min="2" class="input-field" /></FormField>
        <FormField label="数据目录" hint="留空使用 bot dataDir/memory"><input v-model="orch.memory.dataDir" class="input-field font-mono" /></FormField>
      </div>
    </SectionCard>

    <SectionCard title="记忆管理" hint="管理员检索、清理和压缩 Orama 物理索引；清理群会同时删除该群的 personal 索引" class="mb-4">
      <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        <FormField label="操作">
          <select v-model="memoryActionType" class="input-field"><option value="list">列出 namespace</option><option value="search">检索测试</option><option value="clear_group">清理群记忆</option><option value="clear_user">清理用户记忆</option><option value="prune">执行 retention 清理</option></select>
        </FormField>
        <FormField label="Bot QQ"><input v-model="memoryBotId" class="input-field font-mono" placeholder="默认当前 bot" /></FormField>
        <FormField label="会话类型"><select v-model="memoryChatType" class="input-field"><option value="group">群聊</option><option value="private">私聊</option></select></FormField>
        <FormField label="群号"><input v-model="memoryGroupId" class="input-field font-mono" /></FormField>
        <FormField label="用户 QQ"><input v-model="memoryUserId" class="input-field font-mono" /></FormField>
        <FormField label="检索语义"><input v-model="memoryQuery" class="input-field" placeholder="例如：和泉纱雾海报" /></FormField>
        <div class="flex items-end"><button class="btn-primary" type="button" @click="runMemoryAction">执行</button></div>
      </div>
      <pre v-if="memoryActionResult" class="mt-3 text-xs bg-black/20 p-3 rounded max-h-[260px] overflow-auto">{{ JSON.stringify(memoryActionResult, null, 2) }}</pre>
    </SectionCard>
  </div>
</template>
