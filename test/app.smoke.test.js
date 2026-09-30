/**
 * 用 jsdom 把真实的 index.html + app.js 跑起来，验证交互层面的逻辑。
 * 只依赖 fetch / localStorage 的桩，不依赖真实浏览器与网络。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const INDEX_HTML = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

const TEST_USER_ID = 'test-user';
const localKey = () => `notes_${TEST_USER_ID}`;
const today = () => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
};

function jsonResponse(data) {
    return { ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) };
}

function errorResponse(status, body = {}) {
    return { ok: false, status, json: async () => body, text: async () => JSON.stringify(body) };
}

function textResponse(text) {
    return { ok: true, status: 200, json: async () => ({}), text: async () => text };
}

const flush = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

function makeNote(overrides = {}) {
    return {
        id: 'n-1', date: today(), timeStart: '09:00', timeEnd: '09:40',
        content: '笔记一', tag: '', color: '', details: '',
        expanded: false, createdAt: 1, updatedAt: 1, ...overrides
    };
}

/** 起一套隔离环境：新的 jsdom + 新的模块实例（用查询串绕过 ESM 缓存）。 */
async function bootApp({ serverNotes = [], localNotes = null, confirmAnswer = true } = {}) {
    const dom = new JSDOM(INDEX_HTML, { url: 'http://localhost:3000/' });
    const { window } = dom;
    window.alert = () => {};
    window.confirm = () => confirmAnswer;
    // api.js 只在首次导入时读取 userId，这里固定成同一个值，保证每个用例的键一致
    window.localStorage.setItem('userId', TEST_USER_ID);
    window.HTMLAnchorElement.prototype.click = function noop() {};

    const state = {
        serverNotes: [...serverNotes],
        postCount: 0,
        aiSummary: '## 总结\n这是 **AI** 生成的总结。',
        exportedBlobs: []
    };

    globalThis.window = window;
    globalThis.document = window.document;
    globalThis.localStorage = window.localStorage;
    globalThis.CSS = window.CSS;
    globalThis.DOMParser = window.DOMParser;
    globalThis.alert = window.alert;
    globalThis.confirm = window.confirm;
    globalThis.File = window.File;
    // jsdom 的 URL.createObjectURL 会用 Node 的实现（要求 Node 的 Blob），这里整体替换掉
    globalThis.URL.createObjectURL = (blob) => {
        state.exportedBlobs.push(blob);
        return 'blob:rfnoter-test';
    };
    globalThis.URL.revokeObjectURL = () => {};

    globalThis.fetch = async (url, options = {}) => {
        const target = String(url);
        if (target.includes('api.deepseek.com')) {
            return jsonResponse({ choices: [{ message: { content: state.aiSummary } }] });
        }
        if (target.includes('/api/notes/')) {
            if (options.method === 'POST') {
                state.postCount += 1;
                state.serverNotes = JSON.parse(options.body);
                return jsonResponse({ success: true, count: state.serverNotes.length });
            }
            return jsonResponse(state.serverNotes);
        }
        if (target.includes('flash-noter-tutorial.md')) {
            return textResponse('# 教程\n\n这是教程正文。');
        }
        return errorResponse(404);
    };

    if (localNotes) window.localStorage.setItem(localKey(), JSON.stringify(localNotes));

    await import(`../public/js/app.js?boot=${Math.random()}`);
    window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
    await flush(50);

    return { dom, window, document: window.document, state };
}

function storageKeys(storage) {
    const keys = [];
    for (let i = 0; i < storage.length; i += 1) keys.push(storage.key(i));
    return keys.filter(Boolean);
}

function submitQuickAdd(document, window, content) {
    document.getElementById('quick-content').value = content;
    document.getElementById('quick-time-start').value = '09:00';
    document.getElementById('quick-time-end').value = '09:40';
    document.getElementById('quick-add-form')
        .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
}

test('首次启动：服务端为空而本机有旧数据时，会导入而不是丢弃', async () => {
    const legacy = [
        makeNote({ id: 'legacy-1', content: '旧笔记一', createdAt: 1 }),
        makeNote({ id: 'legacy-2', content: '旧笔记二', createdAt: 2 })
    ];
    const { document, state } = await bootApp({ serverNotes: [], localNotes: legacy, confirmAnswer: true });

    assert.equal(document.querySelectorAll('.note-card').length, 2, '旧笔记应被导入并显示');
    assert.equal(state.serverNotes.length, 2, '旧笔记应被推送到服务端');
});

test('首次启动：用户拒绝导入时，本地副本会被备份而不是直接销毁', async () => {
    const legacy = [makeNote({ id: 'legacy-1', content: '旧笔记一' })];
    const { document, window, state } = await bootApp({ serverNotes: [], localNotes: legacy, confirmAnswer: false });

    assert.equal(document.querySelectorAll('.note-card').length, 0, '选择以服务器为准时应显示空列表');
    assert.equal(state.postCount, 0, '不应写回服务端');
    const backups = storageKeys(window.localStorage).filter((k) => k.startsWith(`${localKey()}_backup_`));
    assert.equal(backups.length, 1, '应留下一份本地备份');
    assert.equal(JSON.parse(window.localStorage.getItem(backups[0])).length, 1);
});

test('保存失败时会如实提示"未同步"，而不是骗用户"已保存"', async () => {
    const { document, window } = await bootApp({ serverNotes: [] });
    globalThis.fetch = async () => errorResponse(500, { error: 'boom' });

    submitQuickAdd(document, window, '一条新笔记');
    await flush(50);

    assert.match(document.getElementById('save-indicator').textContent, /未同步/);
    assert.ok(document.getElementById('sync-status').textContent.includes('未同步'));
});

test('笔记内容不会被当成 HTML 执行', async () => {
    const { document, window } = await bootApp({ serverNotes: [] });
    submitQuickAdd(document, window, '<img src=x onerror=alert(1)>');
    await flush(50);

    const card = document.querySelector('.note-card');
    assert.equal(card.querySelector('img'), null, '不应产生 img 节点');
    assert.ok(card.textContent.includes('<img src=x onerror=alert(1)>'), '应作为纯文本展示');
});

test('新增笔记走增量渲染，不重建已有卡片', async () => {
    const { document, window } = await bootApp({ serverNotes: [makeNote({ id: 'keep-me', content: '老笔记' })] });
    const original = document.querySelector('.note-card[data-note-id="keep-me"]');
    assert.ok(original);

    submitQuickAdd(document, window, '新笔记');
    await flush(50);

    const cards = [...document.querySelectorAll('.note-card')];
    assert.equal(cards.length, 2);
    assert.ok(cards.includes(original), '原有卡片应仍是同一个 DOM 节点（说明没有全量重渲染）');
    assert.match(document.querySelector('.note-count').textContent, /2 条笔记/);
});

test('展开详情只写本地，不触发服务端全量保存', async () => {
    const { document, state } = await bootApp({ serverNotes: [makeNote({ id: 'n1', details: '详情内容' })] });
    const postsAfterLoad = state.postCount;

    document.querySelector('.note-card .details-btn').dispatchEvent(new globalThis.window.Event('click', { bubbles: true }));
    await flush(50);

    assert.equal(state.postCount, postsAfterLoad, '不应新增 POST');
    assert.ok(!document.querySelector('.note-details-expand').classList.contains('hidden'));
});

test('删除笔记：删掉最后一条后该日期分组也会消失', async () => {
    const notes = [makeNote({ id: 'd1', content: '第一条' }), makeNote({ id: 'd2', content: '第二条' })];
    const { document, window, state } = await bootApp({ serverNotes: notes });

    // 右键第一条 → 删除 → 确认
    document.querySelector('.note-card[data-note-id="d1"]')
        .dispatchEvent(new window.Event('contextmenu', { bubbles: true, cancelable: true }));
    document.getElementById('delete-note-menu-btn').dispatchEvent(new window.Event('click', { bubbles: true }));
    document.getElementById('confirm-delete-btn').dispatchEvent(new window.Event('click', { bubbles: true }));
    await flush(300);

    assert.equal(document.querySelector('.note-card[data-note-id="d1"]'), null);
    assert.ok(document.querySelector('.note-card[data-note-id="d2"]'), '不应误删其它笔记');
    assert.match(document.querySelector('.note-count').textContent, /1 条笔记/);
    assert.equal(state.serverNotes.length, 1);

    // 再删最后一条，分组应被移除
    document.querySelector('.note-card[data-note-id="d2"]')
        .dispatchEvent(new window.Event('contextmenu', { bubbles: true, cancelable: true }));
    document.getElementById('delete-note-menu-btn').dispatchEvent(new window.Event('click', { bubbles: true }));
    document.getElementById('confirm-delete-btn').dispatchEvent(new window.Event('click', { bubbles: true }));
    await flush(300);

    assert.equal(document.querySelectorAll('.note-card').length, 0);
    assert.equal(document.querySelectorAll('.date-group').length, 0, '空掉的日期分组应被清理');
    assert.ok(!document.getElementById('empty-state').classList.contains('hidden'), '应显示空状态');
});

test('导入 JSON：合并模式会追加新笔记并同步到服务端', async () => {
    const { document, window, state } = await bootApp({ serverNotes: [makeNote({ id: 'n-existing', content: '已有笔记' })] });

    const payload = {
        version: '1.2.0',
        notes: [
            makeNote({ id: 'n-imported-1', content: '导入笔记一' }),
            { id: 'bad-note', date: today(), timeStart: '25:00', timeEnd: '09:00', content: '非法时间' },
            { id: 'n-imported-2', date: today(), timeStart: '10:00', timeEnd: '10:30', content: '导入笔记二' }
        ]
    };
    const file = new window.File([JSON.stringify(payload)], 'rfnoter-backup.json', { type: 'application/json' });
    const input = document.getElementById('import-file-input');
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new window.Event('change', { bubbles: true }));
    await flush(80);

    assert.equal(document.querySelectorAll('.note-card').length, 3, '应合并成 3 条（非法那条被丢弃）');
    assert.ok(document.querySelector('.note-card[data-note-id="n-existing"]'), '原有笔记应保留');
    assert.ok(document.querySelector('.note-card[data-note-id="n-imported-1"]'));
    assert.equal(state.serverNotes.length, 3, '导入后应写入服务端');
});

test('导出笔记会生成备份文件', async () => {
    const { document, window, state } = await bootApp({ serverNotes: [makeNote({ id: 'n1' })] });

    document.getElementById('export-btn').dispatchEvent(new window.Event('click', { bubbles: true }));
    await flush(20);

    assert.equal(state.exportedBlobs.length, 1, '应生成一个导出文件');
    assert.match(document.getElementById('save-indicator').textContent, /已导出/);
});

test('AI 总结生成成功后，"重新生成 / 调整配置"仍然可用（不会双双关掉弹窗）', async () => {
    const notes = [makeNote({ id: 'n1', createdAt: 1 }), makeNote({ id: 'n2', createdAt: 2 })];
    const { document } = await bootApp({ serverNotes: notes });

    document.getElementById('selection-toggle-btn').dispatchEvent(new globalThis.window.Event('click', { bubbles: true }));
    await flush();
    document.querySelectorAll('.note-card').forEach((card) => {
        card.dispatchEvent(new globalThis.window.Event('click', { bubbles: true }));
    });
    await flush();
    assert.equal(document.querySelectorAll('.note-card.selected').length, 2);

    document.getElementById('selection-toggle-btn').dispatchEvent(new globalThis.window.Event('click', { bubbles: true }));
    await flush();
    assert.ok(!document.getElementById('ai-summary-modal').classList.contains('hidden'), '配置弹窗应打开');

    document.getElementById('api-key').value = 'sk-test';
    document.querySelector('input[name="output-format"][value="Markdown格式"]').checked = true;
    document.getElementById('generate-summary-btn').dispatchEvent(new globalThis.window.Event('click', { bubbles: true }));
    await flush(80);

    const resultModal = document.getElementById('ai-result-modal');
    assert.ok(!resultModal.classList.contains('hidden'), '结果弹窗应保持打开');
    assert.ok(!document.getElementById('summary-content').classList.contains('hidden'), '应显示总结内容');
    assert.equal(
        [...document.getElementById('summary-text').querySelectorAll('strong')].map((el) => el.textContent).join('|'),
        '总结|AI'
    );

    // 回归点：点击"重新生成"不应把结果弹窗关掉又不打开任何东西
    document.getElementById('regenerate-summary-btn').dispatchEvent(new globalThis.window.Event('click', { bubbles: true }));
    await flush(80);
    assert.ok(!resultModal.classList.contains('hidden'), '"重新生成"之后结果弹窗必须仍然可见');
    assert.ok(!document.getElementById('summary-content').classList.contains('hidden'));

    // 回归点：点击"调整配置"应打开配置弹窗
    document.getElementById('adjust-config-btn').dispatchEvent(new globalThis.window.Event('click', { bubbles: true }));
    await flush(30);
    assert.ok(!document.getElementById('ai-summary-modal').classList.contains('hidden'), '"调整配置"应打开配置弹窗');
    assert.equal(document.querySelectorAll('#selected-notes-preview > div').length, 2, '选中集不应丢失');
});

test('AI 输出的 HTML 会被净化后再渲染', async () => {
    const { document, state } = await bootApp({ serverNotes: [makeNote({ id: 'n1' })] });
    state.aiSummary = '<p>正常段落<script>alert(1)</script><img src=x onerror=alert(2)></p>';

    document.getElementById('selection-toggle-btn').dispatchEvent(new globalThis.window.Event('click', { bubbles: true }));
    await flush();
    document.querySelector('.note-card').dispatchEvent(new globalThis.window.Event('click', { bubbles: true }));
    await flush();
    document.getElementById('selection-toggle-btn').dispatchEvent(new globalThis.window.Event('click', { bubbles: true }));
    await flush();

    document.getElementById('api-key').value = 'sk-test';
    document.querySelector('input[name="output-format"][value="HTML格式"]').checked = true;
    document.getElementById('generate-summary-btn').dispatchEvent(new globalThis.window.Event('click', { bubbles: true }));
    await flush(80);

    const summaryText = document.getElementById('summary-text');
    assert.ok(summaryText.querySelector('p'), '白名单标签应保留');
    assert.equal(summaryText.querySelector('script'), null, 'script 应被剔除');
    assert.equal(summaryText.querySelector('img'), null, 'img 应被剔除');
    assert.equal(summaryText.textContent.includes('alert(2)'), false);
});

test('右键菜单的颜色标记子菜单不会随打开次数累积监听器', async () => {
    const { document } = await bootApp({ serverNotes: [makeNote({ id: 'n1' })] });
    const card = document.querySelector('.note-card');
    const openMenu = () => {
        card.dispatchEvent(new globalThis.window.Event('contextmenu', { bubbles: true, cancelable: true }));
    };
    const menuBtn = document.getElementById('color-menu-btn');
    const submenu = document.getElementById('color-submenu');
    const click = () => menuBtn.dispatchEvent(new globalThis.window.Event('click', { bubbles: true }));

    openMenu();
    click();
    assert.equal(submenu.classList.contains('hidden'), false, '第一次点击应展开');
    click();
    assert.equal(submenu.classList.contains('hidden'), true, '第二次点击应收起');

    openMenu();
    click();
    assert.equal(submenu.classList.contains('hidden'), false, '再次打开菜单后，一次点击仍应展开（未累积监听器）');
    click();
    assert.equal(submenu.classList.contains('hidden'), true);
});

test('帮助弹窗在教程存在时渲染正文', async () => {
    const { document } = await bootApp({ serverNotes: [] });
    document.getElementById('help-btn').dispatchEvent(new globalThis.window.Event('click', { bubbles: true }));
    await flush(30);
    assert.match(document.getElementById('help-content').textContent, /教程/);
    assert.equal(document.getElementById('help-content').querySelector('strong').textContent, '教程');
});
