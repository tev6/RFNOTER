/**
 * 统计面板的渲染。
 *
 * 只负责"把算好的数据画成 DOM"，不做任何聚合计算——那些都在 stats.js 里，
 * 可以脱离浏览器单测。这里接收 (container, data)，因此也不需要 init 注入，
 * 每次打开面板时拿到的是什么就画什么。
 */
import { escapeHTML } from './utils.js';
import { formatMinutes, RANGES, ALLOCATION } from './stats.js';

/** 一天有多少分钟，时间轴用它做百分比换算。 */
const DAY_MINUTES = 1440;

function bar(value, max, className = 'bg-primary') {
    const percent = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
    return `<div class="h-2 rounded-full ${className}" style="width:${percent}%"></div>`;
}

function statCard(label, value) {
    return `
        <div class="bg-gray-50 rounded-lg p-3">
            <div class="text-xs text-gray-500 mb-1">${escapeHTML(label)}</div>
            <div class="text-lg font-semibold text-gray-800">${escapeHTML(value)}</div>
        </div>`;
}

/** 顶部：范围与口径切换。 */
function renderToolbar(data) {
    const rangeButtons = RANGES.map((range) => {
        const active = range.key === data.range;
        return `<button type="button" data-stats-action="range" data-range="${range.key}"
            class="px-2.5 py-1 text-xs rounded-full transition-colors duration-150
                   ${active ? 'bg-primary text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}">
            ${escapeHTML(range.label)}</button>`;
    }).join('');

    const allocationButtons = [
        { key: ALLOCATION.SPLIT, label: '多段均摊', hint: '总时长守恒：一条 60 分钟的「吃饭+B站」记作各 30 分钟' },
        { key: ALLOCATION.FULL, label: '各计全额', hint: '每段都记整条时长，能看出"这件事出现过多久"，但总和会大于实际时间' }
    ].map((option) => {
        const active = option.key === data.allocation;
        return `<button type="button" data-stats-action="allocation" data-allocation="${option.key}"
            title="${escapeHTML(option.hint)}"
            class="px-2.5 py-1 text-xs rounded-full transition-colors duration-150
                   ${active ? 'bg-ai text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}">
            ${escapeHTML(option.label)}</button>`;
    }).join('');

    return `
        <div class="flex flex-wrap items-center gap-3 mb-4">
            <div class="flex items-center gap-1">${rangeButtons}</div>
            <div class="flex items-center gap-1 ml-auto">
                <span class="text-xs text-gray-400">同时做多件事时</span>
                ${allocationButtons}
            </div>
        </div>`;
}

/** 概览数字。 */
function renderOverview(data) {
    const info = data.overview;
    return `
        <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
            ${statCard('记录条数', `${info.count} 条`)}
            ${statCard('总时长', formatMinutes(info.minutes))}
            ${statCard('覆盖天数', `${info.days} 天`)}
            ${statCard('平均每天', formatMinutes(info.avgPerDay))}
        </div>`;
}

/** 时长排行。 */
function renderRanking(data) {
    const ranked = data.ranked;
    if (ranked.length === 0) {
        return '<p class="text-sm text-gray-500">这个范围里还没有记录。</p>';
    }
    const max = ranked[0].minutes;
    const rows = ranked.map((entry, index) => {
        const merged = entry.members.length > 1;
        const expanded = data.expanded.has(index);
        const toggle = merged
            ? `<button type="button" data-stats-action="toggle-members" data-index="${index}"
                    class="ml-2 text-xs text-primary hover:underline">
                    ${expanded ? '收起' : `含 ${entry.members.length} 种写法`}</button>`
            : '';
        const members = (merged && expanded)
            ? `<div class="mt-2 ml-1 pl-3 border-l-2 border-gray-200 space-y-1">
                    ${entry.members.map((m) => `
                        <div class="flex items-center gap-2 text-xs text-gray-500">
                            <span class="flex-1 truncate">${escapeHTML(m.label)}</span>
                            <span class="tabular-nums">${escapeHTML(formatMinutes(m.minutes))}</span>
                            <span class="tabular-nums w-12 text-right">${m.count} 次</span>
                        </div>`).join('')}
               </div>`
            : '';
        return `
            <div class="py-1.5" data-stats-row="${index}" data-label="${escapeHTML(entry.label)}">
                <div class="flex items-center gap-3 text-sm">
                    <span class="w-6 text-right text-xs text-gray-400 tabular-nums">${index + 1}</span>
                    <button type="button" data-stats-action="history" data-label="${escapeHTML(entry.label)}"
                        title="看这件事的历史：都在什么时候做的"
                        class="flex-1 truncate text-left text-gray-700 hover:text-primary hover:underline transition-colors duration-150">${escapeHTML(entry.label)}</button>${toggle}
                    <span class="w-24 text-right font-medium text-gray-800 tabular-nums">${escapeHTML(formatMinutes(entry.minutes))}</span>
                    <span class="w-14 text-right text-xs text-gray-400 tabular-nums">${entry.count} 次</span>
                </div>
                <div class="ml-9 mt-1 bg-gray-100 rounded-full">${bar(entry.minutes, max)}</div>
                ${members}
            </div>`;
    }).join('');

    return `
        <div>
            <div class="flex items-center justify-between mb-2">
                <h3 class="text-sm font-medium text-gray-700">时长排行</h3>
                <span class="text-xs text-gray-400">同名写法的归并结果会标注「含 N 种写法」，可展开看明细</span>
            </div>
            ${rows}
        </div>`;
}

/** 一天时间轴。 */
function renderTimeline(data) {
    const blocks = data.timeline.map((block) => {
        const left = (block.start / DAY_MINUTES) * 100;
        const width = Math.max(0.4, ((block.end - block.start) / DAY_MINUTES) * 100);
        const title = `${block.startClock} ~ ${block.endClock}（${formatMinutes(block.minutes)}）${block.content}`
            + (block.crossDay ? '（跨天，已截断到 24:00）' : '');
        return `<div class="absolute top-0 h-6 rounded-sm bg-primary/70 hover:bg-primary transition-colors duration-150"
                     style="left:${left}%;width:${width}%"
                     title="${escapeHTML(title)}"></div>`;
    }).join('');

    // 每 6 小时一个刻度
    const ticks = [0, 6, 12, 18, 24].map((hour) => `
        <div class="absolute top-6 h-1.5 border-l border-gray-300" style="left:${(hour / 24) * 100}%"></div>
        <div class="absolute top-8 text-[10px] text-gray-400 -translate-x-1/2" style="left:${(hour / 24) * 100}%">${hour}:00</div>
    `).join('');

    const coverage = data.timeline.reduce((sum, block) => sum + block.minutes, 0);
    return `
        <div>
            <div class="flex items-center justify-between mb-2">
                <h3 class="text-sm font-medium text-gray-700">一天时间轴</h3>
                <div class="flex items-center gap-2 text-xs text-gray-500">
                    <button type="button" data-stats-action="day-prev" class="hover:text-primary px-1">◀</button>
                    <span class="tabular-nums">${escapeHTML(data.timelineDate || '—')}</span>
                    <button type="button" data-stats-action="day-next" class="hover:text-primary px-1">▶</button>
                    <span class="text-gray-400">已记录 ${escapeHTML(formatMinutes(coverage))}</span>
                </div>
            </div>
            <div class="relative h-10">${blocks}${ticks}</div>
        </div>`;
}

/** 按小时的作息分布。 */
function renderHourly(data) {
    const max = Math.max(...data.hourly.map((bucket) => bucket.minutes), 1);
    const bars = data.hourly.map((bucket) => {
        const height = Math.max(2, Math.round((bucket.minutes / max) * 100));
        return `
            <div class="flex-1 h-full flex flex-col justify-end items-center" title="${bucket.hour} 点：${formatMinutes(bucket.minutes)}，${bucket.count} 条">
                <div data-hourly-bar class="w-full bg-ai/70 hover:bg-ai rounded-t transition-colors duration-150" style="height:${height}%"></div>
            </div>`;
    }).join('');
    const labels = data.hourly.map((bucket) => `<div class="flex-1 text-center text-[9px] text-gray-400">${bucket.hour % 6 === 0 ? bucket.hour : ''}</div>`).join('');
    return `
        <div>
            <h3 class="text-sm font-medium text-gray-700 mb-2">作息分布（按开始时间）</h3>
            <div class="flex items-end gap-0.5 h-24">${bars}</div>
            <div class="flex gap-0.5 mt-1">${labels}</div>
        </div>`;
}

/** 一年热力图。 */
function renderHeatmap(data) {
    const days = data.heatmap;
    if (days.length === 0) return '';
    const max = Math.max(...days.map((day) => day.minutes), 1);
    // 前面对齐到周日，这样每一列正好是一周
    const offset = days[0].weekday;
    const blanks = Array.from({ length: offset }, () => '<div class="w-2.5 h-2.5"></div>').join('');
    const cells = days.map((day) => {
        const ratio = day.minutes / max;
        // 深色下绿色要反过来排：底色是暗的，越"多"越亮才分得出层次
        // 暗色下 bg-gray-100 与弹窗底色 bg-surface 是同一个值，空格会整片消失，
        // 所以空格单独用 gray-200 压一半透明度：既和底色分得开，又不会让 365 个小方块
        // 在深夜整片发亮（浅色主题下 white 与 gray-100 本来也只差一点点）
        let level = 'bg-gray-100 dark:bg-gray-200/50';
        if (day.minutes > 0) {
            if (ratio > 0.75) level = 'bg-green-600 dark:bg-green-400';
            else if (ratio > 0.5) level = 'bg-green-500 dark:bg-green-500';
            else if (ratio > 0.25) level = 'bg-green-400 dark:bg-green-600';
            else level = 'bg-green-200 dark:bg-green-800';
        }
        const title = `${day.date}：${day.count} 条 / ${formatMinutes(day.minutes)}`;
        return `<div data-heatmap-cell class="w-2.5 h-2.5 rounded-sm ${level}" title="${escapeHTML(title)}"></div>`;
    }).join('');

    return `
        <div>
            <div class="flex items-center justify-between mb-2">
                <h3 class="text-sm font-medium text-gray-700">记录密度（最近 365 天）</h3>
                <div class="flex items-center gap-1 text-[10px] text-gray-400">
                    <span>少</span>
                    <div class="w-2.5 h-2.5 rounded-sm bg-gray-100 dark:bg-gray-200/50"></div>
                    <div class="w-2.5 h-2.5 rounded-sm bg-green-200 dark:bg-green-800"></div>
                    <div class="w-2.5 h-2.5 rounded-sm bg-green-400 dark:bg-green-600"></div>
                    <div class="w-2.5 h-2.5 rounded-sm bg-green-500 dark:bg-green-500"></div>
                    <div class="w-2.5 h-2.5 rounded-sm bg-green-600 dark:bg-green-400"></div>
                    <span>多</span>
                </div>
            </div>
            <div class="grid grid-flow-col grid-rows-7 gap-0.5 overflow-x-auto pb-1">${blanks}${cells}</div>
        </div>`;
}

/** 把整个面板画进 container。 */
export function renderStats(container, data) {
    if (!container) return;
    container.innerHTML = [
        renderToolbar(data),
        renderOverview(data),
        renderRanking(data),
        renderTimeline(data),
        renderHourly(data),
        renderHeatmap(data)
    ].join('<div class="border-t border-gray-100 my-5"></div>');
}

/** 把「一件事的历史」画进 container（A2）。 */
export function renderActivityHistory(container, data) {
    if (!container) return;
    if (!data || data.count === 0) {
        container.innerHTML = '<p class="text-sm text-gray-500">这件事还没有任何记录。</p>';
        return;
    }

    const summary = [
        statCard('出现次数', `${data.count} 次`),
        statCard('合计时长', formatMinutes(data.minutes)),
        statCard('平均每次', formatMinutes(data.avgMinutes)),
        statCard('跨越天数', `${data.days} 天`)
    ].join('');

    // 写法不同但被归并到一起的，要交代清楚，否则用户会以为「我没写过这个」
    const variants = data.variants.length > 1
        ? `<div class="mt-3 text-xs text-gray-500">
                统计里合并了 ${data.variants.length} 种写法：${data.variants.map((v) =>
                    `<span class="inline-block bg-gray-100 rounded px-1.5 py-0.5 mr-1">${escapeHTML(v.label)} · ${escapeHTML(formatMinutes(v.minutes))}</span>`
                ).join('')}
           </div>`
        : '';

    // 从「多段笔记」的卡片进来时要先挑一段，否则没有"整条的历史"这回事
    const choices = Array.isArray(data.choices) && data.choices.length > 1
        ? `<div class="mt-4 flex items-center flex-wrap gap-2 text-xs text-gray-500">
                <span>这条笔记同时记了多件事，看哪一件：</span>
                ${data.choices.map((choice) => {
                    const active = choice === data.label;
                    return `<button type="button" data-history-label="${escapeHTML(choice)}"
                        class="px-2 py-0.5 rounded-full transition-colors duration-150
                               ${active ? 'bg-primary text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}">
                        ${escapeHTML(choice)}</button>`;
                }).join('')}
           </div>`
        : '';

    const rows = data.records.map((record) => {
        // 多段笔记要标出"这一段只按均摊算"，否则时长和卡片上看到的对不上
        const shareHint = record.segments > 1
            ? `<span class="ml-2 text-xs text-amber-600 dark:text-amber-400 whitespace-nowrap">多段笔记 ${record.segments} 段 · 本段 ${escapeHTML(formatMinutes(record.minutes))}，整条 ${escapeHTML(formatMinutes(record.fullMinutes))}</span>`
            : '';
        const tag = record.tag ? `<span class="tag ml-2">${escapeHTML(record.tag)}</span>` : '';
        return `
            <button type="button" data-history-note-id="${escapeHTML(record.id)}"
                class="w-full text-left px-3 py-2 rounded hover:bg-primary/5 transition-colors duration-150 note-row-layout items-center">
                <span class="col-span-3 md:col-span-2 text-sm text-gray-500 whitespace-nowrap">${escapeHTML(record.date)}</span>
                <span class="col-span-3 md:col-span-2 text-sm whitespace-nowrap">${escapeHTML(record.timeStart)} ~ ${escapeHTML(record.timeEnd)}</span>
                <span class="col-span-2 text-sm font-medium tabular-nums whitespace-nowrap">${escapeHTML(formatMinutes(record.minutes))}</span>
                <span class="col-span-4 md:col-span-6 truncate text-sm text-gray-700">${escapeHTML(record.content)}${tag}${shareHint}</span>
            </button>`;
    }).join('');

    container.innerHTML = `
        <div class="grid grid-cols-2 md:grid-cols-4 gap-3">${summary}</div>
        ${choices}
        ${variants}
        <div class="flex items-center justify-between mt-5 mb-2">
            <h3 class="text-sm font-medium text-gray-700">全部记录（新 → 旧）</h3>
            <span class="text-xs text-gray-400">点任意一行可跳到列表里定位那条笔记</span>
        </div>
        <div class="space-y-0.5">${rows}</div>`;
}
