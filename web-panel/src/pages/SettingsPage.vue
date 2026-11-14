<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import client from '../api/client';
import { useConfigStore } from '../stores/config';
import { useAuthStore } from '../stores/auth';
import SectionCard from '../components/SectionCard.vue';
import FormField from '../components/FormField.vue';
import AppIcon from '../components/AppIcon.vue';

const configStore = useConfigStore();
const auth = useAuthStore();
const config = computed(() => configStore.config);

const newPassword = ref('');
const backups = ref<Array<{ name: string; size: number; modifiedAt: string }>>([]);
const backupTotal = ref(0);
const backupLoading = ref(false);
const backupCreating = ref(false);
const backupMessage = ref('');
const backupConfig = ref(true);
const backupCanvasState = ref(true);
const backupCanvasAssets = ref(true);

function formatBytes(bytes: number) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(2) + ' GB';
    if (bytes >= 1024 ** 2) return (bytes / 1024 ** 2).toFixed(1) + ' MB';
    if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return bytes + ' B';
}
async function loadBackups() {
    backupLoading.value = true;
    try {
        const res = await client.get('/system/backups');
        backups.value = Array.isArray(res.data?.backups) ? res.data.backups : [];
        backupTotal.value = Number(res.data?.totalBytes || 0);
    } catch (error: any) {
        backupMessage.value = error?.response?.data?.error || String(error?.message || error);
    } finally {
        backupLoading.value = false;
    }
}
async function createBackup() {
    backupCreating.value = true;
    backupMessage.value = '';
    try {
        const res = await client.post('/system/backups', {
            config: backupConfig.value,
            canvasState: backupCanvasState.value,
            canvasAssets: backupCanvasAssets.value,
        });
        const count = Array.isArray(res.data?.backups) ? res.data.backups.length : 0;
        backupMessage.value = '已创建 ' + count + ' 个备份文件';
        await loadBackups();
    } catch (error: any) {
        backupMessage.value = error?.response?.data?.error || String(error?.message || error);
    } finally {
        backupCreating.value = false;
    }
}
async function deleteBackup(name: string) {
    if (!window.confirm('删除备份 ' + name + '？')) return;
    try {
        await client.delete('/system/backups/' + encodeURIComponent(name));
        backupMessage.value = '已删除 ' + name;
        await loadBackups();
    } catch (error: any) {
        backupMessage.value = error?.response?.data?.error || String(error?.message || error);
    }
}
async function deleteAllBackups() {
    if (!window.confirm('删除全部配置/画布备份？此操作不可恢复。')) return;
    try {
        const res = await client.delete('/system/backups?all=1');
        backupMessage.value = '已删除 ' + Number(res.data?.removed || 0) + ' 个备份，释放 ' + formatBytes(Number(res.data?.freedBytes || 0));
        await loadBackups();
    } catch (error: any) {
        backupMessage.value = error?.response?.data?.error || String(error?.message || error);
    }
}
onMounted(loadBackups);

/**
 * 用后端给的结论，别自己比。
 * 面板拿到的 passwordSeed 是打码后的（'cha••••••••ogin'），
 * 跟默认种子永远不相等——这个红条从打码上线那天起就再没显示过。
 */
const usingDefaultPassword = computed(() => auth.usingDefaultPassword);

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
      <p class="text-[color:var(--ink-3)] text-xs">面板安全与运行信息；NapCat 连接在「接入与准入」页配置</p>
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

    <SectionCard title="备份与存储" hint="更新/重建不再自动备份；这里手动备份配置、画布状态和图片资源" class="mb-4">
      <div class="flex flex-wrap items-center gap-4 mb-3 text-xs">
        <label class="inline-flex items-center gap-2"><input v-model="backupConfig" type="checkbox" class="h-3.5 w-3.5" /> 配置</label>
        <label class="inline-flex items-center gap-2"><input v-model="backupCanvasState" type="checkbox" class="h-3.5 w-3.5" /> 画布/模板库状态</label>
        <label class="inline-flex items-center gap-2"><input v-model="backupCanvasAssets" type="checkbox" class="h-3.5 w-3.5" /> 画布/模板库图片资源</label>
        <button class="btn-primary" type="button" :disabled="backupCreating || (!backupConfig && !backupCanvasState && !backupCanvasAssets)" @click="createBackup">
          {{ backupCreating ? '备份中…' : '立即手动备份' }}
        </button>
        <button class="btn-outline" type="button" :disabled="backupLoading" @click="loadBackups">刷新</button>
      </div>
      <p v-if="backupMessage" class="text-xs mb-3 text-[color:var(--ink-2)]">{{ backupMessage }}</p>
      <div class="text-xs text-[color:var(--ink-3)] mb-2">当前备份占用：{{ formatBytes(backupTotal) }} · 共 {{ backups.length }} 个文件</div>
      <div v-if="backups.length" class="max-h-[260px] overflow-auto border border-[color:var(--hairline-2)] rounded">
        <table class="w-full text-xs">
          <thead><tr class="text-left text-[color:var(--ink-3)]"><th class="p-2">文件</th><th class="p-2">大小</th><th class="p-2">时间</th><th class="p-2"></th></tr></thead>
          <tbody>
            <tr v-for="item in backups" :key="item.name" class="border-t border-[color:var(--hairline-2)]">
              <td class="p-2 font-mono break-all">{{ item.name }}</td>
              <td class="p-2 whitespace-nowrap">{{ formatBytes(item.size) }}</td>
              <td class="p-2 whitespace-nowrap">{{ item.modifiedAt.replace('T', ' ').slice(0, 19) }}</td>
              <td class="p-2 text-right"><button class="btn-outline !px-2 !py-1" type="button" @click="deleteBackup(item.name)">删除</button></td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-else class="text-xs text-[color:var(--ink-3)] py-3">还没有手动备份。</div>
      <div class="flex justify-end mt-3">
        <button v-if="backups.length" class="btn-outline" type="button" @click="deleteAllBackups">删除全部备份</button>
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
