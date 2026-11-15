/**
 * Phase-UI codemod：把原生 <input type="number"> 批量替换为自研 <UiNumberField>。
 *
 * 为什么需要 codemod：全站近 200 处，手改既慢又容易漏字段路径。
 * 但它必须是「保守的」——只做能 100% 确定等价的转换，其余一律跳过并报告：
 *
 *   <input v-model.number="a.b" type="number" min="0" max="2" step="0.1" class="input-field" :disabled="x" />
 *     ↓
 *   <UiNumberField v-model="a.b" :min="0" :max="2" :step="0.1" :disabled="x" />
 *
 * 规则：
 *  - v-model.number → v-model（组件本身只产 number）
 *  - 去掉 class 里的 input-field / font-mono / text-*（组件自带外框与字号），保留布局微调类
 *  - 字面量 min/max/step 转 :min="0" 形式（组件 props 声明为 number）
 *  - @change 保留（组件 emit change）；@keyup.* 丢弃
 *  - 出现 @input / @blur / @focus 或未知动态属性 → 跳过，交人工
 *
 * 用法：node web-panel/tools/codemod-number-inputs.mjs [--write]
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, '../src');
const WRITE = process.argv.includes('--write');

const PASSTHROUGH = new Set(['min', 'max', 'step', 'disabled', 'readonly', 'placeholder']);
const DROP = new Set(['type', 'inputmode', 'autocomplete', 'spellcheck']);
const CLASS_DROP = new Set(['input-field', 'font-mono', 'text-xs', 'text-sm']);

const report = { converted: 0, skipped: [], files: [] };

function parseAttrs(raw) {
    const attrs = [];
    const re = /(:?)([@a-zA-Z_][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
    let m;
    while ((m = re.exec(raw))) {
        const colon = m[1];
        const name = m[2];
        const value = m[3] ?? m[4] ?? m[5] ?? '';
        attrs.push({ bound: colon === ':', name, value, raw: m[0] });
    }
    return attrs;
}

function transformInput(inner) {
    const attrs = parseAttrs(inner);

    const byName = new Map();
    for (const a of attrs) {
        const key = a.name.startsWith('v-model') ? 'v-model' : a.name;
        if (byName.has(key)) return { skip: `duplicate attr ${key}` };
        byName.set(key, a);
    }

    const typeAttr = byName.get('type');
    if (!typeAttr || typeAttr.value !== 'number') return { skip: 'not number' };

    const vmodel = attrs.find(a => a.name === 'v-model.number') || attrs.find(a => a.name === 'v-model');
    if (!vmodel) return { skip: 'no v-model' };

    for (const a of attrs) {
        if (a.name.startsWith('v-model')) continue;
        if (a.name === 'class' || a.name === 'type') continue;
        if (a.name === '@change') continue;
        if (a.name.startsWith('@keyup')) continue;
        if (a.name === '@input' || a.name === '@blur' || a.name === '@focus') {
            return { skip: `has ${a.name}, semantics unclear` };
        }
        if (a.bound) {
            if (!PASSTHROUGH.has(a.name)) return { skip: `bound :${a.name} needs review` };
        } else if (!PASSTHROUGH.has(a.name) && !DROP.has(a.name)) {
            return { skip: `attr ${a.name} needs review` };
        }
    }

    const out = [`v-model="${vmodel.value}"`];

    for (const a of attrs) {
        if (a.name.startsWith('v-model')) continue;
        if (a.name === 'type' || a.name === 'class') continue;
        if (DROP.has(a.name)) continue;
        if (a.name.startsWith('@keyup')) continue;
        if (a.name === '@change') { out.push(`@change="${a.value}"`); continue; }

        if (a.name === 'disabled' || a.name === 'readonly') {
            out.push(a.bound ? `:${a.name}="${a.value}"` : `:${a.name}="true"`);
            continue;
        }
        /* placeholder 是字符串 prop，即使字面量是 "60" 也必须保持字符串绑定，
           否则 vue-tsc 会报 Type 'number' is not assignable to type 'string'。 */
        if (a.name === 'placeholder') {
            out.push(a.bound ? `:placeholder="${a.value}"` : `placeholder="${a.value}"`);
            continue;
        }
        const numericLiteral = !a.bound && /^-?\d+(\.\d+)?$/.test(a.value);
        if (numericLiteral || a.bound) { out.push(`:${a.name}="${a.value}"`); continue; }
        out.push(`${a.name}="${a.value}"`);
    }

    const classAttr = byName.get('class');
    if (classAttr) {
        const kept = classAttr.value.split(/\s+/).filter(Boolean).filter(c => !CLASS_DROP.has(c));
        if (kept.length) out.push(`class="${kept.join(' ')}"`);
    }

    return { html: `<UiNumberField ${out.join(' ')} />` };
}

async function walk(dir) {
    const out = [];
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...await walk(p));
        else if (entry.name.endsWith('.vue')) out.push(p);
    }
    return out;
}

const IMPORT_LINE = "import UiNumberField from '../components/ui/UiNumberField.vue';";

for (const file of await walk(SRC)) {
    const original = await fs.readFile(file, 'utf8');
    if (!/type="number"/.test(original)) continue;

    let changed = 0;
    const next = original.replace(/<input\b([^>]*?)\/?>/g, (whole, inner) => {
        if (!/type\s*=\s*["']number["']/.test(inner)) return whole;
        const r = transformInput(inner);
        if (r.skip) {
            report.skipped.push({
                file: path.relative(SRC, file),
                reason: r.skip,
                snippet: whole.replace(/\s+/g, ' ').slice(0, 150),
            });
            return whole;
        }
        changed += 1;
        report.converted += 1;
        return r.html;
    });

    if (!changed) continue;

    let withImport = next;
    if (!/components\/ui\/UiNumberField\.vue/.test(next)) {
        const lines = next.split('\n');
        let lastImport = -1;
        for (let i = 0; i < lines.length; i += 1) {
            if (/^\s*import\s/.test(lines[i])) lastImport = i;
            if (/^\s*<\/script>/.test(lines[i])) break;
        }
        if (lastImport >= 0) lines.splice(lastImport + 1, 0, IMPORT_LINE);
        else lines.unshift(IMPORT_LINE);
        withImport = lines.join('\n');
    }

    report.files.push({ file: path.relative(SRC, file), changed });
    if (WRITE) await fs.writeFile(file, withImport, 'utf8');
}

console.log('');
console.log(`=== codemod input[type=number] -> UiNumberField (${WRITE ? 'WRITE' : 'DRY-RUN'}) ===`);
console.log(`converted ${report.converted} in ${report.files.length} files`);
console.log('');
for (const f of report.files) console.log(`  ${String(f.changed).padStart(3)}  ${f.file}`);

if (report.skipped.length) {
    console.log('');
    console.log(`--- skipped ${report.skipped.length} (manual review) ---`);
    for (const s of report.skipped) {
        console.log(`  [${s.reason}] ${s.file}`);
        console.log(`      ${s.snippet}`);
    }
}
if (!WRITE) console.log('\n(dry-run; add --write to apply)');
