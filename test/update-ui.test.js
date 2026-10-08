/**
 * E4 更新提示：界面模块的单元测试。
 *
 * 除了纯函数，这里还干两件"守门"的活：
 *   1. 用 jsdom 把 initUpdateUI 真接一遍线，验证"推来新版本 → 圆点亮 → 点开弹窗
 *      → 点知道了 → 圆点灭"这条路真的走得通（只看纯函数证明不了按钮接对了）；
 *   2. 比对 index.html 里我们依赖的那些 id 与 update-ui.js 的接线是否一致——
 *      少一个 id，功能会**静默失效**（getElementById 返回 null，不报错）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import {
    shouldShowBadge, formatReleaseNotes, describeVersions, initUpdateUI
} from '../public/js/update-ui.js';

const INDEX_HTML = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

const status = (over = {}) => ({
    ok: true, hasUpdate: true, currentVersion: '2.12.0', latestVersion: '2.13.0',
    tag: 'v2.13.0', name: 'v2.13.0 更新检查',
    notes: '## 新功能\n- 可以检查更新了\n- **修复**：某处崩溃',
    publishedAt: '2026-10-09T00:00:00Z',
    pageUrl: 'https://github.com/tev6/RFNOTER/releases/tag/v2.13.0',
    downloadUrl: 'https://x/RFNOTER-Setup-2.13.0.exe',
    downloadName: 'RFNOTER-Setup-2.13.0.exe',
    downloadSize: 111666621, downloadSizeText: '106.5 MB',
    ...over
});

/* ------------------------------------------------------------------ */
/* 纯函数                                                              */
/* ------------------------------------------------------------------ */

test('E4：只有「查成功 + 有新版本 + 没被认掉」才亮圆点', () => {
    assert.equal(shouldShowBadge(status()), true);
    assert.equal(shouldShowBadge(status({ hasUpdate: false })), false, '已是最新不该亮');
    assert.equal(shouldShowBadge(status({ ok: false })), false, '查失败不该亮（不能瞎报）');
    assert.equal(shouldShowBadge(status({ muted: true })), false, '用户认掉的版本不该再亮');
    assert.equal(shouldShowBadge(null), false);
    assert.equal(shouldShowBadge(undefined), false);
});

test('E4：更新说明裁成纯文本（不渲染外部 Markdown）', () => {
    const text = formatReleaseNotes('## 标题\n\n- 条目一\n- 条目二\n\n**粗体** 和 `代码`');
    assert.ok(!text.includes('#'), '井号应被去掉');
    assert.ok(!text.includes('**'), '粗体星号应被去掉');
    assert.ok(!text.includes('`'), '反引号应被去掉');
    assert.match(text, /标题/);
    assert.match(text, /· 条目一/);
    assert.match(text, /粗体/);
});

test('E4：长说明被截断并加省略号（不能把弹窗撑爆）', () => {
    const long = '很长的说明。'.repeat(500);
    const text = formatReleaseNotes(long, { maxChars: 100 });
    assert.ok(text.length <= 101, `实际长度 ${text.length}`);
    assert.ok(text.endsWith('…'));
});

test('E4：没说说明时返回空串（由界面补默认文案）', () => {
    assert.equal(formatReleaseNotes(null), '');
    assert.equal(formatReleaseNotes(undefined), '');
    assert.equal(formatReleaseNotes(''), '');
});

test('E4：版本对比文案', () => {
    assert.equal(describeVersions(status()), '当前 2.12.0 → 最新 2.13.0');
    assert.equal(describeVersions({ ok: false }), '');
});

/* ------------------------------------------------------------------ */
/* DOM 接线                                                            */
/* ------------------------------------------------------------------ */

/** 造一个带真实 id 的最小 DOM（与 index.html 里那些 id 同名）。 */
function setupDom() {
    const dom = new JSDOM(`<!DOCTYPE html><html><body>
        <button id="update-badge" class="hidden" title="有新版本"></button>
        <div id="update-modal" class="fixed hidden">
            <h3 id="update-title"></h3>
            <p id="update-versions"></p>
            <p id="update-notes"></p>
            <button id="update-download-btn"></button>
            <button id="update-dismiss-btn"></button>
            <button id="close-update-btn"></button>
        </div>
    </body></html>`);
    const { window } = dom;
    return {
        dom, window,
        els: {
            badge: window.document.getElementById('update-badge'),
            modal: window.document.getElementById('update-modal'),
            titleLabel: window.document.getElementById('update-title'),
            versionLabel: window.document.getElementById('update-versions'),
            notesLabel: window.document.getElementById('update-notes'),
            downloadBtn: window.document.getElementById('update-download-btn'),
            dismissBtn: window.document.getElementById('update-dismiss-btn'),
            closeBtn: window.document.getElementById('close-update-btn')
        }
    };
}

test('E4：初始没有新版本时圆点是灭的（不能一上来就闪）', async () => {
    const { els } = setupDom();
    let pushed = null;
    const ui = initUpdateUI({
        ...els,
        bridge: { updateStatus: async () => null, onUpdateStatus: (cb) => { pushed = cb; } }
    });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(ui.badgeVisible(), false);
    assert.equal(els.badge.classList.contains('hidden'), true);
    assert.ok(pushed, '应当注册了推送回调');
});

test('E4：主进程推来新版本 → 圆点亮起来且带版本号提示', async () => {
    const { els } = setupDom();
    let pushed = null;
    const ui = initUpdateUI({
        ...els,
        bridge: { updateStatus: async () => null, onUpdateStatus: (cb) => { pushed = cb; } }
    });
    pushed(status());
    assert.equal(ui.badgeVisible(), true);
    assert.match(els.badge.title, /2\.13\.0/);
    assert.match(els.badge.title, /2\.12\.0/);
});

test('E4：启动时主动拉一次状态（检查可能先于接线完成）', async () => {
    const { els } = setupDom();
    initUpdateUI({
        ...els,
        bridge: {
            updateStatus: async () => status(),
            onUpdateStatus: () => {}
        }
    });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(els.badge.classList.contains('hidden'), false,
        '接线前就查到的结果也必须能显示出来');
});

test('E4 回归：慢的启动拉取不能把「已认掉」的状态盖回来（实测踩过）', async () => {
    // 时序：用户点「知道了」→ 圆点灭 → 那个迟到的 updateStatus() 才返回，
    // 带回来一份**没有 muted 标记**的状态。若不额外记一份本地已认掉的版本号，
    // 圆点会莫名其妙又亮起来。
    const { els, window } = setupDom();
    let resolvePull;
    const slowPull = new Promise((resolve) => { resolvePull = resolve; });
    const ui = initUpdateUI({
        ...els,
        bridge: {
            updateStatus: () => slowPull,          // 故意等我们手动放行
            onUpdateStatus: () => {},
            dismissUpdate: async () => {}
        }
    });

    // 推送先到，用户看到圆点并点「知道了」
    ui.render(status());
    assert.equal(ui.badgeVisible(), true);
    els.dismissBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(ui.badgeVisible(), false, '点完知道了应当立刻灭');

    // 现在那个迟到的拉取才返回，且它带来的状态**没有 muted**
    resolvePull(status());
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(ui.badgeVisible(), false,
        '迟到的拉取不能把已经认掉的版本重新点亮');
});

test('E4：迟到的拉取若带来「更新的版本」，仍应重新点亮', async () => {
    // 上一条的反向保护：压住的只能是那一个版本号，不能变成"静音一切"。
    const { els, window } = setupDom();
    let resolvePull;
    const slowPull = new Promise((resolve) => { resolvePull = resolve; });
    const ui = initUpdateUI({
        ...els,
        bridge: {
            updateStatus: () => slowPull,
            onUpdateStatus: () => {},
            dismissUpdate: async () => {}
        }
    });
    ui.render(status({ latestVersion: '2.13.0' }));
    els.dismissBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(ui.badgeVisible(), false);

    resolvePull(status({ latestVersion: '2.14.0' }));
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(ui.badgeVisible(), true, '出了更新的版本就该重新提醒');
});

test('E4：点圆点打开弹窗，内容填好', () => {
    const { els } = setupDom();
    let pushed = null;
    initUpdateUI({
        ...els,
        bridge: { updateStatus: async () => null, onUpdateStatus: (cb) => { pushed = cb; } }
    });
    pushed(status());
    assert.equal(els.modal.classList.contains('hidden'), true, '没点之前不该自己弹出来');

    els.badge.dispatchEvent(new els.badge.ownerDocument.defaultView.MouseEvent('click', { bubbles: true }));
    assert.equal(els.modal.classList.contains('hidden'), false, '点了应当打开');
    assert.match(els.titleLabel.textContent, /2\.13\.0/);
    assert.match(els.versionLabel.textContent, /当前 2\.12\.0 → 最新 2\.13\.0/);
    assert.match(els.notesLabel.textContent, /可以检查更新了/);
    assert.match(els.downloadBtn.textContent, /去下载/);
    assert.match(els.downloadBtn.textContent, /106\.5 MB/);
});

test('E4：没有更新说明时给出默认文案而不是空白', () => {
    const { els } = setupDom();
    let pushed = null;
    initUpdateUI({
        ...els,
        bridge: { updateStatus: async () => null, onUpdateStatus: (cb) => { pushed = cb; } }
    });
    pushed(status({ notes: '' }));
    els.badge.dispatchEvent(new els.badge.ownerDocument.defaultView.MouseEvent('click', { bubbles: true }));
    assert.match(els.notesLabel.textContent, /没有写更新说明/);
});

test('E4：点「知道了」→ 通知主进程、关弹窗、圆点灭掉', async () => {
    const { els, window } = setupDom();
    let pushed = null;
    const dismissed = [];
    const ui = initUpdateUI({
        ...els,
        bridge: {
            updateStatus: async () => null,
            onUpdateStatus: (cb) => { pushed = cb; },
            dismissUpdate: async (v) => { dismissed.push(v); }
        }
    });
    pushed(status());
    els.badge.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    els.dismissBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 10));

    assert.deepEqual(dismissed, ['2.13.0'], '要把版本号告诉主进程，才记得住');
    assert.equal(els.modal.classList.contains('hidden'), true);
    assert.equal(ui.badgeVisible(), false, '认掉之后圆点要灭');
});

test('E4：点「去下载」用安装包直链打开浏览器，并关掉弹窗', async () => {
    const { els, window } = setupDom();
    let pushed = null;
    const opened = [];
    initUpdateUI({
        ...els,
        bridge: {
            updateStatus: async () => null,
            onUpdateStatus: (cb) => { pushed = cb; },
            openDownload: async (url) => { opened.push(url); }
        }
    });
    pushed(status());
    els.badge.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    els.downloadBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 10));

    assert.deepEqual(opened, ['https://x/RFNOTER-Setup-2.13.0.exe']);
    assert.equal(els.modal.classList.contains('hidden'), true);
});

test('E4：没有附件直链时退回 release 页面（后者永远存在）', async () => {
    const { els, window } = setupDom();
    let pushed = null;
    const opened = [];
    initUpdateUI({
        ...els,
        bridge: {
            updateStatus: async () => null,
            onUpdateStatus: (cb) => { pushed = cb; },
            openDownload: async (url) => { opened.push(url); }
        }
    });
    pushed(status({ downloadUrl: null }));
    els.badge.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    els.downloadBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(opened, ['https://github.com/tev6/RFNOTER/releases/tag/v2.13.0']);
});

test('E4：关闭按钮收起弹窗，但不等于"认掉了"（圆点还在）', () => {
    const { els, window } = setupDom();
    let pushed = null;
    const ui = initUpdateUI({
        ...els,
        bridge: { updateStatus: async () => null, onUpdateStatus: (cb) => { pushed = cb; } }
    });
    pushed(status());
    els.badge.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    els.closeBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    assert.equal(els.modal.classList.contains('hidden'), true);
    assert.equal(ui.badgeVisible(), true, '只是关掉窗口，下次还该提醒');
});

test('E4：网页端没有桥时不接线也不抛异常', () => {
    const { els } = setupDom();
    // bridge 为 null：模拟浏览器打开同一份 public/
    const ui = initUpdateUI({ ...els, bridge: null });
    assert.equal(ui.badgeVisible(), false);
    assert.doesNotThrow(() => ui.render(status()));
});

test('E4：桥里的方法抛异常也不能把界面弄崩', async () => {
    const { els } = setupDom();
    let pushed = null;
    initUpdateUI({
        ...els,
        bridge: {
            updateStatus: async () => { throw new Error('IPC 挂了'); },
            onUpdateStatus: (cb) => { pushed = cb; },
            dismissUpdate: async () => { throw new Error('IPC 挂了'); }
        }
    });
    await new Promise((r) => setTimeout(r, 10));
    pushed(status());
    assert.doesNotThrow(() => els.dismissBtn.dispatchEvent(
        new els.dismissBtn.ownerDocument.defaultView.MouseEvent('click', { bubbles: true })
    ));
});

/* ------------------------------------------------------------------ */
/* 与 index.html 的一致性                                              */
/* ------------------------------------------------------------------ */

test('E4：亮起来时补上 inline-flex（否则摘掉 hidden 会退回 inline，图标文字不居中）', () => {
    const { els } = setupDom();
    const ui = initUpdateUI({ ...els, bridge: null });
    ui.render(status());
    assert.equal(els.badge.classList.contains('inline-flex'), true);
    assert.equal(els.badge.classList.contains('hidden'), false);

    ui.render(status({ hasUpdate: false }));
    assert.equal(els.badge.classList.contains('hidden'), true);
    assert.equal(els.badge.classList.contains('inline-flex'), false, '灭掉时要一起摘掉');
});

test('E4：index.html 里确实有接线依赖的那些元素 id', () => {
    // 少一个 id 就会静默失效：getElementById 返回 null，addEventListener 不报错，
    // 功能只是"点了没反应"。这条专门拦这种情况。
    for (const id of [
        'update-badge', 'update-modal', 'update-title', 'update-versions',
        'update-notes', 'update-download-btn', 'update-dismiss-btn', 'close-update-btn'
    ]) {
        assert.ok(INDEX_HTML.includes(`id="${id}"`), `index.html 缺少 id="${id}"`);
    }
});

test('E4：圆点默认是隐藏的（不能一进页面就亮着骗人）', () => {
    const badgeTag = /<button id="update-badge"[^>]*>/.exec(INDEX_HTML);
    assert.ok(badgeTag, '应当找得到圆点按钮');
    assert.match(badgeTag[0], /class="[^"]*hidden/, '圆点初始必须带 hidden');
});

test('E4：弹窗默认是隐藏的（且复用 surface 底色，暗色下才不会白块）', () => {
    const modalTag = /<div id="update-modal"[^>]*>/.exec(INDEX_HTML);
    assert.ok(modalTag);
    assert.match(modalTag[0], /hidden/);
    assert.match(modalTag[0], /z-50/);
    // bg-white 在暗色下会是刺眼的白块，项目约定弹窗底色一律用 bg-surface
    assert.ok(!/bg-white/.test(modalTag[0]), '弹窗不该用不透明的 bg-white');
});

test('E4：app.js 确实把更新 UI 接上了', () => {
    const app = fs.readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
    assert.match(app, /initUpdateUI\(/, 'app.js 必须调用 initUpdateUI');
    assert.match(app, /import \{ initUpdateUI \} from '\.\/update-ui\.js'/);
    assert.match(app, /updateModal/, 'Esc 处理需要认得这个弹窗元素');
});

test('E4：preload 暴露了更新相关的四个方法', () => {
    const preload = fs.readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf8');
    for (const name of ['updateStatus', 'checkUpdate', 'dismissUpdate', 'openDownload', 'onUpdateStatus']) {
        assert.match(preload, new RegExp(`${name}:`), `preload 缺少 ${name}`);
    }
});

test('E4：主进程注册了对应的 IPC 通道', () => {
    const main = fs.readFileSync(new URL('../electron/main.js', import.meta.url), 'utf8');
    for (const channel of ['update:status', 'update:check', 'update:dismiss', 'update:open-download']) {
        assert.ok(main.includes(`'${channel}'`), `main.js 缺少 IPC 通道 ${channel}`);
    }
});
