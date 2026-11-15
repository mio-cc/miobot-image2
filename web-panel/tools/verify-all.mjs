/**
 * verify-all —— 一条命令完成「起服务 → 静态核查 → 交互核查 → 收尾」。
 *
 * 为什么需要它：本机的后台进程会在工具调用/轮次边界被回收，
 * 分几次调用跑「起服务」和「跑验证」会拿到 ERR_CONNECTION_REFUSED 或半途 navError。
 * 把服务作为本进程的子进程拉起，验证结束再杀掉，生命周期就完全可控。
 *
 * 用法：
 *   node web-panel/tools/verify-all.mjs              # 静态 + 交互
 *   node web-panel/tools/verify-all.mjs --ui         # 只跑静态
 *   node web-panel/tools/verify-all.mjs --inter      # 只跑交互
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import net from 'node:net';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PANEL = path.resolve(__dirname, '..');
const REPO = path.resolve(PANEL, '..');
const RUNTIME = path.join(PANEL, '.verify', 'runtime');

const PORT = Number(process.env.MIOBOT_PORT || 3018);
const HOST = '127.0.0.1';
const BASE = `http://${HOST}:${PORT}/admin/`;
const PASSWORD = process.env.MIOBOT_PANEL_PASSWORD || 'verify-seed';

const onlyUi = process.argv.includes('--ui');
const onlyInter = process.argv.includes('--inter');
const onlyAuto = process.argv.includes('--autosave');
const runUi = !onlyInter && !onlyAuto;
const runInter = !onlyUi && !onlyAuto;
const runAuto = onlyAuto || (!onlyUi && !onlyInter);

/**
 * 21 条路由一次跑完会让 Chromium 内存持续增长，
 * 在本机（8G，常驻占用高）会把验证服务挤到被系统回收。
 * 所以分批跑：每批独立 chromium，批间释放。
 */
const ALL_ROUTES = [
    'overview', 'access', 'permissions', 'capabilities', 'mcp',
    'models', 'agent', 'tools', 'jobs', 'prompts',
    'reply', 'features', 'templates', 'cap-image', 'cap-music',
    'cap-voice', 'cap-file', 'cap-memory', 'canvas', 'observability', 'settings',
];
const CHUNK = 7;

/** 端口是否已可连接 */
function probe() {
    return new Promise((resolve) => {
        const sock = net.connect({ port: PORT, host: HOST });
        const done = (ok) => { sock.destroy(); resolve(ok); };
        sock.setTimeout(800);
        sock.once('connect', () => done(true));
        sock.once('error', () => done(false));
        sock.once('timeout', () => done(false));
    });
}

/** 直接起一个 node 子进程跑测试，stdio 继承以便看到实时输出 */
function runNode(args, extraEnv = {}) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, args, {
            cwd: PANEL,
            stdio: 'inherit',
            env: { ...process.env, MIOBOT_PANEL_PASSWORD: PASSWORD, MIOBOT_URL: BASE, ...extraEnv },
        });
        child.on('exit', (code) => resolve(code ?? 1));
    });
}

async function waitForPort(timeoutMs = 25000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await probe()) return true;
        await new Promise(r => setTimeout(r, 300));
    }
    return false;
}

let server = null;
let exitCode = 0;

/**
 * 重置验证 runtime。
 *
 * 为什么必须做：验证过程中面板会真的 POST /config，服务端把规范化后的整份配置
 * 写回 config.json —— 包括 panel.passwordSeed。一旦这个文件被非 UTF-8 安全的
 * 工具（例如 PowerShell 的 Get-Content/Set-Content 往返）碰过，种子就会变成乱码，
 * 之后所有登录都 401，验证会表现为「整站挂掉」。
 * 用 Node fs 以 utf8 重写，保证每轮从已知状态开始。
 */
async function resetRuntime() {
    await fs.mkdir(RUNTIME, { recursive: true });
    await fs.mkdir(path.join(RUNTIME, 'logs'), { recursive: true });
    await fs.writeFile(
        path.join(RUNTIME, 'config.json'),
        JSON.stringify({ panel: { port: PORT, passwordSeed: PASSWORD } }),
        'utf8',
    );
    // 清掉上一轮的画布状态，避免脏数据影响页面
    for (const f of ['canvas-state.json']) {
        await fs.rm(path.join(RUNTIME, f), { force: true }).catch(() => {});
    }
}

try {
    if (!(await probe())) {
        await resetRuntime();
        console.log(`[verify-all] 启动验证服务 :${PORT} …`);
        server = spawn(process.execPath, ['scripts/local-verify-server.mjs'], {
            cwd: REPO,
            stdio: 'ignore',
            env: {
                ...process.env,
                MIOBOT_PORT: String(PORT),
                MIOBOT_HOST: HOST,
                MIOBOT_RUNTIME_DIR: RUNTIME,
                MIOBOT_CONFIG_PATH: path.join(RUNTIME, 'config.json'),
                MIOBOT_LOG_DIR: path.join(RUNTIME, 'logs'),
                MIOBOT_SYSTEM_LOG_PATH: path.join(RUNTIME, 'logs', 'system.ndjson'),
                MIOBOT_CANVAS_LOG_PATH: path.join(RUNTIME, 'logs', 'canvas.ndjson'),
            },
        });
        if (!(await waitForPort())) throw new Error(`服务在 ${PORT} 上没起来`);
        console.log('[verify-all] 服务就绪');
    } else {
        console.log(`[verify-all] 复用已在运行的服务 :${PORT}`);
    }

    if (runUi) {
        console.log('\n──── 静态核查（21 路由，分批）────');
        for (let i = 0; i < ALL_ROUTES.length; i += CHUNK) {
            const batch = ALL_ROUTES.slice(i, i + CHUNK);
            console.log(`\n  [批次 ${Math.floor(i / CHUNK) + 1}] ${batch.join(' ')}`);
            const code = await runNode(['tools/verify-ui.mjs', ...batch]);
            if (code !== 0) exitCode = 1;
            // 批间喘口气，给系统回收内存的时间
            await new Promise(r => setTimeout(r, 1200));
        }
    }

    if (runInter) {
        console.log('\n──── 交互核查 ────');
        const code = await runNode(['tools/verify-interactions.mjs']);
        if (code !== 0) exitCode = 1;
    }

    if (runAuto) {
        console.log('\n──── 自动保存专项核查 ────');
        const code = await runNode(['tools/verify-autosave.mjs']);
        if (code !== 0) exitCode = 1;
    }
} catch (err) {
    console.error('[verify-all] 失败:', err?.message || err);
    exitCode = 2;
} finally {
    if (server) {
        server.kill();
        console.log('\n[verify-all] 已停止验证服务');
    }
}

process.exitCode = exitCode;
