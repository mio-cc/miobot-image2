import type { ParsedImageParams } from '../../image/src/index.js';
import type { IntentInput, IntentSignal } from './types.js';

/**
 * 确定性信号检测：在"内容足够明确"时直接给出高置信意图，避免无谓的 LLM 往返。
 * 不确定时给低置信信号（或不给），交给 planner。所有函数为纯函数，可单测。
 *
 * ── 为什么分强弱两档 ──────────────────────────────────────────
 * 中文匹配没有词边界，只能用 includes。而「改」「换」「加」「去掉」「画」「视频」
 * 这些字在日常聊天里出现的频率，比在真实出图需求里高一个数量级。
 * 之前所有命中一律给 0.9，越过阈值直接短路 planner，于是：
 *   回复一张截图问「把这段话翻译成日语」→ 判成改图，把整句丢给 gpt-image-2
 *   「有什么好看的动画推荐吗」          → 判成生图
 *   「这个视频真好笑」                  → 判成生成视频（又慢又贵）
 * 现在：强词（改图/重绘/文生图/生成视频…）仍然直接判定；
 * 弱词（把这/换个/画/视频…）必须有旁证——同句出现图像名词、或动词与「视频」紧邻——
 * 才升到可执行置信度，否则只给 0.5~0.6，落到阈值以下由 planner 复核。
 *
 * 判错的代价是不对称的：判错成 chat 只是回句废话，判错成 image/video 是
 * 真花钱 + 群里刷屏，而且用户不会来报 bug，只会觉得机器人很傻。所以拿不准一律偏向 chat。
 */

// ── 词条：中文词支持上下文排除 ─────────────────────────────────

interface TermRule {
  term: string;
  /** 命中处的前一个字若属于此串，则不算命中（例：动/漫/壁 + 画）。 */
  denyPrev?: string;
  /** 命中处的后一个字若属于此串，则不算命中（例：画 + 质/面/风）。 */
  denyNext?: string;
}

type Term = string | TermRule;

function ruleOf(term: Term): TermRule {
  return typeof term === 'string' ? { term } : term;
}

// ── 强词：单独出现即可判定 ────────────────────────────────────

const GENERATE_STRONG: Term[] = [
  // zh —— 都带了量词或主语，日常聊天很难误撞
  // 「画一年」「画一会」不是要出图；「画个圈圈」是梗
  { term: '画一', denyNext: '年月日天次会下点些百千万' }, { term: '画个', denyNext: '圈锤鬼屁' },
  '画张', '画幅', '画只', '画条', '画头',
  // 「别给我画饼了」——「给我画」后面接饼/圈之类的就不是要出图
  { term: '帮我画', denyNext: '饼圈押' }, { term: '给我画', denyNext: '饼圈押' }, '替我画',
  '生成图', '生成一张', '生成张', '来一张', '来张', '出一张', '出张',
  '绘制', '生图', '文生图', '设计一张', '做一张图', '做张图', '整一张',
  // en
  'draw', 'create an image', 'make an image', 'make me an image', 'generate an image',
  'a picture of', 'an image of', 'text to image', 'text2image',
];

const EDIT_STRONG: Term[] = [
  // zh —— 明确指向图像操作
  '改图', '修图', '重绘', '局部重绘', '扩图', '图生图', '垫图', '以图生图', '参考图',
  '这张图改', '把这张图', '把图', '抠图', '抠掉', '去水印', '换背景', '换脸', '美化一下',
  // en
  'inpaint', 'outpaint', 'upscale', 'img2img', 'image to image', 'retouch',
];

const INTERROGATE_STRONG: Term[] = [
  // zh
  '反推', '反向提示', '反推提示词', '提取提示词', '这张图的提示词', '识图',
  '描述这张', '描述一下这张', '分析这张图', '这张图是什么', '图片描述',
  // en
  'reverse prompt', 'reverse engineer this image', 'interrogate', 'caption this',
];

// ── 弱词：必须有旁证才升档 ────────────────────────────────────

/** 「弄张」「搞一张」「p张」——动词 + 量词「张」，几乎只用来指一张图。 */
// 注意别写成 \s*(我)?\s* —— 两个变长量词夹一个可选组是歧义分解，
// 匹配失败时引擎要枚举所有切分方式，复杂度 O(n²)：
// 一条 6 万空白字符的消息能把事件循环卡住 5 秒，bot 对所有群停止响应。
// 改成只保留一个变长量词，可选部分各自带上自己的空白。
const MAKE_A_SHEET = /(画|弄|搞|整|做|来|出|给我|帮我|p|P)\s*(?:我\s*)?(?:一\s*)?张/;

/** 创作物名词：出现这些词再配上任意「做」类动词，基本就是要出图。 */
const CREATIVE_ARTIFACT = /贺卡|logo|头像|壁纸|表情包|海报|封面|插画|图标|banner|名片|卡片|立绘|头图|背景图/i;
const MAKE_VERB_ANY = /画|生成|制作|做|弄|搞|整|设计|想要|来个|来一个/;

/**
 * 「这表情包咋做的」「求问这是哪个插画师的图」——问的是**来历和做法**，不是要一份。
 * 创作物名词 + 制作动词这个组合，在「问」和「要」两种语境下长得一模一样，
 * 只能靠这些提问标记区分。
 */
const ASKING_ABOUT = /咋(做|弄|画|整|搞)|怎么(做|弄|画|整|搞|来)|哪(个|位|家|来|下|找|买)|谁(做|画|设计|的)|求问|请问|教教|教我|出处|原图|在哪/;

const GENERATE_WEAK: Term[] = [
  // 单字「画」误伤面极广，把最常见的组合字排掉；剩下的仍只给弱信号。
  { term: '画', denyPrev: '动漫壁插油国版绘简笔工水墨素描卡通计比刻图漫book', denyNext: '质面风家展布饼廊册作报室师具板画法' },
  '生成一', '来个', '搞一张',
  'paint', 'render', 'generate',
];

const EDIT_WEAK: Term[] = [
  '改成', '编辑', '修改', '换成', '换个', '替换', '去掉', '删掉', '抹掉',
  '加上', '添加', '调整', '调色', '美化', '风格化', '把这',
  '弄成', '搞成', '整成', '变成', '擦了', '擦掉', '涂掉', '修清楚', '修一下', '加个', '换掉', 'p掉', 'p成',
  'edit', 'modify', 'change', 'replace', 'remove', 'turn this into', 'based on this image',
];

const INTERROGATE_WEAK: Term[] = [
  '描述一下', '描述下', '看图', '看看这', '这是什么', '这幅图', '图里', '图中',
  '什么内容', '解析这', '分析这',
  'describe', 'caption', 'what is this', "what's in this", 'what is in this', 'analyze this image',
];

/** 图像名词：句子直接谈到「一张图」。 */
const IMAGE_NOUN = /图|照片|相片|画面|截图|头像|壁纸|封面|logo|photo|image|picture/i;

/**
 * 视觉对象：真实的改图指令常常压根不提「图」，只说图里的东西——
 * 「把天空改成紫色」「背景换成海边」「去掉右下角的水印」。
 * 而误伤的那些句子操作的是抽象事物（话题/计划/道理/运费），落不到这张表上。
 * 判别弱编辑词到底在改图还是在聊天，靠的就是这个区别。
 */
const VISUAL_TARGET = /天空|云朵|背景|前景|人物|脸部|表情|头发|眼睛|嘴巴|衣服|裙子|帽子|鞋子|颜色|色调|色彩|亮度|对比度|饱和度|水印|字幕|标志|边框|构图|画风|风格|分辨率|滤镜|阴影|光线|模糊|清晰度|马赛克|logo|背景色|黑白|竖版|横版|方形|墨镜|眼镜|口罩|翅膀|文字|行字|水印|糊|清楚|模糊|滤镜|光影|噪点/i;

/**
 * 弱编辑/弱反推词的旁证：谈到图本身，或谈到图里的东西。
 *
 * 必须把命中的词本身从待检文本里剔掉再判——否则「图里」「看图」这类
 * 自带「图」字的弱词等于自己给自己作证，旁证机制形同虚设
 * （「图里这个我也有」会被判成反推）。
 */
function hasVisualContext(text: string, matchedTerm?: string): boolean {
  const rest = matchedTerm ? text.split(matchedTerm).join('') : text;
  return IMAGE_NOUN.test(rest) || VISUAL_TARGET.test(rest);
}

/**
 * 「视频」前面最近的那个动词决定意图。
 * 不能要求动词与「视频」紧邻——最自然的说法恰恰是把主体夹在中间
 * （「生成一段海浪拍打礁石的视频」）；也不能只要出现生成类动词就算
 * （「做完作业再看视频」里离「视频」最近的是「看」）。
 */
const VIDEO_MAKE_VERB = /(生成|制作|创作|做|拍|搞|整|来|出|画|弄)/g;
const VIDEO_CONSUME_VERB = /(看|刷|发|转|下载|上传|录|剪|传|收藏|保存|播放|加载|买|卖)/g;

/** 取「视频」之前那一小段里，最后出现的生成类动词——且它必须比消费类动词更靠后。 */
function videoMakeVerbBefore(text: string): string | undefined {
  const at = text.search(/视频|video/i);
  if (at < 0) return undefined;
  // 只看同一小句：跨过标点就不是在说同一件事了。
  const head = text.slice(Math.max(0, at - 24), at);
  const clause = head.split(/[，。！？!?；;、\n]/).pop() || '';
  const lastIndexOf = (re: RegExp) => {
    let last = -1;
    let hit;
    const rx = new RegExp(re.source, 'g');
    while ((hit = rx.exec(clause)) !== null) last = hit.index;
    return last;
  };
  const make = lastIndexOf(VIDEO_MAKE_VERB);
  const consume = lastIndexOf(VIDEO_CONSUME_VERB);
  if (make < 0) return undefined;
  if (consume > make) return undefined;
  // 「我手机拍的视频」：动词紧跟「的」是定语从句，在描述一个已经存在的视频，
  // 而不是让机器人去做一个。「做个猫跑步的视频」里「的」前面是「步」，不受影响。
  if (/(生成|制作|创作|做|拍|搞|整|来|出|画|弄)的$/.test(clause)) return undefined;
  return clause.slice(make).trim() + '视频';
}
/**
 * 「让这张图动起来」「搞成动的」——要的是视频，只是没说出「视频」两个字。
 * 之前只认字面「视频」，这一整类图生视频的说法全部漏到改图去了。
 */
const ANIMATE_PATTERN = /(搞|弄|做|整|变|改|转)\s*成\s*(动的|动态|会动|活的)|动起来|动画化|让.{0,6}(动起来|会动)/i;

const VIDEO_STRONG_TERMS: Term[] = [
  '文生视频', '图生视频', '视频生成', '动态视频', '让它动起来', '让图片动起来',
  'text to video', 'text2video', 'image to video', 'img2video', 'animate this', 'animate the image',
  'generate a video', 'make a video', 'make me a video', 'create a video',
];

/**
 * 「你能画画吗」「你会做视频吗」——问的是能力，不是让你现在就做。
 * 这类句子命中动作词的概率极高，必须整体压掉。
 */
const CAPABILITY_QUESTION = /你(能|会|可以|支持|能不能|会不会)|能不能|会不会|可以吗|支持吗|行不行/;

/** 「视频用什么软件剪」「怎么做视频」——咨询，不是下单。只对视频生效（视频成本最高）。 */
const VIDEO_CONSULT = /用(什么|啥|哪)|怎么(做|弄|搞|剪|拍|录)|如何|教程|推荐|哪个|哪款|软件|剪辑|加载|下载|发我|发一下|好看|好笑|真棒|没看|多久|多长时间|收费|多少钱|要钱|贵不贵|快不快|教教|教我|谁会|会不会/;

/**
 * 疑问/语气结尾：弱信号遇到直接放弃。
 * 「么」不在其中——「这是什么」「怎么弄」里的么不是语气词，
 * 把它当语气词会把「这是什么」这类真实的看图提问一起毙掉。
 */
const QUESTION_TAIL = /[?？]\s*$|(吗|呢|吧)[\s!！。.…~～]*$/;

// ── 匹配工具 ──────────────────────────────────────────────────

function hasCjk(value: string): boolean {
  return /[㐀-鿿豈-﫿]/u.test(value);
}

/**
 * 中文词用包含 + 上下文排除；英文词用单词/短语边界，避免 "change" 命中 "exchange"。
 * 中文没有词边界可用，只能靠前后字排除——这是「动画/画质」这类误伤唯一的根治手段。
 */
function matchesTerm(text: string, term: Term): boolean {
  const rule = ruleOf(term);
  if (!rule.term) return false;
  const value = String(text || '');

  if (!hasCjk(rule.term)) {
    const escaped = rule.term.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, 'i').test(value.toLowerCase());
  }

  // 逐个出现位置检查前后字，任意一处通过即算命中。
  let from = 0;
  for (;;) {
    const at = value.indexOf(rule.term, from);
    if (at < 0) return false;
    const prev = at > 0 ? value[at - 1] : '';
    const next = value[at + rule.term.length] || '';
    const blockedPrev = Boolean(rule.denyPrev && prev && rule.denyPrev.includes(prev));
    const blockedNext = Boolean(rule.denyNext && next && rule.denyNext.includes(next));
    if (!blockedPrev && !blockedNext) return true;
    from = at + 1;
  }
}

export function matchesAny(text: string, terms: Term[]): string | undefined {
  const value = String(text || '');
  for (const term of terms) {
    if (matchesTerm(value, term)) return ruleOf(term).term;
  }
  return undefined;
}

export function hasGenerateVerb(text: string): string | undefined {
  return matchesAny(text, GENERATE_STRONG) || matchesAny(text, GENERATE_WEAK);
}
export function hasEditVerb(text: string): string | undefined {
  return matchesAny(text, EDIT_STRONG) || matchesAny(text, EDIT_WEAK);
}
export function hasInterrogateVerb(text: string): string | undefined {
  return matchesAny(text, INTERROGATE_STRONG) || matchesAny(text, INTERROGATE_WEAK);
}

/** 是否存在"图像类" bang 参数（模板 / 显式尺寸 / 比例 / 放大 / 张数 / 质量）。 */
export function hasImageBang(params: ParsedImageParams): boolean {
  if (params.templateId) return true;
  return params.tokens.some((token) =>
    /^(?:mb_\d+|\d{2,5}x\d{2,5}|\d{1,2}:\d{1,2}|[124]k|\d+|n=\d+|low|medium|high|auto|standard|hd)!$/i.test(token),
  );
}

/** 视频类 bang：video! / 视频! / 6s! / duration=6! / 480p! / 720p! 等。 */
export function hasVideoBang(params: ParsedImageParams): boolean {
  return params.tokens.some((token) =>
    /^(?:video|视频|t2v|i2v|\d{1,2}s|duration=\d+|480p|720p|1080p)!$/i.test(token),
  );
}

/**
 * 视频意图。只认两种形态：
 *   1. 动词与「视频」紧邻（生成/做/拍/来/出…视频），或明确的 文生视频/animate this 等；
 *   2. 「视频」在句首后接空格再接主体（自由模式的 "视频 日落海边" 用法）。
 * 除此之外句子里出现「视频」一律不产生信号——群里聊视频的频率远高于让机器人生成视频，
 * 而误判一次要跑几分钟并烧掉一次视频额度。
 */
export function hasVideoVerb(text: string): string | undefined {
  const value = String(text || '').trim();
  if (!value) return undefined;
  if (CAPABILITY_QUESTION.test(value) && QUESTION_TAIL.test(value)) return undefined;
  if (VIDEO_CONSULT.test(value)) return undefined;
  if (QUESTION_TAIL.test(value)) return undefined;

  const explicit = matchesAny(value, VIDEO_STRONG_TERMS);
  if (explicit) return explicit;

  const animate = value.match(ANIMATE_PATTERN);
  if (animate) return animate[0];

  const byVerb = videoMakeVerbBefore(value);
  if (byVerb) return byVerb;

  // 「视频 日落海边」：句首 + 空格 + 主体，这是自由模式里明确的下单格式。
  const lead = value.match(/^(视频|video)[\s:：]+(\S.*)$/i);
  if (lead && lead[2].trim().length >= 2) return lead[1];

  return undefined;
}

export interface SignalOptions {
  preferEditWhenImagePresent?: boolean;
}

/**
 * 输入：清洗后的文本、bang 解析结果、是否有图。
 * 输出：命中的信号（可能为空，也可能是低置信的）。由 router 做阈值判定、能力门控与兜底。
 */
export function detectIntentSignals(
  input: IntentInput,
  params: ParsedImageParams,
  options: SignalOptions = {},
): IntentSignal[] {
  const text = String(input.text || '').trim();
  const hasImages = Boolean((input.images && input.images.length) || input.hasReferencedImage);
  const preferEdit = options.preferEditWhenImagePresent !== false;
  const signals: IntentSignal[] = [];

  const askingCapability = CAPABILITY_QUESTION.test(text);
  const isQuestion = QUESTION_TAIL.test(text);


  const genStrong = matchesAny(text, GENERATE_STRONG);
  const genWeak = genStrong ? undefined : matchesAny(text, GENERATE_WEAK);
  const editStrong = matchesAny(text, EDIT_STRONG);
  const editWeak = editStrong ? undefined : matchesAny(text, EDIT_WEAK);
  const interStrong = matchesAny(text, INTERROGATE_STRONG);
  const interWeak = interStrong ? undefined : matchesAny(text, INTERROGATE_WEAK);
  const video = hasVideoVerb(text);
  const imageBang = hasImageBang(params);
  const videoBang = hasVideoBang(params);

  // 问「你会不会画画」是在问能力，不是让你现在画。
  // 但必须同时是疑问句——「能不能生成一只穿西装的鲨鱼」只是说得客气，是真的在下单。
  if (askingCapability && isQuestion && !imageBang && !videoBang) return [];

  // 0) 视频。hasVideoVerb 内部已经排掉了咨询/疑问/能力问句。
  if (video || videoBang) {
    signals.push({
      kind: 'video.generate',
      confidence: videoBang && !video ? 0.8 : 0.9,
      reason: videoBang && !video
        ? '存在视频 bang 参数（video!/时长/分辨率等）'
        : `检测到视频生成意图（"${video}"）`,
    });
  }

  // 1) 反推/识图：需要有图。
  if (hasImages && interStrong) {
    signals.push({ kind: 'image.interrogate', confidence: 0.92, reason: `检测到反推意图（"${interStrong}"）且存在图片` });
  } else if (hasImages && interWeak && !isQuestion) {
    // 「描述一下」「这是什么」这类弱词，必须同句谈到图才敢直接执行。
    signals.push({
      kind: 'image.interrogate',
      confidence: hasVisualContext(text, interWeak) ? 0.88 : 0.55,
      reason: hasVisualContext(text, interWeak)
        ? `检测到反推意图（"${interWeak}"）且句中提到图像内容`
        : `疑似反推意图（"${interWeak}"），但句中没提到图像，交由规划器判断`,
    });
  }

  // 2) 改图：需要有图。
  if (hasImages && editStrong) {
    signals.push({ kind: 'image.edit', confidence: 0.9, reason: `检测到改图意图（"${editStrong}"）且存在图片` });
  } else if (hasImages && editWeak && !isQuestion) {
    // 「把这」「换个」「调整」在日常对话里太常见了——回复一张图闲聊会大量误撞。
    signals.push({
      kind: 'image.edit',
      confidence: hasVisualContext(text, editWeak) ? 0.87 : 0.55,
      reason: hasVisualContext(text, editWeak)
        ? `检测到改图意图（"${editWeak}"）且句中提到图像内容`
        : `疑似改图意图（"${editWeak}"），但句中没提到图像，交由规划器判断`,
    });
  }

  // 3) 生图。除了词库，还认两种句式：「V + 张」和「创作物名词 + 做类动词」。
  const askingAbout = ASKING_ABOUT.test(text);
  const sheetForm = !hasImages && !askingAbout && MAKE_A_SHEET.test(text);
  const artifactForm = !askingAbout && CREATIVE_ARTIFACT.test(text) && MAKE_VERB_ANY.test(text);
  if (!genStrong && (sheetForm || artifactForm)) {
    signals.push({
      kind: hasImages && preferEdit ? 'image.edit' : 'image.generate',
      confidence: 0.82,
      reason: sheetForm ? '句式「动词 + 一张」指向出图' : '提到创作物且带制作动词',
    });
  }
  if (genStrong) {
    signals.push({ kind: 'image.generate', confidence: hasImages ? 0.7 : 0.85, reason: `检测到生图意图（"${genStrong}"）` });
  } else if (genWeak && !isQuestion) {
    signals.push({
      kind: 'image.generate',
      confidence: 0.6,
      reason: `疑似生图意图（"${genWeak}"），证据不足，交由规划器判断`,
    });
  }

  // 4) 图像 bang 参数 + 有主体：这是显式下单，不受弱词规则影响。
  if (imageBang && params.prompt.trim()) {
    signals.push({
      kind: hasImages && preferEdit ? 'image.edit' : 'image.generate',
      confidence: hasImages ? 0.72 : 0.78,
      reason: hasImages ? '存在图像 bang 参数且附带图片' : '存在图像 bang 参数（尺寸/比例/模板/张数等）',
    });
  }

  // 5) 仅模板 bang（mb_1!）即使没有其它主体也强烈表示生图。
  if (params.templateId && !signals.some((s) => s.kind.startsWith('image'))) {
    signals.push({
      kind: hasImages && preferEdit ? 'image.edit' : 'image.generate',
      confidence: 0.7,
      reason: `检测到模板参数（${params.templateId}!）`,
    });
  }

  return dedupeBestByKind(signals);
}

/** 同一 kind 只保留最高置信的一条，并按置信降序。 */
function dedupeBestByKind(signals: IntentSignal[]): IntentSignal[] {
  const best = new Map<string, IntentSignal>();
  for (const signal of signals) {
    const current = best.get(signal.kind);
    if (!current || signal.confidence > current.confidence) best.set(signal.kind, signal);
  }
  return [...best.values()].sort((a, b) => b.confidence - a.confidence);
}
