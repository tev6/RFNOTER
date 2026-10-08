/**
 * 统计：把一堆时间日志算成"时间花在哪"。
 *
 * 全部是纯函数（只依赖 utils），所以能脱离浏览器直接单测——
 * 而且这套聚合逻辑本来就应该能被单独验证，界面上只是把它画出来。
 *
 * ## 为什么不能直接按标题分组
 *
 * 真实数据（1134 条）里有两个必须处理的问题：
 *
 * 1. **同时做多件事**：44% 的笔记用 `+` 表示"这段时间在同时做几件事"
 *    （`吃饭+B站`）。按整条时长归给一个标题会重复计数，所以要拆成段、按时长**均摊**。
 * 2. **细节差异把同一件事拆开**：`30图小河道表水` 和 `30图小河道` 是同一件事。
 *    所以拆段之后还要做**相似归并**，把这类归到一组，明细可展开。
 *
 * ## 一个从数据里发现的坑
 *
 * 中文逗号（`，`）**不是**"同时做"的意思，而是顺叙描述：
 * `出门，上花生课，回家` 是**一件事**（一趟出门），拆成三段就错了。
 * 所以分隔符只收 `+ ＋ 、 / &`，逗号不收。
 */
import { parseClockMinutes } from './utils.js';

/** 视为"同时做多件事"的分隔符。逗号不在此列，见文件头注释。 */
const ACTIVITY_SEPARATORS = /[+＋、/&＆|]+/;

/** 时间范围。 */
export const RANGES = [
    { key: 'today', label: '今天' },
    { key: 'week', label: '本周' },
    { key: 'month', label: '本月' },
    { key: 'all', label: '全部' }
];

/** 归并时的相似度门槛：到这个程度就认为说的是同一件事。 */
const SIMILARITY_THRESHOLD = 0.75;
/** 参与归并的最短长度：太短的（如 cs）包含关系没有意义。 */
const MIN_CLUSTER_LENGTH = 3;
/**
 * 包含关系里，短的那个至少要占到长的这个比例才算"同一件事"。
 *
 * 没有这条会把 `终末地`（3 字）和 `出门和亲戚吃饭，回家，上花生课，坐地铁，路上终末地`
 * （19 字）并到一起——后者只是顺带提了一句终末地，主体是一趟出门。
 */
const MIN_COVERAGE = 0.5;
/** 只对时长靠前的这些条目做归并：长尾都是一次性的，归并没有收益，还会拖慢。 */
const CLUSTER_LIMIT = 120;

/* ------------------------------------------------------------------ */
/* 归一化与拆段                                                        */
/* ------------------------------------------------------------------ */

/**
 * 归一化，用于**分组比较**。
 *
 * 只转换全角**字母数字**（`Ａ`→`A`），不碰全角标点：
 * 中文逗号 `，`、顿号 `、` 是用户原文的一部分，转成半角会让统计里显示的标题
 * 和笔记里写的不一样（`出门，上花生课，回家` → `出门,上花生课,回家`）。
 */
export function normalizeText(raw) {
    return String(raw ?? '')
        .replace(/[\uFF10-\uFF19\uFF21-\uFF3A\uFF41-\uFF5A]/g,
            (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
        .replace(/\u3000/g, ' ')
        .toLowerCase()
        .trim()
        .replace(/\s+/g, ' ');
}

/**
 * 把一个标题拆成若干"活动"。按分隔符拆、去掉空段、排序。
 * 排序是为了让 `吃饭+B站` 和 `B站+吃饭` 落到同一个键上。
 */
export function splitActivities(raw) {
    return normalizeText(raw)
        .split(ACTIVITY_SEPARATORS)
        .map((part) => part.trim())
        .filter(Boolean)
        .sort();
}

/** 归一化后的完整标题（多段按排序后的顺序拼回去）。 */
export function canonicalTitle(raw) {
    return splitActivities(raw).join('+');
}

/**
 * 按**原始书写顺序**拆出活动（不做排序）。
 * 给"这条多段笔记要查哪一段的历史"用——用户看到的顺序是什么，选项就该是什么顺序。
 */
export function activitiesInOrder(raw) {
    return normalizeText(raw)
        .split(ACTIVITY_SEPARATORS)
        .map((part) => part.trim())
        .filter(Boolean);
}

/**
 * 按**原始书写顺序**拆出活动，且**保留用户的原始写法**（不动大小写与全角）。
 *
 * 与 activitiesInOrder 共用同一个分隔符定义，所以拆法完全一致；差别只在这个
 * 不归一化。补全功能需要它：归一化会小写化，若拿归一化后的段去填输入框，
 * 用户写的 `CSGO` 会被悄悄改成 `csgo`——他记的是自己的账，用词不该被工具改掉。
 */
export function activitiesRaw(raw) {
    return String(raw ?? '')
        .split(ACTIVITY_SEPARATORS)
        .map((part) => part.trim())
        .filter(Boolean);
}

/** 一条笔记的时长（分钟），跨天按绕圈算。 */
export function noteDurationMinutes(note) {
    const start = parseClockMinutes(note?.timeStart);
    const end = parseClockMinutes(note?.timeEnd);
    if (start === null || end === null) return 0;
    return end >= start ? end - start : end + 1440 - start;
}

/* ------------------------------------------------------------------ */
/* 相似度与归并                                                        */
/* ------------------------------------------------------------------ */

/** 编辑距离（两行滚动数组，标题都很短，够用）。 */
function editDistance(a, b) {
    if (a === b) return 0;
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i += 1) {
        const curr = [i];
        for (let j = 1; j <= b.length; j += 1) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
        }
        prev = curr;
    }
    return prev[b.length];
}

/** 0~1 的相似度，1 表示完全一样。 */
export function similarity(a, b) {
    if (!a && !b) return 1;
    if (!a || !b) return 0;
    if (a === b) return 1;
    const longest = Math.max(a.length, b.length);
    return 1 - editDistance(a, b) / longest;
}

/** 两个活动名是否应当视为同一件事。 */
export function isSameActivity(a, b) {
    if (a === b) return true;
    const short = a.length <= b.length ? a : b;
    const long = a.length <= b.length ? b : a;
    // 包含关系：`30图小河道` 与 `30图小河道表水`。
    // 要求短的占长的一半以上，否则"顺带提到"的长句会被并进来
    if (short.length >= MIN_CLUSTER_LENGTH && long.includes(short)) {
        return short.length / long.length >= MIN_COVERAGE;
    }
    return similarity(a, b) >= SIMILARITY_THRESHOLD;
}

/**
 * 把条目按"同一件事"聚成簇。
 *
 * 用的是**贪心归类，而不是两两合并的并查集**。
 * 并查集会做传递闭包，于是连成串：真实数据里出现过
 * `终末地` ← `…路上终末地` ← `b站，吃饭，终末地，看番` ← `b站，吃饭`，
 * 最后把毫不相干的「b站，吃饭」并进了「终末地」，比不归并还糟。
 * 这里只和已有簇的**组名**比较，不会有链式效应。
 *
 * @param {Array<{label:string, minutes:number, count:number}>} entries
 * @returns {Array<{label:string, minutes:number, count:number, members:Array}>}
 */
export function clusterActivities(entries) {
    const list = [...entries].sort((a, b) => b.minutes - a.minutes);
    const head = list.slice(0, CLUSTER_LIMIT);
    const tail = list.slice(CLUSTER_LIMIT);

    const clusters = [];
    for (const entry of head) {
        // 按分钟倒序遍历，所以第一个进簇的自然就是组名（时长最高的写法）
        const target = clusters.find((cluster) => isSameActivity(cluster.label, entry.label));
        if (target) target.members.push(entry);
        else clusters.push({ label: entry.label, members: [entry] });
    }

    const result = clusters.map((cluster) => ({
        label: cluster.label,
        minutes: cluster.members.reduce((sum, m) => sum + m.minutes, 0),
        count: cluster.members.reduce((sum, m) => sum + m.count, 0),
        members: [...cluster.members].sort((a, b) => b.minutes - a.minutes)
    }));
    // 长尾原样带上，不参与归并
    for (const entry of tail) {
        result.push({ label: entry.label, minutes: entry.minutes, count: entry.count, members: [entry] });
    }
    return result.sort((a, b) => b.minutes - a.minutes);
}

/* ------------------------------------------------------------------ */
/* 聚合                                                                */
/* ------------------------------------------------------------------ */

export const ALLOCATION = {
    /** 多段按段数均摊（默认）：总时长守恒，不会重复计数。 */
    SPLIT: 'split',
    /** 每段各计全额：能看出"这件事出现过多久"，但总和会大于实际时间。 */
    FULL: 'full'
};

/**
 * 时长排行。
 *
 * @param {Array} notes
 * @param {{allocation?: string, limit?: number}} options
 * @returns {Array<{label, minutes, count, members}>} 已按归并后的时长倒序
 */
export function rankActivities(notes, { allocation = ALLOCATION.SPLIT, limit = 60 } = {}) {
    const bucket = new Map();

    for (const note of notes) {
        const activities = splitActivities(note.content);
        if (activities.length === 0) continue;
        const minutes = noteDurationMinutes(note);
        const share = allocation === ALLOCATION.FULL ? minutes : minutes / activities.length;
        for (const label of activities) {
            const entry = bucket.get(label) || { label, minutes: 0, count: 0, noteIds: new Set() };
            entry.minutes += share;
            // 同一条笔记里重复出现的活动只算一次（`cs+CS` 这种）
            if (!entry.noteIds.has(note.id)) {
                entry.count += 1;
                entry.noteIds.add(note.id);
            }
            bucket.set(label, entry);
        }
    }

    const entries = [...bucket.values()].map((entry) => ({
        label: entry.label,
        minutes: entry.minutes,
        count: entry.count
    }));
    const clusters = clusterActivities(entries);
    return clusters.slice(0, limit).map(({ members, ...rest }) => ({
        ...rest,
        // 只有把多个写法并到一起时才值得展开明细；没归并过就不带这个字段的噪音
        members: members.length > 1 ? members : []
    }));
}

/** 按小时（用开始时间）统计记录时长与条数。 */
export function hourHistogram(notes) {
    const buckets = Array.from({ length: 24 }, (_, hour) => ({ hour, minutes: 0, count: 0 }));
    for (const note of notes) {
        const start = parseClockMinutes(note.timeStart);
        if (start === null) continue;
        const hour = Math.floor(start / 60) % 24;
        buckets[hour].minutes += noteDurationMinutes(note);
        buckets[hour].count += 1;
    }
    return buckets;
}

/** 每天的记录时长与条数，返回 Map（date -> {minutes, count}）。 */
export function dailyBuckets(notes) {
    const byDate = new Map();
    for (const note of notes) {
        const key = note.date;
        if (!key) continue;
        const entry = byDate.get(key) || { date: key, minutes: 0, count: 0 };
        entry.minutes += noteDurationMinutes(note);
        entry.count += 1;
        byDate.set(key, entry);
    }
    return byDate;
}

/**
 * 某一天的时间轴块。
 * 跨天的记录（结束早于开始）会被截断到当日 24:00，并标记 crossDay。
 */
export function timelineBlocks(notes, date) {
    return notes
        .filter((note) => note.date === date)
        .map((note) => {
            const start = parseClockMinutes(note.timeStart) ?? 0;
            const rawEnd = parseClockMinutes(note.timeEnd) ?? start;
            const crossDay = rawEnd < start;
            const end = crossDay ? 1440 : rawEnd;
            return {
                id: note.id,
                content: note.content,
                start,
                end,
                startClock: note.timeStart,
                endClock: note.timeEnd,
                minutes: end - start,
                crossDay
            };
        })
        .sort((a, b) => a.start - b.start);
}

/** 概览数字。 */
export function overview(notes) {
    const byDate = dailyBuckets(notes);
    const dates = [...byDate.keys()].sort();
    const minutes = [...byDate.values()].reduce((sum, day) => sum + day.minutes, 0);
    return {
        count: notes.length,
        minutes,
        days: dates.length,
        firstDate: dates[0] || null,
        lastDate: dates[dates.length - 1] || null,
        avgPerDay: dates.length ? minutes / dates.length : 0,
        avgPerNote: notes.length ? minutes / notes.length : 0
    };
}

/* ------------------------------------------------------------------ */
/* 时间范围                                                            */
/* ------------------------------------------------------------------ */

function dateKey(date) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 按范围过滤笔记。范围边界以本地时间的自然日为准。 */
export function filterByRange(notes, range, now = new Date()) {
    if (range === 'all' || !range) return notes;

    if (range === 'today') {
        const today = dateKey(now);
        return notes.filter((note) => note.date === today);
    }

    let from;
    if (range === 'week') {
        // 周一为一周的开始
        const day = now.getDay() === 0 ? 7 : now.getDay();
        from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (day - 1));
    } else if (range === 'month') {
        from = new Date(now.getFullYear(), now.getMonth(), 1);
    } else {
        return notes;
    }

    const fromKey = dateKey(from);
    const toKey = dateKey(now);
    return notes.filter((note) => note.date >= fromKey && note.date <= toKey);
}

/** 一年热力图需要的日期序列（含今天，共 days 天）。 */
export function heatmapDays(notes, { days = 365, now = new Date() } = {}) {
    const byDate = dailyBuckets(notes);
    const result = [];
    for (let offset = days - 1; offset >= 0; offset -= 1) {
        const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset);
        const key = dateKey(date);
        const entry = byDate.get(key) || { minutes: 0, count: 0 };
        result.push({ date: key, minutes: entry.minutes, count: entry.count, weekday: date.getDay() });
    }
    return result;
}

/** 把分钟数变成"X小时Y分钟"这种给人看的短文本。 */
export function formatMinutes(minutes) {
    const value = Math.round(minutes || 0);
    if (value < 60) return `${value}分钟`;
    const hours = Math.floor(value / 60);
    const rest = value % 60;
    return rest === 0 ? `${hours}小时` : `${hours}小时${rest}分钟`;
}

/**
 * 一件事的历史：把包含这个活动的笔记全找出来，按时间从新到旧排。
 *
 * 匹配规则和统计排行**完全一致**（归一化 + 相似归并），所以点
 * 「30图小河道表水」也能看到当初写成「30图小河道」的那几次——
 * 否则这个功能只是在说"你写的一模一样的标题有哪些"，没什么用。
 *
 * @param {Array} notes
 * @param {string} label 活动名（统计排行里显示的组名）
 * @param {{limit?: number}} options
 */
export function activityHistory(notes, label, { limit = 300 } = {}) {
    const target = normalizeText(label);
    if (!target) {
        return { label: '', count: 0, minutes: 0, days: 0, records: [], variants: [] };
    }

    const records = [];
    const variants = new Map();

    for (const note of notes) {
        const activities = splitActivities(note.content);
        if (activities.length === 0) continue;
        const hit = activities.find((activity) => isSameActivity(activity, target));
        if (!hit) continue;

        const full = noteDurationMinutes(note);
        // 多段笔记（`B站+吃饭`）按段数均摊，和排行口径保持一致，
        // 否则同一个活动在两处显示的时长会互相矛盾
        const share = full / activities.length;

        const variant = variants.get(hit) || { label: hit, count: 0, minutes: 0 };
        variant.count += 1;
        variant.minutes += share;
        variants.set(hit, variant);

        records.push({
            id: note.id,
            date: note.date,
            timeStart: note.timeStart,
            timeEnd: note.timeEnd,
            content: note.content,
            matched: hit,
            minutes: share,
            fullMinutes: full,
            segments: activities.length,
            tag: note.tag || ''
        });
    }

    // 新 → 旧；同一天按开始时间倒序
    records.sort((a, b) => {
        if (a.date !== b.date) return a.date < b.date ? 1 : -1;
        return a.timeStart < b.timeStart ? 1 : -1;
    });

    const minutes = records.reduce((sum, record) => sum + record.minutes, 0);
    const dates = [...new Set(records.map((record) => record.date))].sort();
    return {
        label,
        count: records.length,
        minutes,
        days: dates.length,
        avgMinutes: records.length ? minutes / records.length : 0,
        firstDate: dates[0] || null,
        lastDate: dates[dates.length - 1] || null,
        variants: [...variants.values()].sort((a, b) => b.minutes - a.minutes),
        records: records.slice(0, limit)
    };
}
