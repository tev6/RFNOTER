/**
 * 统计纯逻辑测试。stats.js 不依赖 DOM，直接调用。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    normalizeText, splitActivities, canonicalTitle, noteDurationMinutes,
    similarity, isSameActivity, clusterActivities, rankActivities,
    hourHistogram, dailyBuckets, timelineBlocks, overview,
    filterByRange, heatmapDays, formatMinutes, ALLOCATION
} from '../public/js/stats.js';

const note = (overrides = {}) => ({
    id: 'n1', date: '2026-05-14', timeStart: '09:00', timeEnd: '10:00',
    content: '钓鱼', tag: '', color: '', details: '',
    createdAt: 1, updatedAt: 1, ...overrides
});

test('归一化：全角字母数字转半角、统一小写、压缩空白，但不动标点', () => {
    assert.equal(normalizeText('ＣＳ'), 'cs');
    assert.equal(normalizeText('  B站   直播 '), 'b站 直播');
    assert.equal(normalizeText('１２３'), '123');
    assert.equal(normalizeText(null), '');
    // 全角标点属于用户原文，刻意不转换：转换会让统计里的标题和笔记里写的不一样
    assert.equal(normalizeText('a＋b'), 'a＋b');
    assert.equal(normalizeText('出门，回家'), '出门，回家');
    // 但分隔符本身照拆不误（全角加号也在分隔符集合里）
    assert.deepEqual(splitActivities('a＋b'), ['a', 'b']);
});

test('拆段：+ 之类的分隔符拆开并排序，顺序不同的写法落到同一个键', () => {
    assert.deepEqual(splitActivities('吃饭+B站'), ['b站', '吃饭']);
    assert.deepEqual(splitActivities('B站+吃饭'), ['b站', '吃饭']);
    assert.equal(canonicalTitle('吃饭+B站'), canonicalTitle('B站+吃饭'));
    assert.equal(canonicalTitle('A ＋ B'), 'a+b');
    assert.deepEqual(splitActivities('B站、黑库图'), ['b站', '黑库图']);
});

test('拆段：中文逗号不是"同时做"的意思，不能拆', () => {
    // 真实数据里「出门，上花生课，回家」是**一件事**（一趟出门），拆成三段就错了
    assert.deepEqual(splitActivities('出门，上花生课，回家'), ['出门，上花生课，回家']);
    assert.deepEqual(splitActivities('出门,上花生课,回家'), ['出门,上花生课,回家']);
});

test('时长：跨天按绕圈算，非法时间算 0', () => {
    assert.equal(noteDurationMinutes(note({ timeStart: '09:00', timeEnd: '10:30' })), 90);
    assert.equal(noteDurationMinutes(note({ timeStart: '23:30', timeEnd: '00:30' })), 60);
    assert.equal(noteDurationMinutes(note({ timeStart: '乱写', timeEnd: '10:00' })), 0);
    assert.equal(noteDurationMinutes({}), 0);
});

test('相似度：完全相同为 1，差一个字会明显下降', () => {
    assert.equal(similarity('钓鱼', '钓鱼'), 1);
    assert.ok(similarity('钓鱼', '钓虾') > 0.4);
    assert.ok(similarity('30图小河道表水', '30图小河道') > 0.7);
    assert.ok(similarity('cs', 'b站') < 0.4);
});

test('同一件事的判定：包含关系要够长，短词不参与', () => {
    assert.equal(isSameActivity('30图小河道表水', '30图小河道'), true);
    assert.equal(isSameActivity('27图4m白鲑蹲资格', '27图4m白鲑'), true);
    // cs 是 csgo 的子串，但它们是两回事
    assert.equal(isSameActivity('cs', 'csgo'), false);
    // 老奥打狗 vs 老奥赌蛇：同地点不同行为，不该并
    assert.equal(isSameActivity('老奥打狗', '老奥赌蛇'), false);
    assert.equal(isSameActivity('钓鱼', '钓鱼'), true);
});

test('归并：包含关系要求短的占长的一半以上，避免"顺带提一句"被并进来', () => {
    // 真实数据里的反例：这句主体是一趟出门，只是顺带提到终末地
    assert.equal(isSameActivity('终末地', '出门和亲戚吃饭，回家，上花生课，坐地铁，路上终末地'), false);
    // 而这是真的同一件事
    assert.equal(isSameActivity('30图小河道', '30图小河道表水'), true);
    assert.equal(isSameActivity('小河道表水', '30图小河道表水'), true);
});

test('归并：不做传递合并，不会连成串把不相干的东西并进来', () => {
    // 这四条在真实数据里曾经被并成一簇：
    // 终末地 ← …路上终末地 ← b站，吃饭，终末地，看番 ← b站，吃饭
    const clusters = clusterActivities([
        { label: '终末地', minutes: 1442, count: 48 },
        { label: '出门和亲戚吃饭，回家，上花生课，坐地铁，路上终末地', minutes: 495, count: 1 },
        { label: 'b站，吃饭，终末地，看番', minutes: 260, count: 1 },
        { label: 'b站，吃饭', minutes: 160, count: 1 }
    ]);
    const top = clusters.find((c) => c.label === '终末地');
    assert.equal(top.members.length, 1, '终末地这一簇只应包含它自己');
    assert.ok(!clusters.some((c) => c.members.some((m) => m.label === 'b站，吃饭' && c.label !== 'b站，吃饭')),
        'b站，吃饭不该被并进别的簇');
});

test('归并：同一天里"上午/下午夏令营"这种能并上，且组名取时长最高的', () => {
    const clusters = clusterActivities([
        { label: '上午夏令营', minutes: 465, count: 23 },
        { label: '下午夏令营', minutes: 210, count: 8 },
        { label: '夏令营', minutes: 195, count: 6 },
        { label: '完全不相干的事', minutes: 100, count: 2 }
    ]);
    const camp = clusters.find((c) => c.label === '上午夏令营');
    assert.deepEqual(camp.members.map((m) => m.label).sort(), ['上午夏令营', '下午夏令营', '夏令营']);
    assert.equal(camp.minutes, 870);
    assert.equal(clusters.length, 2);
});

test('归并：相似条目合成一簇，组名取簇内时长最高的那个', () => {
    const clusters = clusterActivities([
        { label: '30图小河道', minutes: 120, count: 3 },
        { label: '30图小河道表水', minutes: 480, count: 9 },
        { label: 'cs', minutes: 600, count: 40 }
    ]);
    assert.equal(clusters.length, 2);
    const river = clusters.find((c) => c.label.includes('小河道'));
    assert.equal(river.label, '30图小河道表水', '组名应该是时长最高的写法');
    assert.equal(river.minutes, 600, '时长要合并');
    assert.equal(river.count, 12);
    assert.deepEqual(river.members.map((m) => m.label), ['30图小河道表水', '30图小河道']);
});

test('排序：归并结果按总时长倒序', () => {
    const clusters = clusterActivities([
        { label: 'a', minutes: 10, count: 1 },
        { label: 'b', minutes: 30, count: 1 },
        { label: 'c', minutes: 20, count: 1 }
    ]);
    assert.deepEqual(clusters.map((c) => c.label), ['b', 'c', 'a']);
});

test('排行：多段按时长均摊，总时长守恒', () => {
    const notes = [
        note({ id: 'a', content: '吃饭+B站', timeStart: '12:00', timeEnd: '13:00' })   // 60 分钟
    ];
    const split = rankActivities(notes, { allocation: ALLOCATION.SPLIT });
    assert.equal(Math.round(split.reduce((s, c) => s + c.minutes, 0)), 60, '均摊后总和应等于原始 60 分钟');
    assert.equal(split.find((c) => c.label === '吃饭').minutes, 30);
    assert.equal(split.find((c) => c.label === 'b站').minutes, 30);
    assert.equal(split.filter((c) => c.label === 'b站')[0].count, 1);
});

test('排行：全额口径下每段各计整条时长（会大于实际时间，但能看出出现时长）', () => {
    const notes = [note({ id: 'a', content: '吃饭+B站', timeStart: '12:00', timeEnd: '13:00' })];
    const full = rankActivities(notes, { allocation: ALLOCATION.FULL });
    assert.equal(full.find((c) => c.label === '吃饭').minutes, 60);
    assert.equal(full.find((c) => c.label === 'b站').minutes, 60);
    assert.equal(full.reduce((s, c) => s + c.minutes, 0), 120);
});

test('排行：顺序不同的多段标题会落到同一批活动上', () => {
    const notes = [
        note({ id: 'a', content: '吃饭+B站', timeStart: '12:00', timeEnd: '12:30' }),
        note({ id: 'b', content: 'B站+吃饭', timeStart: '13:00', timeEnd: '13:30' })
    ];
    const ranked = rankActivities(notes);
    // 拆成活动之后就不存在"组合条目"了——这正是避免重复计数的办法
    assert.deepEqual(ranked.map((c) => c.label).sort(), ['b站', '吃饭']);
    const eat = ranked.find((c) => c.label === '吃饭');
    const bili = ranked.find((c) => c.label === 'b站');
    assert.equal(eat.count, 2, '两条都算进了吃饭');
    assert.equal(bili.count, 2);
    assert.equal(eat.minutes, 30, '每条 30 分钟均摊一半，两条合计 30');
});

test('排行：同一条笔记里重复出现的活动只计一次条数', () => {
    const notes = [note({ id: 'a', content: 'cs+CS', timeStart: '09:00', timeEnd: '10:00' })];
    const ranked = rankActivities(notes);
    assert.equal(ranked.length, 1);
    assert.equal(ranked[0].count, 1, '两个段归一化后是同一个，条数不该算两次');
    assert.equal(ranked[0].minutes, 60);
});

test('排行：归并掉的簇带出 members 明细，未归并的不带', () => {
    const notes = [
        note({ id: 'a', content: '30图小河道表水', timeStart: '09:00', timeEnd: '11:00' }),
        note({ id: 'b', content: '30图小河道', timeStart: '12:00', timeEnd: '13:00' }),
        note({ id: 'c', content: 'cs', timeStart: '14:00', timeEnd: '15:00' })
    ];
    const ranked = rankActivities(notes);
    const river = ranked.find((c) => c.label === '30图小河道表水');
    assert.equal(river.members.length, 2);
    assert.equal(Math.round(river.minutes), 180);
    const cs = ranked.find((c) => c.label === 'cs');
    assert.deepEqual(cs.members, [], '没归并过的不需要明细');
});

test('按小时分布：用开始时间归桶', () => {
    const notes = [
        note({ id: 'a', timeStart: '09:30', timeEnd: '10:30' }),
        note({ id: 'b', timeStart: '09:50', timeEnd: '10:20' }),
        note({ id: 'c', timeStart: '23:30', timeEnd: '00:30' })
    ];
    const buckets = hourHistogram(notes);
    assert.equal(buckets.length, 24);
    assert.equal(buckets[9].count, 2);
    assert.equal(buckets[9].minutes, 90);
    assert.equal(buckets[23].minutes, 60, '跨天记录算在开始的那个小时');
});

test('按天汇总与概览', () => {
    const notes = [
        note({ id: 'a', date: '2026-05-14', timeStart: '09:00', timeEnd: '10:00' }),
        note({ id: 'b', date: '2026-05-14', timeStart: '11:00', timeEnd: '11:30' }),
        note({ id: 'c', date: '2026-05-13', timeStart: '09:00', timeEnd: '09:15' })
    ];
    const daily = dailyBuckets(notes);
    assert.equal(daily.get('2026-05-14').minutes, 90);
    assert.equal(daily.get('2026-05-14').count, 2);

    const info = overview(notes);
    assert.equal(info.count, 3);
    assert.equal(info.days, 2);
    assert.equal(info.minutes, 105);
    assert.equal(info.firstDate, '2026-05-13');
    assert.equal(info.lastDate, '2026-05-14');
    assert.equal(info.avgPerDay, 52.5);
});

test('时间轴：按开始时间排序，跨天记录截断到 24:00 并标记', () => {
    const notes = [
        note({ id: 'late', date: '2026-05-14', timeStart: '20:00', timeEnd: '21:00' }),
        note({ id: 'early', date: '2026-05-14', timeStart: '09:00', timeEnd: '10:00' }),
        note({ id: 'cross', date: '2026-05-14', timeStart: '23:30', timeEnd: '00:30' }),
        note({ id: 'other-day', date: '2026-05-13', timeStart: '09:00', timeEnd: '10:00' })
    ];
    const blocks = timelineBlocks(notes, '2026-05-14');
    assert.deepEqual(blocks.map((b) => b.id), ['early', 'late', 'cross']);
    const cross = blocks.find((b) => b.id === 'cross');
    assert.equal(cross.end, 1440, '应截断到 24:00');
    assert.equal(cross.minutes, 30);
    assert.equal(cross.crossDay, true);
});

test('范围过滤：今天 / 本周 / 本月 / 全部', () => {
    const now = new Date(2026, 4, 14);   // 2026-05-14 周四
    const notes = [
        note({ id: 'today', date: '2026-05-14' }),
        note({ id: 'monday', date: '2026-05-11' }),   // 本周一
        note({ id: 'sunday', date: '2026-05-10' }),   // 上周日
        note({ id: 'firstOfMonth', date: '2026-05-01' }),
        note({ id: 'lastMonth', date: '2026-04-30' })
    ];
    const ids = (range) => filterByRange(notes, range, now).map((n) => n.id);
    assert.deepEqual(ids('today'), ['today']);
    assert.deepEqual(ids('week'), ['today', 'monday'], '周日算下一周，本周从周一开始');
    assert.deepEqual(ids('month'), ['today', 'monday', 'sunday', 'firstOfMonth']);
    assert.equal(ids('all').length, 5);
});

test('热力图：给出连续 N 天，缺失的日期补 0', () => {
    const now = new Date(2026, 4, 14);
    const notes = [note({ id: 'a', date: '2026-05-14', timeStart: '09:00', timeEnd: '10:00' })];
    const days = heatmapDays(notes, { days: 7, now });
    assert.equal(days.length, 7);
    assert.equal(days[6].date, '2026-05-14');
    assert.equal(days[6].minutes, 60);
    assert.equal(days[0].date, '2026-05-08');
    assert.equal(days[0].minutes, 0);
});

test('时长文案', () => {
    assert.equal(formatMinutes(0), '0分钟');
    assert.equal(formatMinutes(45), '45分钟');
    assert.equal(formatMinutes(60), '1小时');
    assert.equal(formatMinutes(90), '1小时30分钟');
});
