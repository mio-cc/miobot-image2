<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import CapabilityPageLayout from '../components/CapabilityPageLayout.vue';
import { useCapabilityStore } from '../stores/capabilities';

/**
 * 通用能力详情页：任何注册进能力注册表的 id（包括新增的 fake capability）
 * 都自动套 CapabilityPageLayout 成页，不需要为每个能力手写页面。
 * R16/4.1：有专属完整配置页的能力（生图/音乐/语音/文件/记忆）自动转发，
 * 能力中心卡片的统一入口是 /capabilities/<id>。
 */

const route = useRoute();
const capabilityStore = useCapabilityStore();

const capabilityId = computed(() => String(route.params.id || ''));
const featureId = computed(() => (capabilityStore.bindings.some(item => item.key === capabilityId.value) ? capabilityId.value : ''));

const knownPages: Record<string, string> = {
    'image.generate': '/cap-image',
    'image.edit': '/cap-image',
    'image.interrogate': '/cap-image',
    'audio.music.generate': '/cap-music',
    'tts.speak': '/cap-voice',
    'file.read': '/cap-file',
    'file.list': '/cap-file',
    'memory.search': '/cap-memory',
};
</script>

<template>
  <CapabilityPageLayout v-if="capabilityId" :capability-id="capabilityId" :feature-id="featureId"
    :subtitle="'能力注册表自动生成页面；该能力可在「能力中心」搜索进入' + (knownPages[capabilityId] ? '，专属完整配置页在「' + knownPages[capabilityId] + '」' : '')" />
  <div v-else class="text-sm text-[color:var(--ink-3)]">
    未知能力。回到 <router-link class="underline" to="/capabilities">能力中心</router-link> 重新选择。
  </div>
</template>