<script lang="ts">
import { defineComponent, inject } from 'vue';
export default defineComponent({
  setup() {
    return { ...(inject('panelStore', {}) as Record<string, any>) };
  },
});
</script>
<template>
          <div class="animate-fadein">

            <header class="page-head">
              <h1 class="page-head__title">Codex 助手</h1>
              <p class="page-head__desc">通过后台对话修改服务器项目。每次 Git 推送都是普通 commit，不使用 force；远端领先时会拒绝推送，避免覆盖仓库历史。服务端可用 <code style="font-family: var(--font-mono); color: var(--primary);">MIOBOT_CODEX_REMOTE_ENABLED=0</code> 临时关闭。</p>
              <div class="page-head__actions">
                <span class="status-pill" :data-tone="codexStatusTone()">{{ codexStatusText() }}</span>
                <button @click="refreshCodexPanel" :disabled="codexStatusLoading || codexGitLoading" class="btn-outline text-sm">
                  {{ codexStatusLoading || codexGitLoading ? '刷新中...' : '刷新状态' }}
                </button>
              </div>
            </header>

            <div class="codex-hero card p-5">
              <div class="codex-hero__copy">
                <span class="codex-eyebrow">Codex Remote Workspace</span>
                <h3>通过后台对话修改服务器项目</h3>
                <p>把要改的内容说清楚就行。例如：检查画布移动端滑动条问题并修复，然后运行相关测试。</p>
              </div>
            </div>

            <div class="grid grid-cols-1 xl:grid-cols-[1.45fr_0.9fr] gap-5">
              <section class="card p-0 overflow-hidden codex-console">
                <div class="codex-console__bar">
                  <div>
                    <span>Codex 对话控制台</span>
                    <small>{{ codexThreadId ? `线程 ${codexThreadId}` : '下一条消息将创建新线程' }}</small>
                  </div>
                  <button @click="resetCodexThread" class="btn-outline text-[11px] py-1 px-2">新线程</button>
                </div>

                <div class="codex-chat-list">
                  <div v-if="!codexMessages.length" class="codex-empty">
                    <strong>把要改的内容说清楚就行。</strong>
                    <span>例如：检查画布移动端滑动条问题并修复，然后运行相关测试。</span>
                  </div>
                  <article v-for="message in codexMessages" :key="message.id" :class="codexMessageClass(message.role)">
                    <div class="codex-message__meta">
                      <span>{{ message.role === 'user' ? '你' : message.role === 'assistant' ? 'Codex' : message.role === 'error' ? '错误' : '系统' }}</span>
                      <time>{{ message.timestamp }}</time>
                      <em v-if="message.meta">{{ message.meta }}</em>
                    </div>
                    <pre>{{ message.text }}</pre>
                  </article>
                </div>

                <div class="codex-compose">
                  <textarea
                    v-model="codexInput"
                    rows="5"
                    class="input-field codex-compose__textarea"
                    placeholder="输入要让 Codex 在服务器项目里执行的任务..."
                    :disabled="codexSending"
                    @keydown.enter.exact.prevent="sendCodexMessage"
                  ></textarea>
                  <div class="codex-compose__footer">
                    <div class="codex-compose__controls">
                      <label>
                        <span>权限</span>
                        <select v-model="codexSandbox" class="input-field font-mono">
                          <option v-for="preset in (codexStatus?.sandboxPresets || ['read_only','workspace_write'])" :key="preset" :value="preset">
                            {{ preset }}
                          </option>
                        </select>
                      </label>
                      <label>
                        <span>模型</span>
                        <input v-model="codexModel" class="input-field font-mono" placeholder="留空使用默认" />
                      </label>
                    </div>
                    <button @click="sendCodexMessage" :disabled="codexSending || !codexInput.trim() || !codexReady()" class="btn-primary codex-send-button">
                      {{ codexSending ? '执行中...' : '发送给 Codex' }}
                    </button>
                  </div>
                </div>
              </section>

              <aside class="space-y-4">
                <section class="card p-5 codex-side-card">
                  <div class="codex-side-card__head">
                    <div>
                      <h3>运行环境</h3>
                      <p>SDK、工作区和安全状态</p>
                    </div>
                    <span class="status-pill" :data-tone="codexStatusTone()">{{ codexStatusText() }}</span>
                  </div>
                  <div v-if="codexStatusError" class="codex-alert codex-alert--error">{{ codexStatusError }}</div>
                  <div class="codex-kv">
                    <span>工作区</span><code>{{ codexStatus?.workspace?.path || '-' }}</code>
                    <span>Python</span><code>{{ codexStatus?.python?.pythonVersion || '-' }}</code>
                    <span>SDK</span><code>{{ codexStatus?.python?.sdkVersion || (codexStatus?.python?.sdkAvailable ? 'available' : '未安装') }}</code>
                    <span>登录态</span><code>{{ codexStatus?.account?.signedIn ? '已登录' : (codexStatus?.login?.running ? '等待网页登录' : '未登录') }}</code>
                    <span>超时</span><code>{{ Math.round((codexStatus?.timeoutMs || 0) / 1000) || '-' }}s</code>
                  </div>
                  <div v-if="codexStatus?.python?.sdkAvailable" class="codex-login-box">
                    <div v-if="codexStatus?.account?.signedIn" class="codex-alert">
                      服务器 Codex 已登录，可以直接通过上方对话修改项目。
                    </div>
                    <div v-else-if="codexStatus?.login?.running" class="codex-login-code">
                      <span>网页登录授权</span>
                      <p class="codex-login-code__hint">请在浏览器打开 OpenAI 授权链接，完成后这里会自动刷新登录态。</p>
                      <a :href="codexStatus.login.authUrl" target="_blank" rel="noreferrer" class="btn-primary text-xs">打开网页登录</a>
                      <div class="codex-callback-submit">
                        <textarea
                          v-model="codexCallbackUrl"
                          rows="2"
                          placeholder="如果浏览器停在 http://localhost:1457/auth/callback?...，把地址栏完整链接粘贴到这里"
                        ></textarea>
                        <button @click="submitCodexCallbackUrl" :disabled="codexCallbackSubmitting || !codexCallbackUrl.trim()" class="btn-primary text-xs">
                          {{ codexCallbackSubmitting ? '提交中...' : '提交回调地址' }}
                        </button>
                      </div>
                      <p class="codex-login-code__hint">远程服务器登录时，localhost 回调可能会停在你的电脑浏览器里；复制完整地址提交即可让服务器完成登录。</p>
                      <button @click="cancelCodexWebLogin" class="btn-outline text-xs">取消登录</button>
                    </div>
                    <button v-else @click="startCodexWebLogin" :disabled="codexLoginLoading" class="btn-primary w-full text-sm">
                      {{ codexLoginLoading ? '生成登录链接中...' : '网页登录服务器 Codex' }}
                    </button>
                    <p class="codex-git-note">流程：后台生成 OpenAI 授权链接，你在浏览器完成网页登录，登录态保存在服务器 Codex 本地环境。</p>
                  </div>
                  <div v-if="codexStatus && !codexStatus.python?.sdkAvailable" class="codex-alert">
                    服务器需安装 SDK：<code>{{ codexStatus.installCommand }}</code>
                  </div>
                  <div v-if="codexStatus && !codexStatus.workspace?.ok" class="codex-alert codex-alert--error">
                    {{ codexStatus.workspace?.error }}
                  </div>
                </section>

                <section class="card p-5 codex-side-card">
                  <div class="codex-side-card__head">
                    <div>
                      <h3>Git 版本同步</h3>
                      <p>{{ codexGitFilesSummary() }}</p>
                    </div>
                    <button @click="fetchCodexGitStatus" :disabled="codexGitLoading" class="btn-outline text-xs">
                      {{ codexGitLoading ? '读取中' : '刷新' }}
                    </button>
                  </div>

                  <div v-if="codexGitError" class="codex-alert codex-alert--error">{{ codexGitError }}</div>
                  <div class="codex-kv">
                    <span>分支</span><code>{{ codexGitStatus?.branch || '-' }}</code>
                    <span>上游</span><code>{{ codexGitStatus?.upstream?.upstream || '未设置' }}</code>
                    <span>领先/落后</span><code>ahead {{ codexGitStatus?.upstream?.ahead || 0 }} / behind {{ codexGitStatus?.upstream?.behind || 0 }}</code>
                    <span>远端</span><code>{{ codexGitStatus?.remote ? '已配置' : '未读取' }}</code>
                  </div>

                  <div v-if="codexGitStatus?.upstream?.behind" class="codex-alert codex-alert--error">
                    远端领先 {{ codexGitStatus.upstream.behind }} 个 commit。请先拉取/合并，后台不会强推覆盖。
                  </div>

                  <div class="codex-git-files">
                    <div v-if="!codexGitStatus?.files?.length" class="codex-empty codex-empty--mini">服务器工作区没有可提交变更。</div>
                    <div v-for="file in (codexGitStatus?.files || [])" :key="file.raw" class="codex-git-file">
                      <span>{{ file.status }}</span>
                      <code>{{ file.path }}</code>
                    </div>
                  </div>

                  <pre v-if="codexGitStatus?.diffStat" class="codex-diffstat">{{ codexGitStatus.diffStat }}</pre>

                  <label class="codex-commit-label">
                    <span>提交信息</span>
                    <input v-model="codexCommitMessage" class="input-field" placeholder="Codex remote update" />
                  </label>
                  <button
                    @click="pushCodexGitChanges"
                    :disabled="codexGitPushLoading || !codexGitStatus?.dirty || codexGitStatus?.upstream?.behind"
                    class="btn-primary w-full"
                  >
                    {{ codexGitPushLoading ? '提交并推送中...' : '提交并推送到 Git' }}
                  </button>
                  <p class="codex-git-note">使用普通 <code>git push</code>，不使用 <code>--force</code>；每次推送都会产生可回滚的 commit。</p>
                </section>
              </aside>
            </div>

          </div>
</template>
