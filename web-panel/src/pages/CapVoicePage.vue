<script setup lang="ts">
import { computed } from 'vue';
import { useConfigStore } from '../stores/config';
import SectionCard from '../components/SectionCard.vue';
import FormField from '../components/FormField.vue';
import ToggleField from '../components/ToggleField.vue';

/**
 * 语音能力页。
 * 由原 OrchestrationPage 的「FishAudio 音色自助」卡迁入；
 * TR.2/TR.3 会把 VoicePage（bot.tts 合成）也并入此页。
 */

const configStore = useConfigStore();
const config = computed(() => configStore.config);
const orch = computed(() => config.value?.orchestration);
</script>

<template>
  <div v-if="config && orch">
    <header class="mb-4">
      <h1 class="page-title mb-0.5">语音</h1>
      <p class="text-[color:var(--ink-3)] text-xs">
        FishAudio 音色自助：用户候选短期保存；个人偏好按群/私聊隔离。
      </p>
    </header>

    <SectionCard title="FishAudio 音色自助" hint="用户候选短期保存；个人偏好按群/私聊隔离" class="mb-4">
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
  </div>
</template>
