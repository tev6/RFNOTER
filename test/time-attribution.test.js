/**
 * 时间归属与取整的回归测试。
 *
 * 这些用例针对的都是「真实数据里出现过、但以前没有测试拦着」的缺陷。
 * 每一条都写清了旧行为错在哪——把修复回退掉，这些用例必须变红，
 * 否则它们只是在描述实现，拦不住任何人。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    ceilToStepTimestamp,
    ceilToStepMinutes,
    dateStringOfClockInRange,
    getCurrentDateString,
    minutesToClock,
    calculateTimeDuration
} from '../public/js/utils.js';

/* ------------------------------------------------------------------ */
/* 5 分钟取整：小时末不能溢出                                          */
/* ------------------------------------------------------------------ */

const at = (h, m, s = 0) => new Date(2026, 4, 14, h, m, s);   // 2026-05-14 周四

test('取整：普通时刻向上取整到 5 分钟', () => {
    assert.equal(ceilToStepMinutes(at(10, 58)), 660, '10:58 -> 11:00');
    assert.equal(ceilToStepMinutes(at(10, 0)), 600, '整点不动');
    assert.equal(ceilToStepMinutes(at(10, 1)), 605, '10:01 -> 10:05');
});

test('取整：23:58 必须跨到次日 00:00，而不是当天 24:00 或回绕', () => {
    // 旧实现算 ceil(58/5)*5 = 60，再交给 new Date(y,m,d,23,60)。
    // 实测后果：23:58 点「复制」，起点变成次日 00:00，
    // 复制出来的记录被挂到**第二天**（date=次日、区间 00:00~00:30）。
    const minutes = ceilToStepMinutes(at(23, 58));
    assert.equal(minutes, 1440, '23:58 应取整成 1440（次日 00:00）');

    const stamp = new Date(ceilToStepTimestamp(at(23, 58)));
    assert.equal(stamp.getDate(), 15, '时间戳应落在次日');
    assert.equal(stamp.getHours(), 0);
    assert.equal(stamp.getMinutes(), 0);
    assert.equal(getCurrentDateString(stamp), '2026-05-15', '日期必须跟着走');
});

test('取整：23:55 恰好是边界，不跨天', () => {
    const stamp = new Date(ceilToStepTimestamp(at(23, 55)));
    assert.equal(stamp.getDate(), 14);
    assert.equal(stamp.getHours(), 23);
    assert.equal(stamp.getMinutes(), 55);
});

test('取整：23:59 跨天，且秒/毫秒被清零（否则时长会多出几十秒的零头）', () => {
    const stamp = new Date(ceilToStepTimestamp(at(23, 59, 59)));
    assert.equal(getCurrentDateString(stamp), '2026-05-15');
    assert.equal(stamp.getSeconds(), 0);
    assert.equal(stamp.getMilliseconds(), 0);
});

test('取整：跨天后算出的时间戳一定不早于原时刻', () => {
    // 这条是"向上取整"的定义，任何回绕实现都会违反
    for (const [h, m] of [[0, 0], [0, 3], [9, 1], [12, 34], [23, 56], [23, 58], [23, 59]]) {
        const base = at(h, m, 30);
        const stamp = ceilToStepTimestamp(base);
        assert.ok(stamp >= base.getTime(),
            `${h}:${m} 取整后 ${new Date(stamp).toTimeString()} 不应早于原时刻`);
    }
});

test('取整：跨天时刻 + 时长换算成时间区间是连续的，不出现零长记录', () => {
    // 复现 duplicateNote 的路径：23:58 复制一条 30 分钟的记录
    const durationMinutes = calculateTimeDuration('23:00', '23:30');
    const startDate = new Date(ceilToStepTimestamp(at(23, 58)));
    const startMinutes = startDate.getHours() * 60 + startDate.getMinutes();
    assert.equal(startMinutes, 0, '起点应是 00:00');
    assert.equal(minutesToClock(startMinutes), '00:00');
    assert.equal(minutesToClock(startMinutes + durationMinutes), '00:30', '终点 00:30，不是 00:00');
});

/* ------------------------------------------------------------------ */
/* 凌晨补记的日期归属                                                  */
/* ------------------------------------------------------------------ */

test('归属：凌晨 1 点补记跨夜记录 23:50-00:20，应算昨天', () => {
    // 真实数据里 41 条创建于 0-5 点，其中就有写成 23:50-00:20 的。
    // 旧实现恒取 getCurrentDateString()，这条会挂到今天，
    // 用户得手动开编辑弹窗把日期改回昨天。
    const now = at(1, 5);
    assert.equal(dateStringOfClockInRange('23:50', '00:20', now), '2026-05-13');
});

test('归属：白天记 23:50-00:20（提前规划）不该被挪到昨天', () => {
    const now = at(15, 0);
    assert.equal(dateStringOfClockInRange('23:50', '00:20', now), '2026-05-14');
});

test('归属：不跨夜的记录始终归当天，哪怕是凌晨', () => {
    const now = at(2, 0);
    assert.equal(dateStringOfClockInRange('00:10', '00:55', now), '2026-05-14');
    assert.equal(dateStringOfClockInRange('01:00', '02:00', now), '2026-05-14');
});

test('归属：5 点之后不算凌晨，不往回挪', () => {
    const now = at(6, 0);
    assert.equal(dateStringOfClockInRange('23:50', '00:20', now), '2026-05-14');
});

test('归属：跨月的凌晨补记要正确回到上个月最后一天', () => {
    // 这是手工改日期最容易改错的地方
    const now = new Date(2026, 5, 1, 0, 30);   // 6 月 1 日 00:30
    assert.equal(dateStringOfClockInRange('23:50', '00:20', now), '2026-05-31');
});

test('归属：跨年同理', () => {
    const now = new Date(2027, 0, 1, 0, 30);   // 2027-01-01 00:30
    assert.equal(dateStringOfClockInRange('23:50', '00:20', now), '2026-12-31');
});

test('归属：时间非法时退回今天，不抛异常', () => {
    const now = at(1, 0);
    assert.equal(dateStringOfClockInRange('', '', now), '2026-05-14');
    assert.equal(dateStringOfClockInRange('25:00', '99:99', now), '2026-05-14');
});
