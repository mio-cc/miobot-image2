<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import CapabilityPageLayout from '../components/CapabilityPageLayout.vue';
import { useCapabilityStore } from '../stores/capabilities';

/**
 * 通用能力详情页：任何注册进能力注册表的 id（包括新增的 fake capability）
 * 都自动套 CapabilityPageLayout 成页，不需要为每个能力手写页面。
 * 有专属页面的能力（生图/音乐/语音等）由目录页直接链接到专属路由。
 */

const route = useRoute();
const capabilityStore = useCapabilityStore();

const capabilityId = computed(() => String(route.params.id || ''));
const featureId = computed(() => (capabilityStore.bindings.some(item => item.key === capabilityId.value) ? capabilityId.value : ''));

const knownPages: Record<string, string> = {
    'image.generate': '/cap-image',
    'audio.music.generate': '/cap-music',
    'tts.speak': '/cap-voice',
};
</script>

<template>
  <CapabilityPageLayout :capability-id="capabilityId" :feature-id="featureId"
    :subtitle="'能力注册表自动生成页面' + (knownPages[capabilityId] ? '；该能力有专属配置页，可从「权限与审批 → 能力目录」进入' : '')" />
</template>
