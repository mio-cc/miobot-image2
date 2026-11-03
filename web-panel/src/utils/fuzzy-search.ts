/**
 * 统一模糊搜索（方案 §3.3）—— AppSelect 下拉与节点模型展开共用同一份实现。
 *
 * 设计要点：
 * - **预建索引**：lowercase / 去分隔符 compact / 词首 initials / 中文别名拼音首字母
 *   在 buildSearchIndex 一次性算好，每次按键只做匹配，不重算字符串形态。
 * - **子序列匹配**（非前缀非包含）：输入 `4omi` 命中 `gpt-4o-mini`，`ds` 命中 `deepseek-chat`；
 *   `g4m` 命中 `gpt-4o-mini` 的词首（g**pt**-**4**o-**m**ini）；`sdqs` 命中别名「深度求索」。
 * - **排序**：前缀命中 > 连续子串命中 > 词首命中（initials / 拼音首字母）> 分散子序列命中；
 *   同档位候选更短者优先，再按原始顺序稳定排序（保持调用方按 provider 的分组）。
 * - 纯函数、零 DOM / 框架依赖：面板打开时构建一次，按键期间 O(候选数) 匹配。
 */

/** 搜索候选：raw 必填；alias 是中文别名（节点名等），参与拼音首字母与直接包含匹配。 */
export interface SearchCandidate {
    raw: string;
    alias?: string;
}

/** 预建索引条目。compact/initials 的每个字符都带 raw 里的原始下标，供高亮回映。 */
export interface IndexedEntry<T> {
    item: T;
    lower: string;
    /** 去掉分隔符的 lowercase："gpt-4o-mini" → "gpt4omini" */
    compact: string;
    /** compact[i] 在 raw 中的字符下标（Array.from 口径） */
    compactMap: number[];
    /** 分词首字母："gpt-4o-mini" → "g4m"；DeepSeekChat → "dsc"；深度求索 → "sdqs" */
    initials: string;
    /** initials[i] 在 raw 中的字符下标 */
    initialMap: number[];
    aliasLower: string;
    aliasInitials: string;
}

export interface SearchHit<T> {
    item: T;
    /** 4=前缀 3=连续子串 2=词首 1=分散子序列 */
    tier: number;
    /** 命中起点（同档位下越靠前越优先） */
    matchIndex: number;
    /** raw 上的高亮区间 [start, end)，字符下标按 Array.from 口径 */
    ranges: Array<[number, number]>;
}

/* ── 内置拼音首字母表（方案：内置别名表，可缺省）。
   覆盖常见厂商/产品名与配置常用字；表外字符静默跳过（该字不参与首字母索引）。
   成对书写：字符 + 首字母。 ── */
const PINYIN_DATA =
    // 厂商 / 产品
    '深s度d求q索s阿a里l巴b赫h通t义y千q问w达d摩m豆d包b字z节j跳t动d火h山s方f舟z腾t讯x混h元y' +
    '文w心x一y言y飞f星x智z谱p清q月y之z暗a面m基j础c开k放f硅g流l零l万w物w壁b思s必b驰c商s汤t' +
    '天t工g阶j跃y辰c川c稀x宇y秘m塔t谷g歌g微w软r必b应y苹p果g亚y马m逊x华h为w荣r耀y' +
    // 配置常用字
    '中w英y机j器q人r对d话h聊l天t绘h画h图t视s频p语y音y朗l读d作z曲q乐l歌g词c摘z要y总z结j记j忆y' +
    '翻f译y快k慢m大d小x主z备b用y转z化h参c数s判p定d前q处c理l能n助z手s模m型x节j点d密m钥y地d址z' +
    '并b发f测c试s反f推t编b辑j生s成c渲r染r代d码m搜s索s联l网w筛s选x择z全q部b输s入r出c上s传c下x载z' +
    '文w件j片p相x册c播b放f队d列l超c时s重c试s间j隔g数s量l质z格g式s尺c寸c预y设s风f板b提t示s词c' +
    '工g作z流l配p置z设s保b存c取x消q确q认r删s除c添t加j启q停t展z开k收s起q更g多d没m有y名m称c码m' +
    '户h权q限x角j色s群q组z频p道d白b黑h单d通t知z警j告g错c误w日r志z监j控k统t计j表b快k照z版b本b' +
    '修x复f升s级j回h滚g导d入r分f标b签q理l端d点d请q响x应y负f载z均j衡h跳t转z缓h存c异y步b同t' +
    '锁s池c连l接j断d开k失s败b成s功g忽h略l强q制z手s动d自z默m认r佳j推t荐j可k维w护h';

const PINYIN_INITIALS: Record<string, string> = {};
for (let i = 0; i < PINYIN_DATA.length; i += 2) {
    PINYIN_INITIALS[PINYIN_DATA[i]] = PINYIN_DATA[i + 1];
}

const KEEP_CHAR = /[a-z0-9\u4e00-\u9fff]/;
const IS_LOWER = /[a-z]/;
const IS_DIGIT = /[0-9]/;
const IS_CJK = /[\u4e00-\u9fff]/;

/** compact 形态：lowercase 后仅保留字母/数字/CJK（忽略 - _ . : / 空格等一切分隔符）。 */
export function compactString(raw: string): string {
    let out = '';
    for (const ch of String(raw || '')) {
        const lower = ch.toLowerCase();
        if (KEEP_CHAR.test(lower)) out += lower;
    }
    return out;
}

type CharType = 'lower' | 'upper' | 'digit' | 'cjk' | 'sep' | 'none';

function classify(ch: string): CharType {
    if (IS_LOWER.test(ch)) return 'lower';
    if (IS_DIGIT.test(ch)) return 'digit';
    if (IS_CJK.test(ch)) return 'cjk';
    const upper = ch.toLowerCase();
    if (upper !== ch && IS_LOWER.test(upper)) return 'upper';
    return 'sep';
}

/** 分词首字母：分隔符切词 + camelCase 边界 + CJK 逐字。返回 initials 与 raw 下标映射。 */
function computeInitials(raw: string): { initials: string; initialMap: number[] } {
    const chars = Array.from(String(raw || ''));
    const initials: string[] = [];
    const initialMap: number[] = [];
    let prev: CharType = 'none';
    for (let i = 0; i < chars.length; i++) {
        const type = classify(chars[i]);
        if (type === 'sep') { prev = 'sep'; continue; }
        const nextType = i + 1 < chars.length ? classify(chars[i + 1]) : 'none';
        const isTokenStart =
            prev === 'none' || prev === 'sep' || type === 'cjk' ||
            // camelCase：小写/数字后遇到大写（deepSeek → deep | Seek）
            (type === 'upper' && (prev === 'lower' || prev === 'digit')) ||
            // 缩写词收尾：大写后跟大写+小写（MOSSImage → MOSS | Image）
            (type === 'upper' && prev === 'upper' && nextType === 'lower');
        if (isTokenStart) {
            const initial = type === 'cjk' ? (PINYIN_INITIALS[chars[i]] ?? '') : chars[i].toLowerCase();
            if (initial) { initials.push(initial); initialMap.push(i); }
        }
        prev = type;
    }
    return { initials: initials.join(''), initialMap };
}

function buildEntryFields(text: string): Pick<IndexedEntry<unknown>, 'lower' | 'compact' | 'compactMap' | 'initials' | 'initialMap'> {
    const raw = String(text || '');
    const chars = Array.from(raw);
    let compact = '';
    const compactMap: number[] = [];
    chars.forEach((ch, i) => {
        const lower = ch.toLowerCase();
        if (KEEP_CHAR.test(lower)) { compact += lower; compactMap.push(i); }
    });
    const { initials, initialMap } = computeInitials(raw);
    return { lower: raw.toLowerCase(), compact, compactMap, initials, initialMap };
}

/**
 * 预建索引。items 与 textOf 由调用方给（AppSelect 传选项数组，节点展开传模型名数组）。
 * 索引随 items 数组重建（computed 缓存），按键期间不会重跑这里。
 */
export function buildSearchIndex<T>(items: T[], textOf: (item: T) => SearchCandidate): IndexedEntry<T>[] {
    return items.map(item => {
        const { raw, alias } = textOf(item);
        const base = buildEntryFields(raw);
        const aliasLower = String(alias || '').toLowerCase();
        const aliasInitials = alias ? computeInitials(alias).initials : '';
        return { item, ...base, aliasLower, aliasInitials };
    });
}

/** 贪心左到右子序列匹配；命中返回每个 query 字符在 target 里的下标，否则 null。 */
function matchSubsequence(query: string, target: string): number[] | null {
    if (!query) return [];
    const positions: number[] = [];
    let from = 0;
    for (const ch of query) {
        const found = target.indexOf(ch, from);
        if (found === -1) return null;
        positions.push(found);
        from = found + 1;
    }
    return positions;
}

/** 把 compact 坐标区间映射回 raw 字符下标区间。 */
function mapRange(map: number[], from: number, length: number): Array<[number, number]> {
    const ranges: Array<[number, number]> = [];
    for (let i = from; i < from + length && i < map.length; i++) ranges.push([map[i], map[i] + 1]);
    return ranges;
}

/**
 * 匹配 + 排序。空查询返回全部（无高亮、原始顺序）。
 * 命中优先级：前缀(4) > 连续子串(3) > 词首/拼音首字母(2) > 分散子序列(1)。
 */
export function searchIndexed<T>(index: IndexedEntry<T>[], query: string): SearchHit<T>[] {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return index.map(entry => ({ item: entry.item, tier: 4, matchIndex: 0, ranges: [] }));
    const qc = compactString(q);

    const hits: Array<SearchHit<T> & { _order: number; _length: number }> = [];
    index.forEach((entry, order) => {
        let tier = 0;
        let matchIndex = 0;
        let ranges: Array<[number, number]> = [];

        if (entry.lower.startsWith(q)) {
            tier = 4; ranges = [[0, Array.from(q).length]];
        } else if (qc && entry.compact.startsWith(qc)) {
            tier = 4; ranges = mapRange(entry.compactMap, 0, Array.from(qc).length);
        } else if (entry.aliasLower.startsWith(q)) {
            tier = 4;
        } else if (entry.lower.includes(q)) {
            const at = entry.lower.indexOf(q);
            tier = 3; matchIndex = at; ranges = [[at, at + Array.from(q).length]];
        } else if (qc && entry.compact.includes(qc)) {
            const at = entry.compact.indexOf(qc);
            tier = 3; matchIndex = entry.compactMap[at] ?? at; ranges = mapRange(entry.compactMap, at, Array.from(qc).length);
        } else if (entry.aliasLower.includes(q)) {
            tier = 3; matchIndex = entry.aliasLower.indexOf(q);
        } else if (qc && entry.initials.startsWith(qc)) {
            tier = 2; ranges = mapRange(entry.initialMap, 0, Array.from(qc).length);
        } else if (qc && entry.aliasInitials.startsWith(qc)) {
            tier = 2;
        } else if (qc) {
            const positions = matchSubsequence(qc, entry.compact);
            if (positions) {
                tier = 1; matchIndex = entry.compactMap[positions[0]] ?? positions[0];
                ranges = positions.map(p => [entry.compactMap[p], entry.compactMap[p] + 1] as [number, number]);
            } else {
                const initialPositions = matchSubsequence(qc, entry.initials);
                if (initialPositions) {
                    tier = 1; matchIndex = entry.initialMap[initialPositions[0]] ?? initialPositions[0];
                    ranges = initialPositions.map(p => [entry.initialMap[p], entry.initialMap[p] + 1] as [number, number]);
                } else if (matchSubsequence(qc, entry.aliasInitials)) {
                    tier = 1;
                }
            }
        }
        if (tier) hits.push({ item: entry.item, tier, matchIndex, ranges, _order: order, _length: entry.compact.length });
    });

    hits.sort((a, b) =>
        b.tier - a.tier ||
        a.matchIndex - b.matchIndex ||
        a._length - b._length ||
        a._order - b._order);
    return hits;
}
