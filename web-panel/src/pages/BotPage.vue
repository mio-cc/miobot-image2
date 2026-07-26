<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useConfigStore } from '../stores/config';
import SectionCard from '../components/SectionCard.vue';
import FormField from '../components/FormField.vue';
import ToggleField from '../components/ToggleField.vue';

const configStore = useConfigStore();
const config = computed(() => configStore.config);

/**
 * 名单类输入用独立文本 ref，失焦时才写回数组。
 * 直接「:value 格式化 + @input 立即 split/filter」的写法里，每敲一个逗号都会被
 * filter(Boolean) 吃掉，结果是根本没法输入第二个条目。
 */
const ownersText = ref('');
const whitelistGroupsText = ref('');
const whitelistPrivateText = ref('');
const blacklistText = ref('');

function syncFromConfig() {
    const bot = config.value?.bot;
    if (!bot) return;
    ownersText.value = (bot.ownerQQs || []).join(', ');
    whitelistGroupsText.value = (bot.whitelistGroups || []).join(', ');
    whitelistPrivateText.value = (bot.whitelistPrivate || []).join(', ');
    blacklistText.value = (bot.blacklistGroupUsers || []).join('\n');
}
watch(() => config.value?.bot, syncFromConfig, { immediate: true });

function splitList(value: string, separator: RegExp) {
    return value.split(separator).map(item => item.trim()).filter(Boolean);
}

function commitOwners() {
    config.value.bot.ownerQQs = splitList(ownersText.value, /[,，\s]+/);
    ownersText.value = config.value.bot.ownerQQs.join(', ');
}
function commitWhitelistGroups() {
    config.value.bot.whitelistGroups = splitList(whitelistGroupsText.value, /[,，\s]+/);
    whitelistGroupsText.value = config.value.bot.whitelistGroups.join(', ');
}
function commitWhitelistPrivate() {
    config.value.bot.whitelistPrivate = splitList(whitelistPrivateText.value, /[,，\s]+/);
    whitelistPrivateText.value = config.value.bot.whitelistPrivate.join(', ');
}
function commitBlacklist() {
    config.value.bot.blacklistGroupUsers = splitList(blacklistText.value, /[\n,，]+/);
    blacklistText.value = config.value.bot.blacklistGroupUsers.join('\n');
}

const strategyOptions = [
    { value: 'forward', label: '合并转发' },
    { value: 'quote', label: '引用原消息' },
    { value: 'at', label: '@ 提问者' },
    { value: 'plain', label: '普通消息' },
];

const commandFields = [
    { key: 'genImage', label: '文生图', placeholder: '生图, 画, draw', hint: '群里可不 @ 直接使用' },
    { key: 'img2Img', label: '图生图 / 参考图', placeholder: '图生图, 参考图, i2i', hint: '' },
    { key: 'editImage', label: '改图 / 编辑', placeholder: '改图, 编辑, edit', hint: '' },
    { key: 'interrogate', label: '反推提示词', placeholder: '反推, 看图, 描述', hint: '' },
    { key: 'originalImage', label: '获取原图', placeholder: '原图, original', hint: '引用机器人发的压缩图后使用' },
    { key: 'templateLibrary', label: '本地模板库', placeholder: '模板库, mb', hint: '' },
    { key: 'referencedTemplateImage', label: '引用模板生图', placeholder: '套模板, rt', hint: '需要先引用一条模板消息' },
    { key: 'remotePromptSearch', label: '远程模板库搜索', placeholder: 'pp, 远程模板', hint: '支持中文关键词' },
    { key: 'remotePromptSmartImage', label: '远程智能套模板', placeholder: 'spp', hint: '' },
    { key: 'help', label: '帮助', placeholder: '/help, 帮助', hint: '帮助内容自动生成，改指令会同步' },
    { key: 'toggleEnhance', label: '润色开关', placeholder: '润色, enhance', hint: '写在描述前，例如：画 润色 一只柴犬' },
    { key: 'forceEnhance', label: '强制润色', placeholder: '润色, enhance', hint: '' },
    { key: 'disableEnhance', label: '禁用润色', placeholder: '原文, raw, 不润色', hint: '' },
    { key: 'imageCount', label: '张数后缀', placeholder: 's', hint: '例如 2s! 生成 2 张，最多 4 张' },
];
</script>

<template>
  <div v-if="config">
    <header class="mb-4">
      <h1 class="page-title mb-0.5">Bot 行为</h1>
      <p class="text-[color:var(--ink-3)] text-xs">触发方式、回复策略、触发词与名单。模型分工在「能力分工」页配置。</p>
    </header>

    <SectionCard title="身份" class="mb-4">
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <FormField label="机器人 QQ 号" hint="用于识别 @ 自己；留空则由 NapCat 上报的登录号自动填">
          <input v-model="config.bot.botQqId" class="input-field font-mono" placeholder="例如 123456789" />
        </FormField>
        <FormField label="管理员 QQ" hint="多个用逗号分隔。管理员不受黑名单与白名单限制">
          <input v-model="ownersText" @blur="commitOwners" class="input-field font-mono" placeholder="123456, 654321" />
        </FormField>
      </div>
    </SectionCard>

    <SectionCard title="触发入口" hint="决定机器人在群里什么时候会响应" class="mb-4">
      <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
        <ToggleField v-model="config.bot.triggerModes.mention" label="@bot + 内容"
          hint="未命中指令时进入自由模式或日常对话" />
        <ToggleField v-model="config.bot.triggerModes.replyToBot" label="引用 bot 消息 + 指令"
          hint="例如引用机器人发的图后发送「反推」" />
      </div>
      <p class="text-[color:var(--ink-3)] text-xs mt-3 leading-relaxed">
        另外，所有指令在群里都可以不 @ 直接使用（例如直接发「画 一只猫」）。
        视频生成没有独立触发词——说「生成一个视频」或带 <code class="mono">video!</code>、<code class="mono">6s!</code>
        这类后缀时会自动判定为视频意图。
      </p>
    </SectionCard>

    <SectionCard title="群聊上下文" hint="@bot 时自动带上最近的群聊记录，让回答接得住话题" class="mb-4">
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <ToggleField v-model="config.bot.groupContext.enabled" label="启用群聊上下文" />
        <FormField label="拉取条数" hint="太多会明显推高 token 消耗">
          <input v-model.number="config.bot.groupContext.messageCount" type="number" min="1" max="200"
            :disabled="!config.bot.groupContext.enabled" class="input-field" />
        </FormField>
        <FormField label="最大字符数">
          <input v-model.number="config.bot.groupContext.maxChars" type="number" min="500" step="500"
            :disabled="!config.bot.groupContext.enabled" class="input-field" />
        </FormField>
        <div class="grid grid-cols-1 gap-2">
          <ToggleField v-model="config.bot.groupContext.skipForward" label="跳过合并转发消息"
            :disabled="!config.bot.groupContext.enabled" />
          <ToggleField v-model="config.bot.groupContext.includeImages" label="带上图片"
            hint="对话模型不支持视觉时会自动忽略" :disabled="!config.bot.groupContext.enabled" />
        </div>
      </div>
    </SectionCard>

    <SectionCard title="回复策略" hint="不同内容类型可以用不同的回复方式" class="mb-4">
      <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
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

    <SectionCard title="图片与撤回" class="mb-4">
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

    <SectionCard title="触发词" hint="多个用逗号分隔。留空会恢复默认值" class="mb-4">
      <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        <FormField v-for="field in commandFields" :key="field.key" :label="field.label" :hint="field.hint">
          <input v-model="config.bot.commands[field.key]" class="input-field" :placeholder="field.placeholder" />
        </FormField>
      </div>
    </SectionCard>

    <SectionCard title="白名单 / 黑名单" hint="白名单留空表示全部放行">
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <FormField label="允许的群号" hint="多个用逗号分隔">
          <input v-model="whitelistGroupsText" @blur="commitWhitelistGroups" class="input-field font-mono" placeholder="留空 = 全部放行" />
        </FormField>
        <FormField label="允许的私聊 QQ" hint="多个用逗号分隔">
          <input v-model="whitelistPrivateText" @blur="commitWhitelistPrivate" class="input-field font-mono" placeholder="留空 = 全部放行" />
        </FormField>
        <div class="md:col-span-2">
          <FormField label="群内用户黑名单" hint="每行一条，格式 群号:QQ，也支持 *:QQ">
            <textarea v-model="blacklistText" @blur="commitBlacklist" rows="4" class="input-field font-mono resize-y"
              placeholder="123456789:987654321&#10;*:987654321"></textarea>
          </FormField>
        </div>
      </div>
    </SectionCard>
  </div>
</template>
