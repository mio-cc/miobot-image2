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
              <h1 class="page-head__title">提示词模板</h1>
              <p class="page-head__desc">本地模板分工、引用模板分工、远程提示词库、智能提示词转模板、本地模板库管理。用户可用 <code style="font-family: var(--font-mono); color: var(--primary);">mb_1！</code> 套用模板。</p>
            </header>

            <div class="card p-5">
              <div class="flex items-center justify-between mb-4">
                <h3 class="section-title">本地模板分工</h3>
                <button @click="resetTemplatePrompt" class="btn-outline text-xs">默认填充提示词</button>
              </div>
              <p style="color: var(--muted); font-size: 0.78rem; margin-bottom: 14px;">用户使用 mb_1！ 这类模板编号时，会先让这里配置的模型把用户提示词填进模板，再提交给生图/改图模型；模型填充失败时会自动降级为直接套模板。</p>
              <div class="group-grid" style="grid-template-columns: repeat(auto-fit, minmax(min(240px, 100%), 1fr));">
                <div>
                  <label class="label-sm">模板填充路由</label>
                  <div class="setting-row" style="padding: 8px 12px; flex-direction: column; align-items: flex-start; gap: 6px;">
                    <code style="font-family: var(--font-mono); font-size: 0.76rem; color: var(--text);">{{ routeSummary(['llm', 'templateNodeIndex'], ['llm', 'templateModel']) }}</code>
                    <button @click="currentPage = 'modelRoutes'" class="btn-outline text-xs" style="min-height: 28px; padding: 0 8px;">去路由</button>
                  </div>
                  <p style="color: var(--muted-light); font-size: 0.72rem; margin-top: 6px;">填空值时不调用模型，直接替换 <code v-pre style="font-family: var(--font-mono); color: var(--primary);">{{prompt}}</code></p>
                </div>
                <div>
                  <label class="label-sm">模板填充提示词</label>
                  <textarea v-model="config.llm.templatePromptTemplate" rows="9" class="input-field font-mono text-xs" />
                  <p style="color: var(--muted-light); font-size: 0.72rem; margin-top: 6px;">占位符：<code v-pre style="font-family: var(--font-mono); color: var(--primary);">{{templateTitle}}</code>、<code v-pre style="font-family: var(--font-mono); color: var(--primary);">{{templatePrompt}}</code>、<code v-pre style="font-family: var(--font-mono); color: var(--primary);">{{rawPrompt}}</code></p>
                </div>
              </div>
            </div>

            <div class="card p-5">
              <div class="flex items-center justify-between mb-4">
                <h3 class="section-title">引用模板分工</h3>
                <button @click="resetReferencedTemplatePrompt" class="btn-outline text-xs">默认提示词</button>
              </div>
              <p style="color: var(--muted); font-size: 0.78rem; margin-bottom: 14px;">引用模板生图会单独使用这里的节点、模型和填充提示词，不再复用本地模板填充配置。</p>
              <div class="group-grid" style="grid-template-columns: repeat(auto-fit, minmax(min(240px, 100%), 1fr));">
                <div>
                  <label class="label-sm">引用模板填充路由</label>
                  <div class="setting-row" style="padding: 8px 12px; flex-direction: column; align-items: flex-start; gap: 6px;">
                    <code style="font-family: var(--font-mono); font-size: 0.76rem; color: var(--text);">{{ routeSummary(['llm', 'referencedTemplateNodeIndex'], ['llm', 'referencedTemplateModel']) }}</code>
                    <button @click="currentPage = 'modelRoutes'" class="btn-outline text-xs" style="min-height: 28px; padding: 0 8px;">去路由</button>
                  </div>
                  <div style="margin-top: 12px;">
                    <label class="label-sm">超时（毫秒）</label>
                    <input v-model.number="config.llm.referencedTemplateTimeoutMs" type="number" min="30000" step="30000" class="input-field" />
                  </div>
                  <p style="color: var(--muted-light); font-size: 0.72rem; margin-top: 6px;">填空值时引用模板生图会提示未配置填充模型</p>
                </div>
                <div>
                  <label class="label-sm">引用模板填充提示词</label>
                  <textarea v-model="config.llm.referencedTemplatePromptTemplate" rows="9" class="input-field font-mono text-xs" />
                  <p style="color: var(--muted-light); font-size: 0.72rem; margin-top: 6px;">占位符：<code v-pre style="font-family: var(--font-mono); color: var(--primary);">{{templateTitle}}</code>、<code v-pre style="font-family: var(--font-mono); color: var(--primary);">{{templatePrompt}}</code>、<code v-pre style="font-family: var(--font-mono); color: var(--primary);">{{rawPrompt}}</code></p>
                </div>
              </div>
            </div>

            <div class="card p-5">
              <div class="flex items-center justify-between mb-4">
                <h3 class="section-title">远程提示词库</h3>
                <label class="setting-row" style="padding: 6px 12px; min-height: 34px;">
                  <input type="checkbox" v-model="config.promptsChat.enabled" style="accent-color: var(--primary);" />
                  <span style="font-size: 0.78rem; font-weight: 600; color: var(--text-soft);">启用远程库</span>
                </label>
              </div>
              <p style="color: var(--muted); font-size: 0.78rem; margin-bottom: 14px;">远程搜索负责中文友好的模板检索，智能检索会先从远程库取少量候选，再用配置的模型选择并融合模板。</p>
              <div class="group-grid group-grid--3">
                <div>
                  <label class="label-sm">接入地址</label>
                  <input v-model="config.promptsChat.endpoint" class="input-field" placeholder="远程 MCP 地址（可留空）" />
                </div>
                <div>
                  <label class="label-sm">接口密钥</label>
                  <input v-model="config.promptsChat.apiKey" type="password" class="input-field" placeholder="可留空" />
                </div>
                <div>
                  <label class="label-sm">智能匹配路由</label>
                  <div class="setting-row" style="padding: 8px 12px;">
                    <code style="font-family: var(--font-mono); font-size: 0.74rem; color: var(--text); flex: 1; overflow-wrap: anywhere;">{{ routeSummary(['promptsChat', 'smartNodeIndex'], ['promptsChat', 'smartModel']) }}</code>
                    <button @click="currentPage = 'modelRoutes'" class="btn-outline text-xs" style="min-height: 26px; padding: 0 8px;">去路由</button>
                  </div>
                </div>
                <div>
                  <label class="label-sm">搜索类型</label>
                  <select v-model="config.promptsChat.searchType" class="input-field">
                    <option value="">全部</option>
                    <option value="IMAGE">图像</option>
                    <option value="TEXT">文本</option>
                    <option value="STRUCTURED">结构化</option>
                    <option value="VIDEO">视频</option>
                    <option value="AUDIO">音频</option>
                  </select>
                </div>
                <div>
                  <label class="label-sm">搜索拉取上限</label>
                  <input v-model.number="config.promptsChat.searchLimit" type="number" min="1" max="50" class="input-field" />
                </div>
                <div>
                  <label class="label-sm">QQ 展示条数</label>
                  <input v-model.number="config.promptsChat.displayLimit" type="number" min="1" max="10" class="input-field" />
                </div>
                <label class="setting-row" style="padding: 8px 12px;">
                  <span style="font-size: 0.78rem; color: var(--text-soft);">中文转英文搜索</span>
                  <input type="checkbox" v-model="config.promptsChat.translateSearchQuery" style="accent-color: var(--primary);" />
                </label>
                <label class="setting-row" style="padding: 8px 12px;">
                  <span style="font-size: 0.78rem; color: var(--text-soft);">结果说明翻译中文</span>
                  <input type="checkbox" v-model="config.promptsChat.translateResults" style="accent-color: var(--primary);" />
                </label>
                <div>
                  <label class="label-sm">智能搜索上限</label>
                  <input v-model.number="config.promptsChat.smartSearchLimit" type="number" min="3" max="50" class="input-field" />
                </div>
                <div>
                  <label class="label-sm">候选模板数</label>
                  <input v-model.number="config.promptsChat.smartCandidateLimit" type="number" min="1" max="10" class="input-field" />
                </div>
              </div>
              <div class="group-grid group-grid--2" style="margin-top: 14px;">
                <div>
                  <div class="flex items-center justify-between mb-1">
                    <label class="label-sm">搜索词生成提示词</label>
                    <button @click="resetPromptsChatSearchPrompt" class="text-xs" style="color: var(--primary);">恢复默认</button>
                  </div>
                  <textarea v-model="config.promptsChat.searchQueryPromptTemplate" rows="8" class="input-field font-mono text-xs" />
                  <p style="color: var(--muted-light); font-size: 0.72rem; margin-top: 6px;">占位符：<code v-pre style="font-family: var(--font-mono); color: var(--primary);">{{rawPrompt}}</code></p>
                </div>
                <div>
                  <div class="flex items-center justify-between mb-1">
                    <label class="label-sm">智能选择融合提示词</label>
                    <button @click="resetPromptsChatSmartPrompt" class="text-xs" style="color: var(--primary);">恢复默认</button>
                  </div>
                  <textarea v-model="config.promptsChat.smartPromptTemplate" rows="8" class="input-field font-mono text-xs" />
                  <p style="color: var(--muted-light); font-size: 0.72rem; margin-top: 6px;">占位符：<code v-pre style="font-family: var(--font-mono); color: var(--primary);">{{rawPrompt}}</code>、<code v-pre style="font-family: var(--font-mono); color: var(--primary);">{{candidates}}</code></p>
                </div>
              </div>
            </div>

            <div class="card p-5">
              <div class="flex items-center justify-between mb-4">
                <h3 class="section-title">智能提示词转模板</h3>
                <button @click="convertPromptToTemplate" :disabled="templateConvertLoading" class="btn-primary text-sm">
                  {{ templateConvertLoading ? '转化中...' : '转化并存入' }}
                </button>
              </div>
              <p style="color: var(--muted); font-size: 0.78rem; margin-bottom: 14px;">把现成提示词粘贴进来，智能模型会抽象成可复用模板并自动存入下方模板库。</p>
              <div class="setting-row" style="padding: 8px 12px; margin-bottom: 12px;">
                <span style="color: var(--muted); font-size: 0.74rem; font-weight: 600;">转模板路由</span>
                <code style="font-family: var(--font-mono); font-size: 0.74rem; color: var(--text); flex: 1; text-align: right;">{{ routeSummary(['llm', 'templateConvertNodeIndex'], ['llm', 'templateConvertModel']) }}</code>
                <button @click="currentPage = 'modelRoutes'" class="btn-outline text-xs" style="min-height: 26px; padding: 0 8px;">去路由</button>
              </div>
              <textarea v-model="templateConvertSource" rows="5" class="input-field font-mono text-xs" style="margin-bottom: 14px;"
                placeholder="粘贴一段完整提示词，智能模型会把一次性的主体、场景、风格等抽象成含 {{prompt}} 的模板。"></textarea>
              <div class="group-grid group-grid--2">
                <div>
                  <div class="flex items-center justify-between mb-1">
                    <label class="label-sm">转化提示词</label>
                    <button @click="resetTemplateConvertPrompt" class="text-xs" style="color: var(--primary);">恢复默认</button>
                  </div>
                  <textarea v-model="config.llm.templateConvertPromptTemplate" rows="8" class="input-field font-mono text-xs" />
                  <p style="color: var(--muted-light); font-size: 0.72rem; margin-top: 6px;">占位符：<code v-pre style="font-family: var(--font-mono); color: var(--primary);">{{rawPrompt}}</code></p>
                </div>
                <div>
                  <div class="flex items-center justify-between mb-1">
                    <label class="label-sm">自动命名提示词</label>
                    <button @click="resetTemplateTitlePrompt" class="text-xs" style="color: var(--primary);">恢复默认</button>
                  </div>
                  <textarea v-model="config.llm.templateTitlePromptTemplate" rows="8" class="input-field font-mono text-xs" />
                  <p style="color: var(--muted-light); font-size: 0.72rem; margin-top: 6px;">占位符：<code v-pre style="font-family: var(--font-mono); color: var(--primary);">{{templatePrompt}}</code></p>
                </div>
              </div>
              <p v-if="templateConvertStatus" style="font-size: 0.78rem; margin-top: 14px;" :style="{ color: templateConvertStatus.includes('失败') || templateConvertStatus.includes('为空') || templateConvertStatus.includes('先粘贴') ? 'var(--danger)' : 'var(--success)' }">
                {{ templateConvertStatus }}
              </p>
            </div>

            <div class="card p-5">
              <div class="flex items-center justify-between mb-4">
                <h3 class="section-title">本地提示词模板库</h3>
                <button @click="addPromptTemplate" class="btn-outline text-sm">＋ 添加模板</button>
              </div>
              <p style="color: var(--muted); font-size: 0.78rem; margin-bottom: 14px;">编号按顺序自动生成 mb_1 / mb_2。用户可用 <code style="font-family: var(--font-mono); color: var(--primary);">mb_1！</code> 套用；尺寸参数用感叹号，例如 <code style="font-family: var(--font-mono); color: var(--primary);">9:16！</code>。</p>

              <div v-if="promptTemplates().length" class="space-y-3 max-h-[640px] overflow-y-auto pr-2">
                <div v-for="(tpl, idx) in promptTemplates()" :key="tpl.id || idx" class="setting-row" style="padding: 14px; flex-direction: column; align-items: stretch; gap: 12px;">
                  <div class="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                    <div class="flex flex-wrap items-center gap-2">
                      <span class="tag" style="background: var(--primary-soft); border-color: var(--primary-line); color: var(--primary);">{{ tpl.id || `mb_${Number(idx) + 1}` }}</span>
                      <input v-model="tpl.title" @blur="normalizePromptTemplateIds" class="input-field md:w-72" placeholder="模板标题" />
                      <button @click="generateTemplateTitle(tpl, Number(idx))" :disabled="templateTitleLoading[templateKey(tpl, Number(idx))]" class="btn-outline text-xs">
                        {{ templateTitleLoading[templateKey(tpl, Number(idx))] ? '命名中...' : '智能命名' }}
                      </button>
                    </div>
                    <div class="flex items-center gap-2">
                      <button @click="toggleTemplateCollapsed(tpl, Number(idx))" class="btn-outline text-xs">
                        {{ isTemplateCollapsed(tpl, Number(idx)) ? '展开' : '折叠' }}
                      </button>
                      <button @click="removePromptTemplate(Number(idx))" class="btn-danger text-xs">删除</button>
                    </div>
                  </div>
                  <textarea v-if="!isTemplateCollapsed(tpl, Number(idx))" v-model="tpl.prompt" @blur="normalizePromptTemplateIds" rows="5" class="input-field font-mono text-xs"
                    placeholder="支持 {{prompt}} 或 {{rawPrompt}} 占位用户描述；不写占位符时会自动把用户描述追加到模板后。"></textarea>
                  <div v-else class="setting-row" style="padding: 8px 12px; background: var(--surface-soft);">
                    <span style="font-size: 0.76rem; color: var(--muted); max-height: 48px; overflow: hidden; white-space: pre-wrap;">{{ tpl.prompt }}</span>
                  </div>
                </div>
              </div>
              <div v-else class="setting-row" style="padding: 24px; justify-content: center; border-style: dashed; color: var(--muted); font-size: 0.86rem;">
                暂无模板，添加后用户就能用 mb_1！ 调用
              </div>
            </div>

          </div>
</template>
