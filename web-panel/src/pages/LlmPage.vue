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
              <h1 class="page-head__title">模型与节点</h1>
              <p class="page-head__desc">管理 OpenAI 兼容接口节点、能力分工、推理参数、生图测试、模型请求限制与提示词模板。</p>
            </header>

            <!-- API 节点列表 -->
            <div class="card p-5">
              <div class="flex items-center justify-between mb-4">
                <h3 class="section-title">接口节点</h3>
                <button @click="addNode" class="btn-outline text-sm">＋ 添加节点</button>
              </div>

              <div class="space-y-3">
                <div v-for="(node, idx) in config.llm.apiKeys" :key="idx"
                  :class="['node-card', config.llm.activeNodeIndex === idx ? 'node-card-active' : '']">
                  <div class="flex items-center justify-between mb-3">
                    <div class="flex items-center gap-2">
                      <button @click="setActiveNode(idx)"
                        :class="['w-5 h-5 rounded-full border-2 transition-all flex items-center justify-center',
                          config.llm.activeNodeIndex === idx ? 'border-indigo-500 bg-indigo-500' : 'border-gray-300']">
                        <span v-if="config.llm.activeNodeIndex === idx" class="w-2 h-2 rounded-full bg-white"></span>
                      </button>
                      <span class="text-sm font-semibold" style="color: var(--text);">{{ node.name || '未命名' }}</span>
                      <span v-if="config.llm.activeNodeIndex === idx" class="tag" style="background: var(--primary-soft); border-color: var(--primary-line); color: var(--primary);">活跃</span>
                      <label class="flex items-center gap-1 text-xs" style="color: var(--muted);">
                        <input type="checkbox" v-model="node.enabled" style="accent-color: var(--primary);" />
                        启用
                      </label>
                    </div>
                    <div class="flex gap-2">
                      <button @click="applyAnyRouterPreset(idx)" class="btn-outline text-xs py-1 px-3">Any Router</button>
                      <button @click="applyChatGpt2ApiPreset(idx)" class="btn-outline text-xs py-1 px-3">chatgpt2api</button>
                      <button @click="fetchModels(idx)" :disabled="modelLoading" class="btn-outline text-xs py-1 px-3">
                        {{ modelLoading ? '⏳' : '🔄' }} 获取模型
                      </button>
                      <button v-if="config.llm.apiKeys.length > 1" @click="removeNode(idx)" class="btn-danger text-xs">删除</button>
                    </div>
                  </div>

                  <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
                    <div>
                      <label class="label-sm">节点名称</label>
                      <input v-model="node.name" class="input-field" placeholder="我的节点" />
                    </div>
                    <div>
                      <label class="label-sm">基础地址</label>
                      <input v-model="node.baseUrl" class="input-field" placeholder="https://anyrouter.top/v1" />
                      <span style="color: var(--muted-light); font-size: 0.72rem; margin-top: 4px; display: block;">也可粘贴 "https://...-密钥sk-..."，点击获取模型时自动拆分。</span>
                    </div>
                    <div>
                      <label class="label-sm">接口密钥</label>
                      <input v-model="node.key" type="password" class="input-field" placeholder="API Key（留空不保存）" />
                    </div>
                  </div>
                  <div v-if="node.models?.length" class="setting-row" style="margin-top: 12px; padding: 10px 12px; flex-direction: column; align-items: flex-start; gap: 8px;">
                    <div class="flex items-center justify-between w-full">
                      <span style="color: var(--muted); font-size: 0.72rem; font-weight: 600;">已保存模型 {{ node.models.length }}</span>
                      <span v-if="node.modelsFetchedAt" style="color: var(--muted-light); font-size: 0.68rem; font-family: var(--font-mono);">{{ node.modelsFetchedAt }}</span>
                    </div>
                    <div class="flex flex-wrap gap-1.5 max-h-24 overflow-y-auto">
                      <span v-for="m in node.models" :key="`${idx}-${m}`" class="tag">{{ m }}</span>
                    </div>
                  </div>
                </div>
              </div>

              <p v-if="modelError" style="color: var(--danger); font-size: 0.76rem; margin-top: 12px;">{{ modelError }}</p>
              <p v-if="fetchedModels.length" style="color: var(--success); font-size: 0.76rem; margin-top: 12px;">✅ 已获取 {{ fetchedModels.length }} 个模型</p>
            </div>

            <!-- 能力开关与参数 -->
            <div class="card p-5">
              <h3 class="section-title mb-4">能力分工</h3>
              <div class="group-grid group-grid--3">

                <!-- Chat -->
                <div class="setting-row" style="flex-direction: column; align-items: stretch; gap: 12px;" :style="config.llm.chatEnabled ? '' : 'opacity: 0.6;'">
                  <div class="flex items-center justify-between w-full">
                    <span style="font-size: 0.86rem; font-weight: 600; color: var(--text);">🤖 日常对话</span>
                    <label class="toggle"><input type="checkbox" v-model="config.llm.chatEnabled"><span class="toggle-slider"></span></label>
                  </div>
                  <div class="setting-row" style="padding: 8px 10px; border-color: var(--success-line); background: var(--success-soft);">
                    <span style="color: var(--muted); font-size: 0.72rem;">路由</span>
                    <code style="font-family: var(--font-mono); font-size: 0.72rem; color: var(--text); flex: 1; text-align: right;">{{ routeSummary(['llm', 'chatNodeIndex'], ['llm', 'chatModel']) }}</code>
                    <button @click="currentPage = 'modelRoutes'" class="btn-outline text-xs" style="min-height: 26px; padding: 0 8px;">去路由</button>
                  </div>
                  <div>
                    <label class="label-sm">智能推理等级</label>
                    <select v-model="config.llm.reasoningEffort" class="input-field" :disabled="!config.llm.chatEnabled">
                      <option value="low">低</option>
                      <option value="medium">标准</option>
                      <option value="high">高</option>
                      <option value="xhigh">超高</option>
                    </select>
                  </div>
                  <p style="color: var(--muted-light); font-size: 0.72rem;">群聊 @机器人 / 私聊对话</p>
                </div>

                <!-- Enhance -->
                <div class="setting-row" style="flex-direction: column; align-items: stretch; gap: 12px; border-color: var(--warn-line); background: var(--warn-soft);">
                  <div class="flex items-center justify-between w-full">
                    <span style="font-size: 0.86rem; font-weight: 600; color: var(--text);">🧠 提示词润色</span>
                    <span class="tag" style="background: var(--warn-soft); border-color: var(--warn-line); color: var(--warn);">关键词触发</span>
                  </div>
                  <div class="setting-row" style="padding: 8px 10px; background: var(--surface);">
                    <span style="color: var(--muted); font-size: 0.72rem;">路由</span>
                    <code style="font-family: var(--font-mono); font-size: 0.72rem; color: var(--text); flex: 1; text-align: right;">{{ routeSummary(['llm', 'enhanceNodeIndex'], ['llm', 'enhanceModel']) }}</code>
                    <button @click="currentPage = 'modelRoutes'" class="btn-outline text-xs" style="min-height: 26px; padding: 0 8px;">去路由</button>
                  </div>
                  <p style="color: var(--muted-light); font-size: 0.72rem;">用户在生图命令后加"润色"才会调用</p>
                </div>

                <!-- Translation -->
                <div class="setting-row" style="flex-direction: column; align-items: stretch; gap: 12px; border-color: #99f6e4; background: #f0fdfa;">
                  <div class="flex items-center justify-between w-full">
                    <span style="font-size: 0.86rem; font-weight: 600; color: var(--text);">🌐 翻译 / 本地化</span>
                    <span class="tag" style="background: #f0fdfa; border-color: #99f6e4; color: #0d9488;">远程库搜索</span>
                  </div>
                  <div class="setting-row" style="padding: 8px 10px; background: var(--surface);">
                    <span style="color: var(--muted); font-size: 0.72rem;">路由</span>
                    <code style="font-family: var(--font-mono); font-size: 0.72rem; color: var(--text); flex: 1; text-align: right;">{{ routeSummary(['llm', 'translationNodeIndex'], ['llm', 'translationModel']) }}</code>
                    <button @click="currentPage = 'modelRoutes'" class="btn-outline text-xs" style="min-height: 26px; padding: 0 8px;">去路由</button>
                  </div>
                  <p style="color: var(--muted-light); font-size: 0.72rem;">中文关键词转英文检索，结果翻译成中文</p>
                </div>

                <!-- Image -->
                <div class="setting-row" style="flex-direction: column; align-items: stretch; gap: 12px;" :style="config.llm.imageEnabled ? 'border-color: #ddd6fe; background: #f5f3ff;' : 'opacity: 0.6;'">
                  <div class="flex items-center justify-between w-full">
                    <span style="font-size: 0.86rem; font-weight: 600; color: var(--text);">🎨 图像生成</span>
                    <label class="toggle"><input type="checkbox" v-model="config.llm.imageEnabled"><span class="toggle-slider"></span></label>
                  </div>
                  <div class="setting-row" style="padding: 8px 10px; background: var(--surface);">
                    <span style="color: var(--muted); font-size: 0.72rem;">路由</span>
                    <code style="font-family: var(--font-mono); font-size: 0.72rem; color: var(--text); flex: 1; text-align: right;">{{ routeSummary(['llm', 'imageNodeIndex'], ['llm', 'imageModel']) }}</code>
                    <button @click="currentPage = 'modelRoutes'" class="btn-outline text-xs" style="min-height: 26px; padding: 0 8px;">去路由</button>
                  </div>
                  <div class="grid grid-cols-2 gap-3">
                    <div>
                      <label class="label-sm">生成张数</label>
                      <input v-model.number="config.llm.imageCount" type="number" min="1" max="4" step="1" class="input-field" :disabled="!config.llm.imageEnabled" />
                    </div>
                    <div>
                      <label class="label-sm">超时（毫秒）</label>
                      <input v-model.number="config.llm.imageTimeoutMs" type="number" min="30000" step="30000" class="input-field" :disabled="!config.llm.imageEnabled" />
                    </div>
                    <div>
                      <label class="label-sm">失败重试</label>
                      <input v-model.number="config.llm.imageRetryCount" type="number" min="0" max="5" step="1" class="input-field" :disabled="!config.llm.imageEnabled" />
                    </div>
                    <div>
                      <label class="label-sm">重试间隔</label>
                      <input v-model.number="config.llm.imageRetryDelayMs" type="number" min="0" step="500" class="input-field" :disabled="!config.llm.imageEnabled" />
                    </div>
                  </div>
                  <label class="setting-row" style="padding: 8px 10px; background: var(--surface);">
                    <span style="font-size: 0.78rem; color: var(--text-soft);">失败后合规改写重试</span>
                    <input type="checkbox" v-model="config.llm.safeRewriteOnFailure" style="accent-color: #8b5cf6;" />
                  </label>
                  <div class="flex gap-2">
                    <input v-model="imageTestPrompt" class="input-field" placeholder="测试提示词" :disabled="imageTestLoading || !config.llm.imageEnabled" />
                    <button @click="testImageApi" :disabled="imageTestLoading || !config.llm.imageEnabled" class="btn-outline text-xs whitespace-nowrap">
                      {{ imageTestLoading ? '测试中...' : '测试生图' }}
                    </button>
                  </div>
                  <div v-if="imageTestResult" class="setting-row" style="padding: 10px 12px; flex-direction: column; align-items: flex-start; gap: 6px;" :style="imageTestResult.success ? 'border-color: var(--success-line); background: var(--success-soft);' : 'border-color: var(--danger-line); background: var(--danger-soft);'">
                    <span style="font-size: 0.82rem; font-weight: 600;" :style="{ color: imageTestResult.success ? 'var(--success)' : 'var(--danger)' }">{{ imageTestResult.success ? '生图接口正常' : '生图接口异常' }}</span>
                    <span style="font-size: 0.76rem; color: var(--text-soft); word-break: break-word; width: 100%;">{{ imageTestResult.message }}</span>
                    <div style="display: flex; flex-wrap: wrap; gap: 12px; font-size: 0.7rem; color: var(--muted);">
                      <span v-if="imageTestResult.durationMs !== undefined">耗时：{{ imageTestResult.durationMs }}ms</span>
                      <span v-if="imageTestResult.base64Chars">编码：{{ imageTestResult.base64Chars }} 字符</span>
                    </div>
                  </div>
                </div>

                <!-- Edit -->
                <div class="setting-row" style="flex-direction: column; align-items: stretch; gap: 12px; border-color: #a5f3fc; background: #ecfeff;">
                  <div class="flex items-center justify-between w-full">
                    <span style="font-size: 0.86rem; font-weight: 600; color: var(--text);">🖼️ 图生图 / 改图</span>
                  </div>
                  <div class="setting-row" style="padding: 8px 10px; background: var(--surface);">
                    <span style="color: var(--muted); font-size: 0.72rem;">路由</span>
                    <code style="font-family: var(--font-mono); font-size: 0.72rem; color: var(--text); flex: 1; text-align: right;">{{ routeSummary(['llm', 'editNodeIndex'], ['llm', 'editModel']) }}</code>
                    <button @click="currentPage = 'modelRoutes'" class="btn-outline text-xs" style="min-height: 26px; padding: 0 8px;">去路由</button>
                  </div>
                  <p style="color: var(--muted-light); font-size: 0.72rem;">回复图片后使用图生图/改图命令</p>
                </div>

                <!-- Interrogate -->
                <div class="setting-row" style="flex-direction: column; align-items: stretch; gap: 12px; border-color: var(--danger-line); background: var(--danger-soft);">
                  <div class="flex items-center justify-between w-full">
                    <span style="font-size: 0.86rem; font-weight: 600; color: var(--text);">🔍 机器人图片反推</span>
                  </div>
                  <div class="setting-row" style="padding: 8px 10px; background: var(--surface);">
                    <span style="color: var(--muted); font-size: 0.72rem;">路由</span>
                    <code style="font-family: var(--font-mono); font-size: 0.72rem; color: var(--text); flex: 1; text-align: right;">{{ routeSummary(['llm', 'interrogateNodeIndex'], ['llm', 'interrogateModel']) }}</code>
                    <button @click="currentPage = 'modelRoutes'" class="btn-outline text-xs" style="min-height: 26px; padding: 0 8px;">去路由</button>
                  </div>
                  <div>
                    <label class="label-sm">反推超时（毫秒）</label>
                    <input v-model.number="config.llm.interrogateTimeoutMs" type="number" min="30000" step="30000" class="input-field" />
                  </div>
                  <p style="color: var(--muted-light); font-size: 0.72rem;">仅用于机器人回复图片后的反推命令</p>
                </div>

              </div>
            </div>

            <!-- 模型请求限制 -->
            <div class="card p-5">
              <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between mb-4">
                <h3 class="section-title">模型请求限制</h3>
                <span style="color: var(--muted-light); font-size: 0.72rem;">并发数 0 = 不限制；1 = 顺序排队</span>
              </div>
              <div v-if="modelLimitRows().length" class="space-y-2 max-h-80 overflow-y-auto">
                <div v-for="item in modelLimitRows()" :key="`${item.idx}-${item.model}`" class="setting-row" style="padding: 10px 12px;">
                  <div style="min-width: 0; flex: 1;">
                    <div style="color: var(--muted-light); font-size: 0.7rem;">{{ item.node.name || `节点 ${item.idx + 1}` }}</div>
                    <div style="color: var(--text); font-size: 0.82rem; font-weight: 600; word-break: break-all;">{{ item.model }}</div>
                  </div>
                  <label class="flex items-center gap-2 text-sm" style="color: var(--text-soft); flex: 0 0 auto;">
                    <input type="checkbox" style="accent-color: #0ea5e9;"
                      :checked="modelLimitEnabled(item.idx, item.model)"
                      @change="setModelLimitEnabled(item.idx, item.model, ($event.target as HTMLInputElement).checked)" />
                    启用
                  </label>
                  <div style="flex: 0 0 110px;">
                    <label class="label-sm">并发数</label>
                    <input type="number" min="0" step="1" class="input-field"
                      :value="modelLimitConcurrency(item.idx, item.model)"
                      @input="setModelLimitConcurrency(item.idx, item.model, Number(($event.target as HTMLInputElement).value))" />
                  </div>
                </div>
              </div>
              <p v-else style="color: var(--muted); font-size: 0.84rem;">还没有已保存模型。先在接口节点里点击"获取模型"，这里会自动列出可限制的模型。</p>
            </div>

            <!-- 提示词模板 -->
            <div class="card p-5">
              <div class="flex items-center justify-between mb-4">
                <h3 class="section-title">提示词模板</h3>
                <div class="flex flex-wrap gap-2">
                  <button @click="resetEnhancePrompt" class="btn-outline text-xs">默认润色</button>
                  <button @click="resetInterrogatePrompt" class="btn-outline text-xs">默认反推</button>
                  <button @click="resetSafeRewritePrompt" class="btn-outline text-xs">默认合规</button>
                  <button @click="resetTranslationPrompt" class="btn-outline text-xs">默认翻译</button>
                </div>
              </div>
              <div class="group-grid group-grid--2">
                <div>
                  <label class="label-sm">润色模板</label>
                  <textarea v-model="config.llm.enhancePromptTemplate" rows="10" class="input-field font-mono text-xs" />
                  <p style="color: var(--muted-light); font-size: 0.72rem; margin-top: 6px;">可使用 <code v-pre style="font-family: var(--font-mono); color: var(--primary);">{{rawPrompt}}</code> 占位用户原始提示词</p>
                </div>
                <div>
                  <label class="label-sm">机器人图片反推模板</label>
                  <textarea v-model="config.llm.interrogatePromptTemplate" rows="10" class="input-field font-mono text-xs" />
                  <p style="color: var(--muted-light); font-size: 0.72rem; margin-top: 6px;">只影响机器人图片反推命令，不影响前台反推库</p>
                </div>
                <div>
                  <label class="label-sm">合规改写模板</label>
                  <textarea v-model="config.llm.safeRewritePromptTemplate" rows="10" class="input-field font-mono text-xs" />
                  <p style="color: var(--muted-light); font-size: 0.72rem; margin-top: 6px;">生图失败后用于保留意图、移除风险内容</p>
                </div>
                <div>
                  <label class="label-sm">远程库翻译模板</label>
                  <textarea v-model="config.llm.translationPromptTemplate" rows="10" class="input-field font-mono text-xs" />
                  <p style="color: var(--muted-light); font-size: 0.72rem; margin-top: 6px;">占位符：<code v-pre style="font-family: var(--font-mono); color: var(--primary);">{{mode}}</code>、<code v-pre style="font-family: var(--font-mono); color: var(--primary);">{{input}}</code></p>
                </div>
              </div>
            </div>

            <!-- 会话策略 -->
            <div class="card p-5">
              <h3 class="section-title mb-4">会话策略</h3>
              <div class="group-grid" style="grid-template-columns: repeat(auto-fit, minmax(min(220px, 100%), 1fr));">
                <div class="setting-row" style="flex-direction: column; align-items: stretch; gap: 10px; border-color: #bae6fd; background: #f0f9ff;">
                  <div class="flex items-center justify-between w-full">
                    <span style="font-size: 0.86rem; font-weight: 600; color: var(--text);">自动新会话</span>
                    <label class="toggle"><input type="checkbox" v-model="config.llm.autoNewConversation"><span class="toggle-slider"></span></label>
                  </div>
                  <p style="color: var(--muted-light); font-size: 0.72rem;">达到阈值后丢弃旧上下文，从下一句开始全新对话</p>
                </div>
                <div>
                  <label class="label-sm">最大轮数</label>
                  <input v-model.number="config.llm.maxConversationRounds" type="number" min="1" max="100" class="input-field" :disabled="!config.llm.autoNewConversation" />
                  <p style="color: var(--muted-light); font-size: 0.72rem; margin-top: 6px;">按用户发言轮数计数，建议 6-12</p>
                </div>
                <div>
                  <label class="label-sm">最大字符数</label>
                  <input v-model.number="config.llm.maxConversationChars" type="number" min="100" step="100" class="input-field" :disabled="!config.llm.autoNewConversation" />
                  <p style="color: var(--muted-light); font-size: 0.72rem; margin-top: 6px;">总上下文字符达到阈值也会自动开新会话</p>
                </div>
              </div>
            </div>

            <!-- 已探测模型 -->
            <div v-if="fetchedModels.length" class="card p-5">
              <h3 class="section-title mb-3">已探测模型 ({{ fetchedModels.length }})</h3>
              <div class="flex flex-wrap gap-1.5 max-h-36 overflow-y-auto">
                <span v-for="m in fetchedModels" :key="m" class="tag">{{ m }}</span>
              </div>
            </div>

          </div>
</template>
