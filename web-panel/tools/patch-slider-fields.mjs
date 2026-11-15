/**
 * 把「可见滑动条 + 数字框」的组合改成「单个带范围底纹的数字框」。
 *
 * 背景：在密集配置表单里放一条 22px 高的滑轨，纵向节奏被打断、视觉很突兀。
 * 主流做法（Blender / Figma / Rive / Spline 的 value field）是不显示滑轨：
 * 数值框本身可左右拖动微调，再用极淡的底纹表示值在区间中的位置。
 *
 * 本脚本只做「滑块行 → meter 数字框」的等价替换，数据绑定路径不变。
 * 用 Node fs（显式 utf8）读写，避免 PowerShell 破坏中文。
 *
 * 用法：node web-panel/tools/patch-slider-fields.mjs [--write]
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, '../src');
const WRITE = process.argv.includes('--write');

/** 匹配形如：<div class="flex items-center gap-3"> <UiSlider .../> <UiNumberField .../> </div> */
const SLIDER_ROW = /<div class="flex items-center gap-3">\s*<UiSlider\b[^>]*?\/>\s*<UiNumberField\b([^>]*?)\/>\s*<\/div>/g;

/** 从 UiNumberField 的原有属性里取出 v-model 与 min/max/step，重建为 meter 版本。 */
function rebuild(attrString) {
    const keep = [];
    for (const name of ['v-model', ':min', ':max', ':step', ':disabled', 'placeholder', 'suffix', 'prefix']) {
        const re = new RegExp(`${name.replace(':', ':')}="([^"]*)"`);
        const m = attrString.match(re);
        if (m) keep.push(`${name}="${m[1]}"`);
    }
    // 固定宽度：底纹需要一点长度才读得出比例，同时不占满整行
    keep.push('meter');
    keep.push('class="!w-[140px]"');
    return `<UiNumberField ${keep.join(' ')} />`;
}

const files = [];
async function walk(dir) {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) await walk(p);
        else if (e.name.endsWith('.vue')) files.push(p);
    }
}
await walk(SRC);

let changedFiles = 0;
let replaced = 0;
const detail = [];

for (const file of files) {
    let text = await fs.readFile(file, 'utf8');
    if (!text.includes('<UiSlider')) continue;

    const before = text;
    text = text.replace(SLIDER_ROW, (_whole, attrs) => {
        replaced += 1;
        return rebuild(attrs);
    });
    if (text === before) continue;

    // UiSlider 若已不再使用，移除其 import（否则 vue-tsc 报 TS6133）
    if (!/<UiSlider\b/.test(text)) {
        text = text.replace(/^import UiSlider from '[^']*';\r?\n/m, '');
    }

    changedFiles += 1;
    detail.push(path.relative(SRC, file));
    if (WRITE) await fs.writeFile(file, text, 'utf8');
}

console.log(`slider row -> meter number field: ${replaced} 处，涉及 ${changedFiles} 个文件${WRITE ? '' : '（dry-run）'}`);
for (const d of detail) console.log(`  ${d}`);
