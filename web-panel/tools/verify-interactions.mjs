/**
 * Phase-UI 交互验收器。
 *
 * verify-ui.mjs 只证明「看起来对」（无原生控件 / 无报错 / 无溢出）；
 * 本脚本进一步证明「用起来对」——对真实 DOM 跑交互并按预期断言：
 *
 *   1. 侧栏：收起 64px → 悬停展开 248px → 移开回缩 → 钉住常驻 → 取消钉住
 *   2. 数字步进器：▲ +step / ▼ 回退 / ↓ 键 / 越界 clamp / 空值 → null
 *   3. 开关：点击切换 aria-checked
 *   4. 下拉：点击开面板 / Esc 关闭 / 焦点归还
 *   5. 滑动条：方向键改值
 *   6. 深色主题：data-theme 切换后 body 背景变化
 *
 * 工程约束：每一步都包在 guard() 里并带超时，任一项失败/挂起都不会拖垮整轮；
 * 顶部有硬看门狗，超时强制退出并保留已产出的结果。
 *
 * 用法：MIOBOT_PANEL_PASSWORD=verify-seed node web-panel/tools/verify-interactions.mjs
 */
import { chromium } from 'playwright-core';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, '../.verify');
const BASE = process.env.MIOBOT_URL || 'http://127.0.0.1:3018/admin/';
const PASSWORD = process.env.MIOBOT_PANEL_PASSWORD || 'verify-seed';
const CHROME = process.env.PW_CHROME
    || 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';

const STEP_TIMEOUT = 20000;
const WATCHDOG_MS = 240000;

const results = [];

function check(name, ok, detail = '') {
    results.push({ name, ok: Boolean(ok), detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

/** 把任意 promise 包上超时，避免单步挂死整轮。 */
function withTimeout(promise, ms, label) {
    let timer;
    const guard = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout ${ms}ms: ${label}`)), ms);
    });
    return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

/** 单步执行器：异常转成 FAIL 而不是中断整轮。 */
async function step(name, fn) {
    try {
        await withTimeout(fn(), STEP_TIMEOUT, name);
    } catch (err) {
        check(name, false, String(err?.message || err).slice(0, 160));
    }
}

async function writeReport() {
    const failed = results.filter(r => !r.ok);
    await fs.mkdir(OUT_DIR, { recursive: true });
    await fs.writeFile(
        path.join(OUT_DIR, 'interactions.json'),
        JSON.stringify({ generatedAt: new Date().toISOString(), results, failed: failed.length }, null, 2),
        'utf8',
    );
    return failed;
}

async function main() {
    // 硬看门狗：无论卡在哪一步，都要落盘并退出
    const watchdog = setTimeout(async () => {
        console.error(`\n[WATCHDOG] 超过 ${WATCHDOG_MS}ms，强制结束并写出已完成的结果`);
        await writeReport().catch(() => {});
        process.exit(3);
    }, WATCHDOG_MS);
    watchdog.unref?.();

    // 取真实 token（面板密码派生）
    let token = PASSWORD;
    try {
        const res = await withTimeout(fetch(`${BASE.replace(/\/admin\/?$/, '')}/api/login`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ password: PASSWORD }),
        }), 8000, 'login');
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

    try {
        const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
        await context.addInitScript(t => {
            try { localStorage.setItem('miobot_token', t); } catch { /* ignore */ }
            try { localStorage.removeItem('miobot_sidebar_pinned'); } catch { /* ignore */ }
        }, token);

        const page = await context.newPage();
        page.setDefaultTimeout(8000);
        page.setDefaultNavigationTimeout(20000);

        const jsErrors = [];
        page.on('pageerror', e => jsErrors.push(String(e).slice(0, 160)));

        /**
         * 切页。第二个参数是该页的「就绪选择器」——必须等它出现，
         * 否则会踩到「.rail 早就在 DOM 里 → 以为切页完成 → 其实路由组件还在懒加载」的竞态。
         */
        const goto = async (route, readySelector) => {
            if (!page.url().includes('/admin/')) {
                await page.goto(`${BASE}#/${route}`, { waitUntil: 'domcontentloaded' });
            } else {
                await page.evaluate(r => { window.location.hash = `#/${r}`; }, route);
            }
            await page.waitForFunction(() => document.querySelector('.rail') != null, null, { timeout: 15000 });
            if (readySelector) {
                await page.locator(readySelector).first().waitFor({ state: 'attached', timeout: 15000 });
            }
            await page.waitForTimeout(450);
        };

        const railWidth = () => page.evaluate(() => {
            const el = document.querySelector('.rail');
            return el ? Math.round(el.getBoundingClientRect().width) : -1;
        });

        /** 等侧栏宽度进入目标区间（过渡 260ms），比固定 sleep 稳。 */
        const waitRailWidth = async (target, tolerance = 3) => {
            await page.waitForFunction(
                ({ t, tol }) => {
                    const el = document.querySelector('.rail');
                    if (!el) return false;
                    return Math.abs(Math.round(el.getBoundingClientRect().width) - t) <= tol;
                },
                { t: target, tol: tolerance },
                { timeout: 6000 },
            );
            return railWidth();
        };

        /* ═══ 1. 侧栏：收起 / 悬停展开 / 回缩 / 钉住 ═══ */
        await step('导航到 agent 页', () => goto('agent', '.numfield'));

        await step('侧栏默认收起为 64px 图标栏', async () => {
            const w = await waitRailWidth(64, 2);
            check('侧栏默认收起为 64px 图标栏', Math.abs(w - 64) <= 2, `实测 ${w}px`);
        });

        await step('悬停侧栏展开到 248px', async () => {
            await page.hover('.rail');
            const w = await waitRailWidth(248, 3);
            check('悬停侧栏展开到 248px', Math.abs(w - 248) <= 3, `实测 ${w}px`);
        });

        await step('移开后回缩到收起态', async () => {
            await page.mouse.move(760, 500);
            const w = await waitRailWidth(64, 2);
            check('移开后回缩到收起态', Math.abs(w - 64) <= 2, `实测 ${w}px`);
        });

        await step('钉住侧栏后常驻展开', async () => {
            const pin = page.locator('button[aria-label="钉住侧栏"]');
            if (!(await pin.count())) { check('钉住侧栏后常驻展开', false, '未找到钉住按钮'); return; }
            await pin.click();
            await page.mouse.move(760, 500);
            const w = await waitRailWidth(248, 3);
            const pressed = await page.locator('button[aria-label="取消钉住侧栏"]').getAttribute('aria-pressed');
            check('钉住侧栏后常驻展开', Math.abs(w - 248) <= 3, `实测 ${w}px, aria-pressed=${pressed}`);
        });

        await step('取消钉住后恢复收起', async () => {
            const unpin = page.locator('button[aria-label="取消钉住侧栏"]');
            if (!(await unpin.count())) { check('取消钉住后恢复收起', false, '未找到取消钉住按钮'); return; }
            await unpin.click();
            await page.mouse.move(760, 500);
            const w = await waitRailWidth(64, 2);
            check('取消钉住后恢复收起', Math.abs(w - 64) <= 2, `实测 ${w}px`);
        });

        /* ═══ 1b. 侧栏品牌区与右侧顶栏必须等高（底边连成一条横线）═══ */
        await step('侧栏品牌区与顶栏等高对齐', async () => {
            const geo = await page.evaluate(() => {
                const brand = document.querySelector('.rail__brand');
                const topbar = document.querySelector('.topbar');
                if (!brand || !topbar) return null;
                const b = brand.getBoundingClientRect();
                const t = topbar.getBoundingClientRect();
                return { brandH: b.height, topbarH: t.height, brandBottom: b.bottom, topbarBottom: t.bottom };
            });
            if (!geo) { check('侧栏品牌区与顶栏等高对齐', false, '未找到 .rail__brand 或 .topbar'); return; }
            const dh = Math.abs(geo.brandH - geo.topbarH);
            const db = Math.abs(geo.brandBottom - geo.topbarBottom);
            check(
                '侧栏品牌区与顶栏等高对齐',
                dh <= 0.5 && db <= 0.5,
                `高 ${geo.brandH} vs ${geo.topbarH}，底边 ${geo.brandBottom} vs ${geo.topbarBottom}`,
            );
        });

        /* ═══ 2. 数字步进器 ═══ */
        await step('数字步进器 ▲ 递增', async () => {
            const field = page.locator('.numfield').first();
            if (!(await field.count())) { check('数字步进器 ▲ 递增', false, '未找到 .numfield'); return; }
            const input = field.locator('input').first();
            const before = await input.inputValue();
            await field.hover();
            await field.locator('button[aria-label="增加"]').click();
            await page.waitForTimeout(220);
            const after = await input.inputValue();
            check('数字步进器 ▲ 递增', before !== after, `${before} → ${after}`);
        });

        await step('数字步进器 ▼ 回退', async () => {
            const field = page.locator('.numfield').first();
            const input = field.locator('input').first();
            const before = await input.inputValue();
            await field.hover();
            await field.locator('button[aria-label="减少"]').click();
            await page.waitForTimeout(220);
            const after = await input.inputValue();
            check('数字步进器 ▼ 回退', before !== after, `${before} → ${after}`);
        });

        await step('数字步进器键盘 ↓ 生效', async () => {
            const field = page.locator('.numfield').first();
            const input = field.locator('input').first();
            const before = await input.inputValue();
            await input.focus();
            await input.press('ArrowDown');
            await page.waitForTimeout(200);
            const after = await input.inputValue();
            check('数字步进器键盘 ↓ 生效', before !== after, `${before} → ${after}`);
        });

        await step('数字步进器越界被 clamp', async () => {
            const field = page.locator('.numfield').first();
            const input = field.locator('input').first();
            const minAttr = await input.getAttribute('aria-valuemin');
            await input.fill('-999999');
            await input.blur();
            await page.waitForTimeout(300);
            const clamped = await input.inputValue();
            const minNum = minAttr != null ? Number(minAttr) : null;
            const ok = minNum != null ? Number(clamped) >= minNum : clamped !== '-999999';
            check('数字步进器越界被 clamp', ok, `输入 -999999 → ${clamped}（aria-valuemin=${minAttr}）`);
        });

        /* ═══ 3. 开关 ═══ */
        await step('开关点击切换 aria-checked', async () => {
            const sw = page.locator('.main-scroll [role=switch]').first();
            if (!(await sw.count())) { check('开关点击切换 aria-checked', false, '未找到 [role=switch]'); return; }
            const s0 = await sw.getAttribute('aria-checked');
            await sw.click();
            await page.waitForTimeout(220);
            const s1 = await sw.getAttribute('aria-checked');
            check('开关点击切换 aria-checked', s0 !== s1, `${s0} → ${s1}`);
            await sw.click();
            await page.waitForTimeout(180);
        });

        /* ═══ 4. 数值框：拖动微调（scrub）+ 范围底纹（替代可见滑条）═══ */
        await step('数值框可拖动微调（scrub）', async () => {
            const field = page.locator('.numfield.is-scrubbable').first();
            if (!(await field.count())) { check('数值框可拖动微调（scrub）', false, '未找到 .is-scrubbable'); return; }
            const input = field.locator('input').first();
            await field.scrollIntoViewIfNeeded();
            const before = await input.inputValue();

            const box = await field.boundingBox();
            if (!box) { check('数值框可拖动微调（scrub）', false, '取不到 boundingBox'); return; }
            const y = box.y + box.height / 2;
            await page.mouse.move(box.x + box.width / 2, y);
            await page.mouse.down();
            // 向右拖 60px：按 240px 走完整个区间，应产生明显变化
            for (let i = 1; i <= 6; i += 1) {
                await page.mouse.move(box.x + box.width / 2 + i * 10, y);
                await page.waitForTimeout(30);
            }
            await page.mouse.up();
            await page.waitForTimeout(220);
            const after = await input.inputValue();
            check('数值框可拖动微调（scrub）', before !== after, `${before} → ${after}`);
        });

        await step('拖动后数值被 clamp 在区间内', async () => {
            const field = page.locator('.numfield.is-scrubbable').first();
            const input = field.locator('input').first();
            const min = await input.getAttribute('aria-valuemin');
            const max = await input.getAttribute('aria-valuemax');
            const val = Number(await input.inputValue());
            const ok = Number.isFinite(val)
                && (min == null || val >= Number(min) - 1e-9)
                && (max == null || val <= Number(max) + 1e-9);
            check('拖动后数值被 clamp 在区间内', ok, `值 ${val}（区间 ${min}..${max}）`);
        });

        await step('范围底纹宽度随数值变化', async () => {
            const field = page.locator('.numfield').filter({ has: page.locator('.numfield__meter') }).first();
            if (!(await field.count())) { check('范围底纹宽度随数值变化', false, '未找到 .numfield__meter'); return; }
            const meter = field.locator('.numfield__meter').first();
            const w0 = await meter.evaluate(el => el.getBoundingClientRect().width);
            const input = field.locator('input').first();
            await input.focus();
            await input.press('ArrowUp');
            await input.press('ArrowUp');
            await page.waitForTimeout(300);
            const w1 = await meter.evaluate(el => el.getBoundingClientRect().width);
            check('范围底纹宽度随数值变化', Math.abs(w1 - w0) > 0.5, `${w0.toFixed(1)}px → ${w1.toFixed(1)}px`);
        });

        await step('页面上不再有可见滑动条', async () => {
            const n = await page.locator('[role=slider]').count();
            check('页面上不再有可见滑动条', n === 0, `[role=slider]=${n}`);
        });

        /* ═══ 5. 下拉（AppSelect，access 页有多个）═══ */
        await step('导航到 access 页', () => goto('access', '[role=combobox]'));

        await step('下拉点击打开面板', async () => {
            const combo = page.locator('[role=combobox]').first();
            if (!(await combo.count())) { check('下拉点击打开面板', false, '未找到 [role=combobox]'); return; }
            await combo.click();
            await page.waitForTimeout(350);
            const n = await page.locator('[role=listbox]').count();
            check('下拉点击打开面板', n > 0, `listbox=${n}`);
        });

        await step('Esc 关闭下拉且焦点归还', async () => {
            await page.keyboard.press('Escape');
            await page.waitForTimeout(320);
            const n = await page.locator('[role=listbox]').count();
            const combo = page.locator('[role=combobox]').first();
            const focused = await combo.evaluate(el => el === document.activeElement);
            check('Esc 关闭下拉', n === 0, `listbox=${n}`);
            check('Esc 后焦点归还触发器', focused, `focused=${focused}`);
        });

        /* ═══ 6. 分段控件（jobs 页状态筛选）═══ */
        await step('导航到 jobs 页', () => goto('jobs', '[role=tablist]'));

        await step('分段控件切换 aria-selected', async () => {
            const seg = page.locator('[role=tablist]').first();
            if (!(await seg.count())) { check('分段控件切换 aria-selected', false, '未找到 [role=tablist]'); return; }
            const tabs = seg.locator('[role=tab]');
            const n = await tabs.count();
            if (n < 2) { check('分段控件切换 aria-selected', false, `tab 数量 ${n}`); return; }
            const before = await tabs.nth(0).getAttribute('aria-selected');
            await tabs.nth(1).click();
            await page.waitForTimeout(320);
            const after0 = await tabs.nth(0).getAttribute('aria-selected');
            const after1 = await tabs.nth(1).getAttribute('aria-selected');
            check(
                '分段控件切换 aria-selected',
                before !== after0 && after1 === 'true',
                `tab0 ${before}→${after0}, tab1→${after1}`,
            );
        });

        await step('分段控件指示块发生位移', async () => {
            const seg = page.locator('[role=tablist]').first();
            const indicator = seg.locator('.seg__indicator').first();
            if (!(await indicator.count())) { check('分段控件指示块发生位移', false, '未找到指示块'); return; }
            const tabs = seg.locator('[role=tab]');
            const n = await tabs.count();
            if (n < 2) { check('分段控件指示块发生位移', false, `tab 数量 ${n}`); return; }
            // 先明确选中第一个，再切到最后一个，避免依赖上一条断言留下的状态
            await tabs.nth(0).click();
            await page.waitForTimeout(400);
            const t0 = await indicator.evaluate(el => getComputedStyle(el).transform);
            await tabs.nth(n - 1).click();
            await page.waitForTimeout(400);
            const t1 = await indicator.evaluate(el => getComputedStyle(el).transform);
            check('分段控件指示块发生位移', t0 !== t1, `${t0} → ${t1}`);
        });

        /* ═══ 7. Toast 通知 ═══ */
        await step('Toast 宿主已挂载', async () => {
            const host = page.locator('.toasts');
            const n = await host.count();
            check('Toast 宿主已挂载', n === 1, `.toasts=${n}`);
        });

        await step('导出触发 Toast 并可手动关闭', async () => {
            // 接受下载事件，避免被下载拦截卡住
            const dl = page.waitForEvent('download', { timeout: 8000 }).catch(() => null);
            await page.locator('button', { hasText: '导出' }).first().click();
            await dl;

            const toast = page.locator('.toast').first();
            await toast.waitFor({ state: 'visible', timeout: 6000 });
            const text = (await toast.innerText()).replace(/\s+/g, ' ').trim();
            check('导出触发 Toast', text.length > 0, text.slice(0, 40));

            const before = await page.locator('.toast').count();
            const closeBtn = page.locator('.toast button[aria-label="关闭提示"]').first();
            if (await closeBtn.count()) {
                await closeBtn.click();
                // 等元素真正从 DOM 移除（TransitionGroup 离场动画 180ms），不靠固定 sleep
                await toast.waitFor({ state: 'detached', timeout: 4000 }).catch(() => {});
                const after = await page.locator('.toast').count();
                check('Toast 可手动关闭', after < before, `${before} → ${after}`);
            } else {
                check('Toast 可手动关闭', false, '未找到关闭按钮');
            }
        });

        /* ═══ 8. 滚动条自动隐藏：滚动时出现，静止后消失 ═══ */
        await step('滚动条静止后自动隐藏', async () => {
            // 必须切到确实可滚动的长页（jobs 内容可能不足一屏，scrollTop 赋值不会触发 scroll）
            await goto('agent', '.numfield');

            /* 关键：不能只断言 is-scrolling class —— 曾经出现过「class 加了但滚动条
               依然常显」的 bug：全局 * { scrollbar-color } 会让 Chrome 忽略
               ::-webkit-scrollbar-*，于是显隐控制完全失效。
               这里直接读伪元素的实际颜色，才真正证明「看不见」。 */
            const readThumb = () => page.evaluate(() => {
                const el = document.querySelector('.main-scroll');
                if (!el) return null;
                const t = getComputedStyle(el, '::-webkit-scrollbar-thumb');
                return { cls: el.className, thumb: t.backgroundColor };
            });

            const alphaOf = (color) => {
                if (!color) return 1;
                if (color === 'transparent') return 0;
                const m = color.match(/rgba?\(([^)]+)\)/);
                if (m) {
                    const p = m[1].split(',').map(s => Number(s.trim()));
                    return p.length === 4 ? p[3] : 1;
                }
                const s = color.match(/\/\s*([\d.]+)\s*\)/);   // color(srgb r g b / a)
                if (s) return Number(s[1]);
                return 1;
            };

            const idle1 = await readThumb();
            if (!idle1) { check('滚动条静止后自动隐藏', false, '未找到 .main-scroll'); return; }

            await page.evaluate(() => {
                const m = document.querySelector('.main-scroll');
                const target = m.scrollTop > 120 ? 0 : 320;
                m.scrollTop = target;
            });
            await page.waitForTimeout(260);
            const during = await readThumb();

            await page.waitForTimeout(2100);
            const idle2 = await readThumb();

            check('滚动条静止时不可见', alphaOf(idle1.thumb) === 0, `thumb=${idle1.thumb}`);
            check('滚动时滚动条出现', alphaOf(during.thumb) > 0, `thumb=${during.thumb}`);
            check('滚动条静止后自动隐藏', alphaOf(idle2.thumb) === 0, `thumb=${idle2.thumb}`);
            check(
                '滚动条显隐靠 class 驱动',
                !idle1.cls.includes('is-scrolling')
                && during.cls.includes('is-scrolling')
                && !idle2.cls.includes('is-scrolling'),
                `${idle1.cls} → ${during.cls} → ${idle2.cls}`,
            );

            /* 回归点：曾经给滚动条加了「悬停保持可见」，导致鼠标停在内容区里
               滚动条再也不消失。这里明确验证：把指针放到内容区中间、不动，
               滚动条必须保持隐藏。 */
            const box = await page.evaluate(() => {
                const m = document.querySelector('.main-scroll');
                const r = m.getBoundingClientRect();
                return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
            });
            await page.mouse.move(box.x, box.y);
            await page.waitForTimeout(2200);
            const hovered = await readThumb();
            check(
                '鼠标悬停内容区时滚动条仍隐藏',
                alphaOf(hovered.thumb) === 0,
                `thumb=${hovered.thumb}`,
            );
        });

        /* ═══ 9. 信息架构：MCP / 记忆 归入能力中心 ═══ */
        await step('侧栏不再有 MCP 与记忆一级项', async () => {
            const labels = await page.evaluate(() =>
                Array.from(document.querySelectorAll('.rail__item .rail__label')).map(el => (el.textContent || '').trim()));
            const hasMcp = labels.some(t => t.includes('MCP'));
            const hasMem = labels.some(t => t.includes('记忆'));
            check('侧栏不再有 MCP 与记忆一级项', !hasMcp && !hasMem, `hasMcp=${hasMcp} hasMem=${hasMem}`);
        });

        await step('能力中心有 MCP 与记忆常驻入口', async () => {
            await goto('capabilities', 'a[href*="#/mcp"], a[href="#/mcp"]');
            const links = await page.evaluate(() => ({
                mcp: !!document.querySelector('a[href$="#/mcp"]'),
                mem: !!document.querySelector('a[href$="#/cap-memory"]'),
            }));
            check('能力中心有 MCP 常驻入口', links.mcp, `mcp=${links.mcp}`);
            check('能力中心有记忆常驻入口', links.mem, `mem=${links.mem}`);
        });

        /* ═══ 10. 层级返回：面包屑 + 返回按钮 ═══ */
        await step('/mcp 面包屑挂在能力中心下', async () => {
            await goto('mcp', '.crumbs');
            const crumbText = await page.evaluate(() => {
                const nav = document.querySelector('.crumbs');
                return nav ? (nav.textContent || '').replace(/\s+/g, ' ').trim() : '';
            });
            check('/mcp 面包屑含能力中心', crumbText.includes('能力中心'), crumbText);
        });

        await step('二级页出现返回按钮且可返回', async () => {
            const back = page.locator('button[aria-label^="返回"]');
            if (!(await back.count())) { check('二级页出现返回按钮', false, '未找到返回按钮'); return; }
            const label = await back.getAttribute('aria-label');
            check('二级页出现返回按钮', true, label || '');
            await back.click();
            await page.waitForTimeout(700);
            const url = page.url();
            check('返回按钮跳回父级', url.includes('/capabilities'), url.split('#')[1] || url);
        });

        await step('无侧栏入口的页面也有面包屑（非死胡同）', async () => {
            await goto('search', '.crumbs');
            const crumbText = await page.evaluate(() => {
                const nav = document.querySelector('.crumbs');
                return nav ? (nav.textContent || '').replace(/\s+/g, ' ').trim() : '';
            });
            check('无侧栏入口的页面也有面包屑', crumbText.length > 0 && crumbText.includes('能力中心'), crumbText);
        });

        /* ═══ 11. 无感自动保存 ═══ */
        await step('改动后无需点击即自动落盘', async () => {
            await goto('agent', '.numfield');
            let posts = 0;
            const onReq = (r) => {
                if (r.method() === 'POST' && /\/api\/config(\?|$)/.test(r.url())) posts += 1;
            };
            page.on('request', onReq);
            try {
                const sw = page.locator('.main-scroll [role=switch]').first();
                if (!(await sw.count())) { check('改动后无需点击即自动落盘', false, '未找到开关'); return; }
                const before = await sw.getAttribute('aria-checked');
                await sw.click();
                const after = await sw.getAttribute('aria-checked');
                if (before === after) { check('改动后无需点击即自动落盘', false, '开关未改变'); return; }

                // 不点任何保存按钮，等防抖(650ms)+请求往返
                await page.waitForTimeout(2600);
                check('改动后无需点击即自动落盘', posts >= 1, `POST /config ×${posts}`);
            } finally {
                page.off('request', onReq);
            }
        });

        await step('自动保存完成后回到「已保存」', async () => {
            const state = await page.evaluate(() => {
                const chip = document.querySelector('.save-chip');
                return chip ? { tone: chip.getAttribute('data-tone'), text: (chip.textContent || '').trim() } : null;
            });
            if (!state) { check('自动保存完成后回到「已保存」', false, '未找到 .save-chip'); return; }
            check('自动保存完成后回到「已保存」', state.text.includes('已保存') || state.tone === 'success', `${state.tone} / ${state.text}`);
        });

        await step('连续改动被防抖合并为一次保存', async () => {
            let posts = 0;
            const onReq = (r) => {
                if (r.method() === 'POST' && /\/api\/config(\?|$)/.test(r.url())) posts += 1;
            };
            page.on('request', onReq);
            try {
                const sw = page.locator('.main-scroll [role=switch]').first();
                // 连点 3 次（奇数 → 最终值与初始不同），间隔远小于防抖窗口
                for (let i = 0; i < 3; i += 1) {
                    await sw.click();
                    await page.waitForTimeout(90);
                }
                await page.waitForTimeout(2800);
                check('连续改动被防抖合并为一次保存', posts === 1, `POST /config ×${posts}（期望 1）`);
            } finally {
                page.off('request', onReq);
            }
        });

        await step('自动保存开关可关闭并恢复手动按钮', async () => {
            const autoSw = page.locator('[role=switch][aria-label="自动保存"]');
            if (!(await autoSw.count())) { check('自动保存开关可关闭', false, '未找到自动保存开关'); return; }
            const before = await autoSw.getAttribute('aria-checked');
            await autoSw.click();
            await page.waitForTimeout(600);
            const after = await autoSw.getAttribute('aria-checked');
            check('自动保存开关状态可见翻转', before !== after, `${before} → ${after}`);

            const manual = await page.locator('button', { hasText: '保存并热重载' }).count();
            check('关闭自动保存后出现手动保存按钮', manual >= 1, `manual=${manual}`);

            // 恢复自动保存，避免影响后续断言
            await autoSw.click();
            await page.waitForTimeout(500);
            const manualAfter = await page.locator('button', { hasText: '保存并热重载' }).count();
            check('重新开启后手动按钮消失', manualAfter === 0, `manual=${manualAfter}`);
        });

        /* ═══ 12. 深色主题 ═══ */
        await step('深色主题切换生效', async () => {
            const light = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
            await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
            await page.waitForTimeout(350);
            const dark = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
            check('深色主题切换生效', light !== dark, `${light} → ${dark}`);
            await page.evaluate(() => document.documentElement.removeAttribute('data-theme'));
        });

        /* ═══ 13. 无 JS 异常 ═══ */
        check('交互过程中无 JS 异常', jsErrors.length === 0, jsErrors.join(' | ') || 'none');
    } finally {
        await withTimeout(browser.close(), 10000, 'browser.close').catch(() => {});
        clearTimeout(watchdog);
    }

    const failed = await writeReport();
    console.log('');
    console.log(`合计 ${results.length} 项断言，失败 ${failed.length} 项`);
    if (failed.length) {
        console.log('[FAIL] 有交互断言未通过');
        process.exitCode = 1;
    } else {
        console.log('[PASS] 全部交互断言通过');
    }
}

main().catch(async err => {
    console.error('[verify-interactions] 致命错误:', err);
    await writeReport().catch(() => {});
    process.exitCode = 2;
});
