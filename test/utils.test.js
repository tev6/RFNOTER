import test from 'node:test';
import assert from 'node:assert/strict';

import {
    parseDateString,
    isTodayDate,
    getCurrentDateString,
    calculateTimeDuration,
    parseClockMinutes,
    minutesToClock,
    formatDuration,
    trimTagToLimit,
    escapeHTML,
    markdownToHtml,
    sanitizeHtml,
    countWords,
    formatRelativeTime,
    groupNotesByDate
} from '../public/js/utils.js';

test('parseDateString 按本地时区解析，不出现 UTC 偏移', () => {
    const parsed = parseDateString('2026-05-14');
    assert.equal(parsed.getFullYear(), 2026);
    assert.equal(parsed.getMonth(), 4);
    assert.equal(parsed.getDate(), 14);
    assert.equal(parsed.getHours(), 0);
});

test('parseDateString 对非法输入返回 null', () => {
    assert.equal(parseDateString(''), null);
    assert.equal(parseDateString(undefined), null);
    assert.equal(parseDateString('not-a-date'), null);
});

test('isTodayDate 与本地日期一致', () => {
    assert.equal(isTodayDate(getCurrentDateString()), true);
    assert.equal(isTodayDate('1999-01-01'), false);
    assert.equal(isTodayDate('乱码'), false);
});

test('calculateTimeDuration 支持跨天并拒绝非法值', () => {
    assert.equal(calculateTimeDuration('09:00', '09:40'), 40);
    assert.equal(calculateTimeDuration('23:40', '00:20'), 40);
    assert.equal(calculateTimeDuration('', '09:40'), 0);
    assert.equal(calculateTimeDuration('25:00', '09:40'), 0);
});

test('parseClockMinutes / minutesToClock 边界', () => {
    assert.equal(parseClockMinutes('23:59'), 1439);
    assert.equal(parseClockMinutes('24:00'), null);
    assert.equal(parseClockMinutes('9:5'), null);
    assert.equal(minutesToClock(1439), '23:59');
    assert.equal(minutesToClock(1440), '00:00'); // 跨天回绕
    assert.equal(minutesToClock(1500), '01:00');
});

test('formatDuration 处理 0 与负数', () => {
    assert.equal(formatDuration(0), '0分钟');
    assert.equal(formatDuration(-5), '0分钟');
    assert.equal(formatDuration(40), '40分钟');
    assert.equal(formatDuration(60), '1小时');
    assert.equal(formatDuration(95), '1小时35分钟');
});

test('trimTagToLimit 中文按 2 个单位计算', () => {
    assert.equal(trimTagToLimit('abcdefghijklmnopqrst'), 'abcdefghijklmnopqrst');
    assert.equal(trimTagToLimit('abcdefghijklmnopqrstu'), 'abcdefghijklmnopqrst');
    assert.equal(trimTagToLimit('中文标签测试中文标签测试中文'), '中文标签测试中文标签');
});

test('escapeHTML 阻断标签注入', () => {
    assert.equal(escapeHTML('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
    assert.equal(escapeHTML(`"'&`), '&quot;&#039;&amp;');
    assert.equal(escapeHTML(null), '');
    assert.equal(escapeHTML(undefined), '');
});

test('markdownToHtml 转义 HTML 且不把 C# 当标题', () => {
    const html = markdownToHtml('<script>alert(1)</script>');
    assert.ok(!html.includes('<script>'));
    assert.ok(html.includes('&lt;script&gt;'));

    const sharp = markdownToHtml('C# 是一门语言');
    assert.equal(sharp.includes('<strong>'), false);

    const heading = markdownToHtml('# 标题');
    assert.equal(heading, '<strong>标题</strong>');

    const bolded = markdownToHtml('**重点**');
    assert.equal(bolded, '<strong>重点</strong>');
});

test('sanitizeHtml 在没有 DOMParser 的环境下降级为全量转义', () => {
    // Node 里没有 DOMParser，走的是保守分支
    assert.equal(sanitizeHtml('<b>x</b>'), '&lt;b&gt;x&lt;/b&gt;');
});

test('countWords 对中文逐字计数', () => {
    assert.equal(countWords('你好世界'), 4);
    assert.equal(countWords('hello world'), 2);
    assert.equal(countWords(''), 0);
});

test('formatRelativeTime 对非法时间戳不再输出 Invalid Date', () => {
    assert.equal(formatRelativeTime(undefined), '时间未知');
    assert.equal(formatRelativeTime('abc'), '时间未知');
    assert.equal(formatRelativeTime(Date.now()), '刚刚');
});

test('groupNotesByDate 按 date 分组且容忍缺失字段', () => {
    const groups = groupNotesByDate([
        { id: 'a', date: '2026-05-14' },
        { id: 'b', date: '2026-05-14' },
        { id: 'c' }
    ]);
    assert.equal(groups['2026-05-14'].length, 2);
    assert.equal(groups[''].length, 1);
});
