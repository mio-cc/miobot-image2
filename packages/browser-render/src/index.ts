import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import sharp from 'sharp';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import type { AppConfig, BrowserRenderConfig, CodeRenderConfig } from '../../config/src/index.js';

export type CodeRenderFormat = 'html' | 'svg' | 'canvas' | 'three';

export interface CodeArtifact {
  format: CodeRenderFormat;
  title?: string;
  width: number;
  height: number;
  html?: string;
  css?: string;
  js?: string;
  svg?: string;
  waitMs?: number;
  readyExpression?: string;
  fullPage?: boolean;
  sendSource?: boolean;
}

export interface RenderedImage {
  path: string;
  name: string;
  mime: string;
  width: number;
  height: number;
  size: number;
  source?: CodeArtifact;
}

export interface UrlScreenshotOptions {
  url: string;
  width?: number;
  height?: number;
  fullPage?: boolean;
  waitMs?: number;
}

export interface BrowserRenderService {
  renderCode(artifact: unknown, outputDir: string): Promise<RenderedImage>;
  screenshotUrl(options: UrlScreenshotOptions, outputDir: string): Promise<RenderedImage>;
  close(): Promise<void>;
}

export interface BrowserRendererOptions {
  getConfig: () => AppConfig;
  logger?: { info(message: string, data?: Record<string, unknown>): void; warn(message: string, data?: Record<string, unknown>): void };
}

/** Chromium 的低资源、低攻击面启动参数；不包含 --disable-web-security。 */
export const CHROMIUM_LAUNCH_ARGS = [
  '--headless=new',
  '--disable-dev-shm-usage',
  '--disable-background-networking',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-breakpad',
  '--disable-extensions',
  '--disable-sync',
  '--disable-translate',
  '--disable-default-apps',
  '--disable-component-update',
  '--disable-domain-reliability',
  '--disable-client-side-phishing-detection',
  '--disable-features=Translate,BackForwardCache,AcceptCHFrame,MediaRouter,OptimizationHints',
  '--disable-notifications',
  '--deny-permission-prompts',
  '--mute-audio',
  '--hide-scrollbars',
  '--metrics-recording-only',
  '--no-first-run',
  '--no-default-browser-check',
  '--renderer-process-limit=1',
  '--js-flags=--max-old-space-size=512',
];

const DEFAULT_CODE_TIMEOUT_MS = 30000;

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : fallback;
}

function isPrivateIpv4(host: string): boolean {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return false;
  const [a, b] = host.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127);
}

export async function assertSafePublicUrl(raw: string, allowPrivate = false): Promise<URL> {
  let url: URL;
  try { url = new URL(String(raw || '').trim()); } catch { throw new Error('URL 格式无效'); }
  if (!/^https?:$/.test(url.protocol)) throw new Error('网页截屏只支持 http/https');
  if (url.username || url.password) throw new Error('URL 不能带用户名或密码');
  if (!url.hostname) throw new Error('URL 缺少主机名');
  if (!allowPrivate) {
    const host = url.hostname.toLowerCase();
    if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.localhost') || host === '::1' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd') || isPrivateIpv4(host)) {
      throw new Error('禁止访问本机、内网或保留地址');
    }
    try {
      const resolved = await lookup(host, { all: true });
      if (resolved.some((entry) => isPrivateIpv4(entry.address) || entry.address === '::1' || entry.address.startsWith('fe80:') || entry.address.startsWith('fc') || entry.address.startsWith('fd'))) {
        throw new Error('域名解析到内网或保留地址');
      }
    } catch (error: any) {
      if (String(error?.message || '').includes('内网')) throw error;
      // DNS 解析失败交给浏览器给出明确错误，避免把一次性 DNS 故障误判成 SSRF。
    }
  }
  return url;
}

function sanitizeSvgSource(value: string): string {
  let text = String(value || '').trim();
  if (text.startsWith('```')) { const nl = text.indexOf('\n'); text = nl >= 0 ? text.slice(nl + 1) : text.slice(3); }
  if (text.endsWith('```')) text = text.slice(0, -3);
  text = text.trim();
  const lower = text.toLowerCase();
  const start = lower.indexOf('<svg');
  if (start >= 0) text = text.slice(start);
  const close = text.toLowerCase().indexOf('</svg>');
  if (close >= 0) text = text.slice(0, close + 6);
  return text.trim();
}

export function normalizeCodeArtifact(input: unknown, config: BrowserRenderConfig): CodeArtifact {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('代码画图结构必须是对象');
  const raw = input as Record<string, any>;
  const format = String(raw.format || 'html').toLowerCase() as CodeRenderFormat;
  if (!['html', 'svg', 'canvas', 'three'].includes(format)) throw new Error(`不支持的代码画图格式: ${format}`);
  const width = clampInt(raw.width, config.defaultWidth, 128, config.maxWidth);
  const height = clampInt(raw.height, config.defaultHeight, 128, config.maxHeight);
  const artifact: CodeArtifact = {
    format,
    title: raw.title === undefined ? undefined : String(raw.title).slice(0, 200),
    width,
    height,
    html: raw.html === undefined ? undefined : String(raw.html).slice(0, config.maxCodeChars),
    css: raw.css === undefined ? undefined : String(raw.css).slice(0, config.maxCodeChars),
    js: raw.js === undefined ? undefined : String(raw.js).slice(0, config.maxCodeChars),
    svg: raw.svg === undefined ? undefined : sanitizeSvgSource(String(raw.svg)).slice(0, config.maxCodeChars),
    waitMs: clampInt(raw.waitMs, 600, 0, 10000),
    readyExpression: raw.readyExpression === undefined ? undefined : String(raw.readyExpression).slice(0, 500),
    fullPage: raw.fullPage === true,
    sendSource: raw.sendSource === true,
  };
  const total = (artifact.html || '').length + (artifact.css || '').length + (artifact.js || '').length + (artifact.svg || '').length;
  if (total > config.maxCodeChars) throw new Error(`代码总长度超过上限 ${config.maxCodeChars}`);
  if (format === 'svg' && !artifact.svg?.trim()) throw new Error('SVG 画图缺少 svg 源码');
  if (['canvas', 'three'].includes(format) && !artifact.js?.trim()) throw new Error(`${format} 画图缺少 js 源码`);
  if (format === 'html' && !artifact.html?.trim() && !artifact.js?.trim()) throw new Error('HTML 画图缺少 html 或 js 内容');
  return artifact;
}

async function loadThreeSource(): Promise<string> {
  const candidates = [
    path.resolve(process.cwd(), 'packages/browser-render/vendor/three.min.js'),
    path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../../../../packages/browser-render/vendor/three.min.js'),
  ];
  for (const candidate of candidates) {
    try { return await fs.readFile(candidate, 'utf8'); } catch { /* try next */ }
  }
  throw new Error('Three.js 本地运行库缺失');
}

export async function buildCodeDocument(artifact: CodeArtifact): Promise<string> {
  const three = artifact.format === 'three' ? await loadThreeSource() : '';
  const body = artifact.format === 'svg'
    ? `<div class="miobot-svg">${artifact.svg || ''}</div>`
    : artifact.format === 'html'
      ? (artifact.html || '')
      : `<canvas id="miobot-canvas" width="${artifact.width}" height="${artifact.height}"></canvas>${artifact.html || ''}`;
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(artifact.title || 'Miobot Code Art')}</title>
<style>html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:#fff}${artifact.css || ''}</style>
</head><body>${body}
${three ? `<script>${three}</script>` : ''}
<script>
window.__MIOBOT_READY__ = false;
try {
${artifact.js || ''}
} catch (error) {
  window.__MIOBOT_ERROR__ = String(error && error.stack || error);
  document.body.innerHTML = '<pre style="color:#b91c1c;white-space:pre-wrap;padding:24px;font:14px monospace">Code error: ' + String(error).replace(/[<>&]/g, function(c){return {'<':'&lt;','>':'&gt;','&':'&amp;'}[c];}) + '</pre>';
}
window.__MIOBOT_READY__ = true;
</script></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[<>&"']/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[char] as string));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createBrowserRenderer(options: BrowserRendererOptions): BrowserRenderService {
  let browser: Browser | null = null;
  let launchPromise: Promise<Browser> | null = null;
  let active = 0;
  let waiters: Array<() => void> = [];
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const config = (): BrowserRenderConfig => options.getConfig().browserRender;
  function executablePath(cfg: BrowserRenderConfig): string | undefined {
    const candidates = [cfg.executablePath, process.env.MIOBOT_CHROMIUM_PATH, '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'];
    return candidates.find((candidate) => Boolean(candidate) && existsSync(String(candidate)));
  }
  const codeTimeout = (): number => options.getConfig().codeRender?.timeoutMs || DEFAULT_CODE_TIMEOUT_MS;

  function argsFor(cfg: BrowserRenderConfig): string[] {
    const args = [...CHROMIUM_LAUNCH_ARGS];
    if (cfg.noSandbox) args.push('--no-sandbox', '--disable-setuid-sandbox');
    if (cfg.enableWebgl) args.push('--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist');
    else args.push('--disable-gpu');
    return args;
  }

  async function getBrowser(): Promise<Browser> {
    if (browser?.isConnected()) return browser;
    if (launchPromise) return launchPromise;
    const cfg = config();
    if (!cfg.enabled) throw new Error('浏览器渲染未启用');
    launchPromise = chromium.launch({
      headless: true,
      executablePath: executablePath(cfg),
      chromiumSandbox: !cfg.noSandbox,
      args: argsFor(cfg),
      timeout: cfg.launchTimeoutMs,
    }).then((value) => {
      browser = value;
      value.on('disconnected', () => { if (browser === value) browser = null; });
      options.logger?.info('Chromium 已启动', { executablePath: cfg.executablePath || 'playwright-auto' });
      return value;
    }).finally(() => { launchPromise = null; });
    return launchPromise;
  }

  function scheduleIdleClose(): void {
    if (idleTimer) clearTimeout(idleTimer);
    const idleMs = config().idleCloseMs;
    if (!idleMs || active > 0) return;
    idleTimer = setTimeout(() => { void closeBrowser(); }, idleMs);
    idleTimer.unref?.();
  }

  async function closeBrowser(): Promise<void> {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    const current = browser;
    browser = null;
    if (current) await current.close().catch(() => undefined);
  }

  async function withSlot<T>(task: () => Promise<T>): Promise<T> {
    const cfg = config();
    if (active >= cfg.maxConcurrency) {
      if (waiters.length >= cfg.maxQueue) throw new Error('渲染任务排队已满，请稍后再试');
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
    active += 1;
    try { return await task(); }
    finally {
      active -= 1;
      waiters.shift()?.();
      scheduleIdleClose();
    }
  }

  async function newPage(width: number, height: number): Promise<{ context: BrowserContext; page: Page }> {
    const b = await getBrowser();
    const context = await b.newContext({
      viewport: { width, height },
      deviceScaleFactor: 1,
      serviceWorkers: 'block',
      permissions: [],
      locale: 'zh-CN',
    });
    const page = await context.newPage();
    page.setDefaultTimeout(config().timeoutMs);
    page.setDefaultNavigationTimeout(config().timeoutMs);
    page.on('dialog', (dialog) => { void dialog.dismiss().catch(() => undefined); });
    page.on('popup', (popup) => { void popup.close().catch(() => undefined); });
    return { context, page };
  }

  async function saveScreenshot(page: Page, outputDir: string, width: number, height: number, fullPage = false, source?: CodeArtifact): Promise<RenderedImage> {
    await fs.mkdir(outputDir, { recursive: true });
    const name = `code-${Date.now()}-${randomUUID().slice(0, 8)}.png`;
    const filePath = path.join(outputDir, name);
    await page.screenshot({ path: filePath, type: 'png', fullPage });
    const stat = await fs.stat(filePath);
    if (stat.size > config().maxScreenshotBytes) {
      await fs.unlink(filePath).catch(() => undefined);
      throw new Error(`截图超过大小上限 ${config().maxScreenshotBytes} bytes`);
    }
    return { path: filePath, name, mime: 'image/png', width, height, size: stat.size, source };
  }

  async function renderSvgFallback(artifact: CodeArtifact, outputDir: string): Promise<RenderedImage> {
    await fs.mkdir(outputDir, { recursive: true });
    const name = `code-${Date.now()}-${randomUUID().slice(0, 8)}.png`;
    const filePath = path.join(outputDir, name);
    const buffer = await sharp(Buffer.from(artifact.svg || ''))
      .resize(artifact.width, artifact.height, { fit: 'fill' })
      .png()
      .toBuffer();
    if (buffer.length > config().maxScreenshotBytes) throw new Error(`SVG 渲染超过大小上限 ${config().maxScreenshotBytes} bytes`);
    await fs.writeFile(filePath, buffer);
    options.logger?.warn('Chromium 不可用，已使用 SVG 光栅化兜底', { width: artifact.width, height: artifact.height, bytes: buffer.length });
    return { path: filePath, name, mime: 'image/png', width: artifact.width, height: artifact.height, size: buffer.length, source: artifact };
  }

  async function renderCodeInternal(artifactInput: unknown, outputDir: string): Promise<RenderedImage> {
    const cfg = config();
    if (!cfg.enabled) throw new Error('浏览器渲染未启用');
    const artifact = normalizeCodeArtifact(artifactInput, cfg);
    try {
      return await renderCodeWithBrowser(artifact, outputDir);
    } catch (error) {
      if (artifact.format !== 'svg') throw error;
      options.logger?.warn('Chromium 渲染失败，尝试 SVG 光栅化兜底', { error: String((error as Error)?.message || error) });
      return await renderSvgFallback(artifact, outputDir);
    }
  }

  async function renderCodeWithBrowser(artifact: CodeArtifact, outputDir: string): Promise<RenderedImage> {
    const cfg = config();
    const html = await buildCodeDocument(artifact);
    const { context, page } = await newPage(artifact.width, artifact.height);
    try {
      await page.route('**/*', (route) => {
        const requestUrl = route.request().url();
        if (/^(data|blob|about):/i.test(requestUrl)) return route.continue();
        return route.abort();
      });
      await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: Math.min(cfg.timeoutMs, codeTimeout()) });
      await page.evaluate(async () => {
        await (document as any).fonts?.ready?.catch?.(() => undefined);
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      }).catch(() => undefined);
      if (artifact.readyExpression) {
        await page.waitForFunction(artifact.readyExpression, undefined, { timeout: Math.min(cfg.timeoutMs, codeTimeout()) }).catch(() => undefined);
      }
      if (artifact.waitMs) await sleep(artifact.waitMs);
      const error = await page.evaluate(() => (window as any).__MIOBOT_ERROR__ || '').catch(() => '');
      if (error) throw new Error(`代码运行失败: ${String(error).slice(0, 500)}`);
      return await saveScreenshot(page, outputDir, artifact.width, artifact.height, artifact.fullPage, artifact);
    } finally {
      await page.close().catch(() => undefined);
      await context.close().catch(() => undefined);
    }
  }

  async function screenshotUrlInternal(input: UrlScreenshotOptions, outputDir: string): Promise<RenderedImage> {
    const cfg = config();
    if (!cfg.enabled) throw new Error('网页截屏未启用');
    const url = await assertSafePublicUrl(input.url, cfg.allowPrivateHosts);
    const width = clampInt(input.width, cfg.defaultWidth, 128, cfg.maxWidth);
    const height = clampInt(input.height, cfg.defaultHeight, 128, cfg.maxHeight);
    const { context, page } = await newPage(width, height);
    try {
      await page.route('**/*', (route) => {
        const requestUrl = route.request().url();
        if (/^(about|data|blob):/i.test(requestUrl)) return route.continue();
        try {
          const parsed = new URL(requestUrl);
          if (!/^https?:$/.test(parsed.protocol)) return route.abort();
          if (!cfg.allowPrivateHosts) {
            const host = parsed.hostname.toLowerCase();
            if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') || isPrivateIpv4(host)) return route.abort();
          }
          return route.continue();
        } catch { return route.abort(); }
      });
      await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: cfg.timeoutMs });
      await page.evaluate(async () => {
        await (document as any).fonts?.ready?.catch?.(() => undefined);
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      }).catch(() => undefined);
      if (input.waitMs) await sleep(input.waitMs);
      return await saveScreenshot(page, outputDir, width, height, input.fullPage === true);
    } finally {
      await page.close().catch(() => undefined);
      await context.close().catch(() => undefined);
    }
  }

  return {
    renderCode: (artifact, outputDir) => withSlot(() => renderCodeInternal(artifact, outputDir)),
    screenshotUrl: (input, outputDir) => withSlot(() => screenshotUrlInternal(input, outputDir)),
    close: closeBrowser,
  };
}
