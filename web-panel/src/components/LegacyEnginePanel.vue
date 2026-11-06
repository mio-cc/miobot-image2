<script setup lang="ts">
import { computed } from 'vue';
import SectionCard from './SectionCard.vue';
import FormField from './FormField.vue';
import ToggleField from './ToggleField.vue';
import AppSelect from './AppSelect.vue';

/**
 * 旧引擎参数面板（agent.mode = off 时走旧链路，以下参数才生效；enforce/shadow 下仅作保留）。
 * 自 AgentPage 拆出（纯模板搬移）：config 由父页传入同一对象引用，v-model 直写成员，
 * 绑定表达式与拆分前完全一致。
 */
const props = defineProps<{ config: any }>();
/* 桥接转发：让模板内的 config 引用与拆分前逐字一致。 */
const config = computed(() => props.config);

/* ═══ 显式命令推理强度与异步视频（旧引擎链路参数）═══ */
const llmReasoningEffortOptions = [
    { value: 'low', label: 'low' },
    { value: 'medium', label: 'medium' },
    { value: 'high', label: 'high' },
    { value: 'xhigh', label: 'xhigh' },
];
</script>

<template>
  <SectionCard v-if="config" title="旧引擎参数" hint="agent.mode = off 时走旧链路，以下参数才生效；enforce/shadow 下仅作保留" class="mb-4">
      <details class="fold-group">
        <summary>自由模式规划（freeMode · @bot 直接说话）</summary>
        <div class="fold-body grid grid-cols-1 md:grid-cols-3 gap-4">
          <div class="flex items-end"><ToggleField v-model="config.freeMode.enabled" label="启用自由模式" hint="关闭后自然语言意图直接走命令分流" /></div>
          <FormField label="规划超时 (ms)" hint="min 30000"><input v-model.number="config.freeMode.timeoutMs" type="number" min="30000" step="30000" class="input-field" /></FormField>
          <FormField label="最多输入图" hint="0-12"><input v-model.number="config.freeMode.maxInputImages" type="number" min="0" max="12" class="input-field" /></FormField>
          <FormField label="最多输出图" hint="1-4"><input v-model.number="config.freeMode.maxOutputImages" type="number" min="1" max="4" class="input-field" /></FormField>
          <div class="flex items-end"><ToggleField v-model="config.freeMode.includeQuotedMessage" label="读取被引用的消息" /></div>
          <div class="flex items-end md:col-span-2"><ToggleField v-model="config.freeMode.preferEditWhenImagePresent" label="有图时优先按改图处理" /></div>
        </div>
      </details>

      <details class="fold-group mt-3">
        <summary>自然语言意图识别（intentRecognition · 旧引擎命令分流）</summary>
        <div class="fold-body grid grid-cols-1 md:grid-cols-3 gap-4">
          <div class="flex items-end"><ToggleField v-model="config.intentRecognition.enabled" label="启用意图识别" hint="关闭后自然语言直接回退正则 / FreeMode 兜底" /></div>
          <FormField label="超时 (ms)" hint="3000-60000"><input v-model.number="config.intentRecognition.timeoutMs" type="number" min="3000" max="60000" step="1000" class="input-field" /></FormField>
          <FormField label="maxTokens"><input v-model.number="config.intentRecognition.maxTokens" type="number" min="1" max="200000" step="10" class="input-field" /></FormField>
          <FormField label="最低置信度" hint="0-1，低于则不执行"><input v-model.number="config.intentRecognition.minConfidence" type="number" min="0" max="1" step="0.05" class="input-field" /></FormField>
          <p class="md:col-span-3 text-[11px] text-[color:var(--ink-3)]">意图识别提示词在「提示词注册表」（intent.recognize 条目）统一编辑。</p>
        </div>
      </details>

      <details class="fold-group mt-3">
        <summary>旧引擎会话限制（llm · 会话轮数 / 字符 / 有效期 / 推理强度）</summary>
        <div class="fold-body grid grid-cols-1 md:grid-cols-3 gap-4">
          <FormField label="历史上限轮数" hint="maxConversationRounds"><input v-model.number="config.llm.maxConversationRounds" type="number" min="1" class="input-field" /></FormField>
          <FormField label="历史字符上限" hint="maxConversationChars"><input v-model.number="config.llm.maxConversationChars" type="number" min="500" class="input-field" /></FormField>
          <FormField label="会话有效期（分钟）" hint="sessionTtlMinutes，0-1440"><input v-model.number="config.llm.sessionTtlMinutes" type="number" min="0" max="1440" class="input-field" /></FormField>
          <FormField label="显式命令推理强度" hint="llm.reasoningEffort · 显式命令执行器用；Agent 循环用上方 agent.reasoningEffort" class="md:col-span-3">
            <AppSelect v-model="config.llm.reasoningEffort" :options="llmReasoningEffortOptions" />
          </FormField>
        </div>
      </details>

      <details class="fold-group mt-3">
        <summary>视频生成任务等待（llm.video* · 异步提交与轮询）</summary>
        <div class="fold-body grid grid-cols-1 md:grid-cols-3 gap-4">
          <div class="flex items-end"><ToggleField v-model="config.llm.videoEnabled" label="启用视频生成" hint="运行时门禁：explicit-executor.ts:108 / runtime.ts:430" /></div>
          <FormField label="单次请求超时 (ms)" hint="提交任务与每次轮询各自的 HTTP 超时"><input v-model.number="config.llm.videoTimeoutMs" type="number" min="30000" step="30000" class="input-field" /></FormField>
          <FormField label="轮询总上限 (ms)" hint="含排队，生成通常 1-5 分钟"><input v-model.number="config.llm.videoPollTimeoutMs" type="number" min="60000" class="input-field" /></FormField>
          <FormField label="轮询间隔 (ms)"><input v-model.number="config.llm.videoPollIntervalMs" type="number" min="1000" step="1000" class="input-field" /></FormField>
          <div class="md:col-span-3 text-[11px] text-[color:var(--ink-3)] leading-relaxed">
            QQ 侧限制：WebSocket 帧上限 50MB，base64 会把体积撑大约 1.34 倍，超过 ~37MB 的视频走 base64 会顶断连接；
            系统会先检查大小，超限时改用文件路径发送或提示改走文件；配置「Docker 路径映射」可完全避开 base64。
          </div>
        </div>
      </details>
  </SectionCard>
</template>
