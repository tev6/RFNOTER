/**
 * 输入补全纯逻辑测试。suggest.js 不依赖 DOM，直接调用。
 *
 * 这里的用例大多照着**真实数据的形状**写：用户的标题里 36% 含 `+`
 * （`CS+终末地+B站`），高频词是 `CS`/`B站` 这种极短的词，
 * 而长尾有大量只出现过一次的长句。补全逻辑必须在这三种情况下都成立。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildVocabulary, topActivities, currentFragment,
    searchSuggestions, applySuggestion, remainderOf
} from '../public/js/suggest.js';

let seq = 0;
const note = (content, overrides = {}) => ({
    id: `n${seq += 1}`, date: '2026-10-01', timeStart: '09:00', timeEnd: '10:00',
    content, tag: '', color: '', details: '',
    createdAt: 1000, updatedAt: 1000, ...overrides
});

/* ------------------------------------------------------------------ */
/* 词表：按活动段聚合，而不是按整条标题                                  */
/* ------------------------------------------------------------------ */

test('词表按活动段拆开统计：合并写法不再稀释高频词', () => {
    // 这正是老实现（按整条 content 聚合）的病灶：
    // `CS` 单独出现 1 次、`CS+B站` 1 次，按整条算是两个各 1 次的低频项，
    // 谁都进不了"常用"；按段算 `CS` 是 2 次，才是它真实的热度。
    const notes = [note('CS'), note('CS+B站')];
    const vocab = buildVocabulary(notes);
    const cs = vocab.find((v) => v.label === 'CS');
    assert.equal(cs.count, 2);
});

test('词表：同一条笔记里重复出现的段只算一次', () => {
    // `cs+CS` 是同一条笔记里的重复，不该自己刷自己的词频
    const vocab = buildVocabulary([note('cs+CS')]);
    assert.equal(vocab.find((v) => v.label === 'cs').count, 1);
});

test('词表：全角与半角视为同一个词', () => {
    const vocab = buildVocabulary([note('ＰＳ'), note('PS')]);
    assert.equal(vocab.length, 1);
    assert.equal(vocab[0].count, 2);
});

test('词表：lastUsedAt 取最近一次使用时间', () => {
    const vocab = buildVocabulary([
        note('CS', { createdAt: 500 }),
        note('CS', { createdAt: 9000 })
    ]);
    assert.equal(vocab.find((v) => v.label === 'CS').lastUsedAt, 9000);
});

test('词表：空标题、无内容笔记被忽略', () => {
    assert.deepEqual(buildVocabulary([note(''), note('   '), note(null), null]), []);
});

/* ------------------------------------------------------------------ */
/* 常用条目                                                            */
/* ------------------------------------------------------------------ */

test('常用条目：只用过一次的不进榜', () => {
    const notes = [note('CS'), note('CS'), note('只写过一次的长句')];
    const labels = topActivities(notes).map((e) => e.label);
    assert.deepEqual(labels, ['CS']);
});

test('补全候选：只写过一次的也不进候选池', () => {
    // 真实数据的形状：74% 的活动段只出现过一次（564 段里 416 段），
    // 它们是长尾噪音。曾经这里漏了阈值，导致打 `C` 时 `Claude被封号`(1 次)
    // 排在 `Coding`(5 次) 前面——补全和常用条目用了两套标准。
    const notes = [
        note('Coding'), note('Coding'), note('Coding'), note('Coding'), note('Coding'),
        note('Claude被封号'),
        note('C2'), note('C2')
    ];
    const labels = searchSuggestions(notes, 'C', { limit: 10 }).map((s) => s.label);
    assert.ok(!labels.includes('Claude被封号'), '只出现 1 次的不该出现在候选里');
    assert.equal(labels[0], 'Coding', '次数最多的排最前');
    assert.ok(labels.includes('C2'));
});

test('补全候选：低频噪音不会挤掉中频的（排序不受影响）', () => {
    const notes = [
        note('B站'), note('B站'), note('B站'),
        note('B占'),                    // 只写过一次的错别字
        note('B站直播'), note('B站直播')
    ];
    const labels = searchSuggestions(notes, 'B', { limit: 10 }).map((s) => s.label);
    assert.ok(!labels.includes('B占'), '只写一次的错别字不该来打扰');
    assert.deepEqual(labels.slice(0, 2), ['B站', 'B站直播']);
});

test('常用条目：近期使用加权能盖过单纯堆次数', () => {
    const now = Date.now();
    const notes = [
        // 旧习惯：次数多，但都是 30 天前
        ...Array.from({ length: 4 }, () => note('B站', { createdAt: now - 30 * 86400000 })),
        // 最近在做：次数少一点，但今天刚用过
        ...Array.from({ length: 3 }, () => note('终末地', { createdAt: now - 60000 }))
    ];
    const labels = topActivities(notes).map((e) => e.label);
    assert.equal(labels[0], '终末地', '最近在做的应当排在旧习惯前面');
});

test('常用条目：limit 生效', () => {
    const notes = [note('a活动'), note('a活动'), note('b活动'), note('b活动'), note('c活动'), note('c活动')];
    assert.equal(topActivities(notes, { limit: 2 }).length, 2);
});

/* ------------------------------------------------------------------ */
/* 当前段定位                                                          */
/* ------------------------------------------------------------------ */

test('当前段：没有分隔符时整串就是当前段', () => {
    assert.deepEqual(currentFragment('CS'), { index: 0, fragment: 'CS', prefix: '' });
});

test('当前段：取最后一个分隔符之后的部分', () => {
    assert.deepEqual(currentFragment('CS+终'), { index: 3, fragment: '终', prefix: 'CS+' });
});

test('当前段：多种分隔符都认，且保留分隔符原文', () => {
    assert.deepEqual(currentFragment('CS＋终').fragment, '终');
    assert.deepEqual(currentFragment('CS、终').fragment, '终');
    assert.deepEqual(currentFragment('CS/终').fragment, '终');
    // `＋` 是全角，占一个字符，所以 index 是 2 而不是 3
    assert.equal(currentFragment('CS＋终').index, 3);
});

test('当前段：差一个字符时也认（用户正打到一半）', () => {
    const { fragment, index } = currentFragment('CS+X');
    assert.equal(fragment, 'X');
    assert.equal(index, 3);
});

/* ------------------------------------------------------------------ */
/* 候选搜索                                                            */
/* ------------------------------------------------------------------ */

test('搜索：空输入不给候选', () => {
    const notes = [note('CS'), note('CS')];
    assert.deepEqual(searchSuggestions(notes, ''), []);
    assert.deepEqual(searchSuggestions(notes, '   '), []);
});

test('搜索：只补当前段，不受前面段影响', () => {
    // 输入 `CS+终`，应当补出 `终末地`，而不是要求整串匹配 `CS+终末地`
    const notes = [note('CS+终末地'), note('CS+终末地')];
    const hits = searchSuggestions(notes, 'CS+终');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].label, '终末地');
});

test('搜索：前缀命中排在子串命中前面', () => {
    const notes = [
        note('B站'), note('B站'),
        note('看B站直播'), note('看B站直播')
    ];
    const hits = searchSuggestions(notes, 'b');
    assert.equal(hits[0].label, 'B站', '以 b 开头的应当排最前');
});

test('搜索：中文没有词边界，子串命中也要给', () => {
    // 打「河」想找「30图小河道」是最自然的预期
    const notes = [note('30图小河道'), note('30图小河道')];
    const hits = searchSuggestions(notes, '河');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].label, '30图小河道');
});

test('搜索：已经打完这一整段就不再提示自己', () => {
    const notes = [note('CS'), note('CS')];
    assert.deepEqual(searchSuggestions(notes, 'CS'), []);
});

test('搜索：候选带 rest，用于灰字预览', () => {
    const notes = [note('终末地'), note('终末地')];
    const hits = searchSuggestions(notes, '终');
    assert.equal(hits[0].label, '终末地');
    assert.equal(hits[0].rest, '末地');
});

test('搜索：大小写不敏感，但填充保留用户原本的写法', () => {
    const notes = [note('CS'), note('CS')];
    assert.equal(searchSuggestions(notes, 'cs').length, 0, '整段相同不提示');

    const notes2 = [note('CSGO'), note('CSGO')];
    const hits = searchSuggestions(notes2, 'cs');
    // 命中了，但 label 必须是用户自己写的 `CSGO`——归一化只用于比较，不用于显示
    assert.equal(hits[0].label, 'CSGO');
});

test('搜索：全角词也能被半角输入命中', () => {
    // label 保留全角 `ＰＳ`，比较走归一化；否则永远匹配不上
    const notes = [note('ＰＳ'), note('ＰＳ')];
    const hits = searchSuggestions(notes, 'ps');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].label, 'ＰＳ', '填充时保留全角原样');
});

test('常用条目：同一组里挑出现最多的写法，且不被小写化', () => {
    const notes = [note('CSGO'), note('CSGO'), note('csgo')];
    const labels = topActivities(notes).map((e) => e.label);
    assert.deepEqual(labels, ['CSGO']);
});

test('搜索：刚打完分隔符时提示下一段（用全库高频）', () => {
    // 用户打完 `CS+` 时当前段还是空的，这正是"同时做多件事"的输入场景。
    // 此时提示全库高频词，而不是共现推荐——真实数据里共现太稀，不稳定。
    const notes = [
        note('CS'), note('CS'),
        note('B站'), note('B站'), note('B站'),
        note('吃饭'), note('吃饭')
    ];
    const hits = searchSuggestions(notes, 'CS+');
    const labels = hits.map((h) => h.label);
    assert.deepEqual(labels, ['B站', '吃饭'], '按频次给出，且不含已在本条里的 CS');
    assert.equal(hits[0].rest, '', '空段没有"还差多少字"');
});

test('搜索：空输入不提示（交给常用条目 chips）', () => {
    const notes = [note('CS'), note('CS')];
    assert.deepEqual(searchSuggestions(notes, ''), []);
});

test('搜索：下一段推荐排除本条已用过的段', () => {
    const notes = [note('B站'), note('B站'), note('吃饭'), note('吃饭'), note('洗澡'), note('洗澡')];
    const labels = searchSuggestions(notes, 'B站+').map((h) => h.label);
    assert.ok(!labels.includes('B站'), '已经在本条里的不该再推荐');
    assert.deepEqual(labels, ['吃饭', '洗澡']);
});

/* ------------------------------------------------------------------ */
/* 填充回输入框                                                        */
/* ------------------------------------------------------------------ */

test('填充：只替换当前段，保留前面的段', () => {
    assert.equal(applySuggestion('CS+终', '终末地'), 'CS+终末地');
});

test('填充：保留当前段后面的内容（用户从中间改词）', () => {
    // 用户把光标放中间改词：`CS+终末地` 里的人想改 `CS` 那段
    assert.equal(applySuggestion('CS+X', '终末地'), 'CS+终末地');
});

test('填充：空输入时直接成为内容', () => {
    assert.equal(applySuggestion('', 'CS'), 'CS');
});

test('填充：保留分隔符的原文写法（全角不改成半角）', () => {
    assert.equal(applySuggestion('CS＋终', '终末地'), 'CS＋终末地');
});

test('remainderOf：算出差多少字', () => {
    assert.equal(remainderOf('终末地', '终'), '末地');
    assert.equal(remainderOf('终末地', ''), '');
    assert.equal(remainderOf('终末地', '终末地'), '');
});
