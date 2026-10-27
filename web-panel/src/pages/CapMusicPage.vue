<script setup lang="ts">
import { computed, ref } from 'vue';
import { useConfigStore } from '../stores/config';
import CapabilityPageLayout from '../components/CapabilityPageLayout.vue';
import FormField from '../components/FormField.vue';
import ToggleField from '../components/ToggleField.vue';
import ModelPicker from '../components/ModelPicker.vue';

/**
 * 音乐能力页（audio.music.generate，Suno 官方 API）。
 * 骨架：CapabilityPageLayout；高级参数 = Suno 接入与 composer 配置。
 */

const configStore = useConfigStore();
const config = computed(() => configStore.config);
const orch = computed(() => config.value?.orchestration);
const sunoKeyVisible = ref(false);
</script>

<template>
  <CapabilityPageLayout capability-id="audio.music.generate" feature-id="audio.music.generate"
    title="音乐（Suno）" advanced-title="Suno 官方 API"
    subtitle="Suno 官方 API 接入：composer 提示词、请求与轮询、配额与歌曲历史；不内置计费">
    <template #advanced>
      <div v-if="orch" class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        <div class="md:col-span-2 xl:col-span-1"><ToggleField v-model="orch.suno.enabled" label="启用 Suno" /></div>
        <FormField label="Provider"><input v-model="orch.suno.provider" class="input-field font-mono" readonly /></FormField>
        <FormField label="API 版本"><select v-model="orch.suno.requestMode" class="input-field"><option value="v6">SunoAPI V6</option><option value="legacy">Legacy Poll API</option></select></FormField>
        <FormField label="Callback URL" hint="V6 创建任务必填；完整地址需包含 /api/orchestration/suno/callback/&lt;Callback Secret&gt;"><input v-model="orch.suno.callbackUrl" class="input-field font-mono" placeholder="https://bot.example/api/orchestration/suno/callback/&lt;secret&gt;" /></FormField>
        <FormField label="Callback Secret" hint="用于校验回调；留空则 V6 回调不可用"><input v-model="orch.suno.callbackSecret" type="password" class="input-field font-mono" /></FormField>
        <FormField label="Composer 节点与模型" hint="把用户请求改写成 Suno 生成参数的模型">
          <ModelPicker capability="chat"
            :node-index="Number(orch.suno.composerNodeIndex) || 0" :model="orch.suno.composerModel || ''"
            @update:node-index="orch.suno.composerNodeIndex = $event"
            @update:model="orch.suno.composerModel = $event" />
        </FormField>
        <FormField label="Composer 温度" hint="建议 0.3 到 0.8"><input v-model.number="orch.suno.composerTemperature" type="number" min="0" max="2" step="0.05" class="input-field" /></FormField>
        <FormField label="Composer maxTokens" hint="生成歌词和 JSON 的上限；复杂完整歌词建议 6000 以上"><input v-model.number="orch.suno.composerMaxTokens" type="number" min="1" max="200000" step="100" class="input-field" /></FormField>
        <FormField label="Composer 覆盖提示词" hint="留空使用内置 Suno V2；可用 {{userText}}、{{supplied}}、{{schema}}、{{model}}、{{defaultVocalGender}}、{{defaultLanguage}}">
          <textarea v-model="orch.suno.composerPromptTemplate" rows="5" class="input-field font-mono text-xs"></textarea>
        </FormField>
        <FormField label="默认人声性别" hint="auto 由模型决定；m/f 仅在 customMode 下传给 Suno，且官方说明只是偏好、不保证命中"><select v-model="orch.suno.defaultVocalGender" class="input-field"><option value="auto">auto / 不指定</option><option value="m">男声 m</option><option value="f">女声 f</option></select></FormField>
        <FormField label="默认歌词语言" hint="留空或 auto 跟随用户；例如 中文、日语、English。Suno 没有独立 language 字段，会写入 prompt/style/lyrics"><input v-model="orch.suno.defaultLanguage" class="input-field" placeholder="auto" /></FormField>
        <div class="flex items-end"><ToggleField v-model="orch.suno.sendLyricsWithMusic" label="同步发送歌词" hint="使用 Suno 返回的真实 lyrics，走合并转发；需要 reply.maxMessages ≥ 2" /></div>
        <FormField label="歌曲历史保留" hint="每个会话/用户最多保留多少首"><input v-model.number="orch.suno.historyMaxRecords" type="number" min="1" max="1000" class="input-field" /></FormField>
        <FormField label="Planner 注入历史" hint="每次规划注入最近多少首歌曲摘要"><input v-model.number="orch.suno.historyPromptLimit" type="number" min="1" max="50" class="input-field" /></FormField>
        <FormField label="Base URL"><input v-model="orch.suno.baseUrl" class="input-field font-mono" placeholder="https://官方 API 地址" /></FormField>
        <FormField label="模型"><input v-model="orch.suno.model" class="input-field font-mono" /></FormField>
        <FormField label="创建路径"><input v-model="orch.suno.createPath" class="input-field font-mono" placeholder="/api/v1/generate" /></FormField>
        <FormField label="状态路径"><input v-model="orch.suno.statusPath" class="input-field font-mono" placeholder="/api/v1/generate/record-info?taskId={id}" /></FormField>
        <FormField label="鉴权 Header"><input v-model="orch.suno.authHeader" class="input-field font-mono" placeholder="Authorization" /></FormField>
        <FormField label="鉴权前缀"><input v-model="orch.suno.authPrefix" class="input-field font-mono" placeholder="Bearer " /></FormField>
        <FormField label="API Key" hint="留遮罩值表示不修改">
          <div class="flex gap-2">
            <input v-model="orch.suno.apiKey" :type="sunoKeyVisible ? 'text' : 'password'" class="input-field font-mono" />
            <button class="btn-outline !px-2" type="button" @click="sunoKeyVisible = !sunoKeyVisible">{{ sunoKeyVisible ? '隐藏' : '显示' }}</button>
          </div>
        </FormField>
        <FormField label="任务等待超时 (ms)" hint="Suno 是远程异步生成，通常需要数分钟；最低 10 分钟，不是单次 HTTP 超时"><input v-model.number="orch.suno.timeoutMs" type="number" min="600000" step="30000" class="input-field" /></FormField>
        <FormField label="轮询间隔 (ms)"><input v-model.number="orch.suno.pollIntervalMs" type="number" min="500" class="input-field" /></FormField>
        <FormField label="最大时长 (秒)"><input v-model.number="orch.suno.maxDurationSeconds" type="number" min="5" class="input-field" /></FormField>
        <FormField label="格式"><select v-model="orch.suno.format" class="input-field"><option value="mp3">mp3</option><option value="wav">wav</option><option value="flac">flac</option></select></FormField>
        <FormField label="最大并发"><input v-model.number="orch.suno.maxConcurrent" type="number" min="1" class="input-field" /></FormField>
        <FormField label="队列上限"><input v-model.number="orch.suno.maxQueue" type="number" min="1" class="input-field" /></FormField>
        <FormField label="最大重试"><input v-model.number="orch.suno.maxRetries" type="number" min="0" max="10" class="input-field" /></FormField>
        <FormField label="每日配额"><input v-model.number="orch.suno.quotaPerUserPerDay" type="number" min="0" class="input-field" /></FormField>
      </div>
    </template>
  </CapabilityPageLayout>
</template>
