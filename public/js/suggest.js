/**
 * 输入补全：把"以前写过什么"变成"这次少打几个字"。
 *
 * 全部是纯函数（只依赖 stats.js 的拆分口径），所以能脱离浏览器直接单测。
 *
 * ## 为什么单独一个模块
 *
 * 界面上原本只有一个「常用条目」chips 区（app.js 的 computeQuickPicks），
 * 它按**整条标题**聚合。但真实数据里 36% 的笔记是 `CS+终末地+B站` 这种
 * 合并写法（1151 条里 415 条含 `+`），于是 `CS`（出现在 147 条里）会被
 * `CS+B站`、`CS+终末地` 这些组合稀释成好几个低频项，真正高频的 `CS`
 * 反而进不了 chips。
 *
 * 这里改成**按活动段聚合**：先把每条笔记拆成段，再统计每段。
 * 拆段直接复用 stats.js 的 activitiesInOrder，好处是——
 *
 * > 补全给出的词，和统计面板里"时间花在哪"的条目，永远是同一套切法。
 *
 * 否则会出现「补全提示 `30图小河道表水`、统计里却叫 `30图小河道`」这种
 * 自相矛盾的情况，用户会开始不信任两个界面。
 *
 * ## 打分：为什么不是纯粹的词频
 *
 * 纯词频会让三个月前的旧习惯长期占满前几位。用户是**天天记**的人
 * （中位数 13 条/天），"最近在做什么"比"历史上做过什么"重要得多，
 * 所以最近用过的要有额外加权，且加权要能盖过靠堆次数上来的旧词。
 */

import { activitiesRaw, normalizeText } from './stats.js';

/** 补全池的最小出现次数：只写过一次的，不值得占提示位。 */
const MIN_SUGGEST_COUNT = 2;

/** 最近用的加权窗口（7 天）与权重。 */
const RECENT_WINDOW_MS = 7 * 86400000;
const RECENT_BONUS = 3;

/** 单次最多返回多少条候选。 */
const DEFAULT_LIMIT = 8;

/**
 * 把历史笔记聚合成"活动段"词表。
 *
 * @param {Array} notes 全部笔记
 * @returns {Array<{label:string, count:number, lastUsedAt:number}>}
 *          按 label 去重后的词表（未排序、未截断），供 searchSuggestions 复用。
 */
export function buildVocabulary(notes) {
    const stats = new Map();

    for (const note of notes) {
        if (!note) continue;
        // 用 activitiesRaw 而不是 activitiesInOrder：后者会先归一化，
        // 原始大小写/全角在全角转换与小写化中已经丢了，`CSGO` 会被还原成 `csgo`。
        // 两者共用同一个分隔符定义，所以拆法一致，只是这个保留原文。
        const activities = activitiesRaw(note.content);
        if (activities.length === 0) continue;
        const usedAt = Number(note.createdAt) || 0;

        // 同一条笔记里重复出现的段（`cs+CS`）只算一次，否则自己刷自己的词频
        const seen = new Set();
        for (const raw of activities) {
            // 归一化后作为**去重键**：`ＰＳ` 与 `PS`、`csgo` 与 `CSGO` 是同一个词，
            // 不该各占一个提示位。
            const key = normalizeText(raw).trim();
            if (!key) continue;
            if (seen.has(key)) continue;
            seen.add(key);

            const shown = shownFormOf(raw);
            const entry = stats.get(key) || { label: shown, count: 0, lastUsedAt: 0, forms: new Map() };
            entry.count += 1;
            entry.lastUsedAt = Math.max(entry.lastUsedAt, usedAt);

            // 但**展示与填充用原始写法**。归一化是小写化的，若直接拿键当标签，
            // 用户写的 `CSGO` 会被补全强行改成 `csgo`——他记的是自己的账，
            // 不该被工具改掉用词。同一组里挑出现最多的那种写法。
            const forms = entry.forms;
            forms.set(shown, (forms.get(shown) || 0) + 1);
            let best = entry.label;
            let bestCount = -1;
            for (const [form, n] of forms) {
                // 次数相同则取更长的那个：`CSGO` 比 `csgo` 更可能是用户的本意写法
                if (n > bestCount || (n === bestCount && form.length > best.length)) {
                    best = form;
                    bestCount = n;
                }
            }
            entry.label = best;

            stats.set(key, entry);
        }
    }

    return [...stats.values()].map(({ forms, ...entry }) => entry);
}

/**
 * 展示用写法：去掉首尾空白，但**保留大小写**。
 * 归一化只用于比较，不用于显示。
 */
function shownFormOf(raw) {
    return String(raw ?? '').trim();
}

/** 词频 + 近期加权。频率为主，最近一周用过的额外加权。 */
function scoreOf(entry, now) {
    const recent = now - entry.lastUsedAt < RECENT_WINDOW_MS ? RECENT_BONUS : 0;
    return entry.count + recent;
}

/**
 * 取"最常用"的活动，用于 chips 区。
 *
 * @param {Array} notes
 * @param {{limit?:number}} options
 * @returns {Array<{label:string, count:number, lastUsedAt:number, score:number}>}
 */
export function topActivities(notes, { limit = DEFAULT_LIMIT } = {}) {
    const now = Date.now();
    return buildVocabulary(notes)
        .filter((entry) => entry.count >= MIN_SUGGEST_COUNT)
        .map((entry) => ({ ...entry, score: scoreOf(entry, now) }))
        .sort((a, b) => b.score - a.score || b.lastUsedAt - a.lastUsedAt)
        .slice(0, limit);
}

/**
 * 当前正在输入的那一段（光标所在的 `+` 分段）。
 *
 * 用户输入 `CS+终` 时，要补的是 `终` 开头的东西，而不是整串 `CS+终`。
 * 同时把"这一段的起点"也返回，界面替换时才知道要替换哪一截。
 *
 * @param {string} text 输入框当前全文
 * @returns {{index:number, fragment:string, prefix:string}} index 是段起点在 text 中的下标
 */
export function currentFragment(text) {
    const source = String(text ?? '');
    // 与 stats.js 的分隔符保持一致；这里要在原文上定位，所以不能用归一化后的串
    const matches = [...source.matchAll(/[+＋、/&＆|]+/g)];
    const last = matches[matches.length - 1];
    if (!last) return { index: 0, fragment: source, prefix: '' };
    const start = last.index + last[0].length;
    return { index: start, fragment: source.slice(start), prefix: source.slice(0, start) };
}

/**
 * 按当前输入给出候选。
 *
 * 匹配规则刻意宽松（子串即可），因为中文没有词边界，打 `河` 想找
 * `30图小河道` 是最自然的预期。排序上：前缀命中 > 子串命中，再比分数。
 *
 * @param {Array} notes 全部笔记
 * @param {string} text 输入框当前全文
 * @param {{limit?:number}} options
 * @returns {Array<{label:string, count:number, lastUsedAt:number, score:number, rest:string}>}
 *          rest 是补全出来后"还需要再打的部分"，界面用来做灰字预览。
 */
export function searchSuggestions(notes, text, { limit = DEFAULT_LIMIT } = {}) {
    const source = String(text ?? '');
    if (!source.trim()) return [];

    const { fragment } = currentFragment(source);
    const needle = normalizeText(fragment).trim().toLowerCase();

    // 刚打完分隔符（`CS+`）：这一段还是空的，此时该提示"接下来可能是什么"。
    //
    // 用**全库高频**而不是共现推荐：真实数据里共现信号太稀（只有 `吃饭→B站`
    // 强到 68%，`CS` 的共现仅 3%），按它排会时灵时不灵。高频词则是稳定信号
    // （B站 289 次、CS 161 次），且用户此刻的意图本来就是"再记一件常做的事"。
    if (!needle) {
        if (!/[+＋、/&＆|]/.test(source)) return [];   // 空输入交给 chips，不在这重复提示
        const used = new Set(activitiesRaw(source).map((s) => normalizeText(s)));
        return topActivities(notes, { limit: limit + used.size })
            .filter((entry) => !used.has(normalizeText(entry.label)))
            .slice(0, limit)
            .map((entry) => ({ ...entry, rank: 0, rest: '' }));
    }

    const now = Date.now();
    const candidates = [];

    for (const entry of buildVocabulary(notes)) {
        // 只写过一次的不进候选池：真实数据里"只出现 1 次"的长尾极多
        // （`Claude被封号`、错别字 `B占`……），它们会把真正想补的词挤下去。
        // 实测：打 `C` 时 `Claude被封号`(1 次) 曾排在第 3，压住了 `Coding`(5 次)。
        if (entry.count < MIN_SUGGEST_COUNT) continue;

        // 比较必须走归一化：label 保留的是用户原始写法（可能是全角 `ＰＳ`），
        // 直接 toLowerCase 会留下全角字符，永远匹配不上归一化后的 needle。
        const hay = normalizeText(entry.label).toLowerCase();
        // 仅当**原文**也已经一模一样时才跳过。不能用 hay === needle 判断：
        // 用户打半角 `ps`、词是 `ＰＳ` 时两者归一化后相等，但写法不同，
        // 仍然应当提示（选它就能统一成全角那个写法）。
        if (entry.label.toLowerCase() === fragment.trim().toLowerCase()) continue;

        let rank;
        if (hay.startsWith(needle)) rank = 0;          // 前缀命中：最想要
        else if (hay.includes(needle)) rank = 1;       // 中间命中：次之
        else continue;                                  // 不相干的直接丢

        candidates.push({
            ...entry,
            score: scoreOf(entry, now),
            rank,
            // 灰字预览要走同一个函数，否则界面上"差多少字"和实际填入的对不上
            rest: remainderOf(entry.label, source)
        });
    }

    return candidates
        .sort((a, b) => a.rank - b.rank || b.score - a.score || b.lastUsedAt - a.lastUsedAt)
        .slice(0, limit);
}

/**
 * 把选中的候选填回输入框，返回新的全文。
 *
 * 只替换**光标所在的段**，后面的内容原样保留：
 * `CS+终` 选 `终末地` → `CS+终末地`（而不是把 `CS+` 一起冲掉）。
 *
 * @param {string} text 输入框当前全文
 * @param {string} label 选中的活动
 * @returns {string} 新全文
 */
export function applySuggestion(text, label) {
    const source = String(text ?? '');
    const { index, fragment } = currentFragment(source);
    // 段尾可能还有用户已经打的内容（如 `终末地+CS`），要保留
    const rest = source.slice(index + fragment.length);
    return source.slice(0, index) + label + rest;
}

/**
 * 一段候选里，用于灰字提示的"还差什么"。
 * 全部候选都返回空串时界面就不画预览了。
 */
export function remainderOf(label, text) {
    const { fragment } = currentFragment(text);
    const trimmed = fragment.trim();
    if (!label || !trimmed) return '';
    const index = label.toLowerCase().indexOf(trimmed.toLowerCase());
    if (index === -1) return '';
    return label.slice(index + trimmed.length);
}
