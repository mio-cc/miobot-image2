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
              <h1 class="page-head__title">Hugging Face 接口</h1>
              <p class="page-head__desc">单独管理 Hugging Face Router / Hub 模型。密钥只保存在本地配置，bot 列表中永远排在普通接口后面。命令示例：<code style="font-family: var(--font-mono); color: var(--primary);">@bot /模型</code> 查看编码，<code style="font-family: var(--font-mono); color: var(--primary);">@bot /q hf.1</code> 切换。</p>
              <div class="page-head__actions">
                <label class="setting-row" style="padding: 6px 12px; min-height: 36px;">
                  <input type="checkbox" v-model="config.huggingFace.enabled" style="accent-color: var(--warn);" />
                  <span style="font-size: 0.8rem; font-weight: 600; color: var(--text-soft);">启用 HF 接口</span>
                </label>
                <label class="setting-row" style="padding: 6px 12px; min-height: 36px; border-color: var(--primary-line); background: var(--primary-soft);">
                  <input type="checkbox" v-model="config.huggingFace.useForChat" style="accent-color: var(--primary);" />
                  <span style="font-size: 0.8rem; font-weight: 600; color: var(--primary);">作为 bot 文本模型</span>
                </label>
              </div>
            </header>

            <div class="card p-5">
              <h3 class="section-title mb-4">接口配置</h3>
              <div class="group-grid group-grid--2">
                <div>
                  <label class="label-sm">Hugging Face Token</label>
                  <input v-model="config.huggingFace.token" type="password" class="input-field font-mono" placeholder="hf_...（查询私有/可见模型时填写）" />
                  <p style="color: var(--muted-light); font-size: 0.72rem; margin-top: 4px;">用于查询 token 可见模型与 Router 调用；不会显示在日志里</p>
                </div>
                <div>
                  <label class="label-sm">Router/OpenAI 兼容地址</label>
                  <input v-model="config.huggingFace.baseUrl" class="input-field font-mono" placeholder="https://router.huggingface.co/v1" />
                  <p style="color: var(--muted-light); font-size: 0.72rem; margin-top: 4px;">对话类默认走 OpenAI-compatible chat/completions</p>
                </div>
                <div>
                  <label class="label-sm">Hub 模型列表 API</label>
                  <input v-model="config.huggingFace.hubApiUrl" class="input-field font-mono" placeholder="https://huggingface.co/api/models" />
                  <p style="color: var(--muted-light); font-size: 0.72rem; margin-top: 4px;">查询模型表用，可改为镜像地址</p>
                </div>
                <div>
                  <label class="label-sm">请求模式</label>
                  <select v-model="config.huggingFace.requestMode" class="input-field font-mono">
                    <option value="openai-chat">OpenAI 聊天兼容（默认）</option>
                    <option value="router-chat">HF Router Chat</option>
                    <option value="legacy-inference">旧 Inference API</option>
                    <option value="provider-task">按任务 Provider API</option>
                  </select>
                </div>
                <div>
                  <label class="label-sm">接口超时（毫秒）</label>
                  <input v-model.number="config.huggingFace.timeoutMs" type="number" min="5000" step="5000" class="input-field font-mono" />
                </div>
                <div>
                  <label class="label-sm">缓存有效期（秒）</label>
                  <input v-model.number="config.huggingFace.cacheTtlSeconds" type="number" min="60" step="60" class="input-field font-mono" />
                </div>
                <div>
                  <label class="label-sm">当前选中编码</label>
                  <input v-model="config.huggingFace.selectedModelCode" class="input-field font-mono" placeholder="hf.1" readonly />
                </div>
                <div>
                  <label class="label-sm">当前选中模型</label>
                  <input v-model="config.huggingFace.selectedModelId" class="input-field font-mono" placeholder="未选择" readonly />
                </div>
              </div>
            </div>

            <div class="card p-5">
              <div class="flex flex-col gap-3 mb-4">
                <div>
                  <h3 class="section-title">筛选面板</h3>
                  <p style="color: var(--muted); font-size: 0.82rem; margin-top: 4px;">先选预设，再按需补充关键词/作者/标签。点击查询后会保存结果缓存。</p>
                </div>
                <div class="flex flex-wrap gap-2">
                  <button @click="applyHfPreset('chat')" class="btn-outline text-xs">对话/LLM</button>
                  <button @click="applyHfPreset('vision')" class="btn-outline text-xs">视觉/VLM</button>
                  <button @click="applyHfPreset('image')" class="btn-outline text-xs">文生图</button>
                  <button @click="applyHfPreset('textVideo')" class="btn-outline text-xs">文生视频</button>
                  <button @click="applyHfPreset('imageVideo')" class="btn-outline text-xs">图生视频</button>
                  <button @click="applyHfPreset('videoVideo')" class="btn-outline text-xs">视频改视频</button>
                  <button @click="applyHfPreset('anyAny')" class="btn-outline text-xs">多模态</button>
                  <button @click="applyHfPreset('asr')" class="btn-outline text-xs">语音识别</button>
                  <button @click="applyHfPreset('private')" class="btn-outline text-xs">我的可见</button>
                  <button @click="applyHfPreset('hot')" class="btn-outline text-xs">热门</button>
                </div>
              </div>

              <div class="group-grid group-grid--3">
                <div>
                  <label class="label-sm">关键词搜索</label>
                  <input v-model="config.huggingFace.filters.search" class="input-field" placeholder="Qwen、Llama、SDXL" />
                </div>
                <div>
                  <label class="label-sm">作者/组织</label>
                  <input v-model="config.huggingFace.filters.author" class="input-field" placeholder="Qwen、meta-llama" />
                </div>
                <div>
                  <label class="label-sm">任务类型</label>
                  <select v-model="config.huggingFace.filters.pipelineTag" class="input-field font-mono">
                    <option value="">全部任务</option>
                    <option value="text-generation">文本生成 / 对话</option>
                    <option value="image-text-to-text">图文转文本 / VLM</option>
                    <option value="text-to-image">文生图</option>
                    <option value="image-to-image">图生图</option>
                    <option value="text-to-video">文生视频</option>
                    <option value="image-to-video">图生视频</option>
                    <option value="video-to-video">视频改视频</option>
                    <option value="image-text-to-video">图文生视频</option>
                    <option value="video-text-to-text">视频理解</option>
                    <option value="any-to-any">多模态任意转任意</option>
                    <option value="automatic-speech-recognition">语音识别</option>
                    <option value="text-to-speech">文本转语音</option>
                    <option value="text-to-audio">文本转音频</option>
                    <option value="audio-to-audio">音频转音频</option>
                    <option value="translation">翻译</option>
                    <option value="summarization">摘要</option>
                    <option value="question-answering">问答</option>
                    <option value="token-classification">Token 分类 / NER</option>
                    <option value="text-classification">文本分类</option>
                    <option value="zero-shot-classification">零样本分类</option>
                    <option value="sentence-similarity">向量/相似度</option>
                    <option value="feature-extraction">特征提取 / Embedding</option>
                    <option value="fill-mask">填空/掩码</option>
                    <option value="object-detection">目标检测</option>
                    <option value="image-classification">图像分类</option>
                    <option value="image-segmentation">图像分割</option>
                    <option value="depth-estimation">深度估计</option>
                    <option value="mask-generation">遮罩生成</option>
                  </select>
                </div>
                <div>
                  <label class="label-sm">标签 filter</label>
                  <input v-model="config.huggingFace.filters.tags" class="input-field" placeholder="多个用逗号分隔，如 chat,gguf" />
                </div>
                <div>
                  <label class="label-sm">框架/库</label>
                  <input v-model="config.huggingFace.filters.library" class="input-field" placeholder="transformers / diffusers / mlx" />
                </div>
                <div>
                  <label class="label-sm">推理状态</label>
                  <select v-model="config.huggingFace.filters.inference" class="input-field">
                    <option value="">不限</option>
                    <option value="warm">可直接推理 warm</option>
                    <option value="cold">冷启动 cold</option>
                    <option value="frozen">不可用 frozen</option>
                  </select>
                </div>
                <div>
                  <label class="label-sm">门禁 gated</label>
                  <select v-model="config.huggingFace.filters.gated" class="input-field">
                    <option value="">不限</option>
                    <option value="false">非门禁</option>
                    <option value="true">门禁模型</option>
                  </select>
                </div>
                <div>
                  <label class="label-sm">Provider</label>
                  <input v-model="config.huggingFace.filters.provider" class="input-field" placeholder="hf-inference / fal-ai" />
                </div>
                <div>
                  <label class="label-sm">排序字段</label>
                  <select v-model="config.huggingFace.filters.sort" class="input-field">
                    <option value="downloads">下载量</option>
                    <option value="likes">点赞数</option>
                    <option value="lastModified">最近更新</option>
                    <option value="createdAt">创建时间</option>
                    <option value="trendingScore">趋势热度</option>
                  </select>
                </div>
                <div>
                  <label class="label-sm">排序方向</label>
                  <select v-model="config.huggingFace.filters.direction" class="input-field">
                    <option value="-1">降序</option>
                    <option value="1">升序</option>
                  </select>
                </div>
                <div>
                  <label class="label-sm">返回上限</label>
                  <input v-model.number="config.huggingFace.filters.limit" type="number" min="1" max="200" class="input-field font-mono" />
                </div>
                <div class="space-y-2">
                  <label class="setting-row" style="padding: 8px 12px;">
                    <span style="font-size: 0.8rem; color: var(--text-soft);">查询 token 可见私有模型</span>
                    <input type="checkbox" v-model="config.huggingFace.filters.includePrivate" style="accent-color: var(--warn);" />
                  </label>
                  <label class="setting-row" style="padding: 8px 12px;">
                    <span style="font-size: 0.8rem; color: var(--text-soft);">仅显示聊天可切换模型</span>
                    <input type="checkbox" v-model="config.huggingFace.filters.onlyChatCompatible" style="accent-color: var(--primary);" />
                  </label>
                </div>
              </div>

              <div class="setting-row" style="margin-top: 16px; padding: 10px 14px; flex-wrap: wrap;">
                <button @click="fetchHuggingFaceModels(false)" :disabled="hfModelsLoading" class="btn-primary text-sm">
                  {{ hfModelsLoading ? '查询中...' : '查询模型' }}
                </button>
                <button @click="fetchHuggingFaceModels(true)" :disabled="hfModelsLoading" class="btn-outline text-sm">强制刷新</button>
                <button @click="clearHfCache" :disabled="hfModelsLoading" class="btn-outline text-sm">清空缓存</button>
                <span style="color: var(--muted); font-size: 0.74rem; font-family: var(--font-mono);">{{ hfFetchStatus || (config.huggingFace.cachedAt ? ('缓存：' + hfFormatDate(config.huggingFace.cachedAt)) : '暂无缓存') }}</span>
              </div>
              <p v-if="hfModelsError" style="color: var(--danger); font-size: 0.82rem; margin-top: 12px;">{{ hfModelsError }}</p>
            </div>

            <div class="card p-5">
              <div class="flex items-center justify-between mb-4">
                <h3 class="section-title">结果表（{{ hfModels().length }}）</h3>
                <span class="tag" style="background: var(--warn-soft); border-color: var(--warn-line); color: var(--warn);">编码：hf-1 / hf.1 / hf.2 ...</span>
              </div>
              <div v-if="hfModels().length" class="overflow-x-auto rounded-xl border" style="border-color: var(--line);">
                <table class="min-w-full text-left text-sm">
                  <thead style="background: var(--surface-soft); font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted);">
                    <tr>
                      <th class="px-3 py-2">编码</th>
                      <th class="px-3 py-2">模型</th>
                      <th class="px-3 py-2">任务</th>
                      <th class="px-3 py-2">Provider</th>
                      <th class="px-3 py-2">状态</th>
                      <th class="px-3 py-2">热度</th>
                      <th class="px-3 py-2">更新</th>
                      <th class="px-3 py-2">操作</th>
                    </tr>
                  </thead>
                  <tbody style="background: var(--surface);">
                    <tr v-for="model in hfModels()" :key="model.id + model.code"
                      :style="config.huggingFace.selectedModelId === model.id ? 'background: var(--primary-soft);' : ''"
                      style="border-top: 1px solid var(--line);">
                      <td class="px-3 py-2 font-mono font-bold" style="color: var(--primary);">{{ model.code }}</td>
                      <td class="px-3 py-2">
                        <div style="font-weight: 600; color: var(--text); word-break: break-all;">{{ model.id }}</div>
                        <div style="font-size: 0.72rem; color: var(--muted-light); word-break: break-all;">{{ (model.tags || []).slice(0, 5).join(' · ') }}</div>
                      </td>
                      <td class="px-3 py-2 font-mono text-xs" style="color: var(--text-soft);">{{ model.pipelineTag || '-' }}</td>
                      <td class="px-3 py-2 font-mono text-xs" style="color: var(--text-soft);">{{ model.provider || '-' }}</td>
                      <td class="px-3 py-2 text-xs">
                        <span class="tag">{{ model.inference || 'unknown' }}</span>
                        <span v-if="model.gated === 'true'" class="tag" style="background: var(--warn-soft); border-color: var(--warn-line); color: var(--warn); margin-left: 4px;">gated</span>
                        <span v-if="model.private" class="tag" style="background: var(--danger-soft); border-color: var(--danger-line); color: var(--danger); margin-left: 4px;">private</span>
                      </td>
                      <td class="px-3 py-2 text-xs" style="color: var(--muted);">⬇ {{ model.downloads || 0 }} / ♥ {{ model.likes || 0 }}</td>
                      <td class="px-3 py-2 text-xs" style="color: var(--muted);">{{ hfFormatDate(model.lastModified) }}</td>
                      <td class="px-3 py-2">
                        <button @click="selectHfModel(model)" class="btn-outline text-xs">选择</button>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p v-else style="color: var(--muted); font-size: 0.84rem;">还没有模型缓存。填写 Token/筛选条件后点击"查询模型"。</p>
            </div>

          </div>
</template>
