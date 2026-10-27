<script setup lang="ts">
import { onMounted, ref } from 'vue';
import client, { errorMessage } from '../api/client';
import SectionCard from '../components/SectionCard.vue';

interface JobRecord {
    jobId?: string;
    taskId?: string;
    id?: string;
    capability?: string;
    toolName?: string;
    status?: string;
    createdAt?: string;
    updatedAt?: string;
    requesterQq?: string;
    source?: string;
    chatType?: string;
    groupId?: string;
    error?: { code?: string; message?: string };
}

const jobs = ref<JobRecord[]>([]);
const loading = ref(false);
const error = ref('');

const STATUS_CLASS: Record<string, string> = {
    running: 'status-warn',
    pending: 'status-warn',
    queued: 'status-warn',
    succeeded: 'status-good',
    success: 'status-good',
    completed: 'status-good',
    failed: 'status-crit',
    error: 'status-crit',
    cancelled: 'status-crit',
    expired: 'status-crit',
    interrupted: 'status-crit',
};

async function refresh() {
    loading.value = true;
    error.value = '';
    try {
        const res = await client.get('/orchestration/jobs');
        jobs.value = res.data.jobs || [];
    } catch (e: any) {
        error.value = errorMessage(e, '读取异步任务失败');
    } finally {
        loading.value = false;
    }
}

onMounted(() => { void refresh(); });
</script>

<template>
  <div>
    <header class="mb-4">
      <h1 class="page-title mb-0.5">异步任务</h1>
      <p class="text-[color:var(--ink-3)] text-xs">编排与 Agent 工具的持久化任务：排队、运行、恢复与终态。</p>
    </header>

    <SectionCard title="任务记录" hint="orchestration-pending-jobs / agent-tool-jobs 的只读视图" class="mb-4">
      <template #action>
        <button class="btn-outline" :disabled="loading" @click="refresh">刷新</button>
      </template>
      <p v-if="error" class="text-xs status-crit mb-2">{{ error }}</p>
      <p v-if="loading" class="text-xs text-[color:var(--ink-3)]">读取中…</p>
      <p v-else-if="!jobs.length" class="text-xs text-[color:var(--ink-3)]">暂无任务记录。</p>
      <div v-else class="space-y-2">
        <div v-for="(job, index) in jobs" :key="job.jobId || job.taskId || index" class="field-box items-start">
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-2">
              <span class="font-mono text-xs truncate">{{ job.jobId || job.taskId }}</span>
              <span :class="['tag', STATUS_CLASS[String(job.status || '').toLowerCase()] || '']">{{ job.status || 'unknown' }}</span>
              <span v-if="job.source" class="tag">{{ job.source }}</span>
              <span v-if="job.capability || job.toolName" class="tag font-mono">{{ job.capability || job.toolName }}</span>
            </div>
            <div v-if="job.error" class="text-xs text-[color:var(--ink-2)] mt-1">
              <span class="status-crit">{{ job.error.code }}</span> {{ job.error.message }}
            </div>
          </div>
          <span class="text-[11px] text-[color:var(--ink-3)] whitespace-nowrap">{{ job.updatedAt || job.createdAt || '' }}</span>
        </div>
      </div>
    </SectionCard>
  </div>
</template>