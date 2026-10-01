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
