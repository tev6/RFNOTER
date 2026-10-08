import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    parseVersion, compareVersions, pickLatestRelease, pickInstallerAsset, formatBytes,
    createUpdateState, createUpdateChecker, CHECK_THROTTLE_MS, MANUAL_THROTTLE_MS
} from '../electron/updater.js';

/* ------------------------------------------------------------------ */
/* 版本号解析与比较                                                     */
/* ------------------------------------------------------------------ */

test('版本号解析：接受带 v 前缀与纯数字两种写法', () => {
    assert.deepEqual(parseVersion('2.13.0').numbers, [2, 13, 0]);
    assert.deepEqual(parseVersion('v2.13.0').numbers, [2, 13, 0]);
    assert.deepEqual(parseVersion('  v1.2.3  ').numbers, [1, 2, 3]);
    assert.equal(parseVersion('2.13.0').prerelease, null);
});

test('版本号解析：预发布标记被保留', () => {
    assert.equal(parseVersion('2.14.0-beta.1').prerelease, 'beta.1');
});

test('版本号解析：不认识的写法返回 null（不能当成有新版）', () => {
    for (const bad of ['', null, undefined, 'latest', '2.13', 'v2', 'abc1.2.3', '2.13.0.1']) {
        assert.equal(parseVersion(bad), null, `应判为无法解析：${String(bad)}`);
    }
});

test('版本比较：逐段数字比较，不是字符串比较', () => {
    // 字符串比较下 '2.9.0' > '2.13.0'，这是这类功能最常见的坑
    assert.ok(compareVersions('2.13.0', '2.9.0') > 0);
    assert.ok(compareVersions('2.9.0', '2.13.0') < 0);
    assert.equal(compareVersions('2.13.0', 'v2.13.0'), 0);
    assert.ok(compareVersions('3.0.0', '2.99.99') > 0);
});

test('版本比较：正式版高于同号预发布版', () => {
    assert.ok(compareVersions('2.14.0', '2.14.0-beta.1') > 0);
    assert.ok(compareVersions('2.14.0-beta.1', '2.14.0') < 0);
});

test('版本比较：任一侧无法解析时返回 null，而不是猜测', () => {
    assert.equal(compareVersions('2.13.0', 'latest'), null);
    assert.equal(compareVersions('bogus', '2.13.0'), null);
});

/* ------------------------------------------------------------------ */
/* 从 API 响应里挑版本                                                  */
/* ------------------------------------------------------------------ */

const release = (over = {}) => ({
    tag_name: 'v2.13.0', name: 'v2.13.0 更新检查', draft: false, prerelease: false,
    body: '说明', published_at: '2026-10-09T00:00:00Z',
    html_url: 'https://github.com/tev6/RFNOTER/releases/tag/v2.13.0',
    assets: [{ name: 'RFNOTER-Setup-2.13.0.exe', browser_download_url: 'https://x/a.exe', size: 111666621 }],
    ...over
});

test('挑最新版：多条里选版本号最大的', () => {
    const picked = pickLatestRelease([
        release({ tag_name: 'v2.9.0' }),
        release({ tag_name: 'v2.13.0' }),
        release({ tag_name: 'v2.10.0' })
    ]);
    assert.equal(picked.version, '2.13.0');
});

test('挑最新版：跳过 draft 与 prerelease', () => {
    const picked = pickLatestRelease([
        release({ tag_name: 'v2.14.0', draft: true }),
        release({ tag_name: 'v2.15.0', prerelease: true }),
        release({ tag_name: 'v2.13.0' })
    ]);
    assert.equal(picked.version, '2.13.0');
});

test('挑最新版：全部是 draft/prerelease 时返回 null', () => {
    assert.equal(pickLatestRelease([
        release({ tag_name: 'v2.14.0', draft: true }),
        release({ tag_name: 'v2.15.0', prerelease: true })
    ]), null);
});

test('挑最新版：tag 不认识时整个忽略，不产生"有新版"', () => {
    assert.equal(pickLatestRelease([release({ tag_name: 'nightly' })]), null);
    assert.equal(pickLatestRelease([]), null);
    assert.equal(pickLatestRelease(null), null);
});

test('挑最新版：只传单个对象（/releases/latest 的形态）也能用', () => {
    const picked = pickLatestRelease(release({ tag_name: 'v2.13.0' }));
    assert.equal(picked.version, '2.13.0');
});

test('挑最新版：带出下载地址与体积文本', () => {
    const picked = pickLatestRelease([release()]);
    assert.equal(picked.downloadName, 'RFNOTER-Setup-2.13.0.exe');
    assert.equal(picked.downloadUrl, 'https://x/a.exe');
    assert.match(picked.downloadSizeText, /MB$/);
    assert.equal(picked.pageUrl, 'https://github.com/tev6/RFNOTER/releases/tag/v2.13.0');
});

test('挑安装包：优先 Setup，其次最大的 exe', () => {
    assert.equal(pickInstallerAsset([
        { name: 'RFNOTER-2.13.0.exe', size: 10, browser_download_url: 'u1' },
        { name: 'RFNOTER-Setup-2.13.0.exe', size: 5, browser_download_url: 'u2' }
    ]).name, 'RFNOTER-Setup-2.13.0.exe');

    assert.equal(pickInstallerAsset([
        { name: 'small.exe', size: 10, browser_download_url: 'u1' },
        { name: 'big.exe', size: 99, browser_download_url: 'u2' }
    ]).name, 'big.exe');
});

test('挑安装包：没有 exe 附件时返回 null', () => {
    assert.equal(pickInstallerAsset([{ name: 'a.zip' }]), null);
    assert.equal(pickInstallerAsset([]), null);
    assert.equal(pickInstallerAsset(undefined), null);
});

test('体积格式化：MB / KB，非法值返回空串', () => {
    assert.equal(formatBytes(111666621), '106.5 MB');
    assert.equal(formatBytes(2048), '2 KB');
    assert.equal(formatBytes(0), '');
    assert.equal(formatBytes(null), '');
});

/* ------------------------------------------------------------------ */
/* 状态文件                                                             */
/* ------------------------------------------------------------------ */

test('状态文件：写进去能读回来', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rfnoter-upd-'));
    const state = createUpdateState(path.join(dir, 'update-state.json'));
    assert.equal(state.lastCheckAt(), 0);
    assert.equal(state.dismissedVersion(), null);

    state.write({ lastCheckAt: 12345, dismissedVersion: '2.13.0' });
    assert.equal(state.lastCheckAt(), 12345);
    assert.equal(state.dismissedVersion(), '2.13.0');
});

test('状态文件：文件不存在或损坏时返回默认值而不是抛异常', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rfnoter-upd-'));
    const missing = createUpdateState(path.join(dir, 'nope.json'));
    assert.equal(missing.lastCheckAt(), 0);
    assert.equal(missing.dismissedVersion(), null);

    const broken = path.join(dir, 'broken.json');
    fs.writeFileSync(broken, '{not json', 'utf8');
    const state = createUpdateState(broken);
    assert.equal(state.lastCheckAt(), 0);
    assert.equal(state.dismissedVersion(), null);
    // 坏文件仍然可以被覆盖修复
    assert.ok(state.write({ lastCheckAt: 7 }));
    assert.equal(state.lastCheckAt(), 7);
});

test('状态文件：lastCheckAt 是垃圾值时当 0 处理（否则节流会算错）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rfnoter-upd-'));
    const file = path.join(dir, 's.json');
    fs.writeFileSync(file, JSON.stringify({ lastCheckAt: 'yesterday' }), 'utf8');
    assert.equal(createUpdateState(file).lastCheckAt(), 0);
});

/* ------------------------------------------------------------------ */
/* 检查器                                                               */
/* ------------------------------------------------------------------ */

function fakeFetch(handler) {
    const calls = [];
    const impl = async (url, options) => {
        calls.push({ url, options });
        return handler(url, options);
    };
    impl.calls = calls;
    return impl;
}

const jsonResponse = (body, { ok = true, status = 200 } = {}) => ({
    ok, status, json: async () => body
});

function tempState() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rfnoter-upd-'));
    return createUpdateState(path.join(dir, 'update-state.json'));
}

test('检查器：当前 2.12.0、线上 2.13.0 时报告有新版本', async () => {
    const checker = createUpdateChecker({
        currentVersion: '2.12.0',
        state: tempState(),
        fetchImpl: fakeFetch(() => jsonResponse([release({ tag_name: 'v2.13.0' })]))
    });
    const result = await checker.check();
    assert.equal(result.ok, true);
    assert.equal(result.hasUpdate, true);
    assert.equal(result.latestVersion, '2.13.0');
    assert.equal(result.currentVersion, '2.12.0');
});

test('检查器：已经是最新版时 hasUpdate 为 false', async () => {
    const checker = createUpdateChecker({
        currentVersion: '2.13.0',
        state: tempState(),
        fetchImpl: fakeFetch(() => jsonResponse([release({ tag_name: 'v2.13.0' })]))
    });
    const result = await checker.check();
    assert.equal(result.ok, true);
    assert.equal(result.hasUpdate, false);
});

test('检查器：本地版本更新时不会倒着提示（开发态常见）', async () => {
    const checker = createUpdateChecker({
        currentVersion: '2.99.0',
        state: tempState(),
        fetchImpl: fakeFetch(() => jsonResponse([release({ tag_name: 'v2.13.0' })]))
    });
    const result = await checker.check();
    assert.equal(result.hasUpdate, false);
});

test('检查器：请求带上 GitHub 必需的 User-Agent', async () => {
    const impl = fakeFetch(() => jsonResponse([release()]));
    const checker = createUpdateChecker({
        currentVersion: '2.12.0', state: tempState(), fetchImpl: impl
    });
    await checker.check();
    assert.equal(impl.calls.length, 1);
    const headers = impl.calls[0].options.headers;
    assert.match(headers['User-Agent'], /RFNOTER\/2\.12\.0/);
    assert.match(impl.calls[0].url, /api\.github\.com\/repos\/tev6\/RFNOTER\/releases/);
});

test('检查器：HTTP 失败时 ok=false，而不是抛异常出去', async () => {
    const checker = createUpdateChecker({
        currentVersion: '2.12.0',
        state: tempState(),
        fetchImpl: fakeFetch(() => jsonResponse({}, { ok: false, status: 403 }))
    });
    const result = await checker.check();
    assert.equal(result.ok, false);
    assert.match(result.reason, /403/);
    assert.equal(result.hasUpdate, undefined);
});

test('检查器：网络异常（断网）时静默失败，不抛', async () => {
    const checker = createUpdateChecker({
        currentVersion: '2.12.0',
        state: tempState(),
        fetchImpl: fakeFetch(() => { throw new Error('fetch failed'); })
    });
    const result = await checker.check();
    assert.equal(result.ok, false);
    assert.match(result.reason, /fetch failed/);
});

test('检查器：JSON 解析失败也走静默失败', async () => {
    const checker = createUpdateChecker({
        currentVersion: '2.12.0',
        state: tempState(),
        fetchImpl: fakeFetch(() => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } }))
    });
    const result = await checker.check();
    assert.equal(result.ok, false);
});

test('检查器：响应里没有可识别版本时 ok=false（不猜）', async () => {
    const checker = createUpdateChecker({
        currentVersion: '2.12.0',
        state: tempState(),
        fetchImpl: fakeFetch(() => jsonResponse([release({ tag_name: 'nightly' })]))
    });
    const result = await checker.check();
    assert.equal(result.ok, false);
    assert.match(result.reason, /没有可识别/);
});

test('检查器：自动检查在节流窗口内不发请求', async () => {
    const state = tempState();
    const impl = fakeFetch(() => jsonResponse([release()]));
    const checker = createUpdateChecker({
        currentVersion: '2.12.0', state, fetchImpl: impl, now: () => 1_000_000
    });
    const first = await checker.check();
    assert.equal(first.checked, true);
    assert.equal(impl.calls.length, 1);

    // 距上次 1 分钟，远小于 6 小时
    const second = await createUpdateChecker({
        currentVersion: '2.12.0', state, fetchImpl: impl, now: () => 1_000_000 + 60_000
    }).check();
    assert.equal(second.ok, true);
    assert.equal(second.skipped, true);
    assert.equal(impl.calls.length, 1, '被节流时不应该再发请求');
});

test('检查器：超过节流窗口后会真的再查一次', async () => {
    const state = tempState();
    const impl = fakeFetch(() => jsonResponse([release()]));
    await createUpdateChecker({
        currentVersion: '2.12.0', state, fetchImpl: impl, now: () => 1_000_000
    }).check();

    await createUpdateChecker({
        currentVersion: '2.12.0', state, fetchImpl: impl,
        now: () => 1_000_000 + CHECK_THROTTLE_MS + 1
    }).check();
    assert.equal(impl.calls.length, 2);
});

test('检查器：手动检查用更短的节流窗口（force）', async () => {
    const state = tempState();
    const impl = fakeFetch(() => jsonResponse([release()]));
    await createUpdateChecker({
        currentVersion: '2.12.0', state, fetchImpl: impl, now: () => 1_000_000
    }).check();

    // 自动检查会被跳过
    const auto = await createUpdateChecker({
        currentVersion: '2.12.0', state, fetchImpl: impl, now: () => 1_000_000 + 60_000
    }).check();
    assert.equal(auto.skipped, true);

    // 手动检查过了 30 秒就允许
    const manual = await createUpdateChecker({
        currentVersion: '2.12.0', state, fetchImpl: impl,
        now: () => 1_000_000 + MANUAL_THROTTLE_MS + 1
    }).check({ force: true });
    assert.equal(manual.checked, true);
    assert.equal(impl.calls.length, 2);
});

test('检查器：连点手动检查不会打光限流额度', async () => {
    const state = tempState();
    const impl = fakeFetch(() => jsonResponse([release()]));
    const base = createUpdateChecker({
        currentVersion: '2.12.0', state, fetchImpl: impl, now: () => 1_000_000
    });
    await base.check({ force: true });

    for (let i = 1; i <= 5; i += 1) {
        const again = await createUpdateChecker({
            currentVersion: '2.12.0', state, fetchImpl: impl, now: () => 1_000_000 + i * 1000
        }).check({ force: true });
        assert.equal(again.skipped, true, `第 ${i} 次连点应被节流`);
    }
    assert.equal(impl.calls.length, 1);
});

test('检查器：失败也会记下检查时间（断网时不至于每次启动都重试）', async () => {
    const state = tempState();
    await createUpdateChecker({
        currentVersion: '2.12.0', state, now: () => 555_000,
        fetchImpl: fakeFetch(() => { throw new Error('offline'); })
    }).check();
    assert.equal(state.lastCheckAt(), 555_000);
});

test('检查器：没有注入 state 时也能工作（不落盘）', async () => {
    const checker = createUpdateChecker({
        currentVersion: '2.12.0',
        fetchImpl: fakeFetch(() => jsonResponse([release({ tag_name: 'v2.13.0' })]))
    });
    const result = await checker.check();
    assert.equal(result.hasUpdate, true);
});

test('检查器：超时被归类为「请求超时」', async () => {
    const checker = createUpdateChecker({
        currentVersion: '2.12.0',
        state: tempState(),
        fetchImpl: fakeFetch(() => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            throw err;
        })
    });
    const result = await checker.check();
    assert.equal(result.ok, false);
    assert.equal(result.reason, '请求超时');
});

test('检查器：日志里记下检查结果（事后能查为什么没提示）', async () => {
    const lines = [];
    const logger = { info: (m) => lines.push(m), warn: (m) => lines.push(`W:${m}`) };
    await createUpdateChecker({
        currentVersion: '2.12.0', state: tempState(), logger,
        fetchImpl: fakeFetch(() => jsonResponse([release({ tag_name: 'v2.13.0' })]))
    }).check();
    assert.ok(lines.some((l) => l.includes('2.13.0') && l.includes('有新版本')));
});
