<script setup lang="ts">
import { computed, onBeforeUnmount, watch } from 'vue';
import { useConfigStore } from '../stores/config';
import { useCapabilityStore } from '../stores/capabilities';
import AppSelect, { type AppSelectOption } from './AppSelect.vue';

/**
 * 「节点 + 模型」二选一组件。
 *
 * 这段组合在配置里出现十几次，而且下拉列表对生图和对话返回同一份模型——
 * 用户完全可以把 gpt-image-2 填进「日常对话」，然后收获一个看不懂的 400。
 * 这里支持按能力过滤，并把识别到的能力以徽标展示出来。
 *
 * 内部实现（P1 UI 组件化）：节点/模型两个下拉统一换成 AppSelect——
 * 触发器与 .input-field 同形态，面板 portal 挂 body，内置 §3.3 模糊搜索
 * （子序列 / 词首 / 拼音首字母），移动端自动切底部抽屉。
 * 对外契约（props / update:nodeIndex / update:model）保持不变。
 */

const props = defineProps<{
    nodeIndex: number;
    model: string;
    /** 只列出具备该能力的模型（ModelOperation，如 chat / image.generate）；不传则不过滤。 */
    capability?: string;
    /** 追加到下拉里的特殊值，例如 none 表示关闭该能力。 */
    extraModels?: string[];
    disabled?: boolean;
    placeholder?: string;
}>();

const emit = defineEmits<{
    'update:nodeIndex': [value: number];
    'update:model': [value: string];
}>();

const configStore = useConfigStore();
const capabilityStore = useCapabilityStore();

/** 节点下拉：启用中的节点；当前指向的节点若被停用也保留（否则触发器会显示成空）。 */
const nodeOptions = computed<AppSelectOption[]>(() => {
    const list: AppSelectOption[] = configStore.nodeOptions.map(({ node, idx }: any) => ({
        value: idx,
        label: node.name || `节点 ${idx + 1}`,
        alias: String(node.baseUrl || ''),
    }));
    if (!list.some(o => String(o.value) === String(props.nodeIndex))) {
        const node = configStore.config?.llm?.apiKeys?.[Number(props.nodeIndex) || 0];
        const idx = Number(props.nodeIndex) || 0;
        list.unshift({ value: idx, label: node?.name || `节点 ${idx + 1}` });
    }
    return list;
});

const models = computed(() => {
    const all = configStore.modelsForNode(props.nodeIndex, props.model, props.extraModels || []);
    if (!props.capability) return all;
    // 过滤是"尽力而为"：识别不出能力的模型一律保留，
    // 否则中转上那些名字看不出门道的模型会被误伤到一个都选不了。
    return all.filter(id => {
        if (props.extraModels?.includes(id) || id === props.model) return true;
        const caps = capabilityStore.capabilitiesOf(id);
        return !caps.length || caps.includes(props.capability as string);
    });
});

const modelOptions = computed<AppSelectOption[]>(() => models.value.map(m => ({ value: m, label: m })));

const detected = computed(() => capabilityStore.capabilitiesOf(props.model));

// 体检表里没有的模型（用户刚敲进去的）单独问一次后端，徽标才不会一直空着。
// 必须防抖：手输模型名时每敲一个字符都会触发 watch，
// 「gpt-4o-mini」十一个字符就是十一次 POST /api/capabilities/resolve，
// 而中间那十次查的都是不存在的模型前缀。
let resolveTimer: number | undefined;
watch(() => props.model, value => {
    if (resolveTimer) window.clearTimeout(resolveTimer);
    const key = String(value || '').trim();
    if (!key || key === 'none' || capabilityStore.capabilitiesOf(key).length) return;
    const nodeIndex = Number(props.nodeIndex) || 0;
    resolveTimer = window.setTimeout(() => {
        resolveTimer = undefined;
        capabilityStore.resolve(nodeIndex, key);
    }, 400);
}, { immediate: true });

onBeforeUnmount(() => { if (resolveTimer) window.clearTimeout(resolveTimer); });
</script>

<template>
  <div class="grid grid-cols-1 sm:grid-cols-[minmax(0,150px)_minmax(0,1fr)] gap-2">
    <AppSelect
      :model-value="nodeIndex"
      :options="nodeOptions"
      :disabled="disabled"
      @update:model-value="(v: string | number) => emit('update:nodeIndex', Number(v))" />
    <div class="min-w-0">
      <!-- allowCustom：保留旧 input+datalist 的自由输入能力（ComfyUI profile id、中转自定义模型名） -->
      <AppSelect
        :model-value="model"
        :options="modelOptions"
        :disabled="disabled"
        searchable
        allow-custom
        mono
        :placeholder="placeholder || 'gpt-4o-mini'"
        @update:model-value="(v: string | number) => emit('update:model', String(v))" />
      <div v-if="detected.length" class="flex flex-wrap gap-1 mt-1.5">
        <span v-for="cap in detected" :key="cap" class="tag">
          {{ capabilityStore.labels[cap] || cap }}
        </span>
      </div>
    </div>
  </div>
</template>
