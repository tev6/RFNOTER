export function generateUUID() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

export function getCurrentDateString(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

/**
 * 按「本地时区」解析 YYYY-MM-DD。
 * 直接 new Date('2026-05-14') 会按 UTC 午夜解析，在 UTC 以西的时区会整体差一天。
 */
export function parseDateString(dateString) {
    const matched = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(String(dateString ?? ''));
    if (!matched) return null;
    const parsed = new Date(Number(matched[1]), Number(matched[2]) - 1, Number(matched[3]));
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function formatRelativeTime(timestamp) {
    const value = Number(timestamp);
    if (!Number.isFinite(value)) return '时间未知';
    const diff = Date.now() - value;
    if (diff < 0) return '刚刚';
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`;
    if (diff < 2592000000) return `${Math.floor(diff / 86400000)}天前`;
    return new Date(value).toLocaleDateString('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatDateForDisplay(dateString) {
    const date = parseDateString(dateString);
    if (!date) return String(dateString ?? '');
    return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}

export function calculateTimeDuration(startTime, endTime) {
    const startTotalMinutes = parseClockMinutes(startTime);
    const endTotalMinutes = parseClockMinutes(endTime);
    if (startTotalMinutes === null || endTotalMinutes === null) return 0;
    let duration = endTotalMinutes - startTotalMinutes;
    if (duration < 0) duration += 24 * 60;
    return duration;
}

/** "HH:MM" -> 从 0 点开始的分钟数；非法输入返回 null。 */
export function parseClockMinutes(clock) {
    const matched = /^(\d{1,2}):(\d{2})$/.exec(String(clock ?? '').trim());
    if (!matched) return null;
    const hours = Number(matched[1]);
    const minutes = Number(matched[2]);
    if (hours > 23 || minutes > 59) return null;
    return hours * 60 + minutes;
}

/** 从 0 点开始的分钟数 -> "HH:MM"（自动对 24 小时取模）。 */
export function minutesToClock(totalMinutes) {
    const normalized = ((Math.round(totalMinutes) % 1440) + 1440) % 1440;
    const hours = String(Math.floor(normalized / 60)).padStart(2, '0');
    const minutes = String(normalized % 60).padStart(2, '0');
    return `${hours}:${minutes}`;
}

export function formatDuration(minutes) {
    const value = Number(minutes);
    if (!Number.isFinite(value) || value <= 0) return '0分钟';
    if (value < 60) return `${value}分钟`;
    const hours = Math.floor(value / 60);
    const remainingMinutes = value % 60;
    if (remainingMinutes === 0) return `${hours}小时`;
    return `${hours}小时${remainingMinutes}分钟`;
}

export function trimTagToLimit(text) {
    let units = 0;
    let out = '';
    for (const ch of String(text ?? '')) {
        const add = /[\u4e00-\u9fff]/.test(ch) ? 2 : 1;
        if (units + add > 20) break;
        units += add;
        out += ch;
    }
    return out;
}

/** 把任意文本转成安全的 HTML 片段（用于插入 innerHTML 之前）。 */
export function escapeHTML(text) {
    if (text === null || text === undefined) return '';
    return String(text).replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    })[ch]);
}

const ALLOWED_TAGS = new Set([
    'P', 'BR', 'HR', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'DEL', 'MARK', 'SMALL',
    'UL', 'OL', 'LI', 'DL', 'DT', 'DD', 'BLOCKQUOTE', 'CODE', 'PRE',
    'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'SPAN', 'DIV',
    'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TH', 'TD', 'CAPTION', 'A'
]);
const ALLOWED_ATTRS = new Set(['href', 'title', 'colspan', 'rowspan', 'align']);
const SAFE_URL_RE = /^(https?:|mailto:|#|\/)/i;

/**
 * 只保留白名单标签/属性的 HTML 净化。
 * AI 总结的「HTML 格式」会走到这里，避免模型输出被当成可执行代码。
 */
export function sanitizeHtml(html) {
    const source = String(html ?? '');
    if (typeof DOMParser === 'undefined') return escapeHTML(source);
    const doc = new DOMParser().parseFromString(`<body>${source}</body>`, 'text/html');
    const walk = (node) => {
        [...node.childNodes].forEach((child) => {
            if (child.nodeType === 8) { // 注释
                child.remove();
                return;
            }
            if (child.nodeType !== 1) return; // 文本节点直接保留
            if (!ALLOWED_TAGS.has(child.tagName)) {
                child.replaceWith(...child.childNodes);
                return;
            }
            [...child.attributes].forEach((attr) => {
                const name = attr.name.toLowerCase();
                const isEventHandler = name.startsWith('on');
                const allowed = ALLOWED_ATTRS.has(name) && !isEventHandler;
                if (!allowed || (name === 'href' && !SAFE_URL_RE.test(attr.value.trim()))) {
                    child.removeAttribute(attr.name);
                }
            });
            if (child.tagName === 'A') {
                child.setAttribute('target', '_blank');
                child.setAttribute('rel', 'noopener noreferrer');
            }
            walk(child);
        });
    };
    walk(doc.body);
    return doc.body.innerHTML;
}

export function markdownToHtml(md) {
    return escapeHTML(md)
        .replace(/^#{1,6}\s+(.+)$/gm, '<strong>$1</strong>')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, '$1<em>$2</em>')
        .replace(/\n/g, '<br>');
}

export function isTodayDate(dateString) {
    const noteDate = parseDateString(dateString);
    if (!noteDate) return false;
    const today = new Date();
    return noteDate.getFullYear() === today.getFullYear()
        && noteDate.getMonth() === today.getMonth()
        && noteDate.getDate() === today.getDate();
}

/** 中文字符逐字计数，拉丁文按空白分词，避免 split(/\s+/) 对中文恒等于 1。 */
export function countWords(text) {
    const source = String(text ?? '');
    const cjk = source.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g);
    const latin = source
        .replace(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, ' ')
        .split(/\s+/)
        .filter(Boolean);
    return (cjk ? cjk.length : 0) + latin.length;
}

export function groupNotesByDate(notes) {
    const groups = {};
    notes.forEach(note => {
        const key = note.date || '';
        if (!groups[key]) groups[key] = [];
        groups[key].push(note);
    });
    return groups;
}
