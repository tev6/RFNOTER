/**
 * 桌面端（Electron 桥）路径的测试。
 *
 * 为什么单独一个文件：api.js 在模块加载时读取一次 window.rfnoter 来决定存储方式，
 * 而 ESM 模块在同一进程里只实例化一次。所以桌面端的用例必须放在独立进程里，
 * 并且第一个用例决定了本进程后续所有用例共用的 userId。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const INDEX_HTML = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

/** 本进程统一使用的 userId（第一个用例里由「沿用已有文件」逻辑选定）。 */
const USER_ID = 'legacy-user';

function makeNote(overrides = {}) {
    return {
        id: 'n-1', date: '2026-05-14', timeStart: '09:00', timeEnd: '09:40',
        content: '笔记一', tag: '', color: '', details: '',
        expanded: false, createdAt: 1, updatedAt: 1, ...overrides
    };
}

/**
 * api.js 只在模块加载时抓一次 window.rfnoter，所以这里必须全程共用同一个 bridge 对象，
 * 每个用例只是重置它背后的状态。
 */
const bridgeState = {
    files: {},
    writes: [],
    quickCaptureHandler: null,
    listCalls: 0,
    failWrite: false
};

const bridge = {
    isDesktop: true,
    platform: 'win32',
    readNotes: async (userId) => {
        const notes = bridgeState.files[userId];
        return notes ? { ok: true, notes, exists: true } : { ok: true, notes: [], exists: false };
    },
    writeNotes: async (userId, notes) => {
        if (bridgeState.failWrite) return { ok: false, error: '磁盘写入失败' };
        bridgeState.writes.push({ userId, notes });
        bridgeState.files[userId] = notes;
        return { ok: true, count: notes.length };
    },
    listUserIds: async () => {
        bridgeState.listCalls += 1;
        return Object.keys(bridgeState.files).map((userId) => ({ userId, mtimeMs: 1 }));
    },
    appInfo: async () => ({ dataDir: 'C:\\fake\\data', version: '2.2.0', hotkey: 'Control+Shift+Space', platform: 'win32' }),
    openDataDir: async () => {},
    onQuickCapture: (callback) => { bridgeState.quickCaptureHandler = callback; }
};

function resetBridge({ files = {}, failWrite = false }) {
    bridgeState.files = JSON.parse(JSON.stringify(files));
    bridgeState.writes = [];
    bridgeState.quickCaptureHandler = null;
    bridgeState.listCalls = 0;
    bridgeState.failWrite = failWrite;
}

const flush = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

async function bootDesktop({ files = {}, localNotes = null, failWrite = false, seedUserId = true, confirmAnswer = true } = {}) {
    // 注意：这里用 http origin 而不是 app://。jsdom 对非 http(s) 的 origin 会禁用
    // localStorage（opaque origin），而 app:// 协议本身已经由 electron 自检覆盖。
    const dom = new JSDOM(INDEX_HTML, { url: 'http://localhost:3000/' });
    const { window } = dom;
    resetBridge({ files, failWrite });

    const confirmCalls = [];
    window.alert = () => {};
    window.confirm = (message) => { confirmCalls.push(message); return confirmAnswer; };
    window.HTMLAnchorElement.prototype.click = function noop() {};

    window.rfnoter = bridge;                        // 必须在 import app.js 之前挂上
    if (seedUserId) window.localStorage.setItem('userId', USER_ID);
    if (localNotes) window.localStorage.setItem(`notes_${USER_ID}`, JSON.stringify(localNotes));

    globalThis.window = window;
    globalThis.document = window.document;
    globalThis.localStorage = window.localStorage;
    globalThis.CSS = window.CSS;
    globalThis.DOMParser = window.DOMParser;
    globalThis.alert = window.alert;
    globalThis.confirm = window.confirm;
    globalThis.File = window.File;
    globalThis.URL.createObjectURL = () => 'blob:test';
    globalThis.URL.revokeObjectURL = () => {};

    const httpCalls = [];
    globalThis.fetch = async (url, options = {}) => {
        httpCalls.push({ url: String(url), method: options.method || 'GET' });
        return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
    };

    await import(`../public/js/app.js?desktop=${Math.random()}`);
    window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
    await flush(60);

    return { window, document: window.document, state: bridgeState, httpCalls, confirmCalls };
}

test('首启：磁盘上已有笔记文件时，沿用它的 userId 而不是新建一个', async () => {
    const { window, document, state } = await bootDesktop({
        files: { [USER_ID]: [makeNote({ id: 'old-1', content: '磁盘里的旧笔记' })] },
        seedUserId: false
    });

    assert.equal(window.localStorage.getItem('userId'), USER_ID, '应沿用已有 userId');
    assert.ok(state.listCalls > 0, '应查询过已有数据文件');
    assert.equal(document.querySelectorAll('.note-card').length, 1);
    assert.match(document.querySelector('.note-card').textContent, /磁盘里的旧笔记/);
});

test('桌面端读写走 IPC，不再发 HTTP 请求', async () => {
    const { document, state, httpCalls } = await bootDesktop({ files: { [USER_ID]: [] } });

    document.getElementById('quick-content').value = '桌面端笔记';
    document.getElementById('quick-time-start').value = '09:00';
    document.getElementById('quick-time-end').value = '09:40';
    document.getElementById('quick-add-form')
        .dispatchEvent(new globalThis.window.Event('submit', { bubbles: true, cancelable: true }));
    await flush(60);

    assert.equal(state.writes.length, 1, '应通过 IPC 写入一次');
    assert.equal(state.writes[0].userId, USER_ID);
    assert.equal(state.writes[0].notes[0].content, '桌面端笔记');
    assert.deepEqual(httpCalls, [], '不应有任何 HTTP 请求');
    assert.match(document.getElementById('save-indicator').textContent, /已保存/);
});

test('桌面端：IPC 写入失败时如实提示未同步，并标记待同步', async () => {
    const { document, window, state } = await bootDesktop({ files: { [USER_ID]: [] }, failWrite: true });

    document.getElementById('quick-content').value = '写不进去的笔记';
    document.getElementById('quick-time-start').value = '09:00';
    document.getElementById('quick-time-end').value = '09:40';
    document.getElementById('quick-add-form')
        .dispatchEvent(new globalThis.window.Event('submit', { bubbles: true, cancelable: true }));
    await flush(60);

    assert.equal(state.writes.length, 0);
    assert.match(document.getElementById('save-indicator').textContent, /未同步/);
    assert.equal(window.localStorage.getItem(`notes_${USER_ID}_pending`), '1');
    // 即使写盘失败，localStorage 副本仍要保住这条笔记
    const localCopy = JSON.parse(window.localStorage.getItem(`notes_${USER_ID}`));
    assert.equal(localCopy[0].content, '写不进去的笔记');
});

test('桌面端：磁盘为空而本地有数据时，先问用户再导入并写盘', async () => {
    const localNotes = [makeNote({ id: 'local-only', content: '仅存在于本地' })];
    const { document, state, confirmCalls } = await bootDesktop({
        files: { [USER_ID]: [] },
        localNotes,
        confirmAnswer: true
    });

    assert.equal(confirmCalls.length, 1, '应弹出导入确认');
    assert.match(confirmCalls[0], /1 条笔记/);
    assert.equal(document.querySelectorAll('.note-card').length, 1, '确认后应显示本地笔记');
    assert.equal(state.writes.length, 1, '确认导入后应写回磁盘');
    assert.equal(state.files[USER_ID][0].content, '仅存在于本地');
});

test('桌面端：拒绝导入时先备份本地副本，再以磁盘为准', async () => {
    const localNotes = [makeNote({ id: 'local-only', content: '不想丢的本地笔记' })];
    const { document, window, state } = await bootDesktop({
        files: { [USER_ID]: [] },
        localNotes,
        confirmAnswer: false
    });

    assert.equal(document.querySelectorAll('.note-card').length, 0, '以磁盘为准时列表应为空');
    assert.equal(state.writes.length, 0, '不应写盘');
    const keys = [];
    for (let i = 0; i < window.localStorage.length; i += 1) keys.push(window.localStorage.key(i));
    const backups = keys.filter((k) => k.startsWith(`notes_${USER_ID}_backup_`));
    assert.equal(backups.length, 1, '应留下备份');
    assert.equal(JSON.parse(window.localStorage.getItem(backups[0]))[0].content, '不想丢的本地笔记');
});

test('桌面端：注册了全局热键回调，触发后聚焦快速输入框', async () => {
    const { document, state } = await bootDesktop({ files: { [USER_ID]: [] } });

    assert.equal(typeof state.quickCaptureHandler, 'function', 'onQuickCapture 应被注册');
    const input = document.getElementById('quick-content');
    input.value = '旧内容';

    state.quickCaptureHandler();
    await flush(10);

    assert.equal(document.activeElement, input, '热键触发后焦点应在快速输入框');
});

test('桌面端：窗口内也能正常导出（不依赖服务端）', async () => {
    const { document, window, state } = await bootDesktop({ files: { [USER_ID]: [makeNote()] } });
    const created = [];
    globalThis.URL.createObjectURL = (blob) => { created.push(blob); return 'blob:test'; };

    document.getElementById('export-btn').dispatchEvent(new window.Event('click', { bubbles: true }));
    await flush(20);

    assert.equal(created.length, 1);
    assert.equal(state.writes.length, 0, '导出不应写盘');
});
