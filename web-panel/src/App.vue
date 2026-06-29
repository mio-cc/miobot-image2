<script setup lang="ts">
// MioBot Console — 精致浅色 SaaS 重构。
// Shell：icon-rail 侧栏 + 面包屑顶栏 + 分组内容区。
// 数据契约不变：usePanelStore provide → 页组件 inject+spread。
import { provide, ref, computed } from 'vue';
import { usePanelStore } from './composables/usePanelStore';
import LlmPage from './pages/LlmPage.vue';
import ModelRoutesPage from './pages/ModelRoutesPage.vue';
import HuggingFacePage from './pages/HuggingFacePage.vue';
import FreeModePage from './pages/FreeModePage.vue';
import ReplyStrategyPage from './pages/ReplyStrategyPage.vue';
import TemplatesPage from './pages/TemplatesPage.vue';
import CanvasConfigPage from './pages/CanvasConfigPage.vue';
import CodexPage from './pages/CodexPage.vue';
import NapcatPage from './pages/NapcatPage.vue';
import LogsPage from './pages/LogsPage.vue';
import OverviewPage from './pages/OverviewPage.vue';

const store = usePanelStore();
provide('panelStore', store);

// Shell 局部状态（不影响 store 数据契约）
const railExpanded = ref(false);
function toggleRail() { railExpanded.value = !railExpanded.value; }

// 侧栏分组：引用 menuItems 的 id，不改 currentPage 契约
const railGroups = [
  { label: '概览', ids: ['about'] },
  { label: '模型', ids: ['llm', 'modelRoutes', 'huggingFace'] },
  { label: 'Bot', ids: ['bot', 'freeMode', 'templates'] },
  { label: '创作', ids: ['canvas', 'codex'] },
  { label: '系统', ids: ['napcat', 'logs'] },
];
const railItems = (ids: string[]) => ids
  .map(id => menuItems.find(m => m.id === id))
  .filter(Boolean) as { id: string; icon: string; label: string }[];

// Shell 仅解构自身模板需要的绑定；其余绑定经 inject 由各页组件自行展开。
const {
  isAuthenticated, password, loginError, login, handleLogout,
  menuItems, currentPage, pageLabel, isMobileSidebarOpen, toggleMobileSidebar, closeMobileSidebar,
  config, saveStatus, savingConfig, saveConfig, exportConfig, triggerImportConfig, importConfigFromFile, configImportInput,
  copyFallbackText, copyFallbackTitle, copyFallbackTextarea, selectCopyFallbackText, closeCopyFallback,
  toasts,
} = store;
</script>

<template>
  <div class="app-root">

    <!-- Login -->
    <div v-if="!isAuthenticated" class="admin-login-page">
      <section class="login-shell" aria-label="MioBot Console 登录">
        <div class="login-visual">
          <div class="brand-lockup">
            <span class="brand-mark">M</span>
            <div>
              <strong>MioBot Console</strong>
              <span>智能机器人管理平台 v2</span>
            </div>
          </div>
          <div class="login-visual__copy">
            <span class="eyebrow">管理控制台</span>
            <h1>机器人<br/>控制台</h1>
            <p>集中管理模型节点、回复策略、画布任务与运行日志。</p>
            <div class="login-features">
              <div class="login-feature"><span class="login-feature__dot"></span>多模型路由与节点管理</div>
              <div class="login-feature"><span class="login-feature__dot"></span>画布工作室与图像生成</div>
              <div class="login-feature"><span class="login-feature__dot"></span>实时日志与系统诊断</div>
            </div>
          </div>
        </div>

        <div class="login-card card">
          <div class="login-card__header">
            <span class="brand-mark brand-mark--small">M</span>
            <div>
              <h2>欢迎回来</h2>
              <p>输入管理密码以继续</p>
            </div>
          </div>
          <div class="space-y-4">
            <div>
              <label class="label-sm">管理密码</label>
              <input v-model="password" @keyup.enter="login" type="password" placeholder="输入管理密码" class="input-field" />
            </div>
            <button @click="login" class="btn-primary w-full">登录控制台</button>
            <p v-if="loginError" class="form-error">{{ loginError }}</p>
          </div>
        </div>
      </section>
    </div>

    <!-- Console Shell -->
    <div v-else class="console-shell">
      <button class="rail-scrim" :data-open="isMobileSidebarOpen" type="button" aria-label="关闭导航" @click="closeMobileSidebar"></button>

      <!-- Rail -->
      <aside :class="['rail', railExpanded ? 'rail--expanded' : '', isMobileSidebarOpen ? 'mobile-open' : '']">
        <div class="rail-brand">
          <span class="brand-mark brand-mark--small">M</span>
          <span class="rail-brand__text">MioBot</span>
          <button class="rail-toggle" type="button" :title="railExpanded ? '收起' : '展开'" @click="toggleRail" aria-label="切换侧栏宽度">
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path :d="railExpanded ? 'M10 12L6 8l4-4' : 'M6 4l4 4-4 4'" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
        </div>

        <nav class="rail-nav" aria-label="主导航">
          <div v-for="(group, gi) in railGroups" :key="group.label" class="rail-group" :class="gi === 0 ? 'rail-group--first' : ''">
            <span class="rail-group__label">{{ group.label }}</span>
            <button v-for="item in railItems(group.ids)" :key="item.id"
              @click="currentPage = item.id; closeMobileSidebar()"
              :class="['rail-item', currentPage === item.id ? 'rail-item--active' : '']"
              :title="item.label">
              <span class="rail-item__icon">{{ item.icon }}</span>
              <span class="rail-item__label">{{ item.label }}</span>
            </button>
          </div>
        </nav>

        <div class="rail-footer">
          <button @click="handleLogout" class="rail-item rail-item--danger" title="退出登录">
            <span class="rail-item__icon">
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M6 2H3v12h3M10 8H6m0 0l3.5-3.5M6 8l3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </span>
            <span class="rail-item__label">退出登录</span>
          </button>
        </div>
      </aside>

      <!-- Main -->
      <main class="console-main">

        <!-- Top Bar -->
        <div class="console-topbar" v-if="config">
          <div class="console-topbar__lead">
            <button class="rail-menu-btn" type="button" aria-label="打开导航" @click="toggleMobileSidebar">
              <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
            </button>
            <nav class="console-breadcrumb" aria-label="位置">
              <span class="console-breadcrumb__root">Console</span>
              <span class="console-breadcrumb__sep">/</span>
              <span class="console-breadcrumb__current">{{ pageLabel() }}</span>
            </nav>
          </div>
          <div class="console-topbar__actions">
            <span class="status-pill" :data-tone="saveStatus.includes('失败') ? 'error' : 'success'">
              {{ saveStatus || '已保存' }}
            </span>
            <input ref="configImportInput" type="file" accept="application/json,.json" class="hidden" @change="importConfigFromFile" />
            <button @click="exportConfig" class="btn-outline text-sm console-topbar__btn">导出</button>
            <button @click="triggerImportConfig" class="btn-outline text-sm console-topbar__btn">导入</button>
            <button @click="saveConfig" :disabled="savingConfig" class="btn-primary text-sm disabled:opacity-60 disabled:cursor-not-allowed">{{ savingConfig ? '保存中...' : '保存' }}</button>
          </div>
        </div>

        <div v-if="config" class="console-content">
          <OverviewPage v-show="currentPage === 'about'" />
          <LlmPage v-show="currentPage === 'llm'" />
          <ModelRoutesPage v-show="currentPage === 'modelRoutes'" />
          <HuggingFacePage v-show="currentPage === 'huggingFace'" />
          <ReplyStrategyPage v-show="currentPage === 'bot'" />
          <FreeModePage v-show="currentPage === 'freeMode'" />
          <TemplatesPage v-show="currentPage === 'templates'" />
          <CanvasConfigPage v-show="currentPage === 'canvas'" />
          <CodexPage v-show="currentPage === 'codex'" />
          <NapcatPage v-show="currentPage === 'napcat'" />
          <LogsPage v-show="currentPage === 'logs'" />
        </div>
      </main>
    </div>

    <div v-if="copyFallbackText" class="copy-fallback-overlay" role="dialog" aria-modal="true" aria-labelledby="manual-copy-title" @click.self="closeCopyFallback">
      <section class="copy-fallback-card">
        <div class="copy-fallback-card__header">
          <div>
            <p class="copy-fallback-kicker">移动端手动复制</p>
            <h3 id="manual-copy-title">自动复制被浏览器拦截</h3>
          </div>
          <button type="button" class="copy-fallback-close" aria-label="关闭手动复制窗口" @click="closeCopyFallback">×</button>
        </div>
        <p class="copy-fallback-help">
          {{ copyFallbackTitle }}。已为你选中日志文本。手机端如果按钮复制无效，请长按下方内容，选择全选并复制。
        </p>
        <textarea
          ref="copyFallbackTextarea"
          class="copy-fallback-textarea"
          :value="copyFallbackText"
          readonly
          @focus="selectCopyFallbackText"
          @click="selectCopyFallbackText"
        ></textarea>
        <div class="copy-fallback-actions">
          <button type="button" class="btn-outline" @click="selectCopyFallbackText">重新选中</button>
          <button type="button" class="btn-primary" @click="closeCopyFallback">完成</button>
        </div>
      </section>
    </div>

    <div v-if="toasts.length" class="toast-container" aria-live="polite">
      <div v-for="toast in toasts" :key="toast.id" :class="['custom-toast', `custom-toast--${toast.type}`]">
        <span>{{ toast.message }}</span>
        <div class="toast-progress"></div>
      </div>
    </div>
  </div>
</template>
