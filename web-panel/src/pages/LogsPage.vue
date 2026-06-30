<script lang="ts">
import { defineComponent, inject } from 'vue';
export default defineComponent({
  setup() {
    return { ...(inject('panelStore', {}) as Record<string, any>) };
  },
});
</script>
<template>
          <div class="animate-fadein">

            <header class="page-head">
              <h1 class="page-head__title">运行日志</h1>
              <p class="page-head__desc">实时监控机器人运行系统日志与消息处理链路。支持级别筛选、全文检索与自动刷新。</p>
              <div class="page-head__actions">
                <button @click="fetchLogs()" :disabled="logLoading" class="btn-outline text-sm">{{ logLoading ? '读取中' : '刷新' }}</button>
                <button @click="copyVisibleLogs" :disabled="!logEntries.length" class="btn-outline text-sm">复制当前</button>
                <button @click="clearLogs" :disabled="logLoading" class="btn-danger text-sm">清空</button>
              </div>
            </header>

            <div class="metric-grid">
              <div class="metric" v-if="logStats">
                <p class="metric__label">内存条数</p>
                <p class="metric__value">{{ logStats.memoryTotal ?? logStats.total }}<span style="font-size: 0.8rem; color: var(--muted-light);"> / {{ logStats.maxMemoryEntries }}</span></p>
              </div>
              <div class="metric metric--primary" v-if="logStats">
                <p class="metric__label">总记录数</p>
                <p class="metric__value">{{ logStats.total }}</p>
              </div>
              <div class="metric metric--success">
                <p class="metric__label">当前显示</p>
                <p class="metric__value">{{ logEntries.length }}</p>
                <p class="metric__hint">条级别记录</p>
              </div>
            </div>

            <div class="card p-5">
              <div class="group-grid group-grid--3" style="grid-template-columns: repeat(auto-fit, minmax(min(160px, 100%), 1fr));">
                <div>
                  <label class="label-sm">级别</label>
                  <select v-model="logLevel" @change="fetchLogs()" class="input-field font-mono">
                    <option value="all">全部</option>
                    <option value="debug">调试</option>
                    <option value="info">信息</option>
                    <option value="warn">警告</option>
                    <option value="error">错误</option>
                  </select>
                </div>
                <div class="log-limit-field">
                  <label class="label-sm">显示条数</label>
                  <input v-model.number="logLimit" @change="applySystemLogLimit" @keyup.enter="applySystemLogLimit" type="number" min="1" max="5000" step="50" class="input-field font-mono" placeholder="300" />
                  <span class="log-limit-hint">1-5000</span>
                </div>
                <div class="log-search-field">
                  <label class="label-sm">全文检索</label>
                  <input v-model="logSearch" @keyup.enter="fetchLogs()" class="input-field" placeholder="报错词 / 范围..." />
                </div>
                <label class="log-auto-refresh" style="margin-top: auto;">
                  <input type="checkbox" v-model="logAutoRefresh" class="rounded accent-indigo-500 h-4.5 w-4.5" />
                  <span>自动刷新</span>
                </label>
              </div>
              <p v-if="logError" class="log-inline-status log-inline-status--error animate-fadein" style="margin-top: 14px;">{{ logError }}</p>
              <p v-if="logCopyStatus" class="log-inline-status log-inline-status--success animate-fadein" style="margin-top: 14px;">{{ logCopyStatus }}</p>
              <p v-if="logStats" class="log-file-path" style="margin-top: 12px; color: var(--muted); font-size: 0.72rem; font-family: var(--font-mono);">文件: <code>{{ logStats.logFile }}</code></p>
            </div>

            <div class="card log-terminal log-terminal--system">
              <div class="log-terminal__bar">
                <div>
                  <span class="log-terminal__title">系统日志输出</span>
                  <small>{{ logEntries.length }} 条级别记录</small>
                </div>
                <button @click="copyVisibleLogs" :disabled="!logEntries.length" class="log-copy-button log-copy-button--bar">复制全部</button>
              </div>

              <div v-if="logLoading && !logEntries.length" class="log-empty-state animate-pulse">
                正在连接系统日志缓冲区...
              </div>
              <div v-else-if="!logEntries.length" class="log-empty-state">
                当前日志流为空，等待机器人交互。
              </div>
              <div v-else class="log-terminal__list">
                <article v-for="(entry, idx) in logEntries" :key="entry.id ?? `${entry.timestamp}-${entry.scope}-${idx}`" class="log-entry">
                  <div class="log-entry__main">
                    <header class="log-entry__meta">
                      <span :class="['log-level-badge', levelBadgeClass(entry.level)]">{{ logLevelText(entry.level) }}</span>
                      <time>{{ entry.timestamp }}</time>
                      <span class="log-entry__scope">{{ entry.scope }}</span>
                      <span class="log-entry__id">#{{ entry.id ?? '-' }}</span>
                      <button @click="copyLogEntry(entry)" class="log-copy-button">复制本条</button>
                    </header>
                    <p class="log-entry__message selectable-log-text">{{ entry.message }}</p>
                  </div>

                  <div v-if="formatLogDetails(entry.details || entry.data)" class="log-entry__details-panel">
                    <div class="log-entry__details-head">
                      <span>原始堆栈 / 结构化数据</span>
                      <button @click="copyLogDetails(entry)" class="log-copy-button">复制详情</button>
                    </div>
                    <pre class="log-entry__details selectable-log-text">{{ formatLogDetails(entry.details || entry.data) }}</pre>
                  </div>
                </article>
              </div>
            </div>

          </div>
</template>
