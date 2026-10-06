/**
 * 分析真实笔记数据，看清这个工具实际是怎么被使用的。
 *
 * 用途：v2.3.0 的三个改动方向就是它算出来的（40.5% 标题重复、14.5 小时/天覆盖、
 * 1133 条 = 24,812 个 DOM 节点）。立项做"本地统计"时，聚合逻辑也可以从这里长出来。
 *
 * 只读，不修改任何数据。用法：
 *   node scripts/analyze-usage.mjs                          # 桌面端数据目录
 *   node scripts/analyze-usage.mjs ./data                   # 指定目录（网页端）
 */
import fs from 'node:fs';
import path from 'node:path';

const dataDir = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.join(process.env.APPDATA, 'rfnoter', 'data');
const file = fs.readdirSync(dataDir).find((f) => f.startsWith('notes_') && f.endsWith('.json'));
if (!file) {
    console.error(`没有在 ${dataDir} 找到 notes_*.json`);
    process.exit(1);
}
const notes = JSON.parse(fs.readFileSync(path.join(dataDir, file), 'utf8'));

const mins = (hhmm) => {
    const [h, m] = String(hhmm).split(':').map(Number);
    return h * 60 + m;
};
const dur = (n) => {
    const s = mins(n.timeStart), e = mins(n.timeEnd);
    return e >= s ? e - s : e + 1440 - s;
};

// --- 基本盘 ---
const dates = [...new Set(notes.map((n) => n.date))].sort();
const realDays = (new Date(dates.at(-1)) - new Date(dates[0])) / 86400000 + 1;
const byDate = new Map();
for (const n of notes) {
    if (!byDate.has(n.date)) byDate.set(n.date, []);
    byDate.get(n.date).push(n);
}

// --- 内容复制度（决定"常用条目"值不值） ---
const contentCount = new Map();
for (const n of notes) contentCount.set(n.content, (contentCount.get(n.content) || 0) + 1);
const distinct = contentCount.size;
const repeated = [...contentCount.entries()].filter(([, c]) => c >= 5).sort((a, b) => b[1] - a[1]);

// --- 标签 ---
const tagCount = new Map();
for (const n of notes) if (n.tag) tagCount.set(n.tag, (tagCount.get(n.tag) || 0) + 1);

// --- 颜色 ---
const colorCount = new Map();
for (const n of notes) colorCount.set(n.color || '(空)', (colorCount.get(n.color || '(空)') || 0) + 1);

// --- 详情 / AI ---
const withDetails = notes.filter((n) => n.details && n.details.trim());
const aiNotes = notes.filter((n) => n.tag === 'AI总结');
const detailLens = withDetails.map((n) => n.details.length);

// --- 时长 ---
const durations = notes.map(dur);
const avgDur = durations.reduce((a, b) => a + b, 0) / durations.length;

// --- 每天覆盖时长 ---
const cover = [...byDate.entries()].map(([d, list]) => ({
    date: d,
    count: list.length,
    minutes: list.reduce((s, n) => s + dur(n), 0)
}));
const avgCover = cover.reduce((s, c) => s + c.minutes, 0) / cover.length;

// --- 记录行为：createdAt 与笔记时间的关系（判断"实时记"还是"事后补"） ---
let realtime = 0, backfill = 0, unknown = 0;
for (const n of notes) {
    const created = new Date(n.createdAt);
    const cDate = `${created.getFullYear()}-${String(created.getMonth() + 1).padStart(2, '0')}-${String(created.getDate()).padStart(2, '0')}`;
    if (!n.createdAt) { unknown++; continue; }
    if (cDate === n.date) realtime++;
    else backfill++;
}

// --- 编辑行为 ---
const edited = notes.filter((n) => n.updatedAt && n.createdAt && n.updatedAt - n.createdAt > 60000);
const expanded = notes.filter((n) => n.expanded === true);

// --- 内容长度 ---
const contentLens = notes.map((n) => [...n.content].length);
const avgLen = contentLens.reduce((a, b) => a + b, 0) / contentLens.length;
const longTitles = notes.filter((n) => [...n.content].length > 12);

// --- 跨天与异常 ---
const crossDay = notes.filter((n) => mins(n.timeEnd) < mins(n.timeStart));
const zeroDur = notes.filter((n) => dur(n) === 0);
const hugeGapDays = (() => {
    const gaps = [];
    for (let i = 1; i < dates.length; i++) {
        const d = (new Date(dates[i]) - new Date(dates[i - 1])) / 86400000;
        if (d > 1) gaps.push({ after: dates[i - 1], before: dates[i], days: d - 1 });
    }
    return gaps;
})();

// --- 记录时段分布（几点在记） ---
const hourHist = new Array(24).fill(0);
for (const n of notes) hourHist[Math.floor(mins(n.timeStart) / 60)]++;

const pct = (a, b) => `${((a / b) * 100).toFixed(1)}%`;

console.log(JSON.stringify({
    总量: {
        笔记条数: notes.length,
        自然天数: realDays,
        有记录的天数: dates.length,
        区间: `${dates[0]} ~ ${dates.at(-1)}`,
        平均每天条数: +(notes.length / realDays).toFixed(1)
    },
    内容: {
        不同标题数: distinct,
        标题复用率: pct(notes.length - distinct, notes.length),
        平均标题字数: +avgLen.toFixed(1),
        超过12字的标题: `${longTitles.length} (${pct(longTitles.length, notes.length)})`,
        高频标题Top20: repeated.slice(0, 20).map(([t, c]) => `${t}×${c}`)
    },
    分类: {
        用过标签的笔记: `${[...tagCount.values()].reduce((a, b) => a + b, 0)} (${pct([...tagCount.values()].reduce((a, b) => a + b, 0), notes.length)})`,
        不同标签数: tagCount.size,
        标签Top10: [...tagCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([t, c]) => `${t}×${c}`),
        颜色分布: Object.fromEntries([...colorCount.entries()].sort((a, b) => b[1] - a[1]))
    },
    详情与AI: {
        有详情的笔记: `${withDetails.length} (${pct(withDetails.length, notes.length)})`,
        详情平均字数: detailLens.length ? Math.round(detailLens.reduce((a, b) => a + b, 0) / detailLens.length) : 0,
        AI总结笔记: aiNotes.length,
        AI使用频率: `${(aiNotes.length / (realDays / 7)).toFixed(2)} 次/周`
    },
    时间: {
        平均每条时长: `${avgDur.toFixed(0)} 分钟`,
        平均每天覆盖: `${(avgCover / 60).toFixed(1)} 小时`,
        覆盖最长的一天: cover.slice().sort((a, b) => b.minutes - a.minutes)[0],
        覆盖最短的一天: cover.slice().sort((a, b) => a.minutes - b.minutes)[0],
        跨天笔记: crossDay.length,
        零时长笔记: zeroDur.length,
        按起始小时分布: hourHist.map((c, h) => `${String(h).padStart(2, '0')}时:${c}`).filter((s) => !s.endsWith(':0'))
    },
    行为: {
        当天记录的: `${realtime} (${pct(realtime, notes.length)})`,
        补记往日: backfill,
        创建后编辑过: `${edited.length} (${pct(edited.length, notes.length)})`,
        处于展开状态: expanded.length,
        断档: hugeGapDays.length ? hugeGapDays : '无（每天都在记）'
    }
}, null, 2));
