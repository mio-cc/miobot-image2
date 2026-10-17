import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { CHROMIUM_LAUNCH_ARGS } from '../dist/packages/browser-render/src/index.js';

const args = [...CHROMIUM_LAUNCH_ARGS];
if (process.env.MIOBOT_CHROMIUM_NO_SANDBOX !== '0') args.push('--no-sandbox', '--disable-setuid-sandbox');
if (process.env.MIOBOT_WEBGL !== '0') args.push('--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist');

const executablePath = [process.env.MIOBOT_CHROMIUM_PATH, process.env.CHROMIUM_PATH, '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'].find((item) => item && existsSync(item));
let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath, args, timeout: 20000 });
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
  await page.setContent('<canvas id="c" width="640" height="360"></canvas>');
  const result = await page.evaluate(() => {
    const canvas = document.getElementById('c');
    const gl = canvas?.getContext('webgl2') || canvas?.getContext('webgl');
    return { webgl: Boolean(gl), userAgent: navigator.userAgent };
  });
  console.log(JSON.stringify({ ok: true, executablePath: executablePath || 'auto', ...result }, null, 2));
} finally {
  await browser?.close().catch(() => undefined);
}
