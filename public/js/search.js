/**
 * 搜索：查询解析、匹配、高亮。
 *
 * 全部是纯函数，所以能脱离 jsdom 直接单测。
 * 高亮尤其需要小心——它要往 DOM 里拼 HTML，必须由这里统一转义，
 * 不能让笔记内容有机会变成标签。
 */
import { escapeHTML } from './utils.js';

/**
 * 解析查询串：按空白切词，全部小写，空词丢掉。
 * 多个词之间是"与"的关系（都要命中）。
 */
export function parseQuery(raw) {
    return String(raw ?? '')
        .trim()
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean);
}

function haystackOf(note, { includeDetails }) {
    const parts = [note.content, note.tag];
    if (includeDetails) parts.push(note.details);
    return parts.filter(Boolean).join('\n').toLowerCase();
}

/**
 * 是否命中。
 *
 * 返回 `{ matched, onlyInDetails }`：详情里命中的也应当被搜到（那是 AI 总结之类
 * 真正有价值的内容），但卡片上高亮不出来，所以要告诉界面"这条是详情里中的"，
 * 否则用户会看到一条"看起来哪都没匹配"的结果。
 */
export function matchNote(note, terms) {
    if (!terms || terms.length === 0) return { matched: true, onlyInDetails: false };
    const main = haystackOf(note, { includeDetails: false });
    const all = haystackOf(note, { includeDetails: true });
    const every = (haystack) => terms.every((term) => haystack.includes(term));
    if (every(main)) return { matched: true, onlyInDetails: false };
    if (every(all)) return { matched: true, onlyInDetails: true };
    return { matched: false, onlyInDetails: false };
}

/** 过滤出命中的笔记（保持传入顺序）。 */
export function filterNotes(list, terms) {
    if (!terms || terms.length === 0) return list;
    return list.filter((note) => matchNote(note, terms).matched);
}

/**
 * 把文本转义后，把命中的片段包进 <mark>。
 * 所有来自笔记的字符都经过 escapeHTML，只有我们自己加的 mark 标签是"生"的。
 */
export function highlightHtml(text, terms) {
    const source = String(text ?? '');
    if (!terms || terms.length === 0 || source === '') return escapeHTML(source);

    const lower = source.toLowerCase();
    const ranges = [];
    for (const term of terms) {
        let index = lower.indexOf(term);
        while (index !== -1) {
            ranges.push([index, index + term.length]);
            index = lower.indexOf(term, index + term.length);
        }
    }
    if (ranges.length === 0) return escapeHTML(source);

    // 合并重叠/相邻的区间，避免出现嵌套的 mark
    ranges.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const range of ranges) {
        const last = merged[merged.length - 1];
        if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
        else merged.push([range[0], range[1]]);
    }

    let html = '';
    let cursor = 0;
    for (const [start, end] of merged) {
        html += escapeHTML(source.slice(cursor, start));
        html += `<mark class="search-hit">${escapeHTML(source.slice(start, end))}</mark>`;
        cursor = end;
    }
    html += escapeHTML(source.slice(cursor));
    return html;
}

/** 界面提示文案：搜到几条 / 一共几条。 */
export function resultLabel(matchedCount, totalCount, terms) {
    if (!terms || terms.length === 0) return '';
    return `找到 ${matchedCount} 条 / 共 ${totalCount} 条`;
}
