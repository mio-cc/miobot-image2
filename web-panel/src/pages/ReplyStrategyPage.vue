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
              <h1 class="page-head__title">回复策略</h1>
              <p class="page-head__desc">机器人回复格式、分段策略、触发入口、图片压缩、TTS 语音、触发词与黑白名单。</p>
            </header>

            <div class="card p-5">
              <h3 class="section-title mb-4">回复格式</h3>
              <div class="group-grid group-grid--3">
                <label v-for="opt in [
                  { value: 'forward', icon: '📦', title: '合并转发', desc: '纯净无打扰，仅发送图片' },
                  { value: 'at',      icon: '🔔', title: '@提问者',  desc: '回复时@发送者并附图' },
                  { value: 'quote',   icon: '💬', title: '引用消息',  desc: '引用原消息并附图' },
                ]" :key="opt.value" :class="['reply-card', config.bot.replyFormat === opt.value ? 'reply-card-active' : '']">
                  <input type="radio" v-model="config.bot.replyFormat" :value="opt.value" class="hidden" />
                  <div style="font-size: 1.5rem; margin-bottom: 4px;">{{ opt.icon }}</div>
                  <div style="font-size: 0.86rem; font-weight: 600; color: var(--text);">{{ opt.title }}</div>
                  <div style="color: var(--muted); font-size: 0.74rem; margin-top: 4px;">{{ opt.desc }}</div>
                </label>
              </div>

              <div style="margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--line);">
                <h4 style="font-size: 0.86rem; font-weight: 700; color: var(--text); margin-bottom: 12px;">按内容类型设置</h4>
                <div class="group-grid group-grid--3">
                  <div>
                    <label class="label-sm">纯文本回复</label>
                    <select v-model="config.bot.replyStrategies.text" class="input-field">
                      <option value="forward">合并转发</option>
                      <option value="quote">引用原消息</option>
                      <option value="at">@ 提问者</option>
                      <option value="plain">普通消息</option>
                    </select>
                    <p style="color: var(--muted-light); font-size: 0.72rem; margin-top: 6px;">自由模式文本通常建议合并转发</p>
                  </div>
                  <div>
                    <label class="label-sm">单图回复</label>
                    <select v-model="config.bot.replyStrategies.image" class="input-field">
                      <option value="forward">合并转发</option>
                      <option value="quote">引用原消息</option>
                      <option value="at">@ 提问者</option>
                      <option value="plain">普通消息</option>
                    </select>
                    <p style="color: var(--muted-light); font-size: 0.72rem; margin-top: 6px;">若智能模型输出包含图片，将丢弃文本只发送图片</p>
                  </div>
                  <div>
                    <label class="label-sm">多图回复</label>
                    <select v-model="config.bot.replyStrategies.multiImage" class="input-field">
                      <option value="forward">多图合并转发</option>
                      <option value="quote">逐条引用</option>
                      <option value="at">@ 提问者（逐条）</option>
                      <option value="plain">普通消息（逐条）</option>
                    </select>
                    <p style="color: var(--muted-light); font-size: 0.72rem; margin-top: 6px;">建议合并转发，避免刷屏</p>
                  </div>
                </div>
              </div>

              <div style="margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--line);">
                <h4 style="font-size: 0.86rem; font-weight: 700; color: var(--text); margin-bottom: 12px;">长文本分段</h4>
                <div class="group-grid group-grid--3">
                  <div>
                    <label class="label-sm">每段最多字数</label>
                    <input type="number" min="0" max="20000" step="100" v-model.number="config.bot.textReply.maxChars" class="input-field" placeholder="1800" />
                    <p style="color: var(--muted-light); font-size: 0.72rem; margin-top: 6px;">0 = 不拆分；建议 1200-2500</p>
                  </div>
                  <div>
                    <label class="label-sm">分段间隔（毫秒）</label>
                    <input type="number" min="0" max="10000" step="100" v-model.number="config.bot.textReply.splitDelayMs" class="input-field" placeholder="800" />
                    <p style="color: var(--muted-light); font-size: 0.72rem; margin-top: 6px;">多段连续发送时的等待时间</p>
                  </div>
                  <label class="setting-row">
                    <div class="setting-row__text">
                      <p class="setting-row__title">显示分段序号</p>
                      <p class="setting-row__desc">例如 (1/3)，方便按顺序阅读</p>
                    </div>
                    <input type="checkbox" v-model="config.bot.textReply.showPartPrefix" style="accent-color: #0ea5e9;" />
                  </label>
                </div>
              </div>

              <div style="margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--line);">
                <h4 style="font-size: 0.86rem; font-weight: 700; color: var(--text); margin-bottom: 12px;">触发入口</h4>
                <div class="group-grid group-grid--2">
                  <label class="setting-row" style="align-items: flex-start;">
                    <div class="setting-row__text">
                      <p class="setting-row__title">@机器人 + 关键字</p>
                      <p class="setting-row__desc">例如 @机器人 画 小狗；无关键字时只在日常对话开启后回复</p>
                    </div>
                    <input type="checkbox" v-model="config.bot.triggerModes.mention" style="accent-color: #0ea5e9;" />
                  </label>
                  <label class="setting-row" style="align-items: flex-start;">
                    <div class="setting-row__text">
                      <p class="setting-row__title">引用机器人消息 + 关键字</p>
                      <p class="setting-row__desc">例如引用机器人的消息后发送 反推；无关键字不进入日常对话</p>
                    </div>
                    <input type="checkbox" v-model="config.bot.triggerModes.replyToBot" style="accent-color: #0ea5e9;" />
                  </label>
                </div>
              </div>

              <div style="margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--line);" class="group-grid group-grid--2">
                <label class="setting-row" style="align-items: flex-start;">
                  <div class="setting-row__text">
                    <p class="setting-row__title">发图后自动撤回</p>
                    <p class="setting-row__desc">默认关闭，只撤回群聊中机器人发出的图片消息</p>
                  </div>
                  <input type="checkbox" v-model="config.bot.autoRecallImages" style="accent-color: #0ea5e9;" />
                </label>
                <div>
                  <label class="label-sm">撤回延迟（秒）</label>
                  <input type="number" min="1" step="1" v-model.number="config.bot.autoRecallDelaySeconds" :disabled="!config.bot.autoRecallImages" class="input-field" placeholder="60" />
                </div>
              </div>

              <div style="margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--line);">
                <h4 style="font-size: 0.86rem; font-weight: 700; color: var(--text); margin-bottom: 12px;">图片压缩与原图</h4>
                <div class="group-grid group-grid--3">
                  <label class="setting-row" style="align-items: flex-start;">
                    <div class="setting-row__text">
                      <p class="setting-row__title">默认发送压缩图</p>
                      <p class="setting-row__desc">保留原图索引，可引用后发送"原图"取回</p>
                    </div>
                    <input type="checkbox" v-model="config.bot.imageCompression.enabled" style="accent-color: #0ea5e9;" />
                  </label>
                  <div>
                    <label class="label-sm">压缩倍率</label>
                    <input type="number" min="0.1" max="1" step="0.05" v-model.number="config.bot.imageCompression.scale" :disabled="!config.bot.imageCompression.enabled" class="input-field" />
                    <p style="color: var(--muted-light); font-size: 0.72rem; margin-top: 6px;">0.65 表示宽高压到 65%</p>
                  </div>
                  <div>
                    <label class="label-sm">图片质量</label>
                    <input type="number" min="1" max="100" step="1" v-model.number="config.bot.imageCompression.quality" :disabled="!config.bot.imageCompression.enabled" class="input-field" />
                    <p style="color: var(--muted-light); font-size: 0.72rem; margin-top: 6px;">默认 82，透明图保留原始格式</p>
                  </div>
                </div>
                <div class="group-grid" style="grid-template-columns: repeat(auto-fit, minmax(min(200px, 100%), 1fr)); margin-top: 14px;">
                  <label class="setting-row" style="align-items: flex-start;">
                    <div class="setting-row__text">
                      <p class="setting-row__title">多图合并预览压缩</p>
                      <p class="setting-row__desc">合并成带编号的压缩预览，原图仍可回复数字取回</p>
                    </div>
                    <input type="checkbox" v-model="config.bot.imageCompression.mergedPreviewEnabled" style="accent-color: #0ea5e9;" />
                  </label>
                  <div>
                    <label class="label-sm">预览缩放</label>
                    <input type="number" min="0.1" max="1" step="0.05" v-model.number="config.bot.imageCompression.mergedPreviewScale" :disabled="!config.bot.imageCompression.mergedPreviewEnabled" class="input-field" />
                  </div>
                  <div>
                    <label class="label-sm">预览压缩质量</label>
                    <input type="number" min="1" max="100" step="1" v-model.number="config.bot.imageCompression.mergedPreviewQuality" :disabled="!config.bot.imageCompression.mergedPreviewEnabled" class="input-field" />
                  </div>
                  <div>
                    <label class="label-sm">预览最大宽度</label>
                    <input type="number" min="512" max="4096" step="64" v-model.number="config.bot.imageCompression.mergedPreviewMaxWidth" :disabled="!config.bot.imageCompression.mergedPreviewEnabled" class="input-field" />
                    <p style="color: var(--muted-light); font-size: 0.72rem; margin-top: 6px;">用于降低 Napcat 上传耗时</p>
                  </div>
                </div>
              </div>
            </div>

            <div class="card p-5">
              <div class="flex items-center justify-between mb-4">
                <h3 class="section-title">Bot 主人管理</h3>
                <span class="tag" style="background: #ecfeff; border-color: #a5f3fc; color: #0ea5e9;">权限敏感</span>
              </div>
              <p style="color: var(--muted); font-size: 0.78rem; margin-bottom: 14px;">主人指令只允许下方主人 QQ 调用；主人无法被拉黑，撤回只撤回机器人最近发出的整条消息。</p>
              <div class="group-grid group-grid--2">
                <div>
                  <label class="label-sm">机器人 QQ 号</label>
                  <input v-model="config.bot.botQqId" class="input-field" placeholder="用于识别 @bot 主人指令" />
                  <p style="color: var(--muted-light); font-size: 0.72rem; margin-top: 6px;">建议填写，避免 Napcat 未上报 self_id 时 @bot 指令无法识别</p>
                </div>
                <div>
                  <label class="label-sm">主人 QQ 号</label>
                  <input :value="config.bot.ownerQQs?.join(', ')"
                    @input="config.bot.ownerQQs = ($event.target as HTMLInputElement).value.split(/[\n,，；;]+/).map((s:string) => s.trim()).filter(Boolean)"
                    class="input-field" placeholder="多个 QQ 用逗号或换行分隔" />
                  <p style="color: var(--muted-light); font-size: 0.72rem; margin-top: 6px;">只有这里的 QQ 可以执行 /拉黑、/拉白、/撤回、/ttsk、/ttsg、/tts.N</p>
                </div>
              </div>
              <div class="setting-row" style="margin-top: 14px; padding: 14px; flex-direction: column; align-items: stretch; gap: 10px;">
                <span style="font-size: 0.86rem; font-weight: 700; color: var(--text);">可用主人指令</span>
                <div class="group-grid group-grid--2" style="font-size: 0.76rem; color: var(--text-soft); line-height: 1.7;">
                  <div><code style="font-family: var(--font-mono); color: var(--primary);">@某人 /拉黑</code>：禁止该群内该 QQ 使用 Bot</div>
                  <div><code style="font-family: var(--font-mono); color: var(--primary);">@某人 /拉白</code>：解除该群内该 QQ 黑名单</div>
                  <div><code style="font-family: var(--font-mono); color: var(--primary);">@bot /撤回</code> 或 <code style="font-family: var(--font-mono); color: var(--primary);">/c3</code>：撤回最近 1/3 条</div>
                  <div><code style="font-family: var(--font-mono); color: var(--primary);">@bot /ttsk</code> / <code style="font-family: var(--font-mono); color: var(--primary);">/ttsg</code>：开启/关闭自动语音</div>
                  <div><code style="font-family: var(--font-mono); color: var(--primary);">@bot /tts.1</code> / <code style="font-family: var(--font-mono); color: var(--primary);">/tts.2</code>：切换 Fish Voice 编号</div>
                </div>
              </div>
            </div>

            <div class="card p-5">
              <div class="flex items-center justify-between mb-4">
                <h3 class="section-title">会话记忆隔离</h3>
              </div>
              <p style="color: var(--muted); font-size: 0.78rem; margin-bottom: 16px;">
                每个用户 QQ 拥有独立的对话记忆（群聊按 group:群号:QQ号 隔离，私聊按 QQ 号隔离），互不干扰。设置空闲超时时间，超时未对话的会话自动清理，避免长期运行内存堆积。设为 0 表示永不清理。
              </p>
              <div class="group-grid group-grid--2">
                <div>
                  <label class="label-sm">会话空闲超时（分钟）</label>
                  <input type="number" min="0" max="1440" v-model.number="config.llm.sessionTtlMinutes" class="input-field" />
                  <p style="color: var(--muted); font-size: 0.72rem; margin-top: 4px;">0 = 永不清理；推荐 30 分钟</p>
                </div>
                <div>
                  <label class="label-sm">最大对话轮数</label>
                  <input type="number" min="1" max="50" v-model.number="config.llm.maxConversationRounds" class="input-field" />
                  <p style="color: var(--muted); font-size: 0.72rem; margin-top: 4px;">1 轮 = 用户+回复，超出从最旧丢弃</p>
                </div>
              </div>
            </div>

            <div class="card p-5">
              <div class="flex items-center justify-between mb-4">
                <h3 class="section-title">群聊上下文注入</h3>
                <label class="setting-row" style="padding: 6px 12px; min-height: 34px;">
                  <input type="checkbox" v-model="config.bot.groupContext.enabled" style="accent-color: #0ea5e9;" />
                  <span style="font-size: 0.78rem; font-weight: 600; color: var(--text-soft);">启用</span>
                </label>
              </div>
              <p style="color: var(--muted); font-size: 0.78rem; margin-bottom: 16px;">
                在群聊中被 @机器人 时，自动拉取最近的群聊记录作为上下文喂给模型，让机器人知道大家在聊什么。机器人会自行判断上下文是否与你的消息相关，相关则结合回复，无关则正常回复。
              </p>
              <div class="group-grid group-grid--2">
                <div>
                  <label class="label-sm">拉取消息条数</label>
                  <input type="number" min="5" max="50" v-model.number="config.bot.groupContext.messageCount" class="input-field" />
                  <p style="color: var(--muted); font-size: 0.72rem; margin-top: 4px;">推荐 30 条</p>
                </div>
                <div>
                  <label class="label-sm">上下文最大字符数</label>
                  <input type="number" min="500" max="20000" v-model.number="config.bot.groupContext.maxChars" class="input-field" />
                  <p style="color: var(--muted); font-size: 0.72rem; margin-top: 4px;">超出从最旧截断</p>
                </div>
                <div>
                  <label class="setting-row" style="padding: 6px 0; min-height: 34px;">
                    <input type="checkbox" v-model="config.bot.groupContext.skipForward" style="accent-color: #0ea5e9;" />
                    <span style="font-size: 0.78rem; color: var(--text-soft);">跳过合并转发消息（避免内容撑爆）</span>
                  </label>
                </div>
                <div>
                  <label class="setting-row" style="padding: 6px 0; min-height: 34px;">
                    <input type="checkbox" v-model="config.bot.groupContext.includeImages" style="accent-color: #0ea5e9;" />
                    <span style="font-size: 0.78rem; color: var(--text-soft);">上下文含图片 URL（视频/文件/语音仍用占位符）</span>
                  </label>
                </div>
              </div>
            </div>

            <div class="card p-5">
              <div class="flex items-center justify-between mb-4">
                <h3 class="section-title">文本转语音 / TTS</h3>
                <label class="setting-row" style="padding: 6px 12px; min-height: 34px;">
                  <input type="checkbox" v-model="config.bot.tts.enabled" style="accent-color: #0ea5e9;" />
                  <span style="font-size: 0.78rem; font-weight: 600; color: var(--text-soft);">启用 TTS</span>
                </label>
              </div>
              <p style="color: var(--muted); font-size: 0.78rem; margin-bottom: 14px;">当机器人回复文本不超过设定字数时，自动调用语音 API 并用 Napcat 语音消息发送；失败会降级为普通文本。</p>
              <div class="group-grid group-grid--3">
                <div>
                  <label class="label-sm">语音服务</label>
                  <select v-model="config.bot.tts.provider" class="input-field">
                    <option value="fish-audio">Fish Audio</option>
                    <option value="openai-compatible">OpenAI 兼容语音</option>
                  </select>
                  <p style="color: var(--muted-light); font-size: 0.72rem; margin-top: 6px;">默认 Fish Audio，兼容模式适配常见 /audio/speech 服务</p>
                </div>
                <div style="grid-column: span 2;">
                  <label class="label-sm">API 地址</label>
                  <input v-model="config.bot.tts.apiUrl" class="input-field" placeholder="https://api.fish.audio/v1/tts" />
                </div>
                <div>
                  <label class="label-sm">API 密钥</label>
                  <input v-model="config.bot.tts.apiKey" type="password" autocomplete="off" class="input-field" placeholder="Bearer Token / API Key" />
                </div>
                <div>
                  <label class="label-sm">模型 ID / 后端</label>
                  <input v-model="config.bot.tts.model" class="input-field" placeholder="Fish: s2-pro；兼容: tts-1" />
                </div>
                <div v-if="config.bot.tts.provider === 'fish-audio'" style="grid-column: 1 / -1;">
                  <div class="flex items-center justify-between mb-2">
                    <div>
                      <label class="label-sm">Fish Voice / Reference ID 列表</label>
                      <p style="color: var(--muted-light); font-size: 0.72rem;">按编号保存，主人可发送 <code style="font-family: var(--font-mono); color: var(--primary);">@bot /tts.1</code> 切换</p>
                    </div>
                    <button type="button" @click="addTtsVoiceId" class="btn-outline text-xs">＋ 添加 Voice ID</button>
                  </div>
                  <div class="space-y-2">
                    <div v-if="!config.bot.tts.voiceIds?.length" class="setting-row" style="padding: 12px; justify-content: center; border-style: dashed; color: var(--muted); font-size: 0.78rem;">
                      还没有添加 Reference ID。点击"添加 Voice ID"后粘贴 Fish Audio 的 reference_id。
                    </div>
                    <div v-for="(_voiceId, idx) in config.bot.tts.voiceIds" :key="`tts-voice-${idx}`" class="tts-voice-row">
                      <button type="button" @click="selectTtsVoiceId(idx)" :class="['tts-voice-index', config.bot.tts.voiceId === String(config.bot.tts.voiceIds[idx] || '').trim() ? 'tts-voice-index--active' : '']">
                        #{{ idx + 1 }}
                      </button>
                      <input v-model="config.bot.tts.voiceIds[idx]" @input="onTtsVoiceIdInput(idx)" class="input-field font-mono" placeholder="Fish reference_id / voice model id" />
                      <button type="button" @click="selectTtsVoiceId(idx)" class="btn-outline text-xs px-3">设为当前</button>
                      <button type="button" @click="removeTtsVoiceId(idx)" class="btn-danger text-xs px-3">删除</button>
                    </div>
                  </div>
                  <input v-model="config.bot.tts.voiceId" class="input-field font-mono" style="margin-top: 12px;" placeholder="当前启用的 Reference ID，可由 /tts.N 切换" />
                  <p style="color: var(--muted-light); font-size: 0.72rem; margin-top: 6px;">当前启用：<code style="font-family: var(--font-mono); color: var(--primary);">{{ config.bot.tts.voiceId || '未选择' }}</code></p>
                </div>
                <div v-else>
                  <label class="label-sm">兼容模式 Voice</label>
                  <input v-model="config.bot.tts.voice" class="input-field" placeholder="alloy / shimmer / 自定义 voice" />
                </div>
                <div>
                  <label class="label-sm">多少字以内转语音</label>
                  <input type="number" min="1" max="4000" step="10" v-model.number="config.bot.tts.autoTextMaxChars" class="input-field" placeholder="180" />
                  <p style="color: var(--muted-light); font-size: 0.72rem; margin-top: 6px;">超过该长度仍按长文本分段发送</p>
                </div>
                <div>
                  <label class="label-sm">输出格式</label>
                  <select v-model="config.bot.tts.format" class="input-field">
                    <option value="mp3">MP3</option>
                    <option value="wav">WAV</option>
                    <option value="opus">Opus</option>
                  </select>
                </div>
                <div>
                  <label class="label-sm">超时（毫秒）</label>
                  <input type="number" min="5000" max="300000" step="1000" v-model.number="config.bot.tts.timeoutMs" class="input-field" placeholder="60000" />
                </div>
                <div>
                  <label class="label-sm">延迟档位</label>
                  <select v-model="config.bot.tts.latency" class="input-field">
                    <option value="normal">normal：质量优先</option>
                    <option value="balanced">balanced：均衡</option>
                    <option value="low">low：低延迟</option>
                  </select>
                </div>
                <div>
                  <label class="label-sm">语速</label>
                  <input type="number" min="0.5" max="2" step="0.05" v-model.number="config.bot.tts.speed" class="input-field" />
                </div>
                <div>
                  <label class="label-sm">音量</label>
                  <input type="number" min="-20" max="20" step="1" v-model.number="config.bot.tts.volume" class="input-field" />
                </div>
              </div>

              <div class="setting-row" style="margin-top: 16px; padding: 14px; flex-direction: column; align-items: stretch; gap: 12px; border-color: #ddd6fe; background: #f5f3ff;">
                <div class="flex items-center justify-between">
                  <div>
                    <span style="font-size: 0.86rem; font-weight: 700; color: var(--text);">语音前置翻译 / 标签模型</span>
                    <p style="color: var(--muted); font-size: 0.74rem; margin-top: 2px;">AI 文本回复命中"多少字以内转语音"后，先经过这里的模型翻译、改写并穿插语音标签，再送入语音 API。</p>
                  </div>
                  <label class="setting-row" style="padding: 6px 12px; min-height: 34px; border-color: #ddd6fe; background: var(--surface);">
                    <input type="checkbox" v-model="config.bot.tts.preprocess.enabled" style="accent-color: #8b5cf6;" />
                    <span style="font-size: 0.78rem; font-weight: 600; color: var(--text-soft);">启用前置处理</span>
                  </label>
                </div>
                <div class="group-grid group-grid--3">
                  <div style="grid-column: span 2;">
                    <label class="label-sm">前置模型路由</label>
                    <div class="setting-row" style="padding: 8px 12px; background: var(--surface);">
                      <span style="color: var(--muted); font-size: 0.74rem;">当前</span>
                      <code style="font-family: var(--font-mono); font-size: 0.74rem; color: var(--text); flex: 1; text-align: right;">{{ routeSummary(['bot', 'tts', 'preprocess', 'nodeIndex'], ['bot', 'tts', 'preprocess', 'model']) }}</code>
                      <button @click="currentPage = 'modelRoutes'" class="btn-outline text-xs" style="min-height: 26px; padding: 0 8px;">去路由</button>
                    </div>
                    <p style="color: var(--muted-light); font-size: 0.72rem; margin-top: 6px;">回复进入语音模式前的 LLM 前置处理，节点/模型集中到模型路由页维护</p>
                  </div>
                  <div>
                    <label class="label-sm">前置超时（毫秒）</label>
                    <input type="number" min="5000" max="300000" step="1000" v-model.number="config.bot.tts.preprocess.timeoutMs" :disabled="!config.bot.tts.preprocess.enabled" class="input-field" />
                  </div>
                  <div>
                    <label class="label-sm">送入语音前延迟（毫秒）</label>
                    <input type="number" min="0" max="30000" step="100" v-model.number="config.bot.tts.preprocess.delayMs" :disabled="!config.bot.tts.preprocess.enabled" class="input-field" />
                    <p style="color: var(--muted-light); font-size: 0.72rem; margin-top: 6px;">用于等待上游、模拟停顿或控制发语音节奏</p>
                  </div>
                  <div>
                    <label class="label-sm">前置输出最多字符</label>
                    <input type="number" min="1" max="8000" step="50" v-model.number="config.bot.tts.preprocess.maxOutputChars" :disabled="!config.bot.tts.preprocess.enabled" class="input-field" />
                  </div>
                  <label class="setting-row" style="align-items: flex-start;">
                    <div class="setting-row__text">
                      <p class="setting-row__title">失败降级原文</p>
                      <p class="setting-row__desc">前置模型异常时仍用原回复发语音</p>
                    </div>
                    <input type="checkbox" v-model="config.bot.tts.preprocess.fallbackToOriginal" :disabled="!config.bot.tts.preprocess.enabled" style="accent-color: #8b5cf6;" />
                  </label>
                </div>
                <div>
                  <label class="label-sm">前置提示词模板</label>
                  <textarea v-model="config.bot.tts.preprocess.promptTemplate" :disabled="!config.bot.tts.preprocess.enabled" rows="7" class="input-field font-mono text-sm"></textarea>
                  <p style="color: var(--muted-light); font-size: 0.72rem; margin-top: 6px;">占位符：<code style="font-family: var(--font-mono); color: var(--primary);">{{text}}</code> / <code style="font-family: var(--font-mono); color: var(--primary);">{{rawText}}</code> / <code style="font-family: var(--font-mono); color: var(--primary);">{{input}}</code> / <code style="font-family: var(--font-mono); color: var(--primary);">{{replyText}}</code>。模型只应输出最终送入语音 API 的文本。</p>
                </div>
              </div>
              <div class="setting-row" style="margin-top: 12px; padding: 10px 14px; border-color: #a5f3fc; background: #ecfeff; font-size: 0.76rem; color: var(--text-soft); line-height: 1.6;">
                Fish Audio 需要填写 <strong>API 密钥</strong>、<strong>模型 ID</strong>（如 s2-pro）和 <strong>Voice / Reference ID</strong>；发送给 QQ 时会转换为 <code style="font-family: var(--font-mono); color: var(--primary);">record</code> 语音消息段。
              </div>
            </div>

            <div class="card p-5">
              <h3 class="section-title mb-2">触发词自定义</h3>
              <p style="color: var(--muted); font-size: 0.78rem; margin-bottom: 14px;">多个关键词用英文逗号分隔；关键字只匹配清理掉 @/引用后的开头位置。</p>
              <div class="group-grid group-grid--3">
                <div>
                  <label class="label-sm">🎨 文生图</label>
                  <input v-model="config.bot.commands.genImage" class="input-field" placeholder="生图, 画" />
                  <label class="label-sm" style="margin-top: 12px;">图片数量指令后缀</label>
                  <input v-model="config.bot.commands.imageCount" class="input-field" placeholder="s" />
                  <p style="color: var(--muted-light); font-size: 0.72rem; margin-top: 4px;">例如 2s! 生成 2 张，最高 4 张</p>
                </div>
                <div>
                  <label class="label-sm">🖼️ 图生图 / 参考图</label>
                  <input v-model="config.bot.commands.img2Img" class="input-field" placeholder="图生图, 参考图, i2i" />
                </div>
                <div>
                  <label class="label-sm">✏️ 改图 / 编辑</label>
                  <input v-model="config.bot.commands.editImage" class="input-field" placeholder="改图, 编辑" />
                </div>
                <div>
                  <label class="label-sm">🔍 反推提示词</label>
                  <input v-model="config.bot.commands.interrogate" class="input-field" placeholder="反推, 看图, 描述" />
                </div>
                <div>
                  <label class="label-sm">🖼️ 获取原图</label>
                  <input v-model="config.bot.commands.originalImage" class="input-field" placeholder="原图" />
                  <p style="color: var(--muted-light); font-size: 0.72rem; margin-top: 4px;">引用机器人发出的压缩图后使用</p>
                </div>
                <div>
                  <label class="label-sm">🧩 本地模板库</label>
                  <input v-model="config.bot.commands.templateLibrary" class="input-field" placeholder="本地模板库, 本地模板, 模板库, mb" />
                  <p style="color: var(--muted-light); font-size: 0.72rem; margin-top: 4px;">@机器人 本地模板库 会用合并转发列出本地模板</p>
                </div>
                <div>
                  <label class="label-sm">🧬 引用模板填充生图</label>
                  <input v-model="config.bot.commands.referencedTemplateImage" class="input-field" placeholder="套模板, 引用模板生图, 模板填充生图" />
                  <p style="color: var(--muted-light); font-size: 0.72rem; margin-top: 4px;">引用含【通用模板提示词】的消息后使用</p>
                </div>
                <div>
                  <label class="label-sm">🌐 远程模板库搜索</label>
                  <input v-model="config.bot.commands.remotePromptSearch" class="input-field" placeholder="pp, 远程模板库, 远程模板" />
                  <p style="color: var(--muted-light); font-size: 0.72rem; margin-top: 4px;">例如：@机器人 远程模板 电影感头像</p>
                </div>
                <div>
                  <label class="label-sm">✨ 远程智能套模板生图</label>
                  <input v-model="config.bot.commands.remotePromptSmartImage" class="input-field" placeholder="spp, 远程模板生图, 智能远程模板" />
                  <p style="color: var(--muted-light); font-size: 0.72rem; margin-top: 4px;">例如：@机器人 智能远程模板! 画面描述</p>
                </div>
                <div>
                  <label class="label-sm">🧠 润色开关</label>
                  <input v-model="config.bot.commands.toggleEnhance" class="input-field" placeholder="润色" />
                  <p style="color: var(--muted-light); font-size: 0.72rem; margin-top: 4px;">例如：画 润色 小狗；不带此词则不润色</p>
                </div>
              </div>
            </div>

            <div class="card p-5">
              <h3 class="section-title mb-2">白名单 / 黑名单</h3>
              <p style="color: var(--muted); font-size: 0.78rem; margin-bottom: 14px;">白名单留空允许所有；群内黑名单每行一个，格式为 群号:QQ，也支持 *:QQ。</p>
              <div class="group-grid group-grid--2">
                <div>
                  <label class="label-sm">允许的群号</label>
                  <input :value="config.bot.whitelistGroups?.join(', ')"
                    @input="config.bot.whitelistGroups = ($event.target as HTMLInputElement).value.split(',').map((s:string) => s.trim()).filter(Boolean)"
                    class="input-field" placeholder="留空 = 全部放行" />
                </div>
                <div>
                  <label class="label-sm">允许的私聊 QQ</label>
                  <input :value="config.bot.whitelistPrivate?.join(', ')"
                    @input="config.bot.whitelistPrivate = ($event.target as HTMLInputElement).value.split(',').map((s:string) => s.trim()).filter(Boolean)"
                    class="input-field" placeholder="留空 = 全部放行" />
                </div>
                <div style="grid-column: 1 / -1;">
                  <label class="label-sm">群内用户黑名单</label>
                  <textarea :value="config.bot.blacklistGroupUsers?.join('\n')"
                    @input="config.bot.blacklistGroupUsers = ($event.target as HTMLTextAreaElement).value.split(/[\n,]/).map((s:string) => s.trim()).filter(Boolean)"
                    class="input-field" style="min-height: 112px; resize: vertical;" placeholder="1098867961:2238639363&#10;*:123456789"></textarea>
                </div>
              </div>
            </div>

          </div>
</template>
