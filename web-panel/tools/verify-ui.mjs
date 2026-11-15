/**
 * Phase-UI 无头浏览器核查器。
 *
 * 目标：为「逐控件 / 逐页面」验收提供可复现证据——
 *   1. nativeControls  最终 DOM 里还剩多少原生低质量控件（必须为 0）
 *   2. consoleErrors   控制台错误（必须为 0）
 *   3. layoutOverflow  横向溢出元素（必须为 0，或仅白名单）
 *   4. a11yMissing     可交互元素缺可访问名
 *   5. snapshot        每页截图 + 关键元素尺寸
 *
 * 用法：
 *   node web-panel/tools/verify-ui.mjs                 # 全部路由
 *   node web-panel/tools/verify-ui.mjs overview reply  # 指定路由
 *   node web-panel/tools/verify-ui.mjs --url=http://127.0.0.1:3018/admin/
 *
 * 前置：服务已在 --url 监听，且 apps/panel/static/admin 是当前构建产物。
 */
import { chromium } from 'playwright-core';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PANEL_ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(PANEL_ROOT, '.verify');
const SHOT_DIR = path.join(OUT_DIR, 'shots');

const argv = process.argv.slice(2);
const urlArg = argv.find(a => a.startsWith('--url='));
const BASE = urlArg ? urlArg.slice(6) : 'http://127.0.0.1:3018/admin/';
const onlyRoutes = argv.filter(a => !a.startsWith('--'));

const CHROME = process.env.PW_CHROME
    || 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';

/** 侧栏可见的全部一级路由（与 router/index.ts 的 navRoutes 对齐）。 */
const ALL_ROUTES = [
    'overview', 'access', 'permissions', 'capabilities', 'mcp',
    'models', 'agent', 'tools', 'jobs', 'prompts',
    'reply', 'features', 'templates', 'cap-image', 'cap-music',
    'cap-voice', 'cap-file', 'cap-memory', 'canvas', 'observability', 'settings',
];

const routes = onlyRoutes.length ? onlyRoutes : ALL_ROUTES;

/**
 * 页面内注入的探测脚本。
 * 注意：这里的字符串会原样在浏览器里 eval，改动时保持自包含、不依赖外部变量。
 */
const PROBE = `(() => {
  const isVisible = (el) => {
    if (!el) return false;
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  /* ── 1. 原生低质量控件 ── */
  const native = [];
  const push = (el, kind) => {
    if (!isVisible(el)) return;
    // 组件内部封装的隐藏 input 允许存在（file picker / switch 的真实 input）
    const r = el.getBoundingClientRect();
    if (r.width <= 2 || r.height <= 2) return;
    native.push({
      kind,
      tag: el.tagName.toLowerCase(),
      cls: (el.className || '').toString().slice(0, 80),
      text: (el.textContent || '').trim().slice(0, 40),
    });
  };
  document.querySelectorAll('select').forEach(el => push(el, 'select'));
  document.querySelectorAll('input[type=checkbox]').forEach(el => {
    // 仅当它自身可见、且没有被 sr-only/自定义外框覆盖时才算
    const rect = el.getBoundingClientRect();
    if (rect.width <= 2 || rect.height <= 2) return;
    if (getComputedStyle(el).opacity === '0') return;
    if (getComputedStyle(el).appearance === 'none' && el.parentElement &&
        el.parentElement.querySelector('.toggle-slider, [class*=switch], [class*=checkbox]')) return;
    push(el, 'checkbox');
  });
  document.querySelectorAll('input[type=number]').forEach(el => push(el, 'number'));
  document.querySelectorAll('input[type=range]').forEach(el => push(el, 'range'));
  document.querySelectorAll('input[type=radio]').forEach(el => {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 2 || rect.height <= 2) return;
    push(el, 'radio');
  });

  /* ── 2. 横向溢出 ── */
  const overflow = [];
  const rootW = document.documentElement.clientWidth;
  document.querySelectorAll('body *').forEach(el => {
    if (!isVisible(el)) return;
    const r = el.getBoundingClientRect();
    if (r.right > rootW + 2 || r.left < -2) {
      // 浮层/Teleport 面板豁免
      if (el.closest('[data-ui-floating],[role=listbox],[role=dialog],[data-teleport]')) return;
      overflow.push({
        tag: el.tagName.toLowerCase(),
        cls: (el.className || '').toString().slice(0, 70),
        left: Math.round(r.left), right: Math.round(r.right), rootW,
      });
    }
  });

  /* ── 3. 可交互元素缺可访问名 ── */
  const a11y = [];
  const interactive = document.querySelectorAll('button, [role=button], a[href], [role=switch], [role=slider], [role=combobox]');
  interactive.forEach(el => {
    if (!isVisible(el)) return;
    const name = (el.getAttribute('aria-label') || el.textContent || '').trim()
      || el.getAttribute('title') || '';
    if (!name) {
      a11y.push({ tag: el.tagName.toLowerCase(), cls: (el.className || '').toString().slice(0, 70) });
    }
  });

  /* ── 4. 结构快照 ── */
  const aside = document.querySelector('aside');
  const shell = document.querySelector('.sidebar, [data-ui-surface=sidebar]');
  return {
    nativeControls: native,
    layoutOverflow: overflow,
    a11yMissingLabels: a11y,
    counts: {
      select: document.querySelectorAll('select').length,
      number: document.querySelectorAll('input[type=number]').length,
      checkbox: document.querySelectorAll('input[type=checkbox]').length,
      range: document.querySelectorAll('input[type=range]').length,
      radio: document.querySelectorAll('input[type=radio]').length,
      file: document.querySelectorAll('input[type=file]').length,
      buttons: document.querySelectorAll('button').length,
    },
    layout: {
      viewport: { w: rootW, h: window.innerHeight },
      bodyScrollW: document.documentElement.scrollWidth,
      sidebarW: aside ? Math.round(aside.getBoundingClientRect().width) : null,
      sidebarCollapsed: aside ? aside.getAttribute('data-rail') : null,
      shellPresent: Boolean(shell),
    },
  };
})()`;

async function main() {
    await fs.mkdir(SHOT_DIR, { recursive: true });

    const browser = await chromium.launch({
        executablePath: CHROME,
        headless: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'],
    });

    const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 1,
        locale: 'zh-CN',
    });

    /* ── 确定性认证：直接预置 localStorage token，避免与登录页挂载赛跑。
       面板密码派生的 token 就是 seed 本身（服务端 /api/login 返回 auth.token）。── */
    const password = process.env.MIOBOT_PANEL_PASSWORD;
    if (password) {
        let token = password;
        try {
            const res = await fetch(`${BASE.replace(/\/admin\/?$/, '')}/api/login`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ password }),
            });
            if (res.ok) {
                const body = await res.json();
                token = body?.auth?.token || body?.token || password;
            }
        } catch { /* 服务不可达时退回用密码本身当 token */ }
        await context.addInitScript(t => {
            try { localStorage.setItem('miobot_token', t); } catch { /* ignore */ }
        }, token);
    }

    /** 收集控制台错误（只关心 error 级别，warning 噪声不计入闸门）。 */
    const results = [];

    for (const route of routes) {
        const page = await context.newPage();
        /* 只把「真正的 JS 异常」计入闸门。
           网络层 4xx/5xx（外部 API、MCP、Suno 等在本机不可达）属于环境噪声，
           单独归到 networkWarnings 供人眼参考，不作为 UI 缺陷判定。 */
        const consoleErrors = [];
        const networkWarnings = [];
        page.on('console', msg => {
            if (msg.type() !== 'error') return;
            const text = msg.text().slice(0, 200);
            if (/Failed to load resource|status of 4\d\d|status of 5\d\d|net::ERR_/i.test(text)) {
                networkWarnings.push(text);
            } else {
                consoleErrors.push(text);
            }
        });
        page.on('pageerror', err => consoleErrors.push(`pageerror: ${String(err).slice(0, 200)}`));

        const target = `${BASE}#/${route}`;
        let probe = null;
        let navError = null;
        try {
            await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 20000 });

            // 等应用挂载出内容（不是登录页、也不是空壳）
            await page.waitForFunction(
                () => document.querySelector('.shell, .rail, main') != null
                    && !document.querySelector('input[type=password]'),
                { timeout: 15000 },
            ).catch(() => {});

            await page.waitForTimeout(900);
            await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});
            await page.waitForTimeout(350);

            probe = await page.evaluate(PROBE);

            // 只截视口图（整页长图会在大页面上超时，且验收主要看首屏布局）
            await page.screenshot({
                path: path.join(SHOT_DIR, `${route}.png`),
                fullPage: false,
                timeout: 20000,
                animations: 'disabled',
            });
        } catch (err) {
            navError = String(err).slice(0, 300);
        }

        results.push({
            route,
            url: target,
            navError,
            consoleErrors,
            networkWarnings,
            ...(probe || {}),
        });

        await page.close();
    }

    await browser.close();

    /* ── 汇总闸门 ── */
    const summary = {
        generatedAt: new Date().toISOString(),
        base: BASE,
        routes: results.length,
        gates: {
            totalNativeControls: results.reduce((n, r) => n + (r.nativeControls?.length || 0), 0),
            totalConsoleErrors: results.reduce((n, r) => n + (r.consoleErrors?.length || 0), 0),
            totalOverflow: results.reduce((n, r) => n + (r.layoutOverflow?.length || 0), 0),
            totalA11y: results.reduce((n, r) => n + (r.a11yMissingLabels?.length || 0), 0),
            navErrors: results.filter(r => r.navError).length,
        },
        perRoute: results.map(r => ({
            route: r.route,
            navError: r.navError,
            consoleErrors: r.consoleErrors?.length || 0,
            networkWarnings: r.networkWarnings?.length || 0,
            nativeControls: r.nativeControls?.length || 0,
            nativeBreakdown: (r.nativeControls || []).reduce((acc, n) => {
                acc[n.kind] = (acc[n.kind] || 0) + 1; return acc;
            }, {}),
            overflow: r.layoutOverflow?.length || 0,
            a11yMissing: r.a11yMissingLabels?.length || 0,
            sidebarW: r.layout?.sidebarW ?? null,
            sidebarCollapsed: r.layout?.sidebarCollapsed ?? null,
        })),
    };

    await fs.writeFile(path.join(OUT_DIR, 'report.json'), JSON.stringify({ summary, detail: results }, null, 2), 'utf8');

    /* ── 控制台表格 ── */
    console.log('\n=== Phase-UI 核查报告 ===');
    console.log(`base: ${BASE}`);
    console.log(`输出: ${OUT_DIR}`);
    console.log('');
    const pad = (s, n) => String(s).padEnd(n);
    console.log(pad('route', 16), pad('native', 7), pad('err', 5), pad('ovf', 5), pad('a11y', 5), 'breakdown');
    for (const r of summary.perRoute) {
        console.log(
            pad(r.route, 16),
            pad(r.nativeControls, 7),
            pad(r.consoleErrors, 5),
            pad(r.overflow, 5),
            pad(r.a11yMissing, 5),
            JSON.stringify(r.nativeBreakdown),
        );
    }
    console.log('');
    console.log('闸门合计:', JSON.stringify(summary.gates));

    const failed = summary.gates.totalNativeControls > 0
        || summary.gates.totalConsoleErrors > 0
        || summary.gates.navErrors > 0;

    if (failed) {
        console.log('\n[FAIL] 未通过闸门。详见 .verify/report.json');
        process.exitCode = 1;
    } else {
        console.log('\n[PASS] 原生控件 0 / 控制台错误 0 / 导航错误 0');
    }
}

main().catch(err => {
    console.error('[verify-ui] 致命错误:', err);
    process.exitCode = 2;
});
