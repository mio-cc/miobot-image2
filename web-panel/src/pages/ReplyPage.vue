<script setup lang="ts">
import { computed } from 'vue';
import { useConfigStore } from '../stores/config';
import SectionCard from '../components/SectionCard.vue';
import FormField from '../components/FormField.vue';
import ToggleField from '../components/ToggleField.vue';

/**
 * 回复与发送页（输出层）。
 * legacy replyStrategies（v2 直发链路）与 orch.reply（编排链路预算）并排展示，
 * 配作用域说明；进度提示、文本转图、图片压缩与撤回同归此页。
 * 语音回复（TTS）的合成与发送策略在「语音」页。
 */

const configStore = useConfigStore();
const config = computed(() => configStore.config);
const orch = computed(() => config.value?.orchestration);
const replyPolicy = computed(() => config.value?.replyPolicy);

const strategyOptions = [
    { value: 'forward', label: '合并转发' },
    { value: 'quote', label: '引用原消息' },
    { value: 'at', label: '@ 提问者' },
    { value: 'plain', label: '普通消息' },
    { value: 'text-image', label: '文本转图片' },
];
</script>

<template>
  <div v-if="config">
    <header class="mb-4">
      <h1 class="page-title mb-0.5">回复与发送</h1>
      <p class="text-[color:var(--ink-3)] text-xs">
        输出层：回复方式、消息预算、进度提示、文本转图与图片压缩。语音回复在「语音」页配置。
      </p>
    </header>

    <SectionCard title="回复方式（v2 直发链路）" hint="按内容类型选择回复方式；编排链路（enforce）走下方消息预算" class="mb-4">
      <div class="grid grid-cols-1 md:grid-cols-3 xl:grid-cols-4 gap-4">
        <FormField label="纯文本回复" hint="长文本建议用合并转发">
          <select v-model="config.bot.replyStrategies.text" class="input-field">
            <option v-for="opt in strategyOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
          </select>
        </FormField>
        <FormField label="单图回复">
          <select v-model="config.bot.replyStrategies.image" class="input-field">
            <option v-for="opt in strategyOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
          </select>
        </FormField>
        <FormField label="多图回复" hint="推荐合并转发，避免刷屏">
          <select v-model="config.bot.replyStrategies.multiImage" class="input-field">
            <option v-for="opt in strategyOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
          </select>
        </FormField>
        <FormField label="单视频">
          <select v-model="config.bot.replyStrategies.video" class="input-field">
            <option v-for="opt in strategyOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
          </select>
        </FormField>
        <FormField label="多视频" hint="推荐合并转发">
          <select v-model="config.bot.replyStrategies.multiVideo" class="input-field">
            <option v-for="opt in strategyOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
          </select>
        </FormField>
        <FormField label="单文件">
          <select v-model="config.bot.replyStrategies.file" class="input-field">
            <option v-for="opt in strategyOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
          </select>
        </FormField>
        <FormField label="多文件" hint="推荐合并转发">
          <select v-model="config.bot.replyStrategies.multiFile" class="input-field">
            <option v-for="opt in strategyOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
          </select>
        </FormField>
        <FormField label="图文视频混排" hint="推荐合并转发">
          <select v-model="config.bot.replyStrategies.mixed" class="input-field">
            <option v-for="opt in strategyOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
          </select>
        </FormField>
      </div>

      <div v-if="config.bot.replyStrategies.text === 'text-image'" class="mt-4 pt-4 border-t border-[color:var(--hairline-2)]">
        <div class="flex flex-wrap items-center gap-3 mb-3">
          <ToggleField v-model="config.bot.textImage.enabled" label="启用文本转图片" />
          <span class="text-xs text-[color:var(--ink-3)]">本地排版后发图，不启动 Chromium；渲染失败自动回退文本。</span>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-4 gap-4">
          <FormField label="默认宽度"><input v-model.number="config.bot.textImage.width" type="number" min="320" max="4096" class="input-field" /></FormField>
          <FormField label="字号"><input v-model.number="config.bot.textImage.fontSize" type="number" min="12" max="96" class="input-field" /></FormField>
          <FormField label="行距"><input v-model.number="config.bot.textImage.lineHeight" type="number" min="1.1" max="3" step="0.1" class="input-field" /></FormField>
          <FormField label="JPEG 质量"><input v-model.number="config.bot.textImage.quality" type="number" min="1" max="100" class="input-field" /></FormField>
          <FormField label="字体"><input v-model="config.bot.textImage.fontFamily" class="input-field font-mono" /></FormField>
          <FormField label="背景色"><input v-model="config.bot.textImage.background" class="input-field font-mono" /></FormField>
          <FormField label="文字色"><input v-model="config.bot.textImage.foreground" class="input-field font-mono" /></FormField>
          <FormField label="强调色"><input v-model="config.bot.textImage.accent" class="input-field font-mono" /></FormField>
        </div>
        <p class="text-xs text-[color:var(--ink-3)] mt-2">服务器需安装中文字体（例如 fonts-noto-cjk）；sharp 不可用时自动回退普通文本。</p>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-3 gap-4 mt-4 pt-4 border-t border-[color:var(--hairline-2)]">
        <FormField label="每段最多字数" hint="0 表示不拆分；建议 1200-2500">
          <input type="number" min="0" max="20000" step="100" v-model.number="config.bot.textReply.maxChars" class="input-field" />
        </FormField>
        <FormField label="分段间隔 (ms)" hint="发太快会被 QQ 判定刷屏">
          <input type="number" min="0" max="10000" step="100" v-model.number="config.bot.textReply.splitDelayMs" class="input-field" />
        </FormField>
        <div class="self-end">
          <ToggleField v-model="config.bot.textReply.showPartPrefix" label="显示分段序号 (1/3)" />
        </div>
      </div>
    </SectionCard>

    <SectionCard v-if="orch" title="编排消息预算（orch.reply）" hint="智能编排 enforce 链路的结果预算；优先嵌套合并转发，文件和语音按不可合并处理" class="mb-4">
      <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        <FormField label="最大结果数"><input v-model.number="orch.reply.maxResultItems" type="number" min="1" class="input-field" /></FormField>
        <FormField label="最大消息数"><input v-model.number="orch.reply.maxMessages" type="number" min="1" max="20" class="input-field" /></FormField>
        <FormField label="嵌套最大节点数"><input v-model.number="orch.reply.nestedMaxNodes" type="number" min="1" class="input-field" /></FormField>
        <FormField label="嵌套最大深度"><input v-model.number="orch.reply.nestedMaxDepth" type="number" min="1" max="5" class="input-field" /></FormField>
        <FormField label="超出预算">
          <select v-model="orch.reply.overflowPolicy" class="input-field">
            <option value="forward">打包为第二个合并转发</option><option value="truncate">截断</option><option value="link">链接</option><option value="zip">ZIP</option><option value="reject">拒绝</option>
          </select>
        </FormField>
        <FormField label="保底首段直发" hint="always=多内容转发前首块文本先直发；转发失败也不丢核心内容">
          <select v-model="orch.reply.textFallback" class="input-field">
            <option value="always">always（始终直发首段）</option><option value="on_forward_fail">on_forward_fail（转发失败才补发）</option><option value="off">off（关闭）</option>
          </select>
        </FormField>
        <div class="md:col-span-2 xl:col-span-1"><ToggleField v-model="orch.reply.preferNestedForward" label="优先嵌套合并转发" /></div>
        <div class="md:col-span-2 xl:col-span-1"><ToggleField v-model="orch.reply.countProgressInBudget" label="进度消息计入预算" /></div>
        <div class="md:col-span-2 xl:col-span-1"><ToggleField v-model="orch.reply.includeTruncationNotice" label="显示截断说明" /></div>
      </div>
    </SectionCard>

    <SectionCard v-if="replyPolicy" title="ReplyPolicy（统一回复策略）" hint="Agent 与编排共用：硬上限、偏好来源、强制转发与语音默认值" class="mb-4">
      <div class="flex flex-wrap gap-3 mb-4">
        <ToggleField v-model="replyPolicy.enabled" label="启用 ReplyPolicy" hint="关闭时沿用旧回复预算与策略" />
        <ToggleField v-model="replyPolicy.allowModelOverride" label="允许模型请求表现" />
        <ToggleField v-model="replyPolicy.allowSessionPreferences" label="允许会话偏好" />
        <ToggleField v-model="replyPolicy.allowUserPreferences" label="允许用户长期偏好" />
      </div>
      <div class="grid grid-cols-1 md:grid-cols-3 xl:grid-cols-4 gap-4">
        <FormField label="默认语音策略">
          <select v-model="replyPolicy.defaultVoice" class="input-field">
            <option value="auto">auto</option><option value="on">on</option><option value="off">off</option>
          </select>
        </FormField>
        <FormField label="强制转发阈值" hint="文本达到该字符数即强制合并转发（auto/direct/plain/forward 全部模式生效，模型请求 direct 也不可绕过）">
          <input v-model.number="replyPolicy.forcedForwardThreshold" type="number" min="1" max="100000" class="input-field" />
        </FormField>
        <FormField label="硬最大字符数" hint="单条消息不可超过的硬上限">
          <input v-model.number="replyPolicy.hardMaxChars" type="number" min="1" max="100000" class="input-field" />
        </FormField>
        <FormField label="硬最大消息数" hint="最终发送预算，优先生效">
          <input v-model.number="replyPolicy.hardMaxMessages" type="number" min="1" max="100" class="input-field" />
        </FormField>
        <FormField label="会话偏好 TTL (ms)" hint="0 表示不过期">
          <input v-model.number="replyPolicy.sessionPreferenceTtlMs" type="number" min="0" class="input-field" />
        </FormField>
        <FormField label="用户偏好 TTL (ms)" hint="0 表示不过期">
          <input v-model.number="replyPolicy.userPreferenceTtlMs" type="number" min="0" class="input-field" />
        </FormField>
        <FormField label="音频发送约束"><div class="tag">强制直发，不可转发</div></FormField>
        <FormField label="文件发送约束"><div class="tag">强制直发，不可转发</div></FormField>
      </div>
    </SectionCard>

    <SectionCard title="慢任务进度提示" hint="默认关闭图片和音乐进度，避免等待时刷屏；需要时可分别开启。视频默认开启。" class="mb-4">
      <ToggleField v-model="config.bot.progress.enabled" label="启用慢任务进度提示" />
            <div class="grid grid-cols-1 md:grid-cols-3 gap-4 mt-4">
              <ToggleField v-model="config.bot.progress.imageEnabled" label="图片生成/改图/反推进度" />
              <ToggleField v-model="config.bot.progress.videoEnabled" label="视频生成进度" />
              <ToggleField v-model="config.bot.progress.audioEnabled" label="音乐生成进度" />
            </div>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
        <FormField label="图片生成提示" hint="支持 {eta} 占位，例如：收到，正在生成图片{eta}，请稍候…">
          <input v-model="config.bot.progress.imageText" :disabled="!config.bot.progress.imageEnabled" class="input-field" />
        </FormField>
        <FormField label="改图/图片处理提示" hint="支持 {eta} 占位">
          <input v-model="config.bot.progress.editText" :disabled="!config.bot.progress.imageEnabled" class="input-field" />
        </FormField>
        <FormField label="图片反推提示" hint="支持 {eta} 占位">
          <input v-model="config.bot.progress.interrogateText" :disabled="!config.bot.progress.imageEnabled" class="input-field" />
        </FormField>
        <FormField label="视频生成提示" hint="支持 {eta} 占位">
          <input v-model="config.bot.progress.videoText" :disabled="!config.bot.progress.videoEnabled" class="input-field" />
        </FormField>
        <FormField label="音乐生成提示" hint="支持 {eta} 占位；无历史样本时会自动去掉占位符">
          <input v-model="config.bot.progress.audioText" :disabled="!config.bot.progress.audioEnabled" class="input-field" />
        </FormField>
      </div>
      <div class="mt-3">
        <ToggleField v-model="config.bot.progress.showEta" label="显示历史平均耗时区间" />
      </div>
    </SectionCard>

    <SectionCard title="图片压缩与自动撤回" class="mb-4">
      <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
        <ToggleField v-model="config.bot.imageCompression.enabled" label="默认发送压缩图"
          hint="保留原图，可引用后发「原图」取回" />
        <FormField label="压缩倍率" hint="0.65 表示宽高压到 65%">
          <input type="number" min="0.1" max="1" step="0.05" v-model.number="config.bot.imageCompression.scale"
            :disabled="!config.bot.imageCompression.enabled" class="input-field" />
        </FormField>
        <FormField label="JPEG 质量" hint="透明图仍会保留 PNG">
          <input type="number" min="1" max="100" step="1" v-model.number="config.bot.imageCompression.quality"
            :disabled="!config.bot.imageCompression.enabled" class="input-field" />
        </FormField>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4 pt-4 border-t border-[color:var(--hairline-2)]">
        <ToggleField v-model="config.bot.autoRecallImages" label="发图后自动撤回"
          hint="只撤回群里由机器人发出的图片" />
        <FormField label="撤回延迟（秒）">
          <input type="number" min="1" step="1" v-model.number="config.bot.autoRecallDelaySeconds"
            :disabled="!config.bot.autoRecallImages" class="input-field" placeholder="60" />
        </FormField>
      </div>
    </SectionCard>
  </div>
</template>
