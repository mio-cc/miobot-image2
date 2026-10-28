<script setup lang="ts">
import { onMounted, ref, computed } from 'vue';
import client, { errorMessage } from '../api/client';
import SectionCard from '../components/SectionCard.vue';

/**
 * R18 提示词注册表：全部提示词统一管理（GET/POST /api/prompts）。
 * 保存 → config.json → bot 进程 loadIfChanged → 下一轮热重载。
 * 内置模板（agent.base/memory.summarize 等）只读展示，待后续开放编辑。
 */

interface PromptEntry {
    id: string;
    title: string;
    description: string;
    category: string;
    hotReload: string;
    variables: string;
    editable: boolean;
    builtin: boolean;
    content: string;
    configPath: string | null;
}

const prompts = ref<PromptEntry[]>([]);
const loading = ref(false);
const error = ref('');
const editingId = ref<string | null>(null);
const editingContent = ref('');
const saving = ref(false);
const flash = ref('');
const filterCategory = ref('全部');
const searchKeyword = ref('');

const CATEGORY_LABELS: Record<string, string> = {
    input: '输入', generation: '生成', memory: '记忆',
    search: '搜索', presentation: '呈现', system: '系统',
};
const CATEGORIES = ['全部', '输入', '生成', '记忆', '搜索', '呈现', '系统'];
const CAT_TO_KEY: Record<string, string> = {
    '': '', '输入': 'input', '生成': 'generation', '记忆': 'memory',
    '搜索': 'search', '呈现': 'presentation', '系统': 'system',
};

const filtered = computed(() => {
    const kw = searchKeyword.value.trim().toLowerCase();
    const cat = CAT_TO_KEY[filterCategory.value] ?? filterCategory.value;
    return prompts.value
        .filter((p) => filterCategory.value === '全部' || p.category === cat)
        .filter((p) => !kw || `${p.id} ${p.title} ${p.description}`.toLowerCase().includes(kw));
});

async function refresh() {
    loading.value = true;
    error.value = '';
    try {
        const res = await client.get('/prompts');
        prompts.value = res.data.prompts || [];
    } catch (e: any) {
        error.value = errorMessage(e);
    } finally {
        loading.value = false;
    }
}

function startEdit(entry: PromptEntry) {
    if (!entry.editable) return;
    editingId.value = entry.id;
    editingContent.value = entry.content;
    flash.value = '';
}

function cancelEdit() {
    editingId.value = null;
    editingContent.value = '';
}

async function saveEdit() {
    if (!editingId.value) return;
    saving.value = true;
    error.value = '';
    try {
        const res = await client.post('/prompts/update', { id: editingId.value, content: editingContent.value });
        flash.value = `已保存 · r${res.data.revision} · ${res.data.hotReload === 'next_turn' ? '下一轮对话自动生效' : '需重启'}`;
        editingId.value = null;
        editingContent.value = '';
        await refresh();
    } catch (e: any) {
        error.value = errorMessage(e);
    } finally {
        saving.value = false;
    }
}

async function resetEntry(entry: PromptEntry) {
    if (!entry.editable || !window.confirm(`确定还原「${entry.title}」为出厂默认？`)) return;
    saving.value = true;
    try {
        await client.post('/prompts/reset', { id: entry.id });
        flash.value = `「${entry.title}」已还原出厂默认`;
        await refresh();
    } catch (e: any) {
        error.value = errorMessage(e);
    } finally {
        saving.value = false;
    }
}

function copyContent(text: string) {
    void navigator.clipboard.writeText(text);
    flash.value = '已复制到剪贴板';
}

onMounted(() => { void refresh(); });
</script>

<template>
  <div>
    <header class="mb-4">
      <h1 class="page-title mb-0.5">提示词注册表</h1>
      <p class="text-[color:var(--ink-3)] text-xs">
        全部提示词统一管理 · 保存即热重载（下一轮对话自动生效） · 点击卡片展开内容
      </p>
    </header>

    <div class="flex flex-wrap items-center gap-3 mb-4">
      <input v-model="searchKeyword" placeholder="搜索提示词…" class="input-field w-52" />
      <div class="flex flex-wrap gap-2">
        <button v-for="cat in CATEGORIES" :key="cat"
          class="text-xs rounded-full border px-4 py-1.5 transition-colors"
          :class="filterCategory === cat
            ? 'bg-[color:var(--ink)] text-white border-transparent font-semibold'
            : 'bg-[color:var(--surface)] text-[color:var(--ink-2)] border-[color:var(--hairline-3)]'"
          @click="filterCategory = cat">{{ cat }}</button>
      </div>
      <span class="text-xs text-[color:var(--ink-3)] ml-auto">{{ filtered.length }} 项</span>
      <button class="btn-outline text-xs" @click="refresh" :disabled="loading">{{ loading ? '刷新中…' : '刷新' }}</button>
    </div>

    <p v-if="flash" class="mb-3 text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
      {{ flash }}
    </p>
    <p v-if="error" class="mb-3 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{{ error }}</p>

    <div v-for="entry in filtered" :key="entry.id" class="mb-3">
      <SectionCard>
        <div class="flex items-start justify-between gap-3 mb-2">
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2 flex-wrap">
              <span class="text-sm font-semibold">{{ entry.title }}</span>
              <span class="tag">{{ CATEGORY_LABELS[entry.category] || entry.category }}</span>
              <span v-if="entry.builtin" class="tag opacity-50">内置·只读</span>
              <span v-else class="tag bg-emerald-50 text-emerald-700 border border-emerald-200">可编辑</span>
            </div>
            <div class="text-xs text-[color:var(--ink-3)] mt-0.5 font-mono">{{ entry.id }}</div>
            <div class="text-xs text-[color:var(--ink-2)] mt-1">{{ entry.description }}</div>
            <div v-if="entry.variables" class="text-[11px] text-[color:var(--ink-3)] mt-1 font-mono">
              变量：{{ entry.variables }}
            </div>
          </div>
          <div class="flex flex-col gap-1.5 flex-none text-right">
            <span class="text-[10px] text-[color:var(--ink-3)]">
              {{ entry.hotReload === 'next_turn' ? '↻ 热重载' : '⚠ 需重启' }}
            </span>
            <div class="flex gap-1.5 justify-end">
              <button v-if="entry.editable && editingId !== entry.id" class="btn-outline text-xs" @click="startEdit(entry)">编辑</button>
              <button v-if="entry.editable" class="btn-outline text-xs opacity-50" @click="resetEntry(entry)">还原</button>
              <button class="btn-outline text-xs opacity-50" @click="copyContent(entry.content)">复制</button>
            </div>
          </div>
        </div>

        <!-- 查看态：折叠展开 -->
        <details v-if="editingId !== entry.id" class="group">
          <summary class="cursor-pointer text-xs text-[color:var(--ink-3)] hover:text-[color:var(--ink)] transition-colors select-none">
            {{ entry.content ? (entry.content.length > 120 ? `展开查看（${entry.content.length} 字符）` : '展开') : '（使用出厂默认——点"编辑"自定义）' }}
            <span class="group-open:hidden">▸</span><span class="hidden group-open:inline">▾</span>
          </summary>
          <pre v-if="entry.content" class="font-mono text-[11px] leading-relaxed overflow-auto max-h-48 p-3 mt-2 rounded-lg bg-[color:var(--page)] border border-[color:var(--hairline)] whitespace-pre-wrap">{{ entry.content }}</pre>
        </details>

        <!-- 编辑态 -->
        <div v-if="editingId === entry.id" class="mt-2">
          <textarea v-model="editingContent"
            class="input-field font-mono text-xs w-full"
            style="min-height: 200px; resize: vertical; line-height: 1.55"
            :placeholder="'提示词内容…可用变量：' + (entry.variables || '（无变量）')"
            spellcheck="false"></textarea>
          <div class="flex gap-2 mt-2 items-center">
            <button class="btn-primary text-xs" @click="saveEdit" :disabled="saving">
              {{ saving ? '保存中…' : '保存（热重载）' }}
            </button>
            <button class="btn-outline text-xs" @click="cancelEdit">取消</button>
            <span class="text-xs text-[color:var(--ink-3)] ml-auto">{{ editingContent.length }} 字符</span>
          </div>
        </div>
      </SectionCard>
    </div>

    <p v-if="!loading && !filtered.length" class="text-sm text-[color:var(--ink-3)] mt-6 text-center">
      没有匹配的提示词。
    </p>
  </div>
</template>