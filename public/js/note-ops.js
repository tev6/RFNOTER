/**
 * 笔记集合上的纯操作。
 *
 * 全部是纯函数：输入笔记数组，返回新数组/新值，不改原对象、不碰 DOM、不持状态。
 * 这样批量编辑这类"改数据"的逻辑可以单独测清楚，界面层只负责收集意图和重绘。
 */
import { trimTagToLimit } from './utils.js';

/**
 * 界面上的实际顺序：日期倒序，同一天内按记录时间倒序。
 *
 * 注意这**不等于** `notes` 数组本身的顺序（那个只按 createdAt 倒序）。
 * 折叠的日期分组不渲染卡片，所以"第 N 条"这种区间选择必须按这个顺序算，
 * 否则跨日期拖选会选错。
 */
export function sortForDisplay(list) {
    return [...list].sort((a, b) => {
        if (a.date !== b.date) return String(b.date).localeCompare(String(a.date));
        return (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0);
    });
}

/**
 * 区间选择：按展示顺序取 fromId 到 toId 之间的所有笔记 id（含两端）。
 * 找不到任一端时返回空数组，调用方自行决定退化成单选。
 */
export function rangeIds(list, fromId, toId) {
    const ordered = sortForDisplay(list);
    const from = ordered.findIndex((note) => note.id === fromId);
    const to = ordered.findIndex((note) => note.id === toId);
    if (from === -1 || to === -1) return [];
    const [start, end] = from <= to ? [from, to] : [to, from];
    return ordered.slice(start, end + 1).map((note) => note.id);
}

/** 标签操作：新增 / 移除 / 替换。 */
export const TAG_OP = { ADD: 'add', REMOVE: 'remove', REPLACE: 'replace' };

/**
 * 对一条笔记应用标签操作，返回新的笔记对象（没变化时返回原对象）。
 * 标签超长会被 trimTagToLimit 截断，和手动编辑时保持一致。
 */
export function applyTagOp(note, { mode, tag }) {
    const current = note.tag || '';
    const value = trimTagToLimit(String(tag ?? '').trim());
    let next = current;

    if (mode === TAG_OP.REPLACE) {
        next = value;
    } else if (mode === TAG_OP.ADD) {
        if (!value) return note;
        // 已经有了就不重复加，但仍算"命中"，便于统计影响条数
        if (current.split(/\s+/).includes(value)) return note;
        next = trimTagToLimit(current ? `${current} ${value}` : value);
    } else if (mode === TAG_OP.REMOVE) {
        if (!value) {
            next = '';   // 不填就表示清空标签
        } else {
            const parts = current.split(/\s+/).filter(Boolean).filter((item) => item !== value);
            next = parts.join(' ');
        }
    } else {
        return note;
    }

    if (next === current) return note;
    return { ...note, tag: next, updatedAt: Date.now() };
}

/**
 * 批量应用标签操作。
 * 返回 { notes, changed }：changed 是被真正改动的条数（用于提示"影响了几条"）。
 */
export function batchApplyTag(list, ids, op) {
    const target = new Set(ids);
    let changed = 0;
    const next = list.map((note) => {
        if (!target.has(note.id)) return note;
        const updated = applyTagOp(note, op);
        if (updated !== note) changed += 1;
        return updated;
    });
    return { notes: next, changed };
}

/** 批量删除。返回 { notes, removed }。 */
export function batchRemove(list, ids) {
    const target = new Set(ids);
    const next = list.filter((note) => !target.has(note.id));
    return { notes: next, removed: list.length - next.length };
}

/**
 * 一批要改动的笔记里，各标签的现有取值分布（用于在弹窗里给出"现有标签"提示）。
 */
export function collectTags(list, ids) {
    const target = new Set(ids);
    const counts = new Map();
    for (const note of list) {
        if (!target.has(note.id)) continue;
        for (const tag of String(note.tag || '').split(/\s+/).filter(Boolean)) {
            counts.set(tag, (counts.get(tag) || 0) + 1);
        }
    }
    return [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([tag, count]) => ({ tag, count }));
}
