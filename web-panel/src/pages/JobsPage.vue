<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
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
    running: 'tag-warn',
    pending: 'tag-warn',
    queued: 'tag-warn',
    succeeded: 'tag-good',
    success: 'tag-good',
    completed: 'tag-good',
    failed: 'tag-bad',
    error: 'tag-bad',
    cancelled: 'tag-bad',
    expired: 'tag-bad',
    interrupted: 'tag-bad',
};

/** 状态筛选分组（展示口径）：运行中 / 已完成 / 失败。 */
const RUNLIKE = new Set(['running', 'pending', 'queued']);
const DONELIKE = new Set(['succeeded', 'success', 'completed']);

const statusFilter = ref<'all' | 'run' | 'done' | 'fail'>('all');
const jobsOfGroup = (group: 'run' | 'done' | 'fail') => jobs.value.filter((job) => {
    const s = String(job.status || '').toLowerCase();
    if (group === 'run') return RUNLIKE.has(s);
    if (group === 'done') return DONELIKE.has(s);
    return !RUNLIKE.has(s) && !DONELIKE.has(s);
});
const filteredJobs = computed(() => {
    if (statusFilter.value === 'all') return jobs.value;
    return jobsOfGroup(statusFilter.value);
});

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

    <!-- 状态筛选 -->
    <div class="flex flex-wrap items-center gap-2 mb-4">
      <div class="flex flex-wrap gap-2">
        <button type="button" class="chip" :class="statusFilter === 'all' ? 'on' : ''" @click="statusFilter = 'all'">全部 <span class="n">{{ jobs.length }}</span></button>
        <button type="button" class="chip" :class="statusFilter === 'run' ? 'on' : ''" @click="statusFilter = 'run'">运行中 <span class="n">{{ jobsOfGroup('run').length }}</span></button>
        <button type="button" class="chip" :class="statusFilter === 'done' ? 'on' : ''" @click="statusFilter = 'done'">已完成 <span class="n">{{ jobsOfGroup('done').length }}</span></button>
        <button type="button" class="chip" :class="statusFilter === 'fail' ? 'on' : ''" @click="statusFilter = 'fail'">失败 <span class="n">{{ jobsOfGroup('fail').length }}</span></button>
      </div>
    </div>

    <SectionCard title="任务记录" hint="orchestration-pending-jobs / agent-tool-jobs 的只读视图" class="mb-4">
      <template #action>
        <button class="btn-outline" :disabled="loading" @click="refresh">刷新</button>
      </template>
      <p v-if="error" class="text-xs status-crit mb-2">{{ error }}</p>

      <!-- 骨架 -->
      <div v-if="loading && !jobs.length" class="space-y-2">
        <div v-for="i in 4" :key="`sk-${i}`" class="skeleton h-10 w-full"></div>
      </div>

      <!-- 空态 -->
      <div v-else-if="!jobs.length" class="empty-state">
        <div class="empty-title">暂无任务记录</div>
        <div class="empty-sub">Suno / 视频 / 文件等异步交付任务会出现在这里</div>
      </div>
      <div v-else-if="!filteredJobs.length" class="empty-state">
        <div class="empty-title">该状态下没有任务</div>
        <div class="empty-sub">切换上方筛选查看其他状态</div>
      </div>

      <!-- 任务表格 -->
      <div v-else class="overflow-x-auto">
        <table class="w-full text-[12.5px]">
          <thead>
            <tr>
              <th class="th">任务</th>
              <th class="th">能力 / 来源</th>
              <th class="th">状态</th>
              <th class="th">更新时间</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(job, index) in filteredJobs" :key="job.jobId || job.taskId || index"
              class="border-b border-[color:var(--hairline-2)] last:border-b-0 hover:bg-[color:var(--surface-2)] transition-colors">
              <td class="px-4 py-2.5 mono text-xs whitespace-nowrap">{{ job.jobId || job.taskId }}</td>
              <td class="px-4 py-2.5 min-w-0">
                <div class="flex flex-wrap items-center gap-1.5">
                  <span v-if="job.capability || job.toolName" class="tag">{{ job.capability || job.toolName }}</span>
                  <span v-if="job.source" class="tag">{{ job.source }}</span>
                </div>
                <div v-if="job.error" class="text-[11px] mt-1 max-w-[480px] truncate" :title="job.error.message">
                  <span class="status-crit">{{ job.error.code }}</span> {{ job.error.message }}
                </div>
              </td>
              <td class="px-4 py-2.5 whitespace-nowrap"><span class="tag" :class="STATUS_CLASS[String(job.status || '').toLowerCase()] || ''">{{ job.status || 'unknown' }}</span></td>
              <td class="px-4 py-2.5 text-[11px] text-[color:var(--ink-3)] whitespace-nowrap">{{ job.updatedAt || job.createdAt || '' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </SectionCard>
  </div>
</template>