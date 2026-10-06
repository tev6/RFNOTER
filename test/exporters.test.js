/**
 * 导出格式的单元测试。
 * exporters.js 是纯函数，不需要 jsdom，直接调用即可。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    notesToJson, notesToMarkdown, notesToCsv, csvEscape, sortForExport,
    exportFilename, mimeFor
} from '../public/js/exporters.js';

const note = (overrides = {}) => ({
    id: 'n1', date: '2026-05-14', timeStart: '09:00', timeEnd: '09:40',
    content: '笔记', tag: '', color: '', details: '',
    createdAt: 1, updatedAt: 1, ...overrides
});

test('JSON 导出是无损的，且带版本与条数', () => {
    const notes = [note({ id: 'a' }), note({ id: 'b', content: '第二条' })];
    const parsed = JSON.parse(notesToJson(notes, { exportedAt: new Date('2026-05-14T09:00:00Z') }));
    assert.equal(parsed.version, '1.2.0');
    assert.equal(parsed.noteCount, 2);
    assert.equal(parsed.exportTime, '2026-05-14T09:00:00.000Z');
    assert.deepEqual(parsed.notes, notes, '笔记内容应原样保留');
});

test('CSV 转义：逗号、引号、换行、首尾空格都会被正确包起来', () => {
    assert.equal(csvEscape('普通'), '普通');
    assert.equal(csvEscape('a,b'), '"a,b"');
    assert.equal(csvEscape('说"引号"'), '"说""引号"""');
    assert.equal(csvEscape('第一行\n第二行'), '"第一行\n第二行"');
    assert.equal(csvEscape(' 前后有空格 '), '" 前后有空格 "');
    assert.equal(csvEscape(null), '');
    assert.equal(csvEscape(undefined), '');
});

test('CSV：带 BOM、CRLF、表头固定，含特殊字符的标题不会串列', () => {
    const csv = notesToCsv([
        note({ content: '钓鱼,带逗号', tag: '标签', details: '第一行\n第二行' })
    ]);
    assert.ok(csv.startsWith('\uFEFF'));
    assert.ok(csv.includes('\r\n'));
    const rows = csv.replace('\uFEFF', '').trimEnd().split('\r\n');
    assert.equal(rows.length, 2);
    assert.equal(rows[0].split(',').length, 10, '表头 10 列');
    // 标题里的逗号被引号包住，整行仍然是 10 个字段（用简单的 CSV 解析验证）
    const parsed = parseCsvLine(rows[1]);
    assert.equal(parsed.length, 10);
    assert.equal(parsed[5], '钓鱼,带逗号');
    assert.equal(parsed[8], '第一行\n第二行');
});

test('Markdown：按日期分节，含时长、标签与详情，并转义特殊字符', () => {
    const md = notesToMarkdown([
        note({ date: '2026-05-14', timeStart: '09:00', timeEnd: '10:30', content: '钓鱼', tag: '户外' }),
        note({ id: 'n2', date: '2026-05-14', timeStart: '10:30', timeEnd: '11:00', content: 'CS' }),
        note({ id: 'n3', date: '2026-05-13', content: '*斜体陷阱*', details: '详情一\n详情二' })
    ]);
    assert.match(md, /^# 闪录笔记/m);
    assert.match(md, /## 2026-05-14 .*（2 条）/);
    assert.match(md, /## 2026-05-13 .*（1 条）/);
    assert.match(md, /1小时30分钟/);
    assert.match(md, /`户外`/);
    assert.match(md, /\\\*斜体陷阱\\\*/, 'Markdown 特殊字符必须转义，否则会破坏排版');
    assert.match(md, /\n  详情一\n  详情二/, '详情要缩进成列表项的一部分并保留换行');
});

test('跨天笔记的时长按 24 小时绕圈计算，不会变成负数', () => {
    const csv = notesToCsv([note({ timeStart: '23:30', timeEnd: '00:30' })]);
    const fields = parseCsvLine(csv.replace('\uFEFF', '').trimEnd().split('\r\n')[1]);
    assert.equal(fields[4], '60');
});

test('导出排序：日期倒序，同一天内按记录时间倒序', () => {
    const sorted = sortForExport([
        note({ id: 'a', date: '2026-05-13', createdAt: 5 }),
        note({ id: 'b', date: '2026-05-14', createdAt: 1 }),
        note({ id: 'c', date: '2026-05-14', createdAt: 9 })
    ]);
    assert.deepEqual(sorted.map((n) => n.id), ['c', 'b', 'a']);
});

test('文件名与 MIME 按格式区分', () => {
    assert.equal(exportFilename('json', '2026-05-14'), 'rfnoter-backup-2026-05-14.json');
    assert.equal(exportFilename('md', '2026-05-14'), 'rfnoter-notes-2026-05-14.md');
    assert.equal(exportFilename('csv', '2026-05-14'), 'rfnoter-notes-2026-05-14.csv');
    assert.match(mimeFor('csv'), /text\/csv/);
    assert.match(mimeFor('md'), /text\/markdown/);
    assert.match(mimeFor('json'), /application\/json/);
});

test('空笔记列表也能导出（不应抛异常）', () => {
    assert.match(notesToMarkdown([]), /共 0 条/);
    const csv = notesToCsv([]);
    assert.equal(csv.replace('\uFEFF', '').trimEnd().split('\r\n').length, 1, '只剩表头');
    assert.equal(JSON.parse(notesToJson([])).notes.length, 0);
});

/** 测试用的最小 CSV 行解析器，用来验证"字段没串列"。 */
function parseCsvLine(line) {
    const fields = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i += 1) {
        const ch = line[i];
        if (inQuotes) {
            if (ch === '"' && line[i + 1] === '"') { current += '"'; i += 1; }
            else if (ch === '"') inQuotes = false;
            else current += ch;
        } else if (ch === '"') inQuotes = true;
        else if (ch === ',') { fields.push(current); current = ''; }
        else current += ch;
    }
    fields.push(current);
    return fields;
}
