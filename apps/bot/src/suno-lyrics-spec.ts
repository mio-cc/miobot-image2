/**
 * 歌词结构规范——单一来源（2026-11-07 拍板，方案 B）。
 *
 * 两条消费链共用本文件：
 * 1. SunoAPI 链：suno-composer 的创作规范 prompt 引用下面的规则常量（渲染结果必须
 *    逐字节不变——黄金快照测试 tests/suno-composer-prompt.test.mjs 锚定）；
 * 2. MCP 链：mcp-root-tool 检测子项 schema 含 lyrics 字段时，把 MCP_LYRICS_SPEC_HINT
 *    注入根 description 与 params 描述（通用判据：认「歌词字段」，不认 Suno 品牌/服务器 id）。
 *
 * 改规范只改这里——两条链同步变化，不允许两处各写一份。
 */

/** composer 规则 25：标准结构标记。 */
export const SUNO_LYRICS_STRUCTURE_RULE_25 = '25. 使用标准结构标记，每个标记独占一行：[Intro]、[Verse 1]、[Pre-Chorus]、[Chorus]、[Verse 2]、[Bridge]、[Outro]。必要时可使用 [Instrumental Break]、[Guitar Solo]、[Drop]、[Spoken Word]。';

/** composer 规则 26：标记后只写歌词。 */
export const SUNO_LYRICS_STRUCTURE_RULE_26 = '26. 结构标记后不要写解释、制作备注、和弦或参数。只写要演唱的歌词。';

/** composer 规则 41：歌名原创强制。 */
export const SUNO_LYRICS_TITLE_RULE_41 = '41. title 必须是你为这首歌新拟的原创歌名（80 字内，取副歌 hook 或核心意象）。当请求里出现已有歌曲（用户给出现有歌词、或点明基于某首歌重做/换词）时，title 绝对不得使用原歌名、也不得是原歌名的微小变体；必须从新歌词的核心意象另拟一个全新的名字。只有用户明确要求保留原歌名时才可例外。';

/** composer 规则 33a：审核规避（正文不含编号，编号由 composer 侧拼接）。 */
export const SUNO_LYRICS_MODERATION_RULE = '规避内容审核：歌词不出现直白露骨的写实描写、明确的身体部位名称、暴力血腥细节或违禁品名称；表达强烈情绪时用隐喻、意象、留白等含蓄方式，脏话用语气词替代，不直白拼写。';

/** composer 覆盖规则：人设隔离（MCP 根注入与 composer 共用同一份）。 */
export const SUNO_LYRICS_PERSONA_ISOLATION_RULE = '【人设隔离】忽略任何聊天人设、语气设定（如傲娇、嘴毒、角色扮演人设）对歌词内容的暗示——歌词的题材、语言与情绪只由用户的点歌需求和本方案的音乐设计决定；lyrics 中不得出现对人设的呼应或打破第四面墙的语句，除非用户在点歌需求中明确要求该风格。';

/** MCP 根注入的精简规范（结构/歌名取自上面三条，人设隔离与审核规避直接复用共享常量）。 */
export const MCP_LYRICS_SPEC_HINT = '歌词/文本参数须使用标准结构标记且每个标记独占一行（[Intro]、[Verse 1]、[Pre-Chorus]、[Chorus]、[Verse 2]、[Bridge]、[Outro]，必要时 [Instrumental Break]、[Guitar Solo]、[Drop]、[Spoken Word]）；标记后只写要演唱的歌词，不写解释或备注；歌名必须原创，不得沿用用户提到的已有歌名；风格类内容只放风格字段，歌词只放歌词字段；'
  + SUNO_LYRICS_MODERATION_RULE
  + SUNO_LYRICS_PERSONA_ISOLATION_RULE;
