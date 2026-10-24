<script setup lang="ts">
import { onMounted, ref } from 'vue';
import client from '../api/client';
import { useConfigStore } from '../stores/config';
import SectionCard from '../components/SectionCard.vue';

/**
 * 观测中心。
 * 由原 OrchestrationPage 拆出：编排 trace 回放 / 配置版本回滚 / 待补全任务。
 * TR.4 会把 LogsPage 与 canvas.logs 设置并入此页。
 */

const configStore = useConfigStore();

const traces = ref<any[]>([]);
const pendingJobs = ref<any[]>([]);
const configVersions = ref<any[]>([]);
const traceReplay = ref<any>(null);

async function loadTraceReplay(trace: any) {
    if (!trace?.requestId) return;
    try {
        const res = await client.get('/orchestration/traces/' + encodeURIComponent(trace.requestId));
        traceReplay.value = res.data || null;
    } catch { traceReplay.value = { traces: [], timeline: [] }; }
}

async function rollbackConfigVersion(version: number) {
    try {
        await client.post('/config/rollback', { version });
        await configStore.fetchConfig();
        await loadObservability();
    } catch { /* 回滚失败由后端审计日志记录，保留当前配置 */ }
}

async function loadObservability() {
    try {
        const [traceRes, jobRes, versionRes] = await Promise.all([
            client.get('/orchestration/traces'),
            client.get('/orchestration/jobs'),
            client.get('/config/versions'),
        ]);
        traces.value = traceRes.data?.traces || [];
        pendingJobs.value = jobRes.data?.jobs || [];
        configVersions.value = versionRes.data?.versions || [];
    } catch { traces.value = []; pendingJobs.value = []; configVersions.value = []; }
}

onMounted(loadObservability);
</script>

<template>
  <div>
    <header class="mb-4">
      <h1 class="page-title mb-0.5">观测中心</h1>
      <p class="text-[color:var(--ink-3)] text-xs">
        编排 trace 回放、配置版本回滚与待补全任务。
      </p>
    </header>

    <SectionCard title="最近编排追踪" hint="来自 bot 进程写入的 JSONL trace；用于定位规划、权限、执行和回复问题" class="mb-4">
      <div class="overflow-x-auto max-h-[360px]">
        <table class="w-full text-xs">
          <thead class="text-[color:var(--ink-3)] border-b border-[color:var(--hairline-2)]">
            <tr><th class="text-left py-2 pr-3">时间</th><th class="text-left py-2 pr-3">请求</th><th class="text-left py-2 pr-3">阶段</th><th class="text-left py-2 pr-3">摘要</th><th class="text-left py-2">操作</th></tr>
          </thead>
          <tbody>
            <tr v-for="trace in [...traces].reverse()" :key="trace.id" class="border-b border-[color:var(--hairline-2)]/60">
              <td class="py-2 pr-3 mono whitespace-nowrap">{{ String(trace.timestamp || '').slice(11, 19) }}</td>
              <td class="py-2 pr-3 mono">{{ trace.requestId }}</td>
              <td class="py-2 pr-3">{{ trace.stage }}</td>
              <td class="py-2 pr-3">{{ trace.summary }}</td>
              <td class="py-2"><button class="btn-outline !px-2 !py-1" type="button" @click="loadTraceReplay(trace)">回放</button></td>
            </tr>
            <tr v-if="!traces.length"><td colspan="5" class="py-3 text-[color:var(--ink-3)]">暂无编排追踪</td></tr>
          </tbody>
        </table>
      </div>
      <div v-if="traceReplay" class="mt-3 border-t border-[color:var(--hairline-2)] pt-3 max-h-[320px] overflow-auto">
        <p class="text-xs mb-2">Trace 回放：<span class="mono">{{ traceReplay.requestId }}</span>（只读，不重新执行）</p>
        <div v-for="(item, index) in traceReplay.timeline || []" :key="index" class="text-xs py-1 border-b border-[color:var(--hairline-2)]/40">
          <span class="mono text-[color:var(--ink-3)]">{{ String(item.at || '').slice(11, 19) }}</span>
          <strong class="mx-2">{{ item.stage }}</strong>{{ item.summary }}
        </div>
      </div>
    </SectionCard>

    <SectionCard title="配置版本与回滚" hint="每次保存记录变更路径与版本快照；回滚会重新校验、热重载并写入审计" class="mb-4">
      <div class="overflow-x-auto max-h-[280px]">
        <table class="w-full text-xs">
          <thead class="text-[color:var(--ink-3)] border-b border-[color:var(--hairline-2)]">
            <tr><th class="text-left py-2 pr-3">版本</th><th class="text-left py-2 pr-3">保存时间</th><th class="text-left py-2 pr-3">变更路径</th><th class="text-left py-2">操作</th></tr>
          </thead>
          <tbody>
            <tr v-for="item in [...configVersions].reverse()" :key="item.version" class="border-b border-[color:var(--hairline-2)]/60">
              <td class="py-2 pr-3 mono">v{{ item.version }} / rev {{ item.revision }}</td>
              <td class="py-2 pr-3">{{ String(item.savedAt || '').slice(0, 19).replace('T', ' ') }}</td>
              <td class="py-2 pr-3 max-w-[520px] truncate">{{ (item.changedPaths || []).join(', ') || '初始配置' }}</td>
              <td class="py-2">
                <span v-if="item.current" class="text-[color:var(--ink-3)]">当前</span>
                <button v-else class="btn-outline !px-2 !py-1" type="button" @click="rollbackConfigVersion(item.version)">回滚</button>
              </td>
            </tr>
            <tr v-if="!configVersions.length"><td colspan="4" class="py-3 text-[color:var(--ink-3)]">暂无版本记录</td></tr>
          </tbody>
        </table>
      </div>
    </SectionCard>

    <SectionCard title="待补全任务" hint="规划器追问后保存的 pendingJob；用户下一条消息会自动合并补充信息并重新规划" class="mb-4">
      <div class="overflow-x-auto max-h-[280px]">
        <table class="w-full text-xs">
          <thead class="text-[color:var(--ink-3)] border-b border-[color:var(--hairline-2)]">
            <tr><th class="text-left py-2 pr-3">会话</th><th class="text-left py-2 pr-3">原始请求</th><th class="text-left py-2 pr-3">提问</th><th class="text-left py-2">过期时间</th></tr>
          </thead>
          <tbody>
            <tr v-for="job in pendingJobs" :key="job.key" class="border-b border-[color:var(--hairline-2)]/60">
              <td class="py-2 pr-3 mono">{{ job.key }}</td>
              <td class="py-2 pr-3 max-w-[360px] truncate">{{ job.originalText }}</td>
              <td class="py-2 pr-3 max-w-[360px] truncate">{{ job.question }}</td>
              <td class="py-2">{{ String(job.expiresAt || '').slice(0, 19).replace('T', ' ') }}</td>
            </tr>
            <tr v-if="!pendingJobs.length"><td colspan="4" class="py-3 text-[color:var(--ink-3)]">暂无待补全任务</td></tr>
          </tbody>
        </table>
      </div>
    </SectionCard>
  </div>
</template>
