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
              <h1 class="page-head__title">画布配置</h1>
              <p class="page-head__desc">画布前台使用独立配置与独立日志；仅复用模型接口节点列表，不与机器人生图配置混用。</p>
              <div class="page-head__actions">
                <a href="/" target="_blank" class="btn-outline text-sm">打开前台</a>
                <a href="/canvas" target="_blank" class="btn-outline text-sm">打开画布</a>
              </div>
            </header>

            <div class="card p-5" style="border-color: var(--primary-line); background: var(--primary-soft);">
              <h3 class="section-title mb-3">前台品牌显示</h3>
              <p style="color: var(--muted); font-size: 0.78rem; margin-bottom: 14px;">控制画布页左上角 Logo 文案、浏览器标签标题和 Favicon / ICO。保存配置后刷新画布生效。</p>
              <div class="group-grid group-grid--2">
                <div>
                  <label class="label-sm">Logo 字</label>
                  <input v-model="config.canvas.brand.logoText" class="input-field font-mono" placeholder="Mio" />
                </div>
                <div>
                  <label class="label-sm">浏览器标签</label>
                  <input v-model="config.canvas.brand.pageTitle" class="input-field" placeholder="Mio 图像画布" />
                </div>
                <div style="grid-column: 1 / -1;">
                  <label class="label-sm">ICO / Favicon URL</label>
                  <input v-model="config.canvas.brand.faviconUrl" class="input-field font-mono" placeholder="/canvas/favicon.ico 或 https://.../favicon.ico" />
                  <p style="color: var(--muted-light); font-size: 0.72rem; margin-top: 6px;">支持站内路径、HTTPS 图片地址或 data:image/...；留空回退到默认图标</p>
                </div>
              </div>
            </div>

            <div class="card p-5">
              <div class="flex items-center justify-between mb-4">
                <h3 class="section-title">画布接口与默认参数</h3>
                <label class="setting-row" style="padding: 6px 12px; min-height: 34px;">
                  <input type="checkbox" v-model="config.canvas.enabled" style="accent-color: var(--primary);" />
                  <span style="font-size: 0.78rem; font-weight: 600; color: var(--text-soft);">启用画布前台</span>
                </label>
              </div>

              <div class="group-grid group-grid--3">
                <div style="grid-column: 1 / -1;">
                  <label class="label-sm">文生图模型路由</label>
                  <div class="setting-row" style="padding: 8px 12px;">
                    <span style="color: var(--muted); font-size: 0.74rem;">当前</span>
                    <code style="font-family: var(--font-mono); font-size: 0.76rem; color: var(--text); flex: 1; text-align: right;">{{ routeSummary(['canvas', 'imageNodeIndex'], ['canvas', 'imageModel']) }}</code>
                    <button @click="currentPage = 'modelRoutes'" class="btn-outline text-xs" style="min-height: 26px; padding: 0 8px;">去路由</button>
                  </div>
                </div>
                <div>
                  <label class="label-sm">请求超时（毫秒）</label>
                  <input v-model.number="config.canvas.imageTimeoutMs" type="number" min="30000" step="30000" class="input-field font-mono" />
                </div>
                <div style="grid-column: 1 / -1;">
                  <label class="label-sm">图生图 / 改图模型路由</label>
                  <div class="setting-row" style="padding: 8px 12px;">
                    <span style="color: var(--muted); font-size: 0.74rem;">当前</span>
                    <code style="font-family: var(--font-mono); font-size: 0.76rem; color: var(--text); flex: 1; text-align: right;">{{ routeSummary(['canvas', 'editNodeIndex'], ['canvas', 'editModel']) }}</code>
                    <button @click="currentPage = 'modelRoutes'" class="btn-outline text-xs" style="min-height: 26px; padding: 0 8px;">去路由</button>
                  </div>
                </div>
                <div>
                  <label class="label-sm">图生图请求格式</label>
                  <select v-model="config.canvas.imageEditRequestMode" class="input-field font-mono">
                    <option value="auto">自动探测</option>
                    <option value="json-images">结构化多图</option>
                    <option value="json-image">结构化单图</option>
                    <option value="multipart">表单上传</option>
                  </select>
                </div>
                <div class="grid grid-cols-2 gap-2">
                  <div>
                    <label class="label-sm">重试次数</label>
                    <input v-model.number="config.canvas.imageRetryCount" type="number" min="0" max="5" step="1" class="input-field font-mono" />
                  </div>
                  <div>
                    <label class="label-sm">重试间隔</label>
                    <input v-model.number="config.canvas.imageRetryDelayMs" type="number" min="0" step="500" class="input-field font-mono" />
                  </div>
                </div>
                <div>
                  <label class="label-sm">默认质量</label>
                  <select v-model="config.canvas.defaultQuality" class="input-field font-mono">
                    <option value="auto">自动</option>
                    <option value="low">低</option>
                    <option value="medium">标准</option>
                    <option value="high">高</option>
                  </select>
                </div>
                <div>
                  <label class="label-sm">默认输出格式</label>
                  <select v-model="config.canvas.defaultOutputFormat" class="input-field font-mono">
                    <option value="png">PNG</option>
                    <option value="jpeg">JPEG</option>
                    <option value="webp">WebP</option>
                  </select>
                </div>
                <div>
                  <label class="label-sm">默认数量</label>
                  <select v-model.number="config.canvas.defaultCount" class="input-field font-mono">
                    <option :value="1">1 张</option>
                    <option :value="2">2 张</option>
                    <option :value="4">4 张</option>
                    <option :value="8">8 张</option>
                    <option :value="16">16 张</option>
                  </select>
                </div>
                <div>
                  <label class="label-sm">默认尺寸</label>
                  <select v-model="config.canvas.defaultSizePresetId" class="input-field font-mono">
                    <option value="auto">自动（模型决定）</option>
                    <option value="square-1k">1:1 方图 1024×1024</option>
                    <option value="poster-portrait">2:3 竖版海报 1024×1536</option>
                    <option value="portrait-2k">3:4 竖图 1152×1536</option>
                    <option value="wide-4k">4:5 社交竖图 1024×1280</option>
                    <option value="story-9-16">9:16 竖屏故事 1152×2048</option>
                    <option value="video-16-9">16:9 视频封面 2048×1152</option>
                    <option value="poster-landscape">3:2 横版海报 1536×1024</option>
                    <option value="square-2k">4:3 横图 1536×1152</option>
                    <option value="landscape-5-4">5:4 横图 1280×1024</option>
                    <option value="wide-2k">21:9 超宽屏 2688×1152</option>
                  </select>
                </div>
                <div>
                  <label class="label-sm">默认风格</label>
                  <select v-model="config.canvas.defaultStylePresetId" class="input-field font-mono">
                    <option value="none">无风格</option>
                    <option value="photoreal">真实摄影</option>
                    <option value="product">产品</option>
                    <option value="illustration">插画</option>
                    <option value="poster">海报</option>
                    <option value="avatar">头像</option>
                  </select>
                </div>
                <div>
                  <label class="label-sm">历史记录上限</label>
                  <input v-model.number="config.canvas.maxHistory" type="number" min="1" max="500" step="1" class="input-field font-mono" />
                </div>
                <div style="grid-column: 1 / -1;">
                  <label class="label-sm">数据存储目录</label>
                  <input v-model="config.canvas.dataDir" class="input-field font-mono" placeholder="默认：画布数据目录" />
                </div>
              </div>
            </div>

            <div class="card p-5">
              <div class="flex items-center justify-between mb-4">
                <h3 class="section-title">画布多模态反推参数</h3>
                <div class="flex gap-2">
                  <button @click="resetCanvasInterrogatePrompt" class="btn-outline text-xs">默认原图反推</button>
                  <button @click="resetCanvasInterrogateTemplatePrompt" class="btn-outline text-xs">默认模板化反推</button>
                </div>
              </div>
              <p style="color: var(--muted); font-size: 0.78rem; margin-bottom: 14px;">专门供画布前端上传图片后分析并反推提取出提示词的规则设定</p>

              <div class="group-grid group-grid--2">
                <div class="setting-row" style="flex-direction: column; align-items: stretch; gap: 12px; border-color: var(--warn-line); background: var(--warn-soft);">
                  <span style="font-size: 0.86rem; font-weight: 700; color: var(--text);">① 原图反推分析（第一阶段）</span>
                  <div class="setting-row" style="padding: 8px 12px; background: var(--surface);">
                    <span style="color: var(--muted); font-size: 0.74rem;">路由</span>
                    <code style="font-family: var(--font-mono); font-size: 0.74rem; color: var(--text); flex: 1; text-align: right;">{{ routeSummary(['canvas', 'interrogateNodeIndex'], ['canvas', 'interrogateModel']) }}</code>
                    <button @click="currentPage = 'modelRoutes'" class="btn-outline text-xs" style="min-height: 26px; padding: 0 8px;">去路由</button>
                  </div>
                  <div>
                    <label class="label-sm">接口超时（毫秒）</label>
                    <input v-model.number="config.canvas.interrogateTimeoutMs" type="number" min="30000" step="30000" class="input-field font-mono" />
                  </div>
                  <div>
                    <label class="label-sm">第一阶段视觉分析提示词</label>
                    <textarea v-model="config.canvas.interrogatePromptTemplate" rows="8" class="input-field font-mono text-xs" />
                  </div>
                </div>

                <div class="setting-row" style="flex-direction: column; align-items: stretch; gap: 12px; border-color: var(--success-line); background: var(--success-soft);">
                  <span style="font-size: 0.86rem; font-weight: 700; color: var(--text);">② 模板抽象生成（第二阶段）</span>
                  <div class="setting-row" style="padding: 8px 12px; background: var(--surface);">
                    <span style="color: var(--muted); font-size: 0.74rem;">路由</span>
                    <code style="font-family: var(--font-mono); font-size: 0.74rem; color: var(--text); flex: 1; text-align: right;">{{ routeSummary(['canvas', 'interrogateTemplateNodeIndex'], ['canvas', 'interrogateTemplateModel']) }}</code>
                    <button @click="currentPage = 'modelRoutes'" class="btn-outline text-xs" style="min-height: 26px; padding: 0 8px;">去路由</button>
                  </div>
                  <div>
                    <label class="label-sm">接口超时（毫秒）</label>
                    <input v-model.number="config.canvas.interrogateTemplateTimeoutMs" type="number" min="30000" step="30000" class="input-field font-mono" />
                  </div>
                  <div>
                    <label class="label-sm">第二阶段变量提取提示词</label>
                    <textarea v-model="config.canvas.interrogateTemplatePromptTemplate" rows="8" class="input-field font-mono text-xs" />
                    <p style="color: var(--muted-light); font-size: 0.7rem; margin-top: 6px; font-family: var(--font-mono);">占位符：<code v-pre style="color: var(--primary);">{{rawPrompt}}</code> 代表上一步原图分析得出的描述</p>
                  </div>
                </div>
              </div>
            </div>

            <div class="card p-5">
              <div class="flex items-center justify-between mb-4">
                <h3 class="section-title">画布卡片管理</h3>
                <button @click="fetchCanvasCards()" :disabled="canvasCardsLoading" class="btn-outline text-sm">
                  {{ canvasCardsLoading ? '刷新中...' : '刷新卡片' }}
                </button>
              </div>
              <p style="color: var(--muted); font-size: 0.78rem; margin-bottom: 14px;">管理画廊与模板库卡片，左侧使用压缩缩略图方便快速预览。</p>

              <div v-if="canvasCardsError" class="setting-row" style="padding: 10px 14px; border-color: var(--danger-line); background: var(--danger-soft); color: var(--danger); font-size: 0.8rem; margin-bottom: 14px;">
                {{ canvasCardsError }}
              </div>

              <div v-if="canvasCardsLoading && !canvasCards.length" class="setting-row" style="padding: 24px; justify-content: center; color: var(--muted); font-size: 0.84rem;">
                正在读取卡片列表...
              </div>
              <div v-else-if="!canvasCards.length" class="setting-row" style="padding: 24px; justify-content: center; color: var(--muted); font-size: 0.84rem;">
                暂无可管理卡片。生成图片或完成模板反推后会显示在这里。
              </div>
              <div v-else class="group-grid group-grid--2">
                <div v-for="card in canvasCards" :key="card.kind + ':' + card.id" class="setting-row" style="padding: 12px; gap: 12px; align-items: flex-start;">
                  <div style="width: 88px; height: 88px; flex: 0 0 88px; overflow: hidden; border-radius: 11px; border: 1px solid var(--line); background: var(--surface-soft);">
                    <img v-if="canvasCardPreviewUrl(card)" :src="canvasCardPreviewUrl(card)" :alt="card.title" style="width: 100%; height: 100%; object-fit: cover;" loading="lazy" />
                    <div v-else style="width: 100%; height: 100%; display: grid; place-items: center; font-size: 0.64rem; color: var(--muted-light);">无预览</div>
                  </div>
                  <div style="min-width: 0; flex: 1;">
                    <div class="flex items-center gap-2 mb-1">
                      <span class="tag" style="background: #ecfeff; border-color: #a5f3fc; color: #0ea5e9;">{{ canvasCardKindText(card.kind) }}</span>
                      <span v-if="card.favorite" class="tag" style="background: var(--warn-soft); border-color: var(--warn-line); color: var(--warn);">已收藏</span>
                    </div>
                    <div style="font-size: 0.84rem; font-weight: 600; color: var(--text); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;">{{ card.title || '未命名卡片' }}</div>
                    <div style="margin-top: 4px; font-size: 0.72rem; color: var(--muted);">{{ card.subtitle }}</div>
                    <div style="margin-top: 2px; font-size: 0.68rem; color: var(--muted-light); font-family: var(--font-mono);">{{ card.createdAt }}</div>
                    <div class="flex flex-wrap gap-2" style="margin-top: 10px;">
                      <a v-if="card.asset?.id" class="btn-outline text-xs" style="min-height: 26px; padding: 0 8px;" :href="canvasCardDownloadUrl(card)" target="_blank" rel="noreferrer">预览原图</a>
                      <button @click="deleteCanvasCard(card)" class="btn-danger text-xs" style="min-height: 26px; padding: 0 8px;">删除</button>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div class="card p-5 canvas-log-card log-panel-card log-panel-card--canvas">
              <div class="log-panel-head">
                <div class="log-panel-title">
                  <span class="log-panel-icon">画</span>
                  <div>
                    <h3>独立画布日志管理器</h3>
                    <p v-if="canvasLogStats">
                      <span>内存 <code>{{ canvasLogStats.memoryTotal ?? canvasLogStats.total }}/{{ canvasLogStats.maxMemoryEntries }}</code></span>
                      <span>总数 <code>{{ canvasLogStats.total }}</code></span>
                      <span class="log-file-path">文件 <code>{{ canvasLogStats.logFile }}</code></span>
                    </p>
                    <p v-else>记录画布接口通信、生图渲染、反推调用与图库同步状态。</p>
                  </div>
                </div>

                <div class="log-controls canvas-log-controls">
                  <div>
                    <label class="label-sm">级别</label>
                    <select v-model="canvasLogLevel" @change="fetchCanvasLogs()" class="input-field font-mono">
                      <option value="all">全部</option>
                      <option value="debug">调试</option>
                      <option value="info">信息</option>
                      <option value="warn">警告</option>
                      <option value="error">错误</option>
                    </select>
                  </div>
                  <div class="log-limit-field">
                    <label class="label-sm">显示条数</label>
                    <input v-model.number="canvasLogLimit" @change="applyCanvasLogLimit" @keyup.enter="applyCanvasLogLimit" type="number" min="1" max="5000" step="50" class="input-field font-mono" placeholder="300" />
                    <span class="log-limit-hint">1-5000</span>
                  </div>
                  <div class="log-search-field">
                    <label class="label-sm">搜索关键字</label>
                    <input v-model="canvasLogSearch" @keyup.enter="fetchCanvasLogs()" class="input-field" placeholder="范围或错误信息..." />
                  </div>
                  <button @click="fetchCanvasLogs()" :disabled="canvasLogLoading" class="btn-outline log-touch-button">{{ canvasLogLoading ? '读取中' : '刷新' }}</button>
                  <button @click="copyCanvasVisibleLogs" :disabled="!canvasLogEntries.length" class="btn-outline log-touch-button log-touch-button--copy">复制当前</button>
                  <button @click="clearCanvasLogs" :disabled="canvasLogLoading" class="btn-danger log-touch-button">清空</button>
                </div>
              </div>

              <div class="log-settings-grid">
                <label class="log-toggle-card">
                  <span>
                    <strong>画布日志记录</strong>
                    <em>{{ config.canvas.logs.enabled ? '正在写入' : '已暂停' }}</em>
                  </span>
                  <input type="checkbox" v-model="config.canvas.logs.enabled" class="rounded accent-indigo-500 h-4.5 w-4.5" />
                </label>
                <div>
                  <label class="label-sm">最低写入级别</label>
                  <select v-model="config.canvas.logs.level" class="input-field">
                    <option value="debug">调试</option>
                    <option value="info">信息</option>
                    <option value="warn">警告</option>
                    <option value="error">错误</option>
                  </select>
                </div>
                <div>
                  <label class="label-sm">内存保留上限</label>
                  <input v-model.number="config.canvas.logs.maxMemoryEntries" type="number" min="100" max="5000" step="100" class="input-field font-mono" />
                </div>
              </div>

              <div class="log-terminal log-terminal--compact">
                <div class="log-terminal__bar">
                  <div>
                    <span class="log-terminal__title">画布日志输出</span>
                    <small>{{ canvasLogEntries.length }} 条符合过滤条件</small>
                  </div>
                  <button @click="copyCanvasVisibleLogs" :disabled="!canvasLogEntries.length" class="log-copy-button log-copy-button--bar">复制全部</button>
                </div>

                <div v-if="canvasLogLoading && !canvasLogEntries.length" class="log-empty-state animate-pulse">
                  正在读取日志缓冲区...
                </div>
                <div v-else-if="!canvasLogEntries.length" class="log-empty-state">
                  当前没有画布日志记录。
                </div>
                <div v-else class="log-terminal__list log-terminal__list--compact">
                  <article v-for="entry in canvasLogEntries" :key="entry.id" class="log-entry log-entry--compact">
                    <header class="log-entry__meta">
                      <span :class="['log-level-badge', levelBadgeClass(entry.level)]">{{ logLevelText(entry.level) }}</span>
                      <time>{{ entry.timestamp }}</time>
                      <span class="log-entry__scope">{{ entry.scope }}</span>
                      <span class="log-entry__id">#{{ entry.id }}</span>
                      <button @click="copyLogEntry(entry)" class="log-copy-button">复制本条</button>
                    </header>
                    <p class="log-entry__message selectable-log-text">{{ entry.message }}</p>
                    <pre v-if="formatLogDetails(entry.details || entry.data)" class="log-entry__details selectable-log-text">{{ formatLogDetails(entry.details || entry.data) }}</pre>
                  </article>
                </div>
              </div>
            </div>

          </div>
</template>
