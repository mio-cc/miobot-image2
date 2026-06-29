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
              <h1 class="page-head__title">模型路由</h1>
              <p class="page-head__desc">所有"选择节点 / 选择模型"的后台入口统一在这里。Bot、画布、模板、反推、自由模式互不混用；当某节点的某模型失效时，运行时会按同名模型自动轮询其它可用节点。</p>
            </header>

            <div class="metric-grid">
              <div class="metric metric--primary">
                <p class="metric__label">可用节点</p>
                <p class="metric__value">{{ nodeOptions().length }}</p>
              </div>
              <div class="metric metric--success">
                <p class="metric__label">路由场景</p>
                <p class="metric__value">{{ modelRouteGroups().reduce((sum, group) => sum + group.items.length, 0) }}</p>
              </div>
              <div class="metric">
                <p class="metric__label">保存方式</p>
                <p class="metric__value" style="font-size: 0.92rem;">仅提交变更</p>
              </div>
            </div>

            <div v-for="group in modelRouteGroups()" :key="group.id" class="card p-5">
              <div class="flex items-center justify-between mb-4">
                <div>
                  <h3 class="section-title">{{ group.title }}</h3>
                  <p style="color: var(--muted); font-size: 0.78rem; margin-top: 4px;">{{ group.subtitle }}</p>
                </div>
                <span class="tag" style="background: var(--primary-soft); border-color: var(--primary-line); color: var(--primary);">{{ group.items.length }} 条路由</span>
              </div>

              <div class="group-grid group-grid--2">
                <div v-for="route in group.items" :key="route.id"
                  class="node-card" :class="routeEnabled(route) ? 'node-card-active' : ''">
                  <div class="flex items-start justify-between gap-3 mb-3">
                    <div>
                      <div class="flex flex-wrap items-center gap-2">
                        <span style="font-size: 0.86rem; font-weight: 700; color: var(--text);">{{ route.title }}</span>
                        <span class="tag">{{ route.badge || 'Model' }}</span>
                        <span class="tag" :style="routeEnabled(route) ? 'background: var(--success-soft); border-color: var(--success-line); color: var(--success);' : ''">
                          {{ routeEnabled(route) ? '启用中' : '未启用' }}
                        </span>
                      </div>
                      <p style="margin-top: 8px; color: var(--muted); font-size: 0.76rem; line-height: 1.5;">{{ route.description }}</p>
                    </div>
                    <span v-if="routeFailoverCount(route)" class="tag" style="background: #ecfeff; border-color: #a5f3fc; color: #0ea5e9; flex: 0 0 auto;">
                      备援 {{ routeFailoverCount(route) }}
                    </span>
                  </div>

                  <div class="setting-row" style="padding: 8px 12px; margin-bottom: 12px;">
                    <span style="color: var(--muted); font-size: 0.72rem; font-weight: 600;">当前</span>
                    <code style="font-family: var(--font-mono); font-size: 0.76rem; color: var(--text); flex: 1; text-align: right; overflow-wrap: anywhere;">{{ routeSummary(route.nodePath, route.modelPath) }}</code>
                  </div>

                  <div class="grid grid-cols-1 md:grid-cols-[220px_1fr] gap-3">
                    <div>
                      <label class="label-sm">节点</label>
                      <select :value="routeNodeIndex(route)" @change="updateModelRoute(route, 'node', $event)" class="input-field font-mono">
                        <option v-for="item in routeNodeOptions(route)" :key="`${route.id}-node-${item.idx}`" :value="item.idx">
                          {{ item.node.name || `节点 ${item.idx + 1}` }}{{ item.node.enabled === false ? '（已禁用）' : '' }}
                        </option>
                      </select>
                    </div>
                    <div>
                      <label class="label-sm">模型</label>
                      <input :value="routeModelValue(route)" :list="routeDatalistId(route)" @input="updateModelRoute(route, 'model', $event)" class="input-field font-mono" :placeholder="route.placeholder || 'gpt-4o-mini'" />
                      <datalist :id="routeDatalistId(route)">
                        <option v-for="m in routeModelOptions(route)" :key="`${route.id}-${m}`" :value="m" />
                      </datalist>
                    </div>
                  </div>
                </div>
              </div>
            </div>

          </div>
</template>
