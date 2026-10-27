import type { AppConfig } from '../../../packages/config/src/index.js';
import type { StructuredLogger } from '../../../packages/logger/src/index.js';
import type { UserRequest } from '../../../packages/orchestration/src/index.js';
import { extractJsonObject } from '../../../packages/orchestration/src/index.js';
import type { ModelClient } from '../../../packages/model/src/index.js';

export interface SunoComposedSpec {
  customMode: boolean;
  instrumental: boolean;
  title?: string;
  musicBrief?: string;
  style?: string;
  lyrics?: string;
  negativeTags?: string;
  vocalGender?: 'm' | 'f';
  duration?: number;
  styleWeight?: number;
  language?: string;
  weirdnessConstraint?: number;
  audioWeight?: number;
  variety?: number;
  model?: string;
}

function clip(value: unknown, max: number): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function nullableClip(value: unknown, max: number): string | undefined {
  const text = clip(value, max);
  return text || undefined;
}

function numberIn(value: unknown, min: number, max: number): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : undefined;
}

function normalizeSpec(raw: Record<string, unknown>, cfg: AppConfig): SunoComposedSpec {
  const instrumental = Boolean(raw.instrumental);
  const configuredGender = cfg.orchestration.suno.defaultVocalGender;
  const requestedGender = raw.vocalGender === 'm' || raw.vocalGender === 'f'
    ? raw.vocalGender
    : configuredGender === 'm' || configuredGender === 'f' ? configuredGender : undefined;
  // 歌词恒由我们的模型写（用户要求）：非纯音乐一律 customMode=true，Suno 只负责演唱与编曲。
  const customMode = instrumental ? Boolean(raw.customMode) : true;
  const lyrics = customMode && !instrumental ? nullableClip(raw.lyrics, 5000) : undefined;
  const musicBrief = nullableClip(raw.musicBrief, 3000);
  const style = nullableClip(raw.style, 1000) || (customMode ? nullableClip(raw.musicBrief, 1000) : undefined);
  const title = customMode ? nullableClip(raw.title, 80) : undefined;
  const negativeTags = customMode ? nullableClip(raw.negativeTags, 1000) : undefined;
  const vocalGender = customMode && !instrumental ? requestedGender : undefined;
  const language = nullableClip(raw.language, 80) || nullableClip(cfg.orchestration.suno.defaultLanguage, 80);
  const model = ['V6', 'V6_WILD', 'V6_MINI'].includes(String(raw.model || '')) ? String(raw.model) : (cfg.orchestration.suno.model || 'V6');
  return {
    customMode,
    instrumental,
    title,
    musicBrief,
    style,
    lyrics,
    negativeTags,
    vocalGender,
    language,
    duration: customMode ? numberIn(raw.duration, 10, Math.min(360, cfg.orchestration.suno.maxDurationSeconds)) : undefined,
    styleWeight: customMode ? numberIn(raw.styleWeight, 0, 1) : undefined,
    weirdnessConstraint: customMode ? numberIn(raw.weirdnessConstraint, 0, 1) : undefined,
    audioWeight: customMode && !instrumental ? numberIn(raw.audioWeight, 0, 1) : undefined,
    variety: customMode ? numberIn(raw.variety, 0, 4) : undefined,
    model,
  };
}
export function buildSunoComposerPrompt(args: Record<string, unknown>, request: UserRequest, cfg: AppConfig, customTemplate?: string): string {
  const supplied = {
    request: args.request || args.prompt || request.text,
    style: args.style,
    lyrics: args.lyrics,
    title: args.title,
    instrumental: args.instrumental,
    duration: args.duration,
    negativeTags: args.negativeTags,
    vocalGender: args.vocalGender,
    language: args.language,
    defaultVocalGender: cfg.orchestration.suno.defaultVocalGender,
    defaultLanguage: cfg.orchestration.suno.defaultLanguage,
    styleWeight: args.styleWeight,
    weirdnessConstraint: args.weirdnessConstraint,
    audioWeight: args.audioWeight,
    variety: args.variety,
  };
  const schemaExample = {
    customMode: true,
    instrumental: false,
    title: '雨夜备忘录',
    musicBrief: 'A warm Japanese city-pop song for a rainy night drive: intimate female vocal, Rhodes piano, soft guitar, 82 BPM, nostalgic but hopeful, memorable chorus about finding comfort in small moments.',
    style: 'japanese city pop, dream pop, warm, intimate, female vocal, breathy, rhodes piano, soft guitar, 82 BPM, analog production',
    lyrics: '[Verse 1]\n夜色漫过后视镜\n雨点替我数着心情\n[Chorus]\n把心事留给雨夜慢慢听',
    negativeTags: null,
    vocalGender: 'f',
    language: '中文',
    duration: null,
    styleWeight: null,
    weirdnessConstraint: null,
    audioWeight: null,
    variety: null,
    model: 'V6',
  };
  const template = String(customTemplate || '').trim();
  if (template) {
    const values: Record<string, string> = {
      userText: request.text,
      supplied: JSON.stringify(supplied),
      defaultVocalGender: String(cfg.orchestration.suno.defaultVocalGender || 'auto'),
      defaultLanguage: String(cfg.orchestration.suno.defaultLanguage || 'auto'),
      schema: JSON.stringify(schemaExample),
      model: String(cfg.orchestration.suno.model || 'V6'),
    };
    let rendered = template;
    for (const [key, value] of Object.entries(values)) rendered = rendered.replaceAll('{{' + key + '}}', () => value);
    if (!template.includes('{{userText}}') && !template.includes('{{supplied}}')) rendered += '\n\n用户请求：' + values.userText;
    if (!template.includes('{{supplied}}')) rendered += '\n\n用户结构化线索：' + values.supplied;
    if (!template.includes('{{schema}}')) rendered += '\n\n输出结构：' + values.schema;
    // 最高优先级覆盖：歌词恒由我们的模型写（用户要求），自定义模板也不得把歌词交给 Suno 代写；
    // 同时做 人设隔离（聊天人格不得渗入歌词内容）。
    rendered += '\n\n' + SUNO_COMPOSER_OVERRIDE;
    return rendered;
  }
  return [
    '你是 Miobot 的 Suno V6 音乐创作导演、歌词作者和音乐制作参数规划器。',
    '把用户自然语言需求转换成 Suno /api/v1/generate 的结构化参数，只输出一个 JSON object。',
    '你不是关键词提取器。你要理解用户想表达的故事、情绪和听感，再写成可演唱、可生成的歌曲方案。',
    '',
    '【输出约束】',
    '1. 只输出 JSON，不要 Markdown、代码块、解释、创作过程或前后缀。',
    '2. 不要照抄用户整句。把用户描述提炼成音乐 brief、style 标签和必要的歌词。',
    '3. 用户明确给出的角色、故事、语言、歌名、歌词和禁止项是硬约束，不得改写含义。',
    '4. 用户提供的歌词必须逐字保留到 lyrics，不要润色、翻译、补写或改变段落顺序。',
    '5. 默认 model 为 ' + String(cfg.orchestration.suno.model || 'V6') + '，只能选择 V6、V6_WILD、V6_MINI。',
    '',
    '【模式选择】',
    '5a. 后台默认人声性别为 ' + String(cfg.orchestration.suno.defaultVocalGender || 'auto') + '；后台默认歌词语言为 ' + String(cfg.orchestration.suno.defaultLanguage || 'auto') + '。用户明确指定时以用户为准；后台默认不是 auto 时必须执行。',
    '6. 歌词恒由你（模型）创作：非纯音乐请求一律 customMode=true，并由你写出完整可唱的歌词放入 lyrics。Suno 只负责演唱与编曲，禁止让 Suno 代写歌词。',
    '7. lyrics 是你的核心职责：按用户的语言、情绪和题材创作完整歌词（用户提供的歌词逐字保留）；同时输出 title（80 字内，取副歌 hook 或核心意象）与 style 标签。仅 instrumental=true 时不需要歌词。',
    '8. 例如 来一首适合雨夜散步的日语女声歌曲 → customMode=true + 你写的日语歌词 + style 标签 + musicBrief 制作简报。不要输出 customMode=false，也不要把歌词留空让 Suno 自由发挥。',
    '9. customMode=true 时，Suno 的 prompt 字段可能被当作歌词。禁止把音乐 brief 放入 prompt；音乐风格只放 style，歌词只放 lyrics。',
    '10. instrumental=true 时不要输出 lyrics，也不要输出 vocalGender 或 audioWeight。',
    '',
    '【musicBrief 写法】',
    '10. musicBrief 是给 Suno 的音乐创作 brief，不是歌词。建议使用简洁英文音乐制作语言，专有名词和用户指定歌词语言保留原文。',
    '11. 按以下顺序自然融合：歌曲主题和叙事 -> 核心情绪 -> genre/subgenre -> 人声类型和语言 -> 主要乐器 -> 节奏和 BPM -> 编曲层次 -> 歌曲结构和 hook -> 制作质感。',
    '12. 写具体声音，不写空泛词。例如用 intimate breathy female vocal、fingerpicked guitar、warm Rhodes、soft brushed drums、analog tape warmth，而不是 beautiful、amazing、professional。',
    '13. musicBrief 控制在 60 到 180 个英文词或等量中文信息，最多 3000 字符。不要堆砌风格名，不要自相矛盾。',
    '',
    '【style 标签写法】',
    '14. style 使用 8 到 16 个高信息量标签，按顺序覆盖：genre、subgenre、mood、vocal type、lead instrumentation、rhythm section、tempo/BPM、production、era、arrangement。',
    '15. 标签用逗号分隔，避免完整句子，避免重复同义词。',
    '16. 人声标签要具体：male/female、breathy/clear/gritty/raspy、intimate/powerful、lead/harmony/choir、rap/sung/spoken。',
    '17. 乐器标签要具体：piano、Rhodes、acoustic guitar、electric guitar、bass、drums、strings、synth pad、brass、percussion；必要时写演奏方式。',
    '18. 节奏和制作标签要具体：BPM、half-time、four-on-the-floor、swing、syncopation、lo-fi、tape saturation、wide stereo、dry close-mic、cinematic reverb。',
    '19. 不要输出类似 (word:1.2) 的权重语法，不要 BREAK，不要 <lora:...>，不要编造 embedding 或模型名。',
    '',
    '【歌词创作标准】',
    '20. 歌词要有清晰情绪弧：开场建立场景或问题 -> verse 推进故事 -> pre-chorus 累积张力 -> chorus 释放核心 hook -> bridge 提供转折 -> outro 回收意象。',
    '21. 优先写可看见、可触摸、可听见的具体细节，少用抽象口号。用场景承载情绪，不要直接解释情绪。',
    '22. 副歌必须有一个短、可重复、易记的核心 hook。歌名或 hook 短语可在副歌中自然重复 2 到 4 次。',
    '23. 每段保持稳定的句长和演唱呼吸点。押韵自然，不为了押韵破坏语义；中文歌词避免翻译腔和机械堆字。',
    '24. 语言必须与用户要求一致。用户没有指定时跟随用户消息的主要语言。不要擅自把中文歌词翻成英文，也不要中英混杂除非用户要求。',
    '24a. 后台默认歌词语言是 ' + String(cfg.orchestration.suno.defaultLanguage || 'auto') + '。用户未指定语言且默认不是 auto 时，歌词必须使用该语言；language 字段输出最终语言。',
    '25. 使用标准结构标记，每个标记独占一行：[Intro]、[Verse 1]、[Pre-Chorus]、[Chorus]、[Verse 2]、[Bridge]、[Outro]。必要时可使用 [Instrumental Break]、[Guitar Solo]、[Drop]、[Spoken Word]。',
    '26. 结构标记后不要写解释、制作备注、和弦或参数。只写要演唱的歌词。',
    '27. 默认写完整但不过长的歌曲：2 个 verse、1 个 pre-chorus、2 到 3 个 chorus、1 个 bridge、1 个 outro。纯器乐则不要歌词。',
    '28. 歌词最多 5000 字符。若用户只给了主题，不要写成空洞的长诗；宁可少而准。',
    '',
    '【语言与题材】',
    '29. 华语流行：自然普通话口语，句尾可押韵但不要强行押；避免英文语法直译和过度古风词。',
    '30. 日语歌曲：使用自然日语句法和常见演唱表达，不要把中文逐字翻译成日语。',
    '31. 英文歌曲：使用自然英文韵律和重音，避免为押韵牺牲语法。',
    '32. 说唱：写清每小节的重音和停顿，句子短、节奏密，副歌要有可重复的口号。',
    '33. 不进行特定题材限制',
    '',
    '【控制参数】',
    '34. duration 仅 custom 模式且 10 到 360 秒；用户没有明确时长时用 null，不要默认写 10 或 20。',
    '35. vocalGender 仅在 custom 模式且用户明确或强烈暗示时输出 m 或 f；不要仅凭 genre 推断。',
    '35a. 后台默认人声性别不是 auto 时，即使普通点歌也必须使用 customMode=true 并输出对应的 vocalGender；如果 instrumental=true 则不要输出。',
    '35b. language 是最终歌词语言的内部选择，不直接作为 Suno 请求字段；必须同步影响 lyrics 和 style。',
    '36. styleWeight 仅在 custom 模式输出 0 到 1。默认 0.6；用户强调必须忠实风格时 0.75 到 0.9；用户想要探索时 0.35 到 0.55。',
    '37. weirdnessConstraint 仅在 custom 模式输出 0 到 1。常规歌曲 0.2 到 0.35；明显实验或先锋 0.6 到 0.85；默认 null。',
    '38. audioWeight 仅在 custom 模式、有人声且存在音频参考时输出 0 到 1；否则 null。',
    '39. variety 仅在 custom 模式输出整数 0 到 4。用户要固定风格用 0 到 1；普通生成用 1；主动探索用 2 到 3；最大发散才用 4。',
    '40. negativeTags 只写用户明确不想要的音乐特征，英文逗号分隔，最多 1000 字符；不要填写 bad quality 等泛化负面词。',
    '41. title 仅 custom 模式且最多 80 字符；优先使用副歌 hook 或核心意象，不要使用文件名式长标题。',
    '',
    '【自检】',
    '42. 提交前检查：歌词是否能唱、副歌是否记得住、语言是否统一、段落是否有推进、style 是否与歌词情绪一致、是否误用了 custom 模式禁止字段。',
    '43. 如果用户只给模糊主题，用音乐类型和情绪做出合理创作决定；如果用户给出明确细节，不要用泛化内容覆盖它。',
    '',
    '输出结构：',
    JSON.stringify(schemaExample),
    '',
    '用户原始请求：' + request.text,
    '用户提供的结构化线索：' + JSON.stringify(supplied),
    '',
    SUNO_COMPOSER_OVERRIDE,
  ].join('\n');
}

/** 追加在所有 composer 提示词（默认+自定义）末尾的硬约束：歌词作者职责 + 人设隔离。 */
const SUNO_COMPOSER_OVERRIDE = [
  '【最高优先级覆盖】无论上文规则如何：非纯音乐（instrumental=false）的请求必须 customMode=true，且由你写出完整可唱的 lyrics（用户提供的歌词逐字保留）；禁止输出 customMode=false，禁止让 Suno 代写歌词。instrumental=true 时不要输出 lyrics。',
  '【人设隔离】忽略任何聊天人设、语气设定（如傲娇、嘴毒、角色扮演人设）对歌词内容的暗示——歌词的题材、语言与情绪只由用户的点歌需求和本方案的音乐设计决定；lyrics 中不得出现对人设的呼应或打破第四面墙的语句，除非用户在点歌需求中明确要求该风格。',
].join('\n');export class SunoPromptComposer {
  constructor(
    private readonly client: Pick<ModelClient, 'chat'>,
    private readonly getConfig: () => AppConfig,
    private readonly logger?: StructuredLogger,
  ) {}

  async compose(args: Record<string, unknown>, request: UserRequest): Promise<SunoComposedSpec> {
    const cfg = this.getConfig();
    const suno = cfg.orchestration.suno;
    const nodeIndex = Number(suno.composerNodeIndex ?? cfg.orchestration.planner.nodeIndex ?? cfg.llm.chatNodeIndex ?? 0);
    const model = String(suno.composerModel || cfg.orchestration.planner.model || cfg.llm.chatModel || '');
    // 免费档模型对复杂 JSON 输出不稳定——重试一次（带纠错提示），失败才走 safe fallback。
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: 'You are a strict JSON Suno prompt planner. Never output markdown.' },
      { role: 'user', content: buildSunoComposerPrompt(args, request, cfg, suno.composerPromptTemplate) },
    ];
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const response = await this.client.chat(nodeIndex, {
          model,
          messages,
          temperature: Number(cfg.orchestration.suno.composerTemperature ?? 0.6),
          maxTokens: Number(cfg.orchestration.suno.composerMaxTokens ?? 6000),
          timeoutMs: Math.max(30000, Number(cfg.orchestration.suno.timeoutMs || 60000)),
        });
        const raw = String(response.text || '');
        const json = extractJsonObject(raw);
        if (!json) {
          // 记录模型实际返回了什么，方便诊断（截断防刷日志）。
          this.logger?.warn('Suno composer 第 ' + attempt + ' 次未输出 JSON', {
            attempt,
            chars: raw.length,
            preview: raw.replace(/\s+/g, ' ').slice(0, 200),
            model,
          });
          if (attempt < 2) {
            messages.push({ role: 'assistant', content: raw.slice(0, 500) });
            messages.push({ role: 'user', content: '你的输出不是有效 JSON。请重新输出，只输出一个 JSON object，不要 Markdown 代码块、解释或任何其他文字。' });
            continue;
          }
          throw new Error('suno_composer_no_json:chars=' + raw.length + ':preview=' + raw.replace(/\s+/g, ' ').slice(0, 120));
        }
        const normalized = normalizeSpec(JSON.parse(json) as Record<string, unknown>, cfg);
        // 歌词恒由我们的模型写：模型没产出歌词（旧模板/漏输出）时回退 Suno 代写，但明确告警。
        if (normalized.customMode && !normalized.instrumental && !normalized.lyrics) {
          this.logger?.warn('Suno composer 未输出歌词，本次回退 Suno 代写（请检查 composer 模板是否要求输出 lyrics）', { model, title: normalized.title || '' });
          normalized.customMode = false;
          normalized.lyrics = undefined;
        }
        if (normalized.customMode && !normalized.style && !normalized.lyrics && !normalized.negativeTags && !normalized.musicBrief) {
          throw new Error('suno_composer_custom_content_missing');
        }
        return normalized;
      } catch (error) {
        if (attempt >= 2 || !/no_json|invalid_json/.test(String((error as Error)?.message || ''))) {
          throw error;
        }
        // JSON 类错误且还有重试次数 → continue 到下一轮
      }
    }
    throw new Error('suno_composer_exhausted');
  }

  /** safe fallback：用用户原文直传 Suno，不做模型编排。 */
  composeSafeFallback(args: Record<string, unknown>, request: UserRequest): SunoComposedSpec {
    const cfg = this.getConfig();
    const suno = cfg.orchestration.suno;
    const userText = clip(args.request || args.prompt || request.text, 3000);
    const lyrics = nullableClip(args.lyrics, 5000);
    const instrumental = Boolean(args.instrumental);
    const configuredGender = suno.defaultVocalGender;
    const requestedGender = args.vocalGender === 'm' || args.vocalGender === 'f'
      ? args.vocalGender
      : configuredGender === 'm' || configuredGender === 'f' ? configuredGender : undefined;
    const customMode = Boolean(lyrics || instrumental || args.title || args.duration || args.negativeTags || requestedGender || args.styleWeight || args.weirdnessConstraint || args.audioWeight || args.variety);
    return {
      customMode,
      instrumental,
      title: customMode ? nullableClip(args.title, 80) : undefined,
      musicBrief: customMode ? undefined : userText,
      style: nullableClip(args.style, 1000) || (customMode ? userText.slice(0, 1000) : undefined),
      lyrics: customMode && !instrumental ? lyrics : undefined,
      negativeTags: customMode ? nullableClip(args.negativeTags, 1000) : undefined,
      vocalGender: customMode && !instrumental ? requestedGender : undefined,
      language: nullableClip(args.language, 80) || nullableClip(suno.defaultLanguage, 80),
      duration: customMode ? numberIn(args.duration, 10, Math.min(360, suno.maxDurationSeconds)) : undefined,
      styleWeight: customMode ? numberIn(args.styleWeight, 0, 1) : undefined,
      weirdnessConstraint: customMode ? numberIn(args.weirdnessConstraint, 0, 1) : undefined,
      audioWeight: customMode && !instrumental ? numberIn(args.audioWeight, 0, 1) : undefined,
      variety: customMode ? numberIn(args.variety, 0, 4) : undefined,
      model: suno.model || 'V6',
    };
  }
}
