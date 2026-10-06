/**
 * 导出格式。
 *
 * 这里全部是**纯函数**：输入笔记数组，输出字符串，不碰 DOM、不持状态。
 * 好处是单元测试可以直接调用（不受 ESM 模块缓存影响），以后拆分 app.js 时也能整块搬走。
 *
 * 三种格式各有分工：
 *   JSON —— 无损、可再导入，唯一的"备份"
 *   Markdown —— 给人读的日志
 *   CSV —— 给表格和脚本用的
 */
import { calculateTimeDuration, formatDuration, parseDateString } from './utils.js';

const CSV_BOM = '\uFEFF';   // Excel 识别 UTF-8 全靠它，少一个字符中文就乱码

function pad(value) {
    return String(value).padStart(2, '0');
}

/** Date -> "YYYY-MM-DD HH:MM:SS"（本地时间，给人看） */
function formatStamp(date) {
    const d = date instanceof Date ? date : new Date(date);
    if (Number.isNaN(d.getTime())) return '';
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
        + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function weekdayLabel(dateString) {
    const parsed = parseDateString(dateString);
    if (!parsed) return '';
    try {
        return parsed.toLocaleDateString('zh-CN', { weekday: 'long' });
    } catch {
        return '';
    }
}

/** 转义 Markdown 里有特殊含义的字符。只处理确实会破坏结构的那些，避免把正常文字改得看不懂。 */
function escapeMarkdown(text) {
    return String(text ?? '').replace(/[\\`*_[\]<>]/g, (ch) => `\\${ch}`);
}

/** CSV 字段转义（RFC 4180）：含引号/逗号/换行或首尾空格时整体加引号，内部引号翻倍。 */
export function csvEscape(value) {
    const text = value === null || value === undefined ? '' : String(value);
    if (!/[",\r\n]/.test(text) && text.trim() === text) return text;
    return `"${text.replace(/"/g, '""')}"`;
}

/** 导出时统一的排序：日期倒序，同一天内按记录时间倒序（和界面上看到的一致）。 */
export function sortForExport(notes) {
    return [...notes].sort((a, b) => {
        if (a.date !== b.date) return String(b.date).localeCompare(String(a.date));
        return (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0);
    });
}

/** JSON 完整备份。 */
export function notesToJson(notes, { exportedAt = new Date() } = {}) {
    return JSON.stringify({
        version: '1.2.0',
        exportTime: (exportedAt instanceof Date ? exportedAt : new Date(exportedAt)).toISOString(),
        noteCount: notes.length,
        notes
    }, null, 2);
}

/** Markdown：按日期分节，每条一行（含时长/标签/详情）。 */
export function notesToMarkdown(notes, { exportedAt = new Date() } = {}) {
    const sorted = sortForExport(notes);
    const lines = ['# 闪录笔记', ''];

    const dates = [...new Set(sorted.map((note) => note.date))];
    const range = dates.length ? `${dates[dates.length - 1]} ~ ${dates[0]}` : '（无）';
    lines.push(`> 导出时间：${formatStamp(exportedAt)}　共 ${notes.length} 条　覆盖 ${range}`);
    lines.push('');

    let currentDate = null;
    for (const note of sorted) {
        if (note.date !== currentDate) {
            currentDate = note.date;
            const count = sorted.filter((item) => item.date === currentDate).length;
            lines.push(`## ${note.date} ${weekdayLabel(note.date)}（${count} 条）`, '');
        }
        const duration = calculateTimeDuration(note.timeStart, note.timeEnd);
        const parts = [`- **${note.timeStart} ~ ${note.timeEnd}**`, `· ${formatDuration(duration)}`];
        if (note.content) parts.push(`· ${escapeMarkdown(note.content)}`);
        if (note.tag) parts.push(`　\`${escapeMarkdown(note.tag)}\``);
        lines.push(parts.join(' '));
        if (note.details && note.details.trim()) {
            // 缩进两格就会被当成该列表项的一部分，换行也保留
            for (const detailLine of note.details.split(/\r?\n/)) {
                lines.push(`  ${escapeMarkdown(detailLine)}`);
            }
        }
    }

    lines.push('');
    return lines.join('\n');
}

/** CSV：一行一条，表头固定。 */
export function notesToCsv(notes) {
    const header = ['日期', '星期', '开始', '结束', '时长(分钟)', '标题', '标签', '颜色', '详情', '记录时间'];
    const rows = sortForExport(notes).map((note) => [
        note.date,
        weekdayLabel(note.date),
        note.timeStart,
        note.timeEnd,
        String(calculateTimeDuration(note.timeStart, note.timeEnd)),
        note.content,
        note.tag || '',
        note.color || '',
        note.details || '',
        note.createdAt ? formatStamp(note.createdAt) : ''
    ].map(csvEscape).join(','));

    // RFC 4180 规定用 CRLF，Excel 最省心
    return CSV_BOM + [header.map(csvEscape).join(','), ...rows].join('\r\n') + '\r\n';
}

/** 统一的文件名，方便日后按名字排序。 */
export function exportFilename(format, dateString) {
    const stamp = dateString || formatStamp(new Date()).slice(0, 10);
    if (format === 'md') return `rfnoter-notes-${stamp}.md`;
    if (format === 'csv') return `rfnoter-notes-${stamp}.csv`;
    return `rfnoter-backup-${stamp}.json`;
}

/** 各格式的 MIME，桌面端写文件与网页端下载都要用。 */
export function mimeFor(format) {
    if (format === 'md') return 'text/markdown;charset=utf-8';
    if (format === 'csv') return 'text/csv;charset=utf-8';
    return 'application/json';
}
