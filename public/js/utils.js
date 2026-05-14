export function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

export function getCurrentDateString() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

export function formatRelativeTime(timestamp) {
    const now = Date.now();
    const diff = now - timestamp;
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`;
    if (diff < 2592000000) return `${Math.floor(diff / 86400000)}天前`;
    const date = new Date(timestamp);
    return date.toLocaleDateString('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatDateForDisplay(dateString) {
    const date = new Date(dateString);
    return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}

export function calculateTimeDuration(startTime, endTime) {
    if (!startTime || !endTime) return 0;
    const [startHour, startMinute] = startTime.split(':').map(Number);
    const [endHour, endMinute] = endTime.split(':').map(Number);
    const startTotalMinutes = startHour * 60 + startMinute;
    const endTotalMinutes = endHour * 60 + endMinute;
    let duration = endTotalMinutes - startTotalMinutes;
    if (duration < 0) duration += 24 * 60;
    return duration;
}

export function formatDuration(minutes) {
    if (minutes < 60) return `${minutes}分钟`;
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    if (remainingMinutes === 0) return `${hours}小时`;
    return `${hours}小时${remainingMinutes}分钟`;
}

export function trimTagToLimit(text) {
    let units = 0;
    let out = '';
    for (const ch of text) {
        const add = /[\u4e00-\u9fff]/.test(ch) ? 2 : 1;
        if (units + add > 20) break;
        units += add;
        out += ch;
    }
    return out;
}

export function markdownToHtml(md) {
    return md
        .replace(/\n/g, '<br>')
        .replace(/#{1,6}\s+(.+)/g, '<strong>$1</strong>')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>');
}

export function isTodayDate(dateString) {
    const today = new Date();
    const noteDate = new Date(dateString);
    return today.toDateString() === noteDate.toDateString();
}

export function groupNotesByDate(notes) {
    const groups = {};
    notes.forEach(note => {
        if (!groups[note.date]) groups[note.date] = [];
        groups[note.date].push(note);
    });
    return groups;
}
