<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import client, { errorMessage } from '../api/client';
import { useConfigStore } from '../stores/config';
import SectionCard from '../components/SectionCard.vue';
import FormField from '../components/FormField.vue';
import ToggleField from '../components/ToggleField.vue';

/**
 * 接入与准入页（用户层）。
 * NapCat 连接（自系统设置迁入）+ 身份与人员（owner/审批管理员合一双写）+
 * 触发方式（含戳一戳/入群欢迎/好友请求事件源）+ 群聊上下文 + 名单 +
 * 消息与限流总策略（C6 全局项；逐能力配额在各能力页「启用与配额」卡）。
 */

const configStore = useConfigStore();
const config = computed(() => configStore.config);

// 关键词触发词：逗号分隔文本 ↔ 数组双向绑定。
const keywordTriggerWordsText = computed({
    get: () => (config.value?.bot?.keywordTrigger?.words || []).join(', '),
    set: (value: string) => {
        if (!config.value?.bot?.keywordTrigger) return;
        config.value.bot.keywordTrigger.words = value
            .split(/[,，]/)
            .map((item: string) => item.trim())
            .filter(Boolean);
    },
});

const napcatTesting = ref(false);
const napcatResult = ref<any>(null);

async function testNapcat() {
    napcatTesting.value = true;
    napcatResult.value = null;
    try {
        // token 只在用户刚改过（不含圆点）时才发；发打码值等于拿一串圆点去连 NapCat。
        // 不发的话后端会回落到磁盘上的旧 token——刚粘上的新 token 根本测不到。
        const typedToken = String(config.value.napcat.token || '');
        const res = await client.post('/test-napcat', {
            wsUrl: config.value.napcat.wsUrl,
            ...(typedToken.includes('••••') ? {} : { token: typedToken }),
        });
        napcatResult.value = res.data;
    } catch (error: any) {
        napcatResult.value = error?.response?.data || { success: false, error: errorMessage(error) };
    } finally {
        napcatTesting.value = false;
    }
}

/**
 * 名单类输入用独立文本 ref，失焦时才写回数组。
 * 直接「:value 格式化 + @input 立即 split/filter」的写法里，每敲一个逗号都会被
 * filter(Boolean) 吃掉，结果是根本没法输入第二个条目。
 */
const ownersText = ref('');
const whitelistGroupsText = ref('');
const whitelistPrivateText = ref('');
const blacklistText = ref('');
// 戳一戳回复池是 string[]：文案本身常含逗号，用「每行一句」文本框 + 失焦写回，
// 不能 v-model 直接绑数组（输入框会把整个字段替换成字符串，保存时被归一化丢弃回落默认）。
const pokeRepliesText = ref('');

function syncFromConfig() {
    const bot = config.value?.bot;
    if (!bot) return;
    // 管理员名单合一（§2.6.4 动作1）：bot.ownerQQs 与 orch.approval.adminQqIds
    // 双写为同一批人；展示取两者并集。
    const admins = new Set([...(bot.ownerQQs || []), ...(config.value?.orchestration?.approval?.adminQqIds || [])]);
    ownersText.value = [...admins].join(', ');
    whitelistGroupsText.value = (bot.whitelistGroups || []).join(', ');
    whitelistPrivateText.value = (bot.whitelistPrivate || []).join(', ');
    blacklistText.value = (bot.blacklistGroupUsers || []).join('\n');
    pokeRepliesText.value = (bot.poke?.replies || []).join('\n');
}
watch(() => [config.value?.bot, config.value?.orchestration?.approval], syncFromConfig, { immediate: true });

function splitList(value: string, separator: RegExp) {
    return value.split(separator).map(item => item.trim()).filter(Boolean);
}

function commitOwners() {
    const owners = splitList(ownersText.value, /[,，\s]+/);
    config.value.bot.ownerQQs = owners;
    // 审批管理员与 owner 是同一批人：双写，保证审批通知一定能找到人。
    if (config.value.orchestration) {
        config.value.orchestration.approval ||= {};
        config.value.orchestration.approval.adminQqIds = [...owners];
    }
    ownersText.value = owners.join(', ');
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
function commitPokeReplies() {
    const replies = splitList(pokeRepliesText.value, /\n/)
        .slice(0, 20); // 与归一化上限一致：回复池最多 20 条。
    config.value.bot.poke.replies = replies.length ? replies : [...DEFAULT_POKE_REPLIES];
    pokeRepliesText.value = config.value.bot.poke.replies.join('\n');
}
/** 清空回复池等于「随机回一句」失效，回落出厂三条而不是空数组。 */
const DEFAULT_POKE_REPLIES = ['戳我干嘛呀', '别戳啦，在的呢', '收到收到，有事直接说~'];
</script>

<template>
  <div v-if="config">
    <header class="mb-4">
      <h1 class="page-title mb-0.5">接入与准入</h1>
      <p class="text-[color:var(--ink-3)] text-xs">
        用户层：NapCat 连接、人员与角色、触发方式（含事件源）、名单与全局限流。
      </p>
    </header>

    <SectionCard title="NapCat 连接" class="mb-4">
      <template #actions>
        <button class="btn-outline text-xs" :disabled="napcatTesting" @click="testNapcat">
          {{ napcatTesting ? '测试中...' : '测试连接' }}
        </button>
      </template>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <FormField label="WebSocket 地址" hint="NapCat 的正向 WebSocket 服务端口">
          <input v-model="config.napcat.wsUrl" class="input-field font-mono" placeholder="ws://127.0.0.1:3001" />
        </FormField>
        <FormField label="Token" hint="留着打码值表示不修改">
          <input v-model="config.napcat.token" type="password" class="input-field font-mono" />
        </FormField>
      </div>

      <div v-if="napcatResult" class="mt-3 rounded-lg border border-[color:var(--hairline-2)] px-3 py-2 text-xs"
        :class="napcatResult.success ? 'status-good' : 'status-crit'">
        <div class="font-semibold">{{ napcatResult.success ? '连接正常' : '连接异常' }}</div>
        <div class="mt-1 text-[color:var(--ink-2)]">{{ napcatResult.message || napcatResult.error }}</div>
        <div v-if="napcatResult.success" class="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[color:var(--ink-3)]">
          <span v-if="napcatResult.selfQqId">QQ: {{ napcatResult.selfQqId }}</span>
          <span v-if="napcatResult.nickname">昵称: {{ napcatResult.nickname }}</span>
          <span v-if="napcatResult.latencyMs !== undefined">耗时: {{ napcatResult.latencyMs }}ms</span>
        </div>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-3 xl:grid-cols-6 gap-4 mt-4 pt-4 border-t border-[color:var(--hairline-2)]">
        <FormField label="通用 action" hint="未单独设超时的 action（好友请求、群历史、get_image 等）都用它；范围 3s-30min">
          <input v-model.number="config.napcat.actionTimeoutMs" type="number" min="3000" max="1800000" step="1000" class="input-field" />
        </FormField>
        <FormField label="文本发送"><input v-model.number="config.napcat.textSendTimeoutMs" type="number" min="3000" step="1000" class="input-field" /></FormField>
        <FormField label="图片上传"><input v-model.number="config.napcat.imageSendTimeoutMs" type="number" min="10000" step="5000" class="input-field" /></FormField>
        <FormField label="文件发送"><input v-model.number="config.napcat.fileSendTimeoutMs" type="number" min="10000" step="10000" class="input-field" /></FormField>
        <FormField label="合并转发"><input v-model.number="config.napcat.forwardSendTimeoutMs" type="number" min="10000" step="5000" class="input-field" /></FormField>
        <FormField label="引用取消息"><input v-model.number="config.napcat.getMessageTimeoutMs" type="number" min="3000" step="1000" class="input-field" /></FormField>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-3 gap-4 mt-4">
        <FormField label="文件发送重试次数"><input v-model.number="config.napcat.fileSendRetryCount" type="number" min="0" max="10" class="input-field" /></FormField>
        <FormField label="文件重试间隔 (ms)"><input v-model.number="config.napcat.fileSendRetryDelayMs" type="number" min="0" step="200" class="input-field" /></FormField>
      </div>

      <p class="text-[color:var(--ink-3)] text-[11px] mt-3 leading-relaxed">
        填好路径映射能显著改善大文件发送：base64 会把体积撑大约 1.34 倍，
        而 WebSocket 帧上限是 50MB，所以超过 ~37MB 的视频走 base64 会直接把连接顶断。
        走路径就完全没有这个问题。
      </p>
    </SectionCard>

    <SectionCard title="身份与人员" class="mb-4">
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <FormField label="机器人 QQ 号" hint="用于识别 @ 自己；留空则由 NapCat 上报的登录号自动填">
          <input v-model="config.bot.botQqId" class="input-field font-mono" placeholder="例如 123456789" />
        </FormField>
        <FormField label="Owner / 审批管理员 QQ" hint="多个用逗号分隔；同时写入 bot.ownerQQs 与审批管理员名单（双写合一）。管理员不受黑名单与白名单限制">
          <input v-model="ownersText" @blur="commitOwners" class="input-field font-mono" placeholder="123456, 654321" />
        </FormField>
      </div>
    </SectionCard>

    <SectionCard title="触发方式" hint="决定机器人在群里什么时候会响应" class="mb-4">
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

      <div class="grid grid-cols-1 gap-4 mt-4 pt-4 border-t border-[color:var(--hairline-2)]">
        <div class="text-xs font-medium">关键词触发（消息含触发词 → 拉上下文 → 模型判断沟通意图）</div>
        <div class="flex items-end"><ToggleField v-model="config.bot.keywordTrigger.enabled" label="启用关键词触发" hint="消息包含触发词时由模型判断是否在跟 bot 说话" /></div>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
          <FormField label="触发词（逗号分隔）" hint="子串匹配、大小写不敏感、不限位置">
            <input v-model="keywordTriggerWordsText" class="input-field" placeholder="miobot, 小mi, bot帮" />
          </FormField>
          <FormField label="上下文条数" hint="命中后拉取前后几条群消息">
            <input v-model="config.bot.keywordTrigger.contextMessages" type="number" min="3" max="10" class="input-field" />
          </FormField>
          <FormField label="判断冷却（毫秒）" hint="同一用户两次判断的最小间隔">
            <input v-model="config.bot.keywordTrigger.windowMs" type="number" min="3000" max="60000" class="input-field" />
          </FormField>
        </div>
      </div>

      <div class="grid grid-cols-1 gap-4 mt-4 pt-4 border-t border-[color:var(--hairline-2)]">
        <div class="text-xs font-medium">对话自动延续（bot 回复后窗口内该用户的下一条消息自动继续对话）</div>
        <div class="flex items-end"><ToggleField v-model="config.bot.autoContinue.enabled" label="启对话延续" hint="无需再 @bot，模型判断是否在继续聊天" /></div>
        <div class="grid grid-cols-1 md:grid-cols-4 gap-3">
          <FormField label="延续窗口（毫秒）" hint="bot 回复后多少毫秒内有效">
            <input v-model="config.bot.autoContinue.windowMs" type="number" min="10000" max="300000" class="input-field" />
          </FormField>
          <FormField label="最大延续轮数" hint="1-10，每轮=用户一条消息+bot一条回复">
            <input v-model="config.bot.autoContinue.maxRounds" type="number" min="1" max="10" class="input-field" />
          </FormField>
          <FormField label="关注窗口消息数" hint="0=关闭；显式触发后最多观察多少条群消息，只对模型判定为接续当前话题的消息回复">
            <input v-model="config.bot.autoContinue.focusMaxMessages" type="number" min="0" max="100" class="input-field" />
          </FormField>
          <FormField label="冷却间隔（毫秒）" hint="两次延续之间的最小间隔">
            <input v-model="config.bot.autoContinue.cooldownMs" type="number" min="5000" max="120000" class="input-field" />
          </FormField>
          <div class="flex items-end"><ToggleField v-model="config.bot.autoContinue.requireModelCheck" label="模型判断延续意图" hint="关闭则纯时间窗口判断（可能误触发）" /></div>
        </div>
      </div>

      <div class="grid grid-cols-1 gap-4 mt-4 pt-4 border-t border-[color:var(--hairline-2)]">
        <div class="text-xs font-medium">人格设定（bot 的名字/性格/说话风格，注入 chat 系统提示词）</div>
        <div class="flex items-end"><ToggleField v-model="config.bot.persona.enabled" label="启用人格设定" hint="关闭时使用默认系统提示词" /></div>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
          <FormField label="bot 名字" hint="例如：大肥鱼、小mi（注入'你的名字是XX'）">
            <input v-model="config.bot.persona.name" class="input-field" placeholder="大肥鱼" :disabled="!config.bot.persona.enabled" />
          </FormField>
          <div></div>
        </div>
        <FormField label="人格系统提示词" hint="描述 bot 的性格/说话风格/语气/回复长度等（5000 字以内）">
          <textarea v-model="config.bot.persona.systemPrompt" class="input-field min-h-[120px]" rows="5"
            placeholder="你是一群朋友里的搞怪担当。说话风格：随意、幽默、偶尔用表情包、喜欢吐槽。回复长度：短句为主，不超过3句话。语气：朋友之间的闲聊感，不是客服。你有自己的喜好和观点。"
            :disabled="!config.bot.persona.enabled" />
        </FormField>
      </div>

      <div class="grid grid-cols-1 gap-4 mt-4 pt-4 border-t border-[color:var(--hairline-2)]">
        <div class="text-xs font-medium">统一上下文（planner 能看到 chat 对话历史，多轮交互更连贯）</div>
        <div class="flex items-end"><ToggleField v-model="config.bot.unifiedContext.enabled" label="启用统一上下文" hint="planner 能看到用户和机器人之前说了什么" /></div>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
          <FormField label="Planner 历史轮数" hint="planner 能看到最近几条对话（2-30）">
            <input v-model.number="config.bot.unifiedContext.plannerHistoryTurns" type="number" min="2" max="30" class="input-field" :disabled="!config.bot.unifiedContext.enabled" />
          </FormField>
          <FormField label="历史字符上限" hint="对话历史的字符预算（500-20000）">
            <input v-model.number="config.bot.unifiedContext.plannerHistoryChars" type="number" min="500" max="20000" class="input-field" :disabled="!config.bot.unifiedContext.enabled" />
          </FormField>
        </div>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-3 gap-4 mt-4 pt-4 border-t border-[color:var(--hairline-2)]">
        <div class="md:col-span-3 text-xs font-medium">事件源（notice / request）</div>
        <div class="flex items-end"><ToggleField v-model="config.bot.poke.enabled" label="戳一戳响应" hint="被戳时从回复池随机回一句" /></div>
        <FormField label="戳一戳冷却 (秒)" hint="每用户冷却，防连戳刷屏">
          <input v-model.number="config.bot.poke.cooldownSec" type="number" min="0" max="3600" class="input-field" :disabled="!config.bot.poke.enabled" />
        </FormField>
        <FormField label="戳一戳回复池" hint="每行一句，被戳时随机挑一条（最多 20 条；清空则回落出厂默认）">
          <textarea v-model="pokeRepliesText" @blur="commitPokeReplies" rows="4" class="input-field resize-y"
            placeholder="戳我干嘛呀&#10;别戳啦，在的呢" :disabled="!config.bot.poke.enabled" />
        </FormField>
        <div class="flex items-end"><ToggleField v-model="config.bot.welcome.enabled" label="入群欢迎" hint="新成员入群时发一条（默认关，防打扰）" /></div>
        <FormField label="欢迎语" hint="占位符 {user}">
          <input v-model="config.bot.welcome.text" class="input-field" placeholder="欢迎 {user} 加入～" :disabled="!config.bot.welcome.enabled" />
        </FormField>
        <FormField label="欢迎冷却 (秒)" hint="同群连续入群的间隔抑制">
          <input v-model.number="config.bot.welcome.cooldownSec" type="number" min="0" max="3600" class="input-field" :disabled="!config.bot.welcome.enabled" />
        </FormField>
        <FormField label="好友请求处理">
          <select v-model="config.bot.friendRequest.mode" class="input-field">
            <option value="ignore">ignore 忽略</option>
            <option value="accept">accept 自动通过</option>
            <option value="notify">notify 私聊通知 owner</option>
          </select>
        </FormField>
        <FormField label="好友请求通知文案" hint="占位符 {user}、{qq}">
          <input v-model="config.bot.friendRequest.notifyText" class="input-field" />
        </FormField>
      </div>
    </SectionCard>

    <SectionCard title="群聊上下文" hint="@bot 时自动带上最近的群聊记录，让回答接得住话题" class="mb-4">
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <ToggleField v-model="config.bot.groupContext.enabled" label="启用群聊上下文" />
        <FormField label="拉取条数" hint="范围 5-100（超出会被后端钳制）；太多会明显推高 token 消耗">
          <input v-model.number="config.bot.groupContext.messageCount" type="number" min="5" max="100"
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

    <SectionCard title="名单" hint="白名单留空表示全部放行">
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

    <SectionCard title="消息与限流总策略" hint="全局闸门；逐能力配额（冷却/日限/并发）在各能力页「启用与配额」卡配置" class="mb-4 mt-4">
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <FormField label="每用户每分钟消息上限" hint="T2.2 防刷屏闸；0 = 关闭，超出静默丢弃；范围 0-60（超出会被后端钳制）">
          <input v-model.number="config.bot.messageRateLimitPerMinute" type="number" min="0" max="60" class="input-field" />
        </FormField>
        <FormField label="消息过期阈值 (秒)" hint="积压/重连后迟到的消息直接丢弃不回复；0 = 不限">
          <input v-model.number="config.bot.staleMessageMaxAgeSeconds" type="number" min="0" max="3600" class="input-field" />
        </FormField>
      </div>
    </SectionCard>
  </div>
</template>
