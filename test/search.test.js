/**
 * 搜索纯逻辑测试。search.js 不依赖 DOM。
 * 高亮这块尤其要盯紧：它负责往 innerHTML 里拼字符串，必须证明它挡得住注入。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseQuery, matchNote, filterNotes, highlightHtml, resultLabel } from '../public/js/search.js';

const note = (overrides = {}) => ({
    id: 'n1', date: '2026-05-14', timeStart: '09:00', timeEnd: '09:40',
    content: '钓鱼', tag: '', color: '', details: '',
    createdAt: 1, updatedAt: 1, ...overrides
});

test('解析查询：去空白、转小写、按空格切词、丢掉空词', () => {
    assert.deepEqual(parseQuery('  CS  B站 '), ['cs', 'b站']);
    assert.deepEqual(parseQuery(''), []);
    assert.deepEqual(parseQuery('   '), []);
    assert.deepEqual(parseQuery('CS'), ['cs']);
    assert.deepEqual(parseQuery(null), []);
});

test('匹配：标题、标签、详情都算，多个词是"与"的关系', () => {
    const n = note({ content: '30图小河道表水', tag: '钓鱼 户外', details: '用了亮片' });
    assert.equal(matchNote(n, parseQuery('小河道')).matched, true);
    assert.equal(matchNote(n, parseQuery('户外')).matched, true);
    assert.equal(matchNote(n, parseQuery('亮片')).matched, true);
    assert.equal(matchNote(n, parseQuery('30图 户外')).matched, true);
    assert.equal(matchNote(n, parseQuery('30图 不存在的词')).matched, false);
});

test('匹配：只在详情里命中时会标记 onlyInDetails', () => {
    const n = note({ content: 'CS', details: '后半段换成了别的图' });
    assert.deepEqual(matchNote(n, parseQuery('CS')), { matched: true, onlyInDetails: false });
    assert.deepEqual(matchNote(n, parseQuery('别的图')), { matched: true, onlyInDetails: true });
    assert.deepEqual(matchNote(n, parseQuery('从未出现')), { matched: false, onlyInDetails: false });
});

test('匹配：大小写不敏感', () => {
    assert.equal(matchNote(note({ content: 'CS' }), parseQuery('cs')).matched, true);
});

test('空查询视为全部命中（没有在搜索）', () => {
    assert.deepEqual(matchNote(note(), []), { matched: true, onlyInDetails: false });
    assert.equal(filterNotes([note({ id: 'a' }), note({ id: 'b' })], []).length, 2);
});

test('过滤：保持原顺序，只留命中的', () => {
    const list = [
        note({ id: 'a', content: '钓鱼' }),
        note({ id: 'b', content: 'CS' }),
        note({ id: 'c', content: '钓鱼 二' })
    ];
    assert.deepEqual(filterNotes(list, parseQuery('钓鱼')).map((n) => n.id), ['a', 'c']);
});

test('高亮：命中片段被 mark 包住，未命中的原样返回', () => {
    assert.equal(highlightHtml('30图小河道表水', parseQuery('小河道')),
        '30图<mark class="search-hit">小河道</mark>表水');
    assert.equal(highlightHtml('没有命中', parseQuery('xyz')), '没有命中');
    assert.equal(highlightHtml('', parseQuery('a')), '');
});

test('高亮：多次命中与重叠命中都不会产生嵌套的 mark', () => {
    const html = highlightHtml('CS 和 cs 和 CSGO', parseQuery('cs'));
    assert.equal((html.match(/<mark/g) || []).length, 3);
    // 自嵌套的 mark 会让浏览器把标签拆开，必须合并重叠区间
    assert.equal(html.includes('<mark class="search-hit"><mark'), false);
});

test('高亮：笔记内容里的 HTML 会被转义，不能借搜索注入', () => {
    const evil = '<img src=x onerror=alert(1)>CS';
    const html = highlightHtml(evil, parseQuery('cs'));
    assert.equal(html.includes('<img'), false, '尖括号必须被转义');
    assert.equal(html.includes('onerror=alert'), true, '文字内容保留，但它已经不在标签里了');
    assert.match(html, /&lt;img/);
    assert.match(html, /<mark class="search-hit">CS<\/mark>/);
});

test('结果文案：只在实际搜索时给出', () => {
    assert.equal(resultLabel(3, 100, parseQuery('cs')), '找到 3 条 / 共 100 条');
    assert.equal(resultLabel(3, 100, []), '');
});
