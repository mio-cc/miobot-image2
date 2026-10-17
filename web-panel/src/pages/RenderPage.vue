<script setup lang="ts">
import { computed } from 'vue';
import { useConfigStore } from '../stores/config';
import SectionCard from '../components/SectionCard.vue';
import FormField from '../components/FormField.vue';
import ToggleField from '../components/ToggleField.vue';

const configStore = useConfigStore();
const config = computed(() => configStore.config);
</script>

<template>
  <div v-if="config">
    <header class="mb-4">
      <h1 class="page-title mb-0.5">代码与网页渲染</h1>
      <p class="text-[color:var(--ink-3)] text-xs">
        代码画图使用独立代码模型生成 HTML/SVG/Canvas/Three.js，再由 Chromium 截图。网页截屏只接受公网 http/https URL。
      </p>
    </header>

    <div class="rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-[color:var(--ink-2)] mb-4">
      当前服务器是 1C2G：建议保持最大并发为 1、队列 3，并确认 Chromium 已安装。任务超时会自动关闭页面、上下文和浏览器进程。
    </div>

    <SectionCard title="Chromium 渲染" hint="保存后生效；不安装 Chromium 时功能会返回明确错误" class="mb-4">
      <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
        <ToggleField v-model="config.browserRender.enabled" label="启用浏览器渲染" />
        <ToggleField v-model="config.browserRender.enableWebgl" label="启用 WebGL / Three.js" hint="使用 SwiftShader，会增加 CPU 和内存占用" />
        <ToggleField v-model="config.browserRender.noSandbox" label="使用 --no-sandbox" hint="仅限隔离的专用环境；宿主机直接运行时不建议关闭沙箱" />
        <FormField label="Chromium 可执行文件" hint="例如 /usr/bin/chromium；留空时由 Playwright 自动查找">
          <input v-model="config.browserRender.executablePath" class="input-field font-mono" placeholder="/usr/bin/chromium" />
        </FormField>
        <FormField label="单任务超时 (ms)">
          <input v-model.number="config.browserRender.timeoutMs" type="number" min="5000" max="120000" step="1000" class="input-field" />
        </FormField>
        <FormField label="启动超时 (ms)">
          <input v-model.number="config.browserRender.launchTimeoutMs" type="number" min="3000" max="60000" step="1000" class="input-field" />
        </FormField>
        <FormField label="空闲关闭 (ms)" hint="0 = 不自动关闭">
          <input v-model.number="config.browserRender.idleCloseMs" type="number" min="0" max="600000" step="10000" class="input-field" />
        </FormField>
        <FormField label="最大并发" hint="1C2G 建议 1">
          <input v-model.number="config.browserRender.maxConcurrency" type="number" min="1" max="4" class="input-field" />
        </FormField>
        <FormField label="最大排队数" hint="超过后直接拒绝，避免堆积">
          <input v-model.number="config.browserRender.maxQueue" type="number" min="0" max="20" class="input-field" />
        </FormField>
      </div>
    </SectionCard>

    <SectionCard title="代码与截图限制" class="mb-4">
      <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
        <FormField label="最大代码字符数">
          <input v-model.number="config.browserRender.maxCodeChars" type="number" min="1000" max="1000000" step="1000" class="input-field" />
        </FormField>
        <FormField label="最大画布宽度">
          <input v-model.number="config.browserRender.maxWidth" type="number" min="128" max="8192" class="input-field" />
        </FormField>
        <FormField label="最大画布高度">
          <input v-model.number="config.browserRender.maxHeight" type="number" min="128" max="8192" class="input-field" />
        </FormField>
        <FormField label="默认宽度">
          <input v-model.number="config.browserRender.defaultWidth" type="number" min="128" max="8192" class="input-field" />
        </FormField>
        <FormField label="默认高度">
          <input v-model.number="config.browserRender.defaultHeight" type="number" min="128" max="8192" class="input-field" />
        </FormField>
        <FormField label="截图大小上限 (bytes)">
          <input v-model.number="config.browserRender.maxScreenshotBytes" type="number" min="1024" max="104857600" step="1048576" class="input-field" />
        </FormField>
      </div>
    </SectionCard>

    <SectionCard title="安全与能力" class="mb-4">
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <ToggleField v-model="config.browserRender.allowPrivateHosts" label="允许截图内网/本机地址" hint="默认关闭；开启会带来 SSRF 风险，不建议" />
        <ToggleField v-model="config.codeRender.enabled" label="启用代码画图" hint="模型选择在「能力分工 → 代码画图」" />
      </div>
      <ul class="text-xs text-[color:var(--ink-3)] space-y-1 list-disc pl-5 mt-3">
        <li>代码渲染默认完全阻断 http/https/ws 网络请求，只允许内联 HTML/CSS/JS、SVG 和本地 Three.js。</li>
        <li>网页截屏会拦截 localhost、私有 IP、内网域名，并在导航前做 DNS 解析检查。</li>
        <li>每个任务使用独立 BrowserContext，finally 中关闭 page/context；空闲时关闭浏览器。</li>
        <li>任务超时、队列满、代码过大、截图过大都会直接返回明确错误。</li>
        <li>Three.js 使用本地 vendor 文件，不从 CDN 加载。</li>
      </ul>
    </SectionCard>

    <SectionCard title="支持的用法" class="mb-4">
      <div class="text-xs text-[color:var(--ink-3)] space-y-1">
        <p><code class="font-mono">用 HTML 画一个...</code> / <code class="font-mono">用 SVG 画一个...</code></p>
        <p><code class="font-mono">用 Canvas 画一个...</code> / <code class="font-mono">用 Three.js 画一个...</code></p>
        <p><code class="font-mono">截一下 https://example.com</code> / <code class="font-mono">网页截图 https://example.com 1200x800</code></p>
        <p>显式命令也可以使用：<code class="font-mono">代码画图 ...</code>、<code class="font-mono">网页截屏 ...</code>。</p>
      </div>
    </SectionCard>
  </div>
</template>
