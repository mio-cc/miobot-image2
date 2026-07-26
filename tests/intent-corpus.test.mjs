import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createIntentRouter } from '../dist/packages/intent-router/src/index.js';

/**
 * 意图识别回归语料。
 *
 * 之前 intent-router 的用例全是正例——每条都在验证「该命中的命中了」，
 * 唯一的负例还不含任何词库字面量，等于没测。于是词库里塞进「把这」「换个」「画」
 * 这类日常高频词的问题一直没被发现：回复一张图问「把这段话翻译成日语」会被判成改图。
 *
 * 这份语料反过来建：**六成以上是负例**——含触发词但其实只是闲聊的真实群聊句子。
 *
 * ── 怎么判分 ──────────────────────────────────────────────
 * 不能拿「语料全判对」当指标。信号层的设计意图就是：**拿不准时不下结论**，
 * 把 0.55 的弱信号交给规划器（真实部署里一定有）。用一个固定回答的假规划器去测，
 * 量到的是假规划器的水平，不是信号层的水平。
 *
 * 所以分三件事量，而且都在**不接规划器**的条件下量（这样看到的纯粹是信号层）：
 *   1. 负例零误报   —— 闲聊绝不能被判成花钱的动作。这是硬红线。
 *   2. 正例零错向   —— 真实需求可以判不出来（落给规划器），但不能判成**另一种**动作。
 *   3. 正例直判覆盖 —— 信号层直接判对的比例。太低说明什么都推给规划器，
 *                      每条消息都要多一次 LLM 往返，慢且花钱。
 */

const dir = path.dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(fs.readFileSync(path.join(dir, 'fixtures', 'intent-corpus.json'), 'utf8'));

const ACTIONS = ['image.generate', 'image.edit', 'image.interrogate', 'video.generate'];

/** 不接规划器：直接观察信号层自己的判断。 */
const router = createIntentRouter();

async function decide(c) {
  return router.route({
    text: c.text,
    images: c.hasImages ? ['http://example.test/ref.png'] : undefined,
    hasReferencedImage: Boolean(c.hasImages),
  });
}

function lines(rows) {
  return rows.map((r) => `  [期望 ${r.expected} → 得到 ${r.got}] ${r.text}${r.hasImages ? '（有图）' : ''}\n      ${r.reason}`).join('\n');
}

let results;
async function evaluated() {
  if (!results) {
    results = [];
    for (const c of corpus) {
      const d = await decide(c);
      results.push({ ...c, got: d.kind, source: d.source, confidence: d.confidence, reason: d.reason });
    }
  }
  return results;
}

test('语料本身是健康的：负例占多数，五类都有覆盖', () => {
  const byKind = {};
  for (const c of corpus) byKind[c.expected] = (byKind[c.expected] || 0) + 1;
  assert.ok(corpus.length >= 100, `语料太少（${corpus.length}）`);
  assert.ok(byKind.chat / corpus.length > 0.5, '负例（chat）应当占多数——误报才是主要风险');
  for (const kind of ['chat', ...ACTIONS]) {
    assert.ok(byKind[kind] > 0, `缺少 ${kind} 的用例`);
  }
  const imageChat = corpus.filter((c) => c.hasImages && c.expected === 'chat').length;
  assert.ok(imageChat >= 15, `「有图但只是闲聊」的样本太少（${imageChat}）——这是最容易误判的一类`);
});

test('硬红线：闲聊绝不能被判成花钱的动作', async () => {
  const rows = await evaluated();
  const falsePositives = rows.filter((r) => r.expected === 'chat' && ACTIONS.includes(r.got));
  assert.equal(falsePositives.length, 0,
    `${falsePositives.length}/${rows.filter((r) => r.expected === 'chat').length} 条闲聊被误判成动作：\n${lines(falsePositives)}`);
});

test('真实需求可以判不出来（交规划器），但不能判成另一种动作', async () => {
  const rows = await evaluated();
  const misrouted = rows.filter((r) => ACTIONS.includes(r.expected) && ACTIONS.includes(r.got) && r.got !== r.expected);
  assert.equal(misrouted.length, 0, `${misrouted.length} 条被路由到了错误的能力：\n${lines(misrouted)}`);
});

test('信号层直判覆盖率：别把什么都推给规划器', async () => {
  const rows = await evaluated();
  const positives = rows.filter((r) => ACTIONS.includes(r.expected));
  const hit = positives.filter((r) => r.got === r.expected);
  const rate = hit.length / positives.length;
  const missed = positives.filter((r) => r.got !== r.expected);
  // 门槛定在 0.6：低于这个说明信号层退化成了摆设，每条消息都要多一次 LLM 往返。
  assert.ok(rate >= 0.6,
    `直判覆盖率只有 ${(rate * 100).toFixed(0)}%（${hit.length}/${positives.length}），以下需要规划器兜底：\n${lines(missed)}`);
  console.log(`      信号层直判覆盖率 ${(rate * 100).toFixed(0)}%（${hit.length}/${positives.length}），其余落到规划器`);
});

test('信号层对超长输入不能有二次方回溯（一条消息卡死全部群聊）', async () => {
  const { detectIntentSignals } = await import('../dist/packages/intent-router/src/signals.js');
  const { parseImageCommand } = await import('../dist/packages/image/src/index.js');

  // 最坏输入：命中动词前缀、后面全是空白、永远匹配不到量词
  for (const n of [20000, 100000]) {
    const text = `画${' '.repeat(n)}`;
    const params = parseImageCommand(text, {});
    const started = process.hrtime.bigint();
    detectIntentSignals({ text }, params, {});
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(ms < 200, `${n} 个空白字符耗时 ${ms.toFixed(0)}ms —— 信号层是同步的，这段时间整个 bot 停止响应`);
  }
});
