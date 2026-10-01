import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createApp } from '../server.js';

/** 起一个监听随机端口的测试服务，返回 baseUrl 与清理函数。 */
async function withServer(options, run) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rfnoter-test-'));
    const app = createApp({ dataDir, ...options });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address();
    try {
        await run({ baseUrl: `http://127.0.0.1:${port}`, dataDir });
    } finally {
        await new Promise((resolve) => server.close(resolve));
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
}

test('正常写入与读取', async () => {
    await withServer({}, async ({ baseUrl, dataDir }) => {
        const notes = [{ id: 'n1', content: '你好' }];
        const postRes = await fetch(`${baseUrl}/api/notes/user-a`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(notes)
        });
        assert.equal(postRes.status, 200);

        const getRes = await fetch(`${baseUrl}/api/notes/user-a`);
        assert.equal(getRes.status, 200);
        assert.deepEqual(await getRes.json(), notes);

        // 写入后不应残留临时文件
        const leftovers = fs.readdirSync(dataDir).filter((f) => f.endsWith('.tmp'));
        assert.deepEqual(leftovers, []);
    });
});

test('未保存过的用户返回空数组', async () => {
    await withServer({}, async ({ baseUrl }) => {
        const res = await fetch(`${baseUrl}/api/notes/never-saved`);
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), []);
    });
});

test('路径穿越被拒绝，且不会在数据目录之外落文件', async () => {
    await withServer({}, async ({ baseUrl, dataDir }) => {
        const payload = JSON.stringify({ pwned: true });

        // 编码后的 ..%2F 不会被 URL 规范化，会真正到达路由，必须由 userId 白名单挡下
        const traversal = await fetch(`${baseUrl}/api/notes/..%2F..%2Fescaped`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: payload
        });
        assert.equal(traversal.status, 400);
        assert.equal((await fetch(`${baseUrl}/api/notes/..%2F..%2Fescaped`)).status, 400);

        // 未编码的 .. 会在路由匹配前被规范化掉，同样不能落到 200
        for (const userId of ['..', 'a/b', 'notes_..', '%2e%2e']) {
            const res = await fetch(`${baseUrl}/api/notes/${userId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: payload
            });
            assert.notEqual(res.status, 200, `userId=${userId} 不应被接受`);
        }

        const parentDir = path.dirname(dataDir);
        assert.equal(fs.existsSync(path.join(parentDir, 'escaped.json')), false);
        assert.equal(fs.existsSync(path.join(parentDir, 'notes___escaped.json')), false);
        assert.deepEqual(
            fs.readdirSync(dataDir).filter((f) => !f.startsWith('notes_')),
            []
        );
    });
});

test('请求体必须是数组', async () => {
    await withServer({}, async ({ baseUrl }) => {
        const res = await fetch(`${baseUrl}/api/notes/user-b`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ not: 'an array' })
        });
        assert.equal(res.status, 400);
        assert.match((await res.json()).error, /数组/);
    });
});

test('超过体积上限时返回 413 而不是静默失败', async () => {
    await withServer({ maxBody: '10kb' }, async ({ baseUrl }) => {
        const big = [{ id: 'x', content: 'x'.repeat(20 * 1024) }];
        const res = await fetch(`${baseUrl}/api/notes/user-c`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(big)
        });
        assert.equal(res.status, 413);
        assert.match((await res.json()).error, /过大/);
    });
});

test('数据文件损坏时返回 JSON 错误而不是 HTML', async () => {
    await withServer({}, async ({ baseUrl, dataDir }) => {
        fs.writeFileSync(path.join(dataDir, 'notes_broken.json'), '{not json', 'utf8');
        const res = await fetch(`${baseUrl}/api/notes/broken`);
        assert.equal(res.status, 500);
        assert.match(res.headers.get('content-type'), /application\/json/);
        assert.match((await res.json()).error, /读取笔记失败/);
    });
});

test('未知 API 返回 JSON 404，静态目录仍可访问', async () => {
    await withServer({}, async ({ baseUrl }) => {
        const apiRes = await fetch(`${baseUrl}/api/nope`);
        assert.equal(apiRes.status, 404);
        assert.match(apiRes.headers.get('content-type'), /application\/json/);

        const pageRes = await fetch(`${baseUrl}/`);
        assert.equal(pageRes.status, 200);
        assert.match(await pageRes.text(), /闪录/);

        // 本地化后的静态资源也要能拿到（桌面端离线可用的前提）
        const vendorRes = await fetch(`${baseUrl}/vendor/tailwind.js`);
        assert.equal(vendorRes.status, 200);
        const iconRes = await fetch(`${baseUrl}/icon.png`);
        assert.equal(iconRes.status, 200);
    });
});
