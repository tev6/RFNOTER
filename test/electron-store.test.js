import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createNoteStore, USER_ID_RE } from '../electron/store.js';

function tempStore() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rfnoter-store-'));
    return { dir, store: createNoteStore(dir) };
}

const note = (overrides = {}) => ({
    id: 'n1', date: '2026-05-14', timeStart: '09:00', timeEnd: '09:40',
    content: '你好', tag: '', color: '', details: '',
    expanded: false, createdAt: 1, updatedAt: 1, ...overrides
});

test('写入后能原样读回', () => {
    const { store } = tempStore();
    const result = store.write('user-a', [note()]);
    assert.equal(result.ok, true);
    assert.equal(result.count, 1);

    const back = store.read('user-a');
    assert.equal(back.ok, true);
    assert.equal(back.exists, true);
    assert.deepEqual(back.notes, [note()]);
});

test('文件不存在时返回空数组而不是报错', () => {
    const { store } = tempStore();
    const result = store.read('never-saved');
    assert.equal(result.ok, true);
    assert.deepEqual(result.notes, []);
    assert.equal(result.exists, false);
});

test('空文件视为空数组', () => {
    const { store } = tempStore();
    fs.writeFileSync(store.fileFor('empty'), '   \n', 'utf8');
    const result = store.read('empty');
    assert.equal(result.ok, true);
    assert.deepEqual(result.notes, []);
});

test('文件损坏时返回错误而不是抛异常', () => {
    const { store } = tempStore();
    fs.writeFileSync(store.fileFor('broken'), '{not json', 'utf8');
    const result = store.read('broken');
    assert.equal(result.ok, false);
    assert.match(result.error, /读取失败/);
});

test('根节点不是数组时明确报错', () => {
    const { store } = tempStore();
    fs.writeFileSync(store.fileFor('object'), '{"a":1}', 'utf8');
    const result = store.read('object');
    assert.equal(result.ok, false);
    assert.match(result.error, /不是数组/);
});

test('拒绝会穿越目录的 userId（并且不落任何文件）', () => {
    const { store } = tempStore();
    for (const bad of ['../../evil', 'a/b', '..', 'a\\b', '', 'x'.repeat(200)]) {
        assert.equal(store.fileFor(bad), null, `fileFor(${JSON.stringify(bad)}) 应为 null`);
        assert.equal(store.read(bad).ok, false);
        assert.equal(store.write(bad, [note()]).ok, false);
    }
    assert.deepEqual(fs.readdirSync(store.dataDir), []);
    assert.equal(fs.existsSync(path.join(store.dataDir, '..', 'evil.json')), false);
});

test('拒绝非数组数据', () => {
    const { store } = tempStore();
    assert.equal(store.write('user-a', { a: 1 }).ok, false);
    assert.equal(store.write('user-a', 'nope').ok, false);
    assert.equal(store.write('user-a', null).ok, false);
});

test('写入是原子替换，不留临时文件', () => {
    const { store } = tempStore();
    store.write('user-a', [note()]);
    store.write('user-a', [note({ content: '第二次' })]);
    const leftovers = fs.readdirSync(store.dataDir).filter((f) => f.endsWith('.tmp'));
    assert.deepEqual(leftovers, []);
    assert.equal(store.read('user-a').notes[0].content, '第二次');
});

test('覆盖写入会丢掉旧内容（验证确实是整体替换）', () => {
    const { store } = tempStore();
    store.write('user-a', [note(), note({ id: 'n2' })]);
    store.write('user-a', [note()]);
    assert.equal(store.read('user-a').notes.length, 1);
});

test('listUserIds 只认合法文件并按修改时间倒序', async () => {
    const { dir, store } = tempStore();
    store.write('older', [note()]);
    await new Promise((r) => setTimeout(r, 10));
    store.write('newer', [note()]);
    fs.writeFileSync(path.join(dir, 'notes_bad!id.json'), '[]', 'utf8');
    fs.writeFileSync(path.join(dir, 'random.txt'), '', 'utf8');

    const ids = store.listUserIds().map((entry) => entry.userId);
    assert.deepEqual(ids, ['newer', 'older']);
});

test('migrateFrom 只复制缺失的文件，不覆盖已有数据', () => {
    const { dir, store } = tempStore();
    const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rfnoter-legacy-'));
    store.write('existing', [note({ content: '新数据' })]);
    fs.writeFileSync(path.join(legacyDir, 'notes_existing.json'), JSON.stringify([note({ content: '旧数据' })]), 'utf8');
    fs.writeFileSync(path.join(legacyDir, 'notes_fresh.json'), JSON.stringify([note({ id: 'f1' })]), 'utf8');
    fs.writeFileSync(path.join(legacyDir, 'ignore.txt'), 'x', 'utf8');

    const copied = store.migrateFrom(legacyDir);
    assert.deepEqual(copied, ['notes_fresh.json']);
    assert.equal(store.read('existing').notes[0].content, '新数据', '不应覆盖已有文件');
    assert.equal(store.read('fresh').notes[0].id, 'f1');
    assert.deepEqual(fs.readdirSync(dir).sort(), ['notes_existing.json', 'notes_fresh.json']);
});

test('USER_ID_RE 与 server.js 的白名单保持一致', () => {
    assert.ok(USER_ID_RE.test('3f2a-1759000000000'));
    assert.ok(!USER_ID_RE.test('../x'));
    assert.ok(!USER_ID_RE.test('a b'));
});

/* ---------------- 备份与轮转（B1） ---------------- */

test('备份：生成一份可解析的副本，并返回条数', () => {
    const { store } = tempStore();
    store.write('u1', [note(), note({ id: 'n2' })]);

    const result = store.backup('u1', { force: true });
    assert.equal(result.ok, true);
    assert.equal(result.valid, true);
    assert.equal(result.count, 2, '备份里应该有 2 条');
    assert.match(result.file, /^notes_u1-\d{8}-\d{6}\.json$/);
    assert.deepEqual(JSON.parse(fs.readFileSync(result.path, 'utf8')).length, 2);
});

test('备份：一小时内不重复，force 可以绕过', () => {
    const { store } = tempStore();
    store.write('u1', [note()]);

    const first = store.backup('u1', { force: true });
    assert.equal(first.skipped, undefined);

    const second = store.backup('u1');
    assert.equal(second.ok, true);
    assert.equal(second.skipped, 'throttled', '刚备份过就应该跳过');
    assert.equal(store.listBackups('u1').length, 1);

    const forced = store.backup('u1', { force: true });
    assert.equal(forced.skipped, undefined);
    assert.equal(store.listBackups('u1').length, 2);
});

test('备份：没有笔记文件、或是空文件时不产生垃圾副本', () => {
    const { dir, store } = tempStore();
    assert.equal(store.backup('nobody').skipped, 'no-file');

    fs.writeFileSync(path.join(dir, 'notes_u2.json'), '', 'utf8');
    assert.equal(store.backup('u2').skipped, 'empty');
    assert.equal(store.listBackups('u2').length, 0);
});

test('备份：源文件损坏时仍然留下副本，但标记为不可解析', () => {
    const { dir, store } = tempStore();
    // 模拟被外部工具写坏的文件
    fs.writeFileSync(path.join(dir, 'notes_u3.json'), '[{"id":"a",', 'utf8');

    const result = store.backup('u3', { force: true });
    assert.equal(result.ok, true, '备份动作本身要成功，坏文件也是证据');
    assert.equal(result.valid, false, '但要如实标记内容不可解析');
    assert.equal(fs.existsSync(result.path), true);
});

test('备份：轮转保留最近 24 份 + 最近 30 天每天一份', () => {
    const { store } = tempStore();
    store.write('u1', [note()]);

    const DAY = 24 * 60 * 60 * 1000;
    const base = Date.now();
    // 造 40 天份的备份；mtime 要在备份之后改，否则下一次轮转看到的还是"刚刚"
    for (let back = 39; back >= 0; back -= 1) {
        const when = base - back * DAY;
        const created = store.backup('u1', { force: true, now: when });
        assert.equal(created.ok, true);
        fs.utimesSync(created.path, new Date(when), new Date(when));
    }

    const kept = store.listBackups('u1');
    assert.equal(kept.length, 30, '40 天应被压到 30 天（每天一份），而不是全留或只剩最近 24 份');
    // 最老的一份应该是 29 天前，30 天前的已被清掉
    const oldest = kept[kept.length - 1];
    const ageDays = Math.round((base - oldest.mtimeMs) / DAY);
    assert.equal(ageDays, 29, `最老的备份应该是 29 天前，实际 ${ageDays} 天`);
});

test('备份：同一秒内连续备份不会互相覆盖', () => {
    const { store } = tempStore();
    const when = Date.now();
    store.write('u1', [note()]);
    const before = store.backup('u1', { force: true, now: when });

    // 模拟"写完一次之后立刻又强制备份"——两次落在同一秒
    store.write('u1', [note(), note({ id: 'n2' })]);
    const after = store.backup('u1', { force: true, now: when });

    assert.notEqual(after.file, before.file, '撞名时必须换一个名字，不能覆盖');
    assert.equal(store.listBackups('u1').length, 2);
    assert.equal(JSON.parse(fs.readFileSync(before.path, 'utf8')).length, 1, '删除前那份必须还在');
    assert.equal(JSON.parse(fs.readFileSync(after.path, 'utf8')).length, 2);
});

test('备份：一天之内产生的多份只保留最近 24 份', () => {
    const { store } = tempStore();
    store.write('u1', [note()]);

    for (let i = 0; i < 40; i += 1) {
        // 名字按秒递增，避免重名互相覆盖
        store.backup('u1', { force: true, now: Date.now() + i * 1000 });
    }
    const kept = store.listBackups('u1').length;
    assert.ok(kept <= 24, `同一天内应只保留 24 份，实际 ${kept}`);
    assert.ok(kept >= 20, `不该清得只剩个位数，实际 ${kept}`);
});

test('备份：备份目录不会被当成一个 userId', () => {
    const { dir, store } = tempStore();
    store.write('u1', [note()]);
    store.backup('u1', { force: true });

    assert.equal(fs.existsSync(path.join(dir, 'backups')), true);
    assert.deepEqual(store.listUserIds().map((entry) => entry.userId), ['u1']);
});

test('备份：userId 非法时拒绝，不会穿越到别的目录', () => {
    const { store } = tempStore();
    const result = store.backup('../evil');
    assert.equal(result.ok, false);
    assert.deepEqual(store.listBackups('../evil'), []);
});
