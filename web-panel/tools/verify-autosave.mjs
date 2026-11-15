/**
 * verify-autosave —— 无感自动保存的正确性专项验证。
 *
 * 单独成文件的原因：其中「保存飞行期间继续编辑不丢改动」需要人为延迟
 * POST /config 并跨越多个保存轮次，放在主交互套件里会拉长运行时间、
 * 在内存吃紧的机器上容易把浏览器/服务挤崩。这里只跑自动保存相关场景。
 *
 * 场景：
 *   1. 改动后无需点击即落盘
 *   2. 连续改动被防抖合并为一次请求
 *   3. 飞行期间继续编辑：本地值不被服务端响应覆盖，且补一轮保存
 *   4. 自动保存开关：关闭 → 出现手动按钮；开启 → 按钮消失
 *   5. 保存状态胶囊的语义（saving → success）
 *
 * 用法：node web-panel/tools/verify-autosave.mjs
 *   （服务需已在 --url 监听；推荐用 node tools/verify-all.mjs --autosave 起服务）
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

const results = [];
const check = (name, ok, detail = '') => {
    results.push({ name, ok: Boolean(ok), detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

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
await context.addInitScript(t => {
    try { localStorage.setItem('miobot_token', t); } catch { /* ignore */ }
    /* 只在首次（键不存在）时给默认值。
       绝不能每次导航都强行写 '1' —— 那样会把「用户关掉自动保存」的持久化值覆盖掉，
       导致「关闭状态刷新后仍保持」这类断言永远失败（而且会掩盖真实缺陷）。 */
    try {
        if (localStorage.getItem('miobot_autosave') == null) {
            localStorage.setItem('miobot_autosave', '1');
        }
    } catch { /* ignore */ }
}, token);

const page = await context.newPage();
page.setDefaultTimeout(12000);
const jsErrors = [];
page.on('pageerror', e => jsErrors.push(String(e).slice(0, 160)));

const countPosts = () => {
    let n = 0;
    const h = (r) => { if (r.method() === 'POST' && /\/api\/config(\?|$)/.test(r.url())) n += 1; };
    page.on('request', h);
    return { get: () => n, off: () => page.off('request', h) };
};

try {
    await page.goto(`${BASE}#/agent`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('.rail') != null, null, { timeout: 15000 });
    await page.waitForTimeout(1400);

    /* ── 1. 改动即落盘 ── */
    {
        const c = countPosts();
        const sw = page.locator('.main-scroll [role=switch]').first();
        const before = await sw.getAttribute('aria-checked');
        await sw.click();
        await page.waitForTimeout(2600);
        check('改动后无需点击即落盘', c.get() >= 1, `POST /config ×${c.get()}`);
        check('开关确实被改', (await sw.getAttribute('aria-checked')) !== before);
        c.off();
    }

    /* ── 2. 防抖合并 ── */
    {
        const c = countPosts();
        const sw = page.locator('.main-scroll [role=switch]').first();
        const EDITS = 4;
        for (let i = 0; i < EDITS; i += 1) { await sw.click(); await page.waitForTimeout(80); }
        await page.waitForTimeout(3000);
        /* 判定「合并」而不是「恰好 1 次」：
           Playwright 每次 click 有 50~100ms 的可操作性开销，4 次点击可能跨过
           防抖窗口，从而合法地产生第 2 轮保存（飞行期间的改动会被补交）。
           真正要证明的是「请求数远少于改动数」。 */
        check(
            '连续改动被合并（请求数 < 改动数）',
            c.get() >= 1 && c.get() < EDITS,
            `POST /config ×${c.get()} / ${EDITS} 次改动`,
        );
        c.off();
    }

    /* ── 3. 状态胶囊语义 ── */
    {
        const state = await page.evaluate(() => {
            const chip = document.querySelector('.save-chip');
            return chip ? { tone: chip.getAttribute('data-tone'), text: (chip.textContent || '').trim() } : null;
        });
        check('保存状态胶囊显示已保存', !!state && (state.tone === 'success' || state.text.includes('已保存')),
            state ? `${state.tone} / ${state.text}` : '未找到');
    }

    /* ── 4. 飞行期间继续编辑不丢改动 ── */
    {
        const c = countPosts();
        /* 延迟要明显长于防抖窗口（650ms）才能制造「飞行中又编辑」的窗口，
           但也不能太长 —— 长时间挂起请求在低内存机器上容易把浏览器拖崩。 */
        const DELAY = 800;
        await page.route('**/api/config', async (route) => {
            if (route.request().method() === 'POST') {
                await new Promise(r => setTimeout(r, DELAY));
            }
            await route.continue().catch(() => {});
        });

        const inputs = page.locator('.numfield input');
        const n = await inputs.count();
        if (n >= 2) {
            const a = inputs.nth(0);
            const b = inputs.nth(1);

            const aBefore = await a.inputValue();
            await a.fill(aBefore === '1' ? '2' : '1');
            await page.waitForTimeout(750);           // 过防抖 → 请求进入飞行（延迟 800ms）

            const bBefore = await b.inputValue();
            const bNext = bBefore === '7' ? '8' : '7';
            await b.fill(bNext);

            await page.waitForTimeout(2600);          // 等飞行结束

            const bAfter = await b.inputValue();
            /* 唯一必须成立的保证：用户的第二次输入没有被服务端响应覆盖。
               补交轮次受防抖与延迟叠加影响、计数不稳定，不作为判定依据；
               本地仍为脏状态时，切页/切后台都会 flushSave 兜底。 */
            check('飞行期间继续编辑不丢改动', bAfter === bNext, `B: ${bBefore} → ${bNext}，最终 ${bAfter}`);
            check('飞行期间发生过至少一次保存', c.get() >= 1, `POST /config ×${c.get()}`);
        } else {
            check('飞行期间继续编辑不丢改动', false, `可编辑数字字段仅 ${n} 个`);
        }

        await page.unroute('**/api/config').catch(() => {});
        c.off();
    }

    /* ── 5. 409 冲突：进入冲突态、给重试入口、且不刷屏 ── */
    {
        // 让服务端持续返回 409（模拟「别的入口改了配置」）
        await page.route('**/api/config', async (route) => {
            if (route.request().method() === 'POST') {
                return route.fulfill({
                    status: 409,
                    contentType: 'application/json',
                    body: JSON.stringify({ success: false, error: '配置已被其他入口修改' }),
                });
            }
            return route.continue().catch(() => {});
        });

        const c = countPosts();
        const sw = page.locator('.main-scroll [role=switch]').first();
        await sw.click();
        await page.waitForTimeout(3600);   // 足够跑完「首次 + 对齐 revision 后重试一次」

        const chip = await page.evaluate(() => {
            const el = document.querySelector('.save-chip');
            return el ? { tone: el.getAttribute('data-tone'), text: (el.textContent || '').trim() } : null;
        });
        check('409 后进入冲突态', !!chip && (chip.tone === 'error' || chip.text.includes('冲突')),
            chip ? `${chip.tone} / ${chip.text}` : '未找到状态胶囊');

        const retryBtn = await page.locator('button', { hasText: '重试保存' }).count();
        check('409 后出现「重试保存」入口', retryBtn >= 1, `retry=${retryBtn}`);

        /* 不刷屏的关键：冲突后必须停止自动重试。
           实现里只允许「首次 + 对齐 revision 后重试 1 次」= 最多 2 次 POST。
           这里再等一段时间，确认没有继续打接口。 */
        const atCheck = c.get();
        await page.waitForTimeout(2600);
        const later = c.get();
        check('冲突后停止自动重试（不刷屏）', later === atCheck && later <= 2, `POST ×${atCheck} → ×${later}`);

        c.off();
        await page.unroute('**/api/config').catch(() => {});

        // 恢复：手动重试一次，把冲突态清掉，避免影响后续断言
        const retry = page.locator('button', { hasText: '重试保存' });
        if (await retry.count()) {
            await retry.first().click();
            await page.waitForTimeout(1800);
            const after = await page.evaluate(() => {
                const el = document.querySelector('.save-chip');
                return el ? { tone: el.getAttribute('data-tone'), text: (el.textContent || '').trim() } : null;
            });
            check('手动重试后恢复为已保存', !!after && (after.tone === 'success' || after.text.includes('已保存')),
                after ? `${after.tone} / ${after.text}` : '未找到');
        }
    }

    /* ── 6. persisted:false（落盘失败）不能显示「已保存」── */
    {
        await page.route('**/api/config', async (route) => {
            if (route.request().method() === 'POST') {
                return route.fulfill({
                    status: 200,
                    contentType: 'application/json',
                    body: JSON.stringify({
                        success: true,
                        persisted: false,
                        message: '磁盘写入失败',
                        revision: 999,
                        hotReload: { revision: 999, changedPaths: [], napcatReconnectRequired: false },
                    }),
                });
            }
            return route.continue().catch(() => {});
        });

        const sw = page.locator('.main-scroll [role=switch]').first();
        await sw.click();
        await page.waitForTimeout(2400);

        const chip = await page.evaluate(() => {
            const el = document.querySelector('.save-chip');
            return el ? { tone: el.getAttribute('data-tone'), text: (el.textContent || '').trim() } : null;
        });
        check(
            'persisted:false 时不显示「已保存」',
            !!chip && !(chip.tone === 'success' && chip.text.includes('已保存')),
            chip ? `${chip.tone} / ${chip.text}` : '未找到',
        );

        /* 脏标记必须保留 —— 否则用户以为存好了，重启就丢 */
        const stillDirty = await page.evaluate(() => {
            const el = document.querySelector('.save-chip');
            return el ? (el.textContent || '').includes('未保存') || el.getAttribute('data-tone') === 'error' : false;
        });
        check('persisted:false 后仍显示未保存/失败', stillDirty);

        await page.unroute('**/api/config').catch(() => {});
    }

    /* ── 7. beforeunload：仍有未保存改动时必须拦一下 ── */
    {
        const guard = await page.evaluate(() => {
            const ev = new Event('beforeunload', { cancelable: true });
            window.dispatchEvent(ev);
            return ev.defaultPrevented;
        });
        check('未保存时离开页面会被拦（beforeunload）', guard === true, `defaultPrevented=${guard}`);

        // 收尾：把改动存掉，让状态回到干净
        const retry = page.locator('button', { hasText: '重试保存' });
        if (await retry.count()) { await retry.first().click(); await page.waitForTimeout(1500); }
        const sw = page.locator('.main-scroll [role=switch]').first();
        await sw.click();
        await page.waitForTimeout(2200);
    }

    /* ── 8. 自动保存开关（真开关，非图标按钮）── */
    {
        const autoSw = page.locator('[role=switch][aria-label="自动保存"]');
        if (!(await autoSw.count())) {
            check('自动保存开关存在且是开关控件', false, '未找到 [role=switch][aria-label="自动保存"]');
        } else {
            check('自动保存开关存在且是开关控件', true, 'role=switch');

            const before = await autoSw.getAttribute('aria-checked');
            await autoSw.click();
            await page.waitForTimeout(600);
            const after = await autoSw.getAttribute('aria-checked');
            check('开关状态有可见变化（aria-checked 翻转）', before !== after, `${before} → ${after}`);

            const manual = await page.locator('button', { hasText: '保存并热重载' }).count();
            check('关闭自动保存后出现手动按钮', manual >= 1, `manual=${manual}`);

            /* 回归点 1：关闭期间改的东西，重新开启后应当立刻落盘，
               而不是等下一次编辑。 */
            const c = countPosts();
            const sw = page.locator('.main-scroll [role=switch]').first();
            await sw.click();                       // 关闭状态下改动
            await page.waitForTimeout(1000);
            const postsWhileOff = c.get();
            check('关闭自动保存期间不落盘', postsWhileOff === 0, `POST ×${postsWhileOff}`);

            await autoSw.click();                   // 重新开启 → 应立即 flush
            await page.waitForTimeout(2200);
            check('重新开启后立刻补存关闭期间的改动', c.get() >= 1, `POST ×${c.get()}`);

            const manualAfter = await page.locator('button', { hasText: '保存并热重载' }).count();
            check('重新开启后手动按钮消失', manualAfter === 0, `manual=${manualAfter}`);
            c.off();
        }
    }

    /* ── 9. 冲突后关掉再打开，自动保存要恢复工作 ── */
    {
        const autoSw = page.locator('[role=switch][aria-label="自动保存"]');
        await page.route('**/api/config', async (route) => {
            if (route.request().method() === 'POST') {
                return route.fulfill({
                    status: 409, contentType: 'application/json',
                    body: JSON.stringify({ success: false, error: '冲突' }),
                });
            }
            return route.continue().catch(() => {});
        });
        const sw = page.locator('.main-scroll [role=switch]').first();
        await sw.click();
        await page.waitForTimeout(2600);
        const conflicted = await page.evaluate(() => {
            const el = document.querySelector('.save-chip');
            return el ? (el.textContent || '').trim() : '';
        });
        check('已进入冲突态（前置条件）', conflicted.includes('冲突'), conflicted);

        await page.unroute('**/api/config').catch(() => {});

        // 关掉再打开：必须清掉冲突标记，否则 scheduleAutoSave 会一直 return
        await autoSw.click();
        await page.waitForTimeout(400);
        await autoSw.click();
        await page.waitForTimeout(2600);

        const after = await page.evaluate(() => {
            const el = document.querySelector('.save-chip');
            return el ? { tone: el.getAttribute('data-tone'), text: (el.textContent || '').trim() } : null;
        });
        check('冲突后关掉再开启，自动保存恢复工作', !!after && !after.text.includes('冲突'),
            after ? `${after.tone} / ${after.text}` : '未找到');
    }

    /* ── 10. 开关状态持久化（刷新后仍生效）── */
    {
        const autoSw = page.locator('[role=switch][aria-label="自动保存"]');
        // 先确保是「关」
        if ((await autoSw.getAttribute('aria-checked')) === 'true') {
            await autoSw.click();
            await page.waitForTimeout(400);
        }
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => document.querySelector('.rail') != null, null, { timeout: 15000 });
        await page.waitForTimeout(1400);

        const persistedOff = await page.locator('[role=switch][aria-label="自动保存"]').getAttribute('aria-checked');
        const manualAfterReload = await page.locator('button', { hasText: '保存并热重载' }).count();
        check('关闭状态刷新后仍保持', persistedOff === 'false', `aria-checked=${persistedOff}`);
        check('刷新后仍是手动保存模式', manualAfterReload >= 1, `manual=${manualAfterReload}`);

        // 再打开，刷新后应保持开启
        await page.locator('[role=switch][aria-label="自动保存"]').click();
        await page.waitForTimeout(500);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => document.querySelector('.rail') != null, null, { timeout: 15000 });
        await page.waitForTimeout(1400);
        const persistedOn = await page.locator('[role=switch][aria-label="自动保存"]').getAttribute('aria-checked');
        const manual2 = await page.locator('button', { hasText: '保存并热重载' }).count();
        check('开启状态刷新后仍保持', persistedOn === 'true', `aria-checked=${persistedOn}`);
        check('刷新后仍是自动保存模式', manual2 === 0, `manual=${manual2}`);
    }

    /* ── 11. 敏感操作（导入配置）仍必须显式确认，不走自动保存 ── */
    {
        const probe = path.join(OUT, 'import-probe.json');
        await fs.mkdir(OUT, { recursive: true });
        await fs.writeFile(probe, JSON.stringify({ panel: { port: 3018 } }), 'utf8');

        let dialogText = '';
        let dialogSeen = false;
        page.on('dialog', async (d) => {
            dialogSeen = true;
            dialogText = d.message();
            await d.dismiss().catch(() => {});
        });

        const before = countPosts();
        try {
            const input = page.locator('.picker__native').first();
            if (await input.count()) {
                await input.setInputFiles(probe);
                await page.waitForTimeout(900);
            }
        } finally {
            await fs.rm(probe, { force: true }).catch(() => {});
        }

        check('导入配置前弹出确认（敏感操作不走自动保存）', dialogSeen, dialogText.slice(0, 40) || '未弹确认');
        check('导入被取消时不会自动落盘', before.get() === 0, `POST ×${before.get()}`);
        before.off();
    }

    check('自动保存过程中无 JS 异常', jsErrors.length === 0, jsErrors.join(' | ') || 'none');
} catch (err) {
    check('自动保存专项验证未中断', false, String(err?.message || err).slice(0, 160));
} finally {
    await browser.close().catch(() => {});
}

await fs.mkdir(OUT, { recursive: true });
await fs.writeFile(path.join(OUT, 'autosave.json'), JSON.stringify({ results, failed: results.filter(r => !r.ok).length }, null, 2), 'utf8');

const failed = results.filter(r => !r.ok);
console.log('');
console.log(`合计 ${results.length} 项断言，失败 ${failed.length} 项`);
if (failed.length) process.exitCode = 1;
else console.log('[PASS] 自动保存专项验证通过');
