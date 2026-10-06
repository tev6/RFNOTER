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
        aiCalls: 0,
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
            state.aiCalls += 1;
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

    assert.match(document.getElementById('save-indicator').textContent, /未写入/);
    assert.ok(document.getElementById('sync-status').textContent.includes('未写入'));
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

/* ---------------- 回归：曾经真实出现过的体验问题 ---------------- */

test('回归：新增笔记插在当天分组的【最前面】，而不是沉到最末尾', async () => {
    const existing = [
        makeNote({ id: 'old-1', content: '旧笔记一', createdAt: 1 }),
        makeNote({ id: 'old-2', content: '旧笔记二', createdAt: 2 })
    ];
    const { document, window } = await bootApp({ serverNotes: existing });

    submitQuickAdd(document, window, '刚写的新笔记');
    await flush(60);

    const texts = [...document.querySelectorAll('.note-card')].map((el) => el.textContent);
    assert.equal(texts.length, 3);
    // 同一天内按创建时间倒序：新笔记 → 旧笔记二 → 旧笔记一
    assert.match(texts[0], /刚写的新笔记/, '新笔记应出现在第一位');
    assert.match(texts[1], /旧笔记二/);
    assert.match(texts[2], /旧笔记一/);
});

test('回归：新增笔记后分组计数同步更新', async () => {
    const { document, window } = await bootApp({ serverNotes: [makeNote({ id: 'n1' })] });
    assert.match(document.querySelector('.note-count').textContent, /1 条笔记/);
    submitQuickAdd(document, window, '第二条');
    await flush(60);
    assert.match(document.querySelector('.note-count').textContent, /2 条笔记/);
});

test('回归：往折叠的日期分组里新增笔记时会自动展开，不会"隐身"', async () => {
    const { document, window } = await bootApp({ serverNotes: [] });
    submitQuickAdd(document, window, '第一条');
    await flush(60);
    // 手动折叠今天的分组
    const header = document.querySelector('.date-header');
    header.dispatchEvent(new window.Event('click', { bubbles: true }));
    await flush(20);
    assert.ok(document.querySelector('.date-group').classList.contains('collapsed'));

    submitQuickAdd(document, window, '折叠状态下新增的笔记');
    await flush(60);
    assert.equal(document.querySelector('.date-group').classList.contains('collapsed'), false, '应自动展开');
    const first = document.querySelector('.note-card');
    assert.equal(first.classList.contains('hidden'), false, '新笔记必须可见');
    assert.match(first.textContent, /折叠状态下新增的笔记/);
});

test('回归：选择模式下一条都没选时，再点按钮可以退出（不会卡住）', async () => {
    const { document } = await bootApp({ serverNotes: [makeNote({ id: 'n1' })] });
    const btn = document.getElementById('selection-toggle-btn');
    const hint = document.getElementById('selection-mode-hint');

    btn.dispatchEvent(new globalThis.window.Event('click', { bubbles: true }));
    await flush(20);
    assert.ok(!hint.classList.contains('hidden'), '应进入选择模式');
    assert.match(btn.textContent, /退出选择模式/, '没有选中项时按钮应显示为可退出');

    btn.dispatchEvent(new globalThis.window.Event('click', { bubbles: true }));
    await flush(20);
    assert.ok(hint.classList.contains('hidden'), '应退出选择模式');
    assert.match(btn.textContent, /选择笔记/);
});

test('回归：选择模式下选中笔记后，按钮变为确认并进入 AI 配置', async () => {
    const { document } = await bootApp({ serverNotes: [makeNote({ id: 'n1' })] });
    const btn = document.getElementById('selection-toggle-btn');
    btn.dispatchEvent(new globalThis.window.Event('click', { bubbles: true }));
    await flush(20);
    document.querySelector('.note-card').dispatchEvent(new globalThis.window.Event('click', { bubbles: true }));
    await flush(20);
    assert.match(btn.textContent, /确认，开始AI总结 \(1\)/);

    btn.dispatchEvent(new globalThis.window.Event('click', { bubbles: true }));
    await flush(20);
    assert.ok(!document.getElementById('ai-summary-modal').classList.contains('hidden'));
});

test('回归：右键菜单在小窗口靠右下角时不会越界', async () => {
    const { document, window } = await bootApp({ serverNotes: [makeNote({ id: 'n1' })] });
    const menu = document.getElementById('context-menu');
    // jsdom 没有真实布局，这里给出确定的菜单尺寸
    menu.getBoundingClientRect = () => ({ width: 200, height: 320, left: 0, top: 0, right: 200, bottom: 320, x: 0, y: 0 });
    Object.defineProperty(window, 'innerWidth', { value: 800, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 600, configurable: true });

    document.querySelector('.note-card').dispatchEvent(new window.MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, clientX: 780, clientY: 580
    }));
    await flush(20);

    const left = parseFloat(menu.style.left);
    const top = parseFloat(menu.style.top);
    assert.ok(left + 200 <= 800, `左边越界了：left=${left}`);
    assert.ok(top + 320 <= 600, `上边越界了：top=${top}`);
    assert.ok(left >= 0 && top >= 0, '也不应跑到负坐标');
});

test('回归：AI 生成期间连点按钮不会重复调用 API（不会重复扣费）', async () => {
    const { document, state } = await bootApp({ serverNotes: [makeNote({ id: 'n1' })] });
    const btn = document.getElementById('selection-toggle-btn');
    btn.dispatchEvent(new globalThis.window.Event('click', { bubbles: true }));
    await flush(20);
    document.querySelector('.note-card').dispatchEvent(new globalThis.window.Event('click', { bubbles: true }));
    await flush(20);
    btn.dispatchEvent(new globalThis.window.Event('click', { bubbles: true }));
    await flush(20);

    document.getElementById('api-key').value = 'sk-test';
    const generate = document.getElementById('generate-summary-btn');
    generate.dispatchEvent(new globalThis.window.Event('click', { bubbles: true }));
    generate.dispatchEvent(new globalThis.window.Event('click', { bubbles: true }));
    generate.dispatchEvent(new globalThis.window.Event('click', { bubbles: true }));
    await flush(120);

    assert.equal(state.aiCalls, 1, `只应调用一次 API，实际 ${state.aiCalls} 次`);
    assert.equal(generate.disabled, false, '结束后按钮应恢复可用');
});

test('回归：界面上显示的是「闪录」与自己的图标，不是旧的「快速笔记」', async () => {
    const { document } = await bootApp({ serverNotes: [] });
    const header = document.querySelector('header');
    assert.match(header.querySelector('h1').textContent, /闪录/);
    assert.equal(header.querySelector('h1').textContent.includes('快速笔记'), false);
    const logo = header.querySelector('img');
    assert.ok(logo, '左上角应该是图片 LOGO');
    assert.match(logo.getAttribute('src'), /icon\.png/);
});

/* ---------------- v2.3.0：高频录入闭环 + 渲染可扩展性 ---------------- */

test('常用条目：按使用频率排序，只出现过一次的不入选，点一下填入标题', async () => {
    const notes = [];
    for (let i = 0; i < 5; i += 1) notes.push(makeNote({ id: `cs-${i}`, content: 'CS', createdAt: i }));
    for (let i = 0; i < 2; i += 1) notes.push(makeNote({ id: `bili-${i}`, content: 'B站', createdAt: 100 + i }));
    notes.push(makeNote({ id: 'once', content: '只出现过一次', createdAt: 500 }));
    const { document, window } = await bootApp({ serverNotes: notes });

    const chips = [...document.querySelectorAll('#quick-picks button')];
    assert.deepEqual(chips.map((c) => c.textContent), ['CS', 'B站'], '应按频率排序且过滤掉低频项');

    chips[0].dispatchEvent(new window.Event('click', { bubbles: true }));
    assert.equal(document.getElementById('quick-content').value, 'CS', '点击应填入标题');
});

test('常用条目：双击 chip 直接记录一条笔记', async () => {
    const notes = [];
    for (let i = 0; i < 3; i += 1) notes.push(makeNote({ id: `x-${i}`, content: '洗澡', createdAt: i }));
    const { document, window, state } = await bootApp({ serverNotes: notes });
    const before = document.querySelectorAll('.note-card').length;

    const chip = document.querySelector('#quick-picks button');
    chip.dispatchEvent(new window.Event('dblclick', { bubbles: true }));
    await flush(80);

    assert.equal(state.serverNotes.length, notes.length + 1, '应新增一条');
    assert.equal(document.querySelectorAll('.note-card').length, before + 1);
});

test('时间接续：显示上一条结束与空档，「补记空档」把起止时间铺满空白', async () => {
    const RealDate = globalThis.Date;
    const FIXED = new RealDate(2026, 9, 6, 14, 0, 0); // 本地时间 2026-10-06 14:00
    class MockDate extends RealDate {
        constructor(...args) { super(...(args.length === 0 ? [FIXED.getTime()] : args)); }
        static now() { return FIXED.getTime(); }
    }
    globalThis.Date = MockDate;
    try {
        const { document, window } = await bootApp({
            serverNotes: [makeNote({
                id: 'prev', date: '2026-10-06', timeStart: '12:00', timeEnd: '12:30',
                content: '上一条', createdAt: 1
            })]
        });

        const hint = document.getElementById('quick-continuity-text');
        const btn = document.getElementById('quick-continue-btn');
        assert.match(hint.textContent, /12:30/, '应显示上一条的结束时间');
        assert.match(hint.textContent, /空档 1小时30分钟/);
        assert.equal(btn.classList.contains('hidden'), false, '有空档时应出现补记按钮');

        btn.dispatchEvent(new window.Event('click', { bubbles: true }));
        assert.equal(document.getElementById('quick-time-start').value, '12:30');
        assert.equal(document.getElementById('quick-time-end').value, '14:00', '结束时间应铺到当前时刻');
    } finally {
        globalThis.Date = RealDate;
    }
});

test('时间接续：刚记完不会提示空档，按钮也不出现', async () => {
    const RealDate = globalThis.Date;
    const FIXED = new RealDate(2026, 9, 6, 14, 0, 0);
    class MockDate2 extends RealDate {
        constructor(...args) { super(...(args.length === 0 ? [FIXED.getTime()] : args)); }
        static now() { return FIXED.getTime(); }
    }
    globalThis.Date = MockDate2;
    try {
        const { document } = await bootApp({
            serverNotes: [makeNote({
                id: 'now', date: '2026-10-06', timeStart: '13:40', timeEnd: '13:58',
                content: '刚记完', createdAt: 1
            })]
        });
        assert.equal(document.getElementById('quick-continue-btn').classList.contains('hidden'), true);
        assert.match(document.getElementById('quick-continuity-text').textContent, /13:58/);
    } finally {
        globalThis.Date = RealDate;
    }
});

test('惰性渲染：折叠的日期分组不生成卡片 DOM，展开时才补上', async () => {
    const notes = [
        makeNote({ id: 'today-1', content: '今天的' }),
        makeNote({ id: 'sep-2', date: '2026-09-02', content: '九月二号', createdAt: 2 }),
        makeNote({ id: 'sep-1a', date: '2026-09-01', content: '九月一号A', createdAt: 1 }),
        makeNote({ id: 'sep-1b', date: '2026-09-01', content: '九月一号B', createdAt: 0 })
    ];
    const { document, window } = await bootApp({ serverNotes: notes });

    assert.equal(document.querySelectorAll('.date-group').length, 3, '三个日期三个分组');
    assert.equal(document.querySelectorAll('.note-card').length, 1, '只有展开的今天生成了卡片');

    const group = [...document.querySelectorAll('.date-group')].find((g) => g.dataset.date === '2026-09-01');
    group.querySelector('.date-header').dispatchEvent(new window.Event('click', { bubbles: true }));
    await flush(30);

    assert.equal(document.querySelectorAll('.note-card').length, 3, '展开后补上该日期的两张卡片');
    const card = document.querySelector('.note-card[data-note-id="sep-1a"]');
    assert.ok(card, '补上的卡片应可被定位');
    assert.equal(card.classList.contains('hidden'), false, '展开后卡片必须可见');
    assert.match(document.querySelector('.note-count').textContent || '', /条笔记/);
});

test('惰性渲染：折叠分组里的笔记仍能被选中并参与 AI 总结', async () => {
    const notes = [
        makeNote({ id: 'today-1', content: '今天的' }),
        makeNote({ id: 'old-1', date: '2026-09-01', content: '旧笔记', createdAt: 1 })
    ];
    const { document } = await bootApp({ serverNotes: notes });

    // 进选择模式 → 点折叠分组的标题 = 整组选中
    document.getElementById('selection-toggle-btn')
        .dispatchEvent(new globalThis.window.Event('click', { bubbles: true }));
    await flush(20);
    const group = [...document.querySelectorAll('.date-group')].find((g) => g.dataset.date === '2026-09-01');
    group.querySelector('.date-header').dispatchEvent(new globalThis.window.Event('click', { bubbles: true }));
    await flush(30);

    assert.match(document.getElementById('selection-toggle-btn').textContent, /确认，开始AI总结 \(1\)/);
    document.getElementById('selection-toggle-btn')
        .dispatchEvent(new globalThis.window.Event('click', { bubbles: true }));
    await flush(30);
    const preview = document.querySelectorAll('#selected-notes-preview > div');
    assert.equal(preview.length, 1, '未渲染的笔记也要能进入 AI 总结');
    assert.match(preview[0].textContent, /旧笔记/);
});
