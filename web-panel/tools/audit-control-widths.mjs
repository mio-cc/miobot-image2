/**
 * audit-control-widths —— 用真实渲染数据找出「过宽」的控件。
 *
 * 判据：控件的实际宽度远大于它当前内容需要的宽度（且不是 textarea / 不是多行文本）。
 * 这类控件就是「一个数字框/枚举框占了半行」的典型，属于本次要修的版式问题。
 *
 * 用法：node web-panel/tools/audit-control-widths.mjs [route...]
 * 输出：控制台表格 + .verify/width-audit.json
 */
import { chromium } from 'playwright-core';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, '../.verify');
const BASE = process.env.MIOBOT_URL || 'http://127.0.0.1:3018/admin/';
const PASSWORD = process.env.MIOBOT_PANEL_PASSWORD || 'verify-seed';
const CHROME = process.env.PW_CHROME
    || 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';

const DEFAULT_ROUTES = [
    'overview', 'access', 'permissions', 'capabilities', 'models', 'agent',
    'tools', 'jobs', 'prompts', 'reply', 'features', 'templates',
    'cap-image', 'cap-music', 'cap-voice', 'cap-file', 'cap-memory',
    'canvas', 'observability', 'settings',
];
const argRoutes = process.argv.slice(2).filter(a => !a.startsWith('--'));
const routes = argRoutes.length ? argRoutes : DEFAULT_ROUTES;

const PROBE = `(() => {
  const out = [];
  const measureText = (text, cs) => {
    const c = document.createElement('canvas').getContext('2d');
    c.font = cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily;
    return c.measureText(text || '').width;
  };
  const nodes = document.querySelectorAll('input.input-field, textarea.input-field, .app-select-trigger, .numfield');
  nodes.forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return;
    const tag = el.tagName.toLowerCase();
    const isArea = tag === 'textarea';
    if (isArea) return;                      // 多行文本本来就该宽
    const isNum = el.classList.contains('numfield');
    const isSel = el.classList.contains('app-select-trigger');
    // 取「实际会显示的内容」：input 用 value，numfield 取内部 input，select 取触发器文本
    let content = '';
    if (isNum) content = (el.querySelector('input')?.value ?? '');
    else if (isSel) content = (el.textContent || '').trim();
    else if (tag === 'input') content = el.value || el.placeholder || '';
    const textW = measureText(content, cs);
    const padW = parseFloat(cs.paddingLeft || '0') + parseFloat(cs.paddingRight || '0');
    // 控件里还有箭头/步进器/图标，给一个固定余量
    const chromeW = isSel ? 34 : isNum ? 34 : 12;
    const need = textW + padW + chromeW;
    const ratio = r.width / Math.max(need, 1);
    if (ratio >= 2.2 && r.width - need >= 70) {
      out.push({
        tag: isNum ? 'number' : isSel ? 'select' : tag,
        w: Math.round(r.width),
        need: Math.round(need),
        ratio: Number(ratio.toFixed(1)),
        content: content.slice(0, 24),
        label: (el.getAttribute('aria-label') || '').slice(0, 24),
      });
    }
  });
  return out;
})()`;

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

const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
await context.addInitScript(t => { try { localStorage.setItem('miobot_token', t); } catch { /* ignore */ } }, token);

const page = await context.newPage();
page.setDefaultTimeout(12000);

const report = {};
for (const route of routes) {
    try {
        await page.goto(`${BASE}#/${route}`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => document.querySelector('.rail') != null, null, { timeout: 12000 });
        await page.waitForTimeout(1000);
        const found = await page.evaluate(PROBE);
        report[route] = found;
    } catch (err) {
        report[route] = [{ error: String(err?.message || err).slice(0, 80) }];
    }
}

await browser.close();

await fs.mkdir(OUT, { recursive: true });
await fs.writeFile(path.join(OUT, 'width-audit.json'), JSON.stringify(report, null, 2), 'utf8');

let total = 0;
for (const [route, rows] of Object.entries(report)) {
    if (!rows.length) continue;
    if (rows[0]?.error) { console.log(`${route.padEnd(15)} ERROR ${rows[0].error}`); continue; }
    total += rows.length;
    console.log(`\n### ${route}  (${rows.length} 个过宽控件)`);
    for (const r of rows.sort((a, b) => b.w - a.w).slice(0, 8)) {
        console.log(`   ${String(r.w).padStart(4)}px  需~${String(r.need).padStart(4)}px  ×${r.ratio}  ${r.tag.padEnd(7)} "${r.content}"`);
    }
}
console.log(`\n合计 ${total} 个过宽控件 → .verify/width-audit.json`);
