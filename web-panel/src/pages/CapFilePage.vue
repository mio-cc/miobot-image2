<script setup lang="ts">
import { computed } from 'vue';
import { useConfigStore } from '../stores/config';
import CapabilityPageLayout from '../components/CapabilityPageLayout.vue';
import FormField from '../components/FormField.vue';
import ToggleField from '../components/ToggleField.vue';

/**
 * 文件能力页（file.read / file.generate / file.list）。
 * 读取限额自 BotPage 迁入（BotPage 已在 TR.4 拆除）。
 */

const configStore = useConfigStore();
const config = computed(() => configStore.config);
</script>

<template>
  <CapabilityPageLayout capability-id="file.read" feature-id="file.read"
    title="文件" advanced-title="读取与解析限额"
    subtitle="文件消息只登记元数据；用户引用文件或发送文件编号后才下载和解析">
    <template #advanced>
      <div v-if="config" class="grid grid-cols-1 md:grid-cols-3 xl:grid-cols-4 gap-4">
        <div class="flex items-end"><ToggleField v-model="config.bot.files.enabled" label="启用文件读取" /></div>
        <FormField label="索引保留（分钟）" hint="默认 1440 = 24 小时">
          <input type="number" min="1" max="10080" v-model.number="config.bot.files.indexTtlMinutes" class="input-field" />
        </FormField>
        <FormField label="每个会话文件数" hint="超出后淘汰最旧记录">
          <input type="number" min="10" max="1000" v-model.number="config.bot.files.maxIndexPerChat" class="input-field" />
        </FormField>
        <FormField label="单文件上限（MB）" hint="下载和解析的硬上限">
          <input type="number" min="1" max="50" v-model.number="config.bot.files.maxFileSizeMB" class="input-field" />
        </FormField>
        <FormField label="最大提取字符数">
          <input type="number" min="1000" max="200000" step="1000" v-model.number="config.bot.files.maxTextChars" class="input-field" />
        </FormField>
        <FormField label="PDF 最大页数">
          <input type="number" min="1" max="200" v-model.number="config.bot.files.maxPdfPages" class="input-field" />
        </FormField>
        <FormField label="表格最大行数">
          <input type="number" min="10" max="2000" v-model.number="config.bot.files.maxSpreadsheetRows" class="input-field" />
        </FormField>
        <FormField label="PPT 最大页数">
          <input type="number" min="1" max="200" v-model.number="config.bot.files.maxSlideCount" class="input-field" />
        </FormField>
        <FormField label="压缩包最大条目数">
          <input type="number" min="10" max="2000" v-model.number="config.bot.files.maxArchiveEntries" class="input-field" />
        </FormField>
        <FormField label="压缩包解压上限（MB）">
          <input type="number" min="1" max="200" v-model.number="config.bot.files.maxArchiveUncompressedMB" class="input-field" />
        </FormField>
      </div>
      <p class="text-[color:var(--ink-3)] text-xs mt-3">
        支持 txt/md/csv/json/yaml/xml、PDF 文本、DOCX、XLSX、PPTX、ZIP 和 APK 元数据。APK 只做静态信息分析，不执行文件。
        生成格式的说法示例见「命令与意图」页。
      </p>
    </template>
  </CapabilityPageLayout>
</template>
