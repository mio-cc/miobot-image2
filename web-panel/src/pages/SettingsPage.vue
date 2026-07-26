<script setup lang="ts">
import { computed, ref } from 'vue';
import client, { errorMessage } from '../api/client';
import { useConfigStore } from '../stores/config';
import { useAuthStore } from '../stores/auth';
import SectionCard from '../components/SectionCard.vue';
import FormField from '../components/FormField.vue';
import AppIcon from '../components/AppIcon.vue';

const configStore = useConfigStore();
const auth = useAuthStore();
const config = computed(() => configStore.config);

const napcatTesting = ref(false);
const napcatResult = ref<any>(null);
const newPassword = ref('');

/**
 * 用后端给的结论，别自己比。
 * 面板拿到的 passwordSeed 是打码后的（'cha••••••••ogin'），
 * 跟默认种子永远不相等——这个红条从打码上线那天起就再没显示过。
 */
const usingDefaultPassword = computed(() => auth.usingDefaultPassword);

async function testNapcat() {
    napcatTesting.value = true;
    napcatResult.value = null;
    try {
        const res = await client.post('/test-napcat', { wsUrl: config.value.napcat.wsUrl });
        napcatResult.value = res.data;
    } catch (error: any) {
        napcatResult.value = error?.response?.data || { success: false, error: errorMessage(error) };
    } finally {
        napcatTesting.value = false;
    }
}

function applyPassword() {
    const value = newPassword.value.trim();
    if (!value) return;
    config.value.panel.passwordSeed = value;
    newPassword.value = '';
    configStore.saveStatus = '新密码已填入，点右上角「保存并热重载」后生效';
}
</script>

<template>
  <div v-if="config">
    <header class="mb-4">
      <h1 class="page-title mb-0.5">系统设置</h1>
      <p class="text-[color:var(--ink-3)] text-xs">NapCat 连接、面板密码与运行信息</p>
    </header>

    <div v-if="usingDefaultPassword" class="card p-4 mb-4" style="border-color: var(--critical)">
      <div class="flex items-start gap-2">
        <span class="status-crit mt-0.5"><AppIcon name="warn" :size="14" /></span>
        <div class="text-xs">
          <div class="font-semibold status-crit mb-1">面板还在用默认密码</div>
          <div class="text-[color:var(--ink-2)]">
            任何能访问这个端口的人都可以登录面板、读到全部节点配置并消耗你的额度，请立刻修改。
          </div>
        </div>
      </div>
    </div>

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
        <FormField label="通用 action"><input v-model.number="config.napcat.actionTimeoutMs" type="number" min="3000" step="1000" class="input-field" /></FormField>
        <FormField label="文本发送"><input v-model.number="config.napcat.textSendTimeoutMs" type="number" min="3000" step="1000" class="input-field" /></FormField>
        <FormField label="图片上传"><input v-model.number="config.napcat.imageSendTimeoutMs" type="number" min="10000" step="5000" class="input-field" /></FormField>
        <FormField label="文件发送"><input v-model.number="config.napcat.fileSendTimeoutMs" type="number" min="10000" step="10000" class="input-field" /></FormField>
        <FormField label="合并转发"><input v-model.number="config.napcat.forwardSendTimeoutMs" type="number" min="10000" step="5000" class="input-field" /></FormField>
        <FormField label="引用取消息"><input v-model.number="config.napcat.getMessageTimeoutMs" type="number" min="3000" step="1000" class="input-field" /></FormField>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-3 gap-4 mt-4">
        <FormField label="文件发送重试次数"><input v-model.number="config.napcat.fileSendRetryCount" type="number" min="0" max="10" class="input-field" /></FormField>
        <FormField label="文件重试间隔 (ms)"><input v-model.number="config.napcat.fileSendRetryDelayMs" type="number" min="0" step="200" class="input-field" /></FormField>
        <FormField label="Docker 路径映射" hint="NapCat 在容器内看到的输出目录；留空则用 base64 传输">
          <input v-model="config.napcat.mountOutputDir" class="input-field font-mono" placeholder="/app/napcat/output" />
        </FormField>
      </div>

      <p class="text-[color:var(--ink-3)] text-[11px] mt-3 leading-relaxed">
        填好路径映射能显著改善大文件发送：base64 会把体积撑大约 1.34 倍，
        而 WebSocket 帧上限是 50MB，所以超过 ~37MB 的视频走 base64 会直接把连接顶断。
        走路径就完全没有这个问题。
      </p>
    </SectionCard>

    <SectionCard title="面板安全" class="mb-4">
      <div class="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
        <FormField label="新面板密码" hint="会话令牌由密码派生，改完当前会话会自动换新令牌">
          <input v-model="newPassword" type="password" class="input-field" autocomplete="new-password"
            placeholder="留空表示不修改" @keyup.enter="applyPassword" />
        </FormField>
        <button class="btn-outline" :disabled="!newPassword.trim()" @click="applyPassword">填入新密码</button>
        <FormField label="监听端口" hint="修改后需要重启进程才生效">
          <input v-model.number="config.panel.port" type="number" min="1" max="65535" class="input-field" />
        </FormField>
      </div>
    </SectionCard>

    <SectionCard title="关于">
      <div class="text-xs text-[color:var(--ink-2)] space-y-1.5 leading-relaxed">
        <p class="font-semibold text-[color:var(--ink)] text-sm mb-2">MioBot Console</p>
        <p>· 接在 NapCat（OneBot 11）后面的多模型 QQ 机器人平台，附带一个独立的图像画布前台。</p>
        <p>· 所有 AI 能力发给你自己配置的节点，支持官方直连、NewAPI/One-API 中转，以及 CLIProxyAPI 这类把 CLI 订阅包装成 API 的反代。</p>
        <p>· 已适配 OpenAI / Anthropic / Google / xAI / DeepSeek / Kimi / 智谱 等的参数差异，由适配层自动处理。</p>
        <p>· 上游拒绝某个参数时会自动剔除或改名并记住（按节点+模型），换网关无需手工调整。</p>
        <p>· 绝大多数配置改动即时热重载。<b>需要重启进程</b>的只有三项：面板监听端口、NapCat 的 WebSocket 地址与 Token（连接在启动时建立）。</p>
      </div>
    </SectionCard>
  </div>
</template>
