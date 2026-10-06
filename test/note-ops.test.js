/**
 * 批量操作与区间选择的纯逻辑测试。note-ops.js 不依赖 DOM，直接调用。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    sortForDisplay, rangeIds, applyTagOp, batchApplyTag, batchRemove, collectTags, TAG_OP
} from '../public/js/note-ops.js';

const note = (overrides = {}) => ({
    id: 'n1', date: '2026-05-14', timeStart: '09:00', timeEnd: '09:40',
    content: '笔记', tag: '', color: '', details: '',
    createdAt: 1, updatedAt: 1, ...overrides
});

test('展示顺序：日期倒序，同一天内按记录时间倒序（与界面一致）', () => {
    const sorted = sortForDisplay([
        note({ id: 'a', date: '2026-05-13', createdAt: 5 }),
        note({ id: 'b', date: '2026-05-14', createdAt: 1 }),
        note({ id: 'c', date: '2026-05-14', createdAt: 9 })
    ]);
    assert.deepEqual(sorted.map((n) => n.id), ['c', 'b', 'a']);
});

test('展示顺序不修改传入的数组', () => {
    const input = [note({ id: 'a', date: '2026-05-13' }), note({ id: 'b', date: '2026-05-14' })];
    const before = input.map((n) => n.id);
    sortForDisplay(input);
    assert.deepEqual(input.map((n) => n.id), before);
});

test('区间选择：按展示顺序取两端之间的全部 id，且与点击先后无关', () => {
    const list = [
        note({ id: 'd1', date: '2026-05-14', createdAt: 3 }),
        note({ id: 'd2', date: '2026-05-14', createdAt: 2 }),
        note({ id: 'd3', date: '2026-05-14', createdAt: 1 }),
        note({ id: 'y1', date: '2026-05-13', createdAt: 9 })
    ];
    assert.deepEqual(rangeIds(list, 'd1', 'd3'), ['d1', 'd2', 'd3']);
    assert.deepEqual(rangeIds(list, 'd3', 'd1'), ['d1', 'd2', 'd3'], '反着点也应是同一段');
    assert.deepEqual(rangeIds(list, 'd2', 'y1'), ['d2', 'd3', 'y1'], '可以跨日期');
    assert.deepEqual(rangeIds(list, 'd1', 'd1'), ['d1']);
    assert.deepEqual(rangeIds(list, 'd1', 'nope'), [], '找不到就返回空，交给调用方处理');
});

test('标签操作：添加 / 移除 / 替换', () => {
    assert.equal(applyTagOp(note({ tag: '' }), { mode: TAG_OP.ADD, tag: '户外' }).tag, '户外');
    assert.equal(applyTagOp(note({ tag: '户外' }), { mode: TAG_OP.ADD, tag: '钓鱼' }).tag, '户外 钓鱼');
    assert.equal(applyTagOp(note({ tag: '户外' }), { mode: TAG_OP.REMOVE, tag: '户外' }).tag, '');
    assert.equal(applyTagOp(note({ tag: '户外 钓鱼' }), { mode: TAG_OP.REMOVE, tag: '户外' }).tag, '钓鱼');
    assert.equal(applyTagOp(note({ tag: '户外' }), { mode: TAG_OP.REPLACE, tag: '工作' }).tag, '工作');
});

test('标签操作：移除时留空 = 清空全部标签', () => {
    assert.equal(applyTagOp(note({ tag: 'a b c' }), { mode: TAG_OP.REMOVE, tag: '' }).tag, '');
});

test('标签操作：重复添加不产生重复标签，且返回原对象（便于统计"影响了几条"）', () => {
    const original = note({ tag: '户外' });
    assert.equal(applyTagOp(original, { mode: TAG_OP.ADD, tag: '户外' }), original);
});

test('标签操作：超长标签会被截断，和手动编辑保持一致', () => {
    const long = '一二三四五六七八九十十一十二';
    const result = applyTagOp(note({ tag: '' }), { mode: TAG_OP.ADD, tag: long });
    assert.ok(result.tag.length < long.length, '应该被 trimTagToLimit 截断');
});

test('标签操作：没变化时不改 updatedAt', () => {
    const original = note({ tag: '户外', updatedAt: 111 });
    assert.equal(applyTagOp(original, { mode: TAG_OP.REMOVE, tag: '不存在' }), original);
});

test('批量改标签：只动选中的，并统计真正改动的条数', () => {
    const list = [
        note({ id: 'a', tag: '' }),
        note({ id: 'b', tag: '户外' }),
        note({ id: 'c', tag: '' })
    ];
    const { notes, changed } = batchApplyTag(list, ['a', 'b'], { mode: TAG_OP.ADD, tag: '户外' });
    assert.equal(changed, 1, 'b 已经有这个标签，不该算改动');
    assert.equal(notes.find((n) => n.id === 'a').tag, '户外');
    assert.equal(notes.find((n) => n.id === 'b').tag, '户外');
    assert.equal(notes.find((n) => n.id === 'c').tag, '', '没选中的不动');
    assert.equal(list.find((n) => n.id === 'a').tag, '', '原数组不被修改');
});

test('批量删除：返回剩余笔记与被删除的条数', () => {
    const list = [note({ id: 'a' }), note({ id: 'b' }), note({ id: 'c' })];
    const { notes, removed } = batchRemove(list, ['a', 'c', '不存在']);
    assert.equal(removed, 2);
    assert.deepEqual(notes.map((n) => n.id), ['b']);
});

test('收集现有标签：按出现次数排序，只统计选中的笔记', () => {
    const list = [
        note({ id: 'a', tag: '户外 钓鱼' }),
        note({ id: 'b', tag: '户外' }),
        note({ id: 'c', tag: '工作' })
    ];
    assert.deepEqual(collectTags(list, ['a', 'b']), [
        { tag: '户外', count: 2 },
        { tag: '钓鱼', count: 1 }
    ]);
});
