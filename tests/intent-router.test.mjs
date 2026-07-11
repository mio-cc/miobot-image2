import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createIntentRouter,
  detectIntentSignals,
  buildPlannerMessages,
  parsePlannerOutput,
  plannerActionToIntentKind,
  preserveLanguage,
  hasImageBang,
  hasVideoBang,
  hasVideoVerb,
} from '../dist/packages/intent-router/src/index.js';
import { parseImageCommand } from '../dist/packages/image/src/index.js';

class FakePlanner {
  constructor(text) { this.text = text; this.calls = []; }
  async createText(request) { this.calls.push(request); return { text: this.text, raw: {} }; }
}
class ThrowingPlanner {
  async createText() { throw new Error('upstream down'); }
}

// 确定性信号（无 LLM）

test('signal: 生图动词且无图 -> image.generate，不调用规划器', async () => {
  const router = createIntentRouter({ planner: new FakePlanner('{"action":"text"}'), plannerModel: 'm' });
  const d = await router.route({ text: '画一只赛博朋克风格的猫' });
  assert.equal(d.kind, 'image.generate');
  assert.equal(d.source, 'signal');
  assert.equal(d.usedPlanner, false);
});

test('signal: 有图 + 改图动词 -> image.edit', async () => {
  const router = createIntentRouter();
  const d = await router.route({ text: '把背景换成海边', images: ['data:image/png;base64,AAA'] });
  assert.equal(d.kind, 'image.edit');
  assert.equal(d.source, 'signal');
});

test('signal: 有图 + 反推动词 -> image.interrogate', async () => {
  const router = createIntentRouter();
  const d = await router.route({ text: '反推一下这张图的提示词', images: ['http://x/y.png'] });
  assert.equal(d.kind, 'image.interrogate');
});

test('signal: "这是什么" + 引用图片 -> image.interrogate', async () => {
  const router = createIntentRouter();
  const d = await router.route({ text: '这是什么', hasReferencedImage: true });
  assert.equal(d.kind, 'image.interrogate');
});

test('signal: 显式尺寸 bang + 主体且无图 -> image.generate', async () => {
  const router = createIntentRouter();
  const d = await router.route({ text: '1024x1536! 雪山日出' });
  assert.equal(d.kind, 'image.generate');
  assert.equal(d.params.size, '1024x1536');
});

test('signal: 仅模板 mb_1! -> image.generate', async () => {
  const router = createIntentRouter();
  const d = await router.route({ text: 'mb_1! 一个女孩' });
  assert.equal(d.kind, 'image.generate');
  assert.equal(d.params.templateId, 'mb_1');
});

test('hasImageBang: 识别尺寸/比例/张数/模板 token', () => {
  assert.equal(hasImageBang(parseImageCommand('9:16! 海边')), true);
  assert.equal(hasImageBang(parseImageCommand('4! 多张')), true);
  assert.equal(hasImageBang(parseImageCommand('就是普通聊天')), false);
});

test('detectIntentSignals: 普通文本无信号', () => {
  const signals = detectIntentSignals({ text: '今天天气怎么样' }, parseImageCommand('今天天气怎么样'), {});
  assert.equal(signals.length, 0);
});

test('signal: 生成视频 -> video.generate', async () => {
  const router = createIntentRouter();
  const d = await router.route({ text: '生成视频 火箭从火星发射' });
  assert.equal(d.kind, 'video.generate');
  assert.equal(d.source, 'signal');
  assert.match(d.params.prompt, /火箭|发射/);
});

test('signal: 做个视频 / 视频 短句 -> video.generate', async () => {
  const router = createIntentRouter();
  const d1 = await router.route({ text: '做个视频 猫咪在草地上跑' });
  assert.equal(d1.kind, 'video.generate');
  const d2 = await router.route({ text: '视频 日落海边' });
  assert.equal(d2.kind, 'video.generate');
});

test('signal: video! bang + 主体 -> video.generate', async () => {
  const router = createIntentRouter();
  const d = await router.route({ text: 'video! 720p! 6s! 一只狐狸穿过雪地' });
  assert.equal(d.kind, 'video.generate');
  assert.equal(d.params.duration, 6);
  assert.equal(d.params.resolution, '720p');
});

test('hasVideoVerb / hasVideoBang', () => {
  assert.ok(hasVideoVerb('生成视频 猫'));
  assert.ok(hasVideoVerb('make a video of a cat'));
  assert.equal(hasVideoBang(parseImageCommand('video! 猫')), true);
  assert.equal(hasVideoBang(parseImageCommand('720p! 6s! 猫')), true);
  assert.equal(hasVideoBang(parseImageCommand('画一只猫')), false);
});

test('signal: 生成视频 优先于生图，不因「生成」走 image', async () => {
  const router = createIntentRouter();
  const d = await router.route({ text: '生成视频 赛博城市夜景' });
  assert.equal(d.kind, 'video.generate');
  assert.notEqual(d.kind, 'image.generate');
});

test('门控: video.generate 不可用 -> 降级 chat', async () => {
  const router = createIntentRouter({ capabilities: { videoGenerate: false, chat: true } });
  const d = await router.route({ text: '生成视频 一只猫' });
  assert.equal(d.degradedFrom, 'video.generate');
  assert.equal(d.kind, 'chat');
});

// 规划器兜底

test('planner: 歧义文本 -> 规划器判 text -> chat，prompt 用用户原始输入而非 plannerText', async () => {
  const planner = new FakePlanner('{"action":"text","text":"你好呀"}');
  const router = createIntentRouter({ planner, plannerModel: 'gpt-4o-mini' });
  const d = await router.route({ text: '在吗' });
  assert.equal(d.kind, 'chat');
  assert.equal(d.source, 'planner');
  assert.equal(d.usedPlanner, true);
  assert.equal(d.params.prompt, '在吗');
});

test('planner: 判 generate -> image.generate 并带规划器 prompt', async () => {
  const planner = new FakePlanner('```json\n{"action":"generate","prompt":"一只狐狸","size":"1024x1024"}\n```');
  const router = createIntentRouter({ planner, plannerModel: 'm' });
  const d = await router.route({ text: '随便来点什么' });
  assert.equal(d.kind, 'image.generate');
  assert.equal(d.params.prompt, '一只狐狸');
});

test('planner: 无规划器且无信号 -> fallback chat', async () => {
  const router = createIntentRouter();
  const d = await router.route({ text: '随便聊聊' });
  assert.equal(d.kind, 'chat');
  assert.equal(d.source, 'fallback');
});

test('planner: 规划器抛错 -> fallback，不崩', async () => {
  const router = createIntentRouter({ planner: new ThrowingPlanner(), plannerModel: 'm' });
  const d = await router.route({ text: '嗯嗯' });
  assert.equal(d.source, 'fallback');
  assert.ok(d.reason.includes('规划器失败'));
});

// bang 覆盖规划器

test('bang 覆盖: 用户给 1024x1536!，规划器给 512，取 bang', async () => {
  const planner = new FakePlanner('{"action":"generate","prompt":"风景","size":"512x512","count":4}');
  const router = createIntentRouter({ planner, plannerModel: 'm', signalThreshold: 0.99 });
  const d = await router.route({ text: '1024x1536! 帮我弄个东西' });
  assert.equal(d.kind, 'image.generate');
  assert.equal(d.params.size, '1024x1536');
});

// 能力门控/降级

test('门控: image.edit 不可用 -> 降级 image.generate（记录 degradedFrom）', async () => {
  const router = createIntentRouter({ capabilities: { imageEdit: false, imageGenerate: true } });
  const d = await router.route({ text: '把天空改成紫色', images: ['data:image/png;base64,AAA'] });
  assert.equal(d.degradedFrom, 'image.edit');
  assert.equal(d.kind, 'image.generate');
});

test('门控: 生图全关 -> 生图降级到 chat', async () => {
  const router = createIntentRouter({ capabilities: { imageGenerate: false, imageEdit: false, chat: true } });
  const d = await router.route({ text: '画一只猫' });
  assert.equal(d.degradedFrom, 'image.generate');
  assert.equal(d.kind, 'chat');
});

// 语言保持

test('preserveLanguage: 中文主体，规划器吐英文 prompt -> 保留中文', () => {
  assert.equal(preserveLanguage('画一只猫', 'a cat'), '画一只猫');
});
test('preserveLanguage: 用户明确要英文 -> 允许英文', () => {
  assert.equal(preserveLanguage('翻译成英文 a cat', 'a cat'), 'a cat');
});

// 规划器消息构造（vision）

test('buildPlannerMessages: 有图 + visionEnabled -> 注入 image_url', () => {
  const messages = buildPlannerMessages(
    { text: '看看这个', images: ['http://x/a.png', 'http://x/b.png'] },
    { visionEnabled: true },
  );
  const user = messages[1];
  assert.ok(Array.isArray(user.content));
  const imageParts = user.content.filter((p) => p.type === 'image_url');
  assert.equal(imageParts.length, 2);
});

test('buildPlannerMessages: 无 vision -> 纯文本 content', () => {
  const messages = buildPlannerMessages({ text: '看看这个', images: ['http://x/a.png'] }, { visionEnabled: false });
  assert.equal(typeof messages[1].content, 'string');
});

// planner 解析单元

test('parsePlannerOutput: interrogate', () => {
  assert.equal(parsePlannerOutput('{"action":"interrogate"}').action, 'interrogate');
});
test('parsePlannerOutput: 非 JSON 视为 text', () => {
  const out = parsePlannerOutput('我觉得可以这样做');
  assert.equal(out.action, 'text');
  assert.equal(out.text, '我觉得可以这样做');
});
test('plannerActionToIntentKind 映射', () => {
  assert.equal(plannerActionToIntentKind('generate'), 'image.generate');
  assert.equal(plannerActionToIntentKind('edit'), 'image.edit');
  assert.equal(plannerActionToIntentKind('interrogate'), 'image.interrogate');
  assert.equal(plannerActionToIntentKind('video'), 'video.generate');
  assert.equal(plannerActionToIntentKind('text'), 'chat');
});

test('planner: action=video -> video.generate', async () => {
  const planner = new FakePlanner('{"action":"video","prompt":"火箭升空","duration":8,"resolution":"720p"}');
  const router = createIntentRouter({ planner, plannerModel: 'm' });
  const d = await router.route({ text: '来点动态的吧' });
  assert.equal(d.kind, 'video.generate');
  assert.equal(d.params.prompt, '火箭升空');
  assert.equal(d.params.duration, 8);
  assert.equal(d.params.resolution, '720p');
});

test('parsePlannerOutput: video', () => {
  const out = parsePlannerOutput('{"action":"video","prompt":"cat runs","duration":6}');
  assert.equal(out.action, 'video');
  assert.equal(out.prompt, 'cat runs');
  assert.equal(out.duration, 6);
});
