<script setup lang="ts">
/**
 * MCP 参数默认值编辑器（2026-11-07 拍板）：键值对 + 锁定开关。
 * 语义：非锁定 = 仅作默认（模型可显式传参覆盖）；锁定 = 无论模型传什么都以此为准。
 * 消费点在根工具 handler 转发前的确定性合并（不靠提示词）——本组件只编辑
 * orchestration.mcpServers[].paramDefaults / childParamDefaults[toolName]。
 * 键为自由输入（授权前拿不到子项 schema，不预判键名）；值智能解析 number/boolean/string。
 */
import { computed } from 'vue';

interface Rule { value: string | number | boolean; locked?: boolean }

const props = defineProps<{ modelValue?: Record<string, Rule>; keySuggestions?: string[]; emptyText?: string }>();
const emit = defineEmits<{ (e: 'update:modelValue', value: Record<string, Rule>): void }>();

const rules = computed<Record<string, Rule>>(() => props.modelValue || {});
const entries = computed(() => Object.entries(rules.value));

function update(next: Record<string, Rule>) { emit('update:modelValue', next); }
function parseValue(text: string): string | number | boolean {
  const trimmed = text.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return text;
}
function setKey(oldKey: string, newKey: string) {
  const key = newKey.trim().slice(0, 120);
  if (!key || key === oldKey) return;
  const next = Object.fromEntries(Object.entries(rules.value).filter(([k]) => k !== oldKey));
  next[key] = rules.value[oldKey];
  update(next);
}
function setValue(key: string, text: string) {
  update({ ...rules.value, [key]: { ...rules.value[key], value: parseValue(text) } });
}
function toggleLock(key: string) {
  update({ ...rules.value, [key]: { ...rules.value[key], locked: !rules.value[key].locked } });
}
function removeRule(key: string) {
  const next = { ...rules.value };
  delete next[key];
  update(next);
}
function addRule() {
  let index = 1;
  while (rules.value[`key${index}`] !== undefined) index += 1;
  update({ ...rules.value, [`key${index}`]: { value: '' } });
}
</script>

<template>
  <div>
    <div v-if="!entries.length" class="flex flex-wrap items-center gap-3">
      <span class="text-xs text-[color:var(--ink-3)]">{{ emptyText || '未配置——子项调用时完全使用模型传参' }}</span>
      <button type="button" class="btn-outline !px-3 !py-1 !text-xs" @click="addRule">+ 加一个参数</button>
    </div>
    <div v-else class="space-y-2">
      <div v-for="[key, rule] in entries" :key="key" class="field-box">
        <div class="grid grid-cols-1 md:grid-cols-[minmax(140px,1fr)_minmax(140px,1.2fr)_auto_auto] gap-2 items-center">
          <input class="input-field !py-1 text-xs font-mono" :value="key" list="param-default-keys"
            placeholder="参数名（如 model）" @change="setKey(key, ($event.target as HTMLInputElement).value)" />
          <input class="input-field !py-1 text-xs font-mono" :value="String(rule.value)"
            placeholder="默认值（数字/true/false/文本）" @input="setValue(key, ($event.target as HTMLInputElement).value)" />
          <button type="button" class="btn-outline !px-2.5 !py-1 !text-xs"
            :class="rule.locked ? '!text-red-500 !border-red-400/60' : ''"
            :title="rule.locked ? '锁定：无论模型传什么都以此为准' : '仅作默认：模型可显式传参覆盖'"
            @click="toggleLock(key)">{{ rule.locked ? '🔒 锁定' : '仅默认' }}</button>
          <button type="button" class="btn-outline !px-1.5 !py-1 !text-xs !text-red-500" @click="removeRule(key)">×</button>
        </div>
      </div>
      <div class="flex flex-wrap items-center gap-3">
        <button type="button" class="btn-outline !px-3 !py-1 !text-xs" @click="addRule">+ 加一个参数</button>
        <span class="text-xs text-[color:var(--ink-3)]">「仅默认」只在该参数缺失时填入；「锁定」强制覆盖模型传参并把锁定状态告诉模型</span>
      </div>
    </div>
    <datalist id="param-default-keys">
      <option v-for="suggestion in keySuggestions || []" :key="suggestion" :value="suggestion" />
    </datalist>
  </div>
</template>
