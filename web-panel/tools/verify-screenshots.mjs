/**
 * 逐页整页截图（供人眼逐块核对视觉）。
 *
 * 与 verify-ui.mjs 的分工：
 *  - verify-ui.mjs        ：断言（原生控件/报错/溢出/a11y），只截视口图，快
 *  - verify-screenshots.mjs：纯取证，截整页长图，慢但完整
 *
 * 整页截图对超长配置页会较慢，所以单独跑、单独超时、失败不阻断。
 *
 * 用法：
 *   node web-panel/tools/verify-screenshots.mjs                 # 全部路由
 *   node web-panel/tools/verify-screenshots.mjs agent reply     # 指定路由
 */
import { chromium } from 'playwright-core';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, '../.verify/shots-full');
const BASE = process.env.MIOBOT_URL || 'http://127.0.0.1:3018/admin/';
const PASSWORD = process.env.MIOBOT_PANEL_PASSWORD || 'verify-seed';
const CHROME = process.env.PW_CHROME
    || 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';

const ALL_ROUTES = [
    'overview', 'access', 'permissions', 'capabilities', 'mcp',
    'models', 'agent', 'tools', 'jobs', 'prompts',
    'reply', 'features', 'templates', 'cap-image', 'cap-music',
    'cap-voice', 'cap-file', 'cap-memory', 'canvas', 'observability', 'settings',
];

const argRoutes = process.argv.slice(2).filter(a => !a.startsWith('--'));
const routes = argRoutes.length ? argRoutes : ALL_ROUTES;
const THEME = process.argv.includes('--dark') ? 'dark' : 'light';

let token = PASSWORD;
try {
    const res = await fetch(`${BASE.replace(/\/admin\/?$/, '')}/api/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: PASSWORD }),
    });
    if (res.ok) {
        const body = await res.json();
        token = body?.auth?.token || body?.token || PASSWORD;
    }
} catch { /* 用密码兜底 */ }

await fs.mkdir(OUT, { recursive: true });

const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
});

const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
await context.addInitScript(({ t, theme }) => {
    try { localStorage.setItem('miobot_token', t); } catch { /* ignore */ }
    try {
        if (theme === 'dark') localStorage.setItem('miobot_theme', 'dark');
        else localStorage.removeItem('miobot_theme');
    } catch { /* ignore */ }
}, { t: token, theme: THEME });

const page = await context.newPage();
page.setDefaultTimeout(15000);

/**
 * 关键：控制台的滚动发生在 `.main-scroll`（内层 div，overflow-y:auto），
 * 文档本身不滚动 —— 所以 `fullPage: true` 只能截到一屏。
 * 这里临时把内层容器与外壳的高度约束解开，让文档按内容撑高，
 * 截完由页面重载自动恢复（每次 goto 都是新的文档状态）。
 */
/**
 * 关键：控制台的滚动发生在 `.main-scroll`（内层 div，overflow-y:auto），
 * 文档本身不滚动 —— 所以 `fullPage: true` 只能截到一屏。
 *
 * 外壳是一条「h-screen + overflow-hidden」的祖先链（Tailwind 类，没有稳定选择器），
 * 所以这里从 .main-scroll 往上逐级把 height/overflow 约束解开，让文档按内容撑高。
 * 每次 goto 都是新文档，无需恢复。
 */
const EXPAND = () => {
    const main = document.querySelector('.main-scroll');
    if (!main) return false;
    let el = main;
    while (el && el !== document.documentElement) {
        el.style.setProperty('height', 'auto', 'important');
        el.style.setProperty('min-height', '0', 'important');
        el.style.setProperty('max-height', 'none', 'important');
        el.style.setProperty('overflow', 'visible', 'important');
        el = el.parentElement;
    }
    document.documentElement.style.setProperty('height', 'auto', 'important');
    document.documentElement.style.setProperty('overflow', 'visible', 'important');
    document.body.style.setProperty('height', 'auto', 'important');
    document.body.style.setProperty('overflow', 'visible', 'important');
    // 侧栏跟随内容高度，避免截图上侧栏断在半空
    const rail = document.querySelector('.rail');
    if (rail) {
        rail.style.setProperty('height', 'auto', 'important');
        rail.style.setProperty('min-height', '100%', 'important');
    }
    return true;
};

const done = [];
for (const route of routes) {
    try {
        await page.goto(`${BASE}#/${route}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForFunction(() => document.querySelector('.rail') != null, null, { timeout: 15000 });
        await page.waitForTimeout(1100);
        await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});
        await page.waitForTimeout(300);

        const expanded = await page.evaluate(EXPAND);
        if (!expanded) throw new Error('.main-scroll not found');
        await page.waitForTimeout(350);

        const suffix = THEME === 'dark' ? '-dark' : '';
        await page.screenshot({
            path: path.join(OUT, `${route}${suffix}.png`),
            fullPage: true,
            animations: 'disabled',
            timeout: 60000,
        });
        done.push(route);
        console.log(`OK   ${route}`);
    } catch (err) {
        console.log(`SKIP ${route}  (${String(err?.message || err).slice(0, 70)})`);
    }
}

await browser.close();
console.log(`\n${done.length}/${routes.length} 张整页截图 → ${OUT}`);
