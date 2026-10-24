<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useConfigStore } from '../stores/config';
import CapabilityPageLayout from '../components/CapabilityPageLayout.vue';
import SectionCard from '../components/SectionCard.vue';
import FormField from '../components/FormField.vue';
import ToggleField from '../components/ToggleField.vue';

/**
 * 语音能力页（tts.speak + voice.*）。
 * 语音类全部归此（§2.6.2）：TTS 合成（bot.tts）+ 朗读前改写 + FishAudio 音色自助
 * （orch.voice）。原 VoicePage 内容已并入，/voice 路由重定向到这里。
 */

const configStore = useConfigStore();
const config = computed(() => configStore.config);
const orch = computed(() => config.value?.orchestration);
const tts = computed(() => config.value?.bot?.tts);

const voiceIdsText = ref('');
watch(tts, value => { voiceIdsText.value = (value?.voiceIds || []).join(', '); }, { immediate: true });

function commitVoiceIds() {
    tts.value.voiceIds = voiceIdsText.value.split(/[,，\s]+/).map(s => s.trim()).filter(Boolean);
    voiceIdsText.value = tts.value.voiceIds.join(', ');
}

const isFish = computed(() => tts.value?.provider === 'fish-audio');
</script>

<template>
  <CapabilityPageLayout capability-id="tts.speak"
    title="语音" models-title="语音合成（TTS）" prompts-title="朗读前文本改写" advanced-title="TTS 高级参数"
    subtitle="TTS 合成、朗读改写与 FishAudio 音色自助；语音类全部归此">
    <template #intro>
      <div class="card p-4 mb-4">
        <div class="text-sm font-semibold mb-1">先确认 NapCat 能发语音</div>
        <p class="text-xs text-[color:var(--ink-2)] leading-relaxed">
          QQ 的语音必须是 <span class="mono">silk</span> 编码。NapCat 里只有 Native Addon 适配器实现了转码——
          装了命令行 ffmpeg <b>并不等于</b>能发语音。合成出来的 mp3/wav 如果没人转码，
          发送会直接失败，日志里表现为 NapCat 侧报错而不是这里报错。
          部署前建议先在 NapCat 后台确认语音功能可用。
        </p>
      </div>
    </template>

    <template #models>
      <div v-if="tts" class="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div class="flex items-end"><ToggleField v-model="tts.enabled" label="启用语音回复" /></div>
        <FormField label="服务商" hint="不同服务商的字段含义不同，切换后请检查下面各项">
          <select v-model="tts.provider" class="input-field">
            <option value="fish-audio">Fish Audio</option>
            <option value="openai-compatible">OpenAI 兼容 /audio/speech</option>
          </select>
        </FormField>
        <FormField label="API 地址">
          <input v-model="tts.apiUrl" class="input-field font-mono"
            :placeholder="isFish ? 'https://api.fish.audio/v1/tts' : 'https://api.openai.com/v1/audio/speech'" />
        </FormField>
        <FormField label="API Key" hint="留着打码值表示不修改">
          <input v-model="tts.apiKey" type="password" class="input-field font-mono" />
        </FormField>
        <FormField v-if="isFish" label="主音色 ID" hint="Fish Audio 后台的 reference id">
          <input v-model="tts.voiceId" class="input-field font-mono" placeholder="例如 7f92f8afb8ec43bf81429cc1c9199cb1" />
        </FormField>
        <FormField v-else label="音色" hint="OpenAI 用 alloy / echo / nova 等">
          <input v-model="tts.voice" class="input-field font-mono" placeholder="alloy" />
        </FormField>
        <FormField label="模型" :hint="isFish ? 'Fish Audio 的 model 请求头。当前免费：s2.1-pro-free；付费：s2.1-pro / s2-pro / s1' : '如 gpt-4o-mini-tts / tts-1'">
          <input v-model="tts.model" class="input-field font-mono" :placeholder="isFish ? 's2.1-pro-free' : 'tts-1'" />
          <p v-if="isFish" class="text-xs text-[color:var(--ink-3)] mt-1">
            实际发送的请求头 model：<span class="mono">{{ tts.model || 's2.1-pro-free' }}</span>
          </p>
        </FormField>
        <FormField label="音频格式">
          <select v-model="tts.format" class="input-field">
            <option value="mp3">mp3</option><option value="wav">wav</option><option value="opus">opus</option>
          </select>
        </FormField>
        <div v-if="isFish" class="md:col-span-3">
          <FormField label="备用音色 ID" hint="多个用逗号分隔；主音色不可用时依次尝试">
            <input v-model="voiceIdsText" @blur="commitVoiceIds" class="input-field font-mono" placeholder="留空即可" />
          </FormField>
        </div>
      </div>
    </template>

    <template #prompts>
      <div v-if="tts">
        <div class="grid grid-cols-1 xl:grid-cols-2 gap-4">
          <FormField label="改写模型" hint="用一个便宜的小模型就够了">
            <input v-model="tts.preprocess.model" class="input-field font-mono" :disabled="!tts.preprocess.enabled" />
          </FormField>
          <div class="flex items-end">
            <ToggleField v-model="tts.preprocess.enabled" label="启用改写" hint="回复里的 Markdown、链接、代码块直接念出来很难听，开启后先让模型改写成口语文本" />
          </div>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-4 gap-4 mt-4">
          <FormField label="改写节点索引">
            <input v-model.number="tts.preprocess.nodeIndex" type="number" min="0" class="input-field" :disabled="!tts.preprocess.enabled" />
          </FormField>
          <FormField label="超时 (ms)">
            <input v-model.number="tts.preprocess.timeoutMs" type="number" min="5000" step="5000"
              :disabled="!tts.preprocess.enabled" class="input-field" />
          </FormField>
          <FormField label="发送前延迟 (ms)" hint="给 QQ 留出处理间隔">
            <input v-model.number="tts.preprocess.delayMs" type="number" min="0" step="100"
              :disabled="!tts.preprocess.enabled" class="input-field" />
          </FormField>
          <FormField label="输出上限（字）">
            <input v-model.number="tts.preprocess.maxOutputChars" type="number" min="50" step="50"
              :disabled="!tts.preprocess.enabled" class="input-field" />
          </FormField>
        </div>
        <div class="mt-4">
          <ToggleField v-model="tts.preprocess.fallbackToOriginal" label="改写失败时用原文"
            hint="关掉的话改写一失败就整条不发语音了" :disabled="!tts.preprocess.enabled" />
        </div>
        <div class="mt-4">
          <div class="flex items-center justify-between mb-1">
            <span class="label-sm !mb-0">改写提示词</span>
            <button class="text-xs hover:underline"
              @click="configStore.resetPrompt('bot.tts.preprocess.promptTemplate', 'ttsPreprocessPromptTemplate')">恢复默认</button>
          </div>
          <textarea v-model="tts.preprocess.promptTemplate" rows="6" class="input-field font-mono text-xs"
            :disabled="!tts.preprocess.enabled" placeholder="占位符 {{text}}"></textarea>
        </div>
      </div>
    </template>

    <template #advanced>
      <div v-if="tts" class="grid grid-cols-1 md:grid-cols-5 gap-4">
        <FormField label="自动朗读上限（字）" hint="超过这个长度就只发文字，不合成语音">
          <input v-model.number="tts.autoTextMaxChars" type="number" min="0" max="2000" step="10" class="input-field" />
        </FormField>
        <FormField label="超时 (ms)" hint="长文本会按字数自动延长，最高 300000ms">
          <input v-model.number="tts.timeoutMs" type="number" min="5000" step="5000" class="input-field" />
        </FormField>
        <FormField label="语速" hint="1 为正常">
          <input v-model.number="tts.speed" type="number" min="0.5" max="2" step="0.05" class="input-field" />
        </FormField>
        <FormField label="音量增益" hint="0 为不调整">
          <input v-model.number="tts.volume" type="number" min="-20" max="20" step="1" class="input-field" />
        </FormField>
        <FormField label="延迟模式" hint="low 更快但音质略降">
          <select v-model="tts.latency" class="input-field">
            <option value="normal">normal</option><option value="balanced">balanced</option><option value="low">low</option>
          </select>
        </FormField>
      </div>
    </template>

    <template #extra>
      <SectionCard v-if="orch" title="FishAudio 音色自助" hint="用户候选短期保存；个人偏好按群/私聊隔离" class="mb-4">
        <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
          <div class="md:col-span-2 xl:col-span-1"><ToggleField v-model="orch.voice.enabled" label="启用音色管理" /></div>
          <div class="md:col-span-2 xl:col-span-1"><ToggleField v-model="orch.voice.userCanChange" label="允许用户修改音色" /></div>
          <div class="md:col-span-2 xl:col-span-1"><ToggleField v-model="orch.voice.licensedOnly" label="只展示已授权音色" /></div>
          <FormField label="允许场景">
            <select v-model="orch.voice.allowedScopes" class="input-field"><option value="both">私聊和群聊</option><option value="private">仅私聊</option><option value="group">仅群聊</option></select>
          </FormField>
          <FormField label="最大候选数"><input v-model.number="orch.voice.maxCandidates" type="number" min="1" max="10" class="input-field" /></FormField>
          <FormField label="候选有效期 (ms)"><input v-model.number="orch.voice.candidateTtlMs" type="number" min="60000" class="input-field" /></FormField>
          <FormField label="试听冷却 (ms)"><input v-model.number="orch.voice.previewCooldownMs" type="number" min="0" class="input-field" /></FormField>
          <FormField label="每日试听上限"><input v-model.number="orch.voice.previewDailyLimit" type="number" min="0" class="input-field" /></FormField>
          <FormField label="试听文本上限"><input v-model.number="orch.voice.previewMaxChars" type="number" min="1" max="200" class="input-field" /></FormField>
          <FormField label="FishAudio 音色 API"><input v-model="orch.voice.voicesApiUrl" class="input-field font-mono" placeholder="https://api.fish.audio/model" /></FormField>
        </div>
      </SectionCard>
    </template>
  </CapabilityPageLayout>
</template>
