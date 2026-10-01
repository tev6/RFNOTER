import {
    app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain,
    nativeImage, shell, protocol
} from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createNoteStore } from './store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const PUBLIC_DIR = path.join(ROOT, 'public');
const ASSETS_DIR = path.join(HERE, 'assets');
const IS_SELFTEST = process.argv.includes('--selftest');
/** 全局热键候选：第一个能被注册成功的就用它。 */
const HOTKEY_CANDIDATES = ['Control+Shift+Space', 'Alt+Shift+N', 'Control+Alt+N'];
const APP_ORIGIN = 'app://rfnoter';
/** 存储目录名固定写死，见下方 setPath 的注释。 */
const APP_DATA_DIR_NAME = 'rfnoter';

// 数据目录必须**与 productName 无关**。
// 打包后 electron-builder 会往 package.json 写入 productName，app.getName() 随之改变，
// app.getPath('userData') 就会跟着搬到 %APPDATA%\RFNOTER —— 用户会以为笔记全丢了。
// 所以这里显式钉死，保证开发态与打包态、以及未来改名都指向同一个目录。
if (IS_SELFTEST) {
    // 自检模式用独立的 userData，绝不碰真实数据
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rfnoter-selftest-'));
    app.setPath('userData', tmpRoot);
    app.setPath('sessionData', tmpRoot);
} else {
    const stableUserData = path.join(app.getPath('appData'), APP_DATA_DIR_NAME);
    fs.mkdirSync(stableUserData, { recursive: true });
    app.setPath('userData', stableUserData);
    app.setPath('sessionData', stableUserData);
}

// 让渲染进程用 app:// 协议加载：CSP 的 'self' 才有意义，
// fetch() 也能正常读本地文件（file:// 下会被 Chromium 拒绝）
protocol.registerSchemesAsPrivileged([{
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true }
}]);

let mainWindow = null;
let tray = null;
let store = null;
let activeHotkey = null;
let quitting = false;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** app:// 需要自己给 MIME，否则 .js/.css 会被当成 octet-stream 而被浏览器拒绝执行。 */
const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.eot': 'application/vnd.ms-fontobject'
};

/** 从 asar 里读图标：createFromPath 在 asar 路径下不可靠，统一走 buffer。 */
function iconImage(fileName) {
    try {
        return nativeImage.createFromBuffer(fs.readFileSync(path.join(ASSETS_DIR, fileName)));
    } catch {
        return nativeImage.createEmpty();
    }
}

function registerAppProtocol() {
    protocol.handle('app', async (request) => {
        const url = new URL(request.url);
        const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
        const target = path.normalize(path.join(PUBLIC_DIR, relative));
        if (!target.startsWith(PUBLIC_DIR + path.sep) && target !== PUBLIC_DIR) {
            return new Response('Forbidden', { status: 403 });
        }
        try {
            // 用 fs 读再自己构造 Response，而不是 net.fetch(file://…)。
            // 打包后 public/ 位于 app.asar 内部，net.fetch 对 asar 路径不可靠。
            // Electron 给 fs 打过补丁，读 asar 内的文件与普通文件一致。
            const data = fs.readFileSync(target);
            const mime = MIME_TYPES[path.extname(target).toLowerCase()] || 'application/octet-stream';
            return new Response(data, { headers: { 'Content-Type': mime } });
        } catch {
            return new Response('Not Found', { status: 404 });
        }
    });
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1180,
        height: 840,
        minWidth: 720,
        minHeight: 520,
        title: 'RFNOTER 闪录',
        icon: iconImage('icon.png'),
        backgroundColor: '#f9fafb',
        autoHideMenuBar: true,
        show: false,
        webPreferences: {
            preload: path.join(HERE, 'preload.cjs'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    mainWindow.loadURL(`${APP_ORIGIN}/index.html`);

    // 关闭 = 收进托盘（否则全局热键就没意义了）
    mainWindow.on('close', (event) => {
        if (!quitting) {
            event.preventDefault();
            mainWindow.hide();
        }
    });

    if (!IS_SELFTEST) {
        mainWindow.once('ready-to-show', () => showWindow());
        // 兜底：万一 ready-to-show 没触发（例如渲染异常），不能让程序变成一个
        // "进程活着但看不见窗口"的幽灵。加载完成 2 秒后仍未显示就强制显示。
        mainWindow.webContents.once('did-finish-load', () => {
            setTimeout(() => {
                if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
                    console.warn('[RFNOTER] ready-to-show 未触发，强制显示窗口');
                    showWindow();
                }
            }, 2000);
        });
        if (process.argv.includes('--layout-debug')) {
            mainWindow.webContents.once('did-finish-load', async () => {
                await wait(2500);
                const pageMetrics = await mainWindow.webContents.executeJavaScript(`(() => {
                    const root = document.documentElement;
                    const header = document.querySelector('header') || root.firstElementChild;
                    const btn = document.getElementById('selection-toggle-btn');
                    return {
                        innerWidth: window.innerWidth,
                        innerHeight: window.innerHeight,
                        clientWidth: root.clientWidth,
                        scrollWidth: root.scrollWidth,
                        bodyScrollWidth: document.body.scrollWidth,
                        dpr: window.devicePixelRatio,
                        headerRect: header ? header.getBoundingClientRect().toJSON() : null,
                        selectionBtnRect: btn ? btn.getBoundingClientRect().toJSON() : null
                    };
                })()`).catch((e) => ({ error: e.message }));
                const metrics = {
                    ...pageMetrics,
                    hotkey: activeHotkey,
                    dataDir: store.dataDir,
                    contentSize: mainWindow.getContentSize(),
                    windowBounds: mainWindow.getBounds()
                };
                console.log('[RFNOTER] layout:', JSON.stringify(metrics));
            });
        }

        // --screenshot=<path>：让 Electron 自己截自己的窗口，避免外部截图工具
        // 在 DPI 缩放下坐标错位（150% 缩放时 GetWindowRect/CopyFromScreen 会互相错开）
        const shotArg = process.argv.find((arg) => arg.startsWith('--screenshot='));
        if (shotArg) {
            const target = shotArg.slice('--screenshot='.length);
            mainWindow.webContents.once('did-finish-load', async () => {
                await wait(2500);
                try {
                    const image = await mainWindow.webContents.capturePage();
                    fs.writeFileSync(target, image.toPNG());
                    console.log(`[RFNOTER] screenshot saved: ${target} ${image.getSize().width}x${image.getSize().height}`);
                } catch (err) {
                    console.error('[RFNOTER] screenshot failed:', err.message);
                }
                quitting = true;
                app.exit(0);
            });
        }
    }
    return mainWindow;
}

function showWindow() {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
}

function triggerQuickCapture() {
    showWindow();
    mainWindow?.webContents.send('quick-capture');
}

function registerHotkey() {
    for (const accelerator of HOTKEY_CANDIDATES) {
        try {
            if (globalShortcut.register(accelerator, triggerQuickCapture)) {
                activeHotkey = accelerator;
                return accelerator;
            }
        } catch (err) {
            console.warn(`[RFNOTER] 热键 ${accelerator} 注册失败：${err.message}`);
        }
    }
    console.warn('[RFNOTER] 所有候选热键都被占用，全局快速记录不可用（托盘菜单仍可打开窗口）');
    return null;
}

function setAutoLaunch(enabled) {
    if (app.isPackaged) {
        // 打包后 process.execPath 就是应用本体，不能再把项目路径当参数传进去
        app.setLoginItemSettings({ openAtLogin: enabled });
        return;
    }
    app.setLoginItemSettings({
        openAtLogin: enabled,
        path: process.execPath,
        args: IS_SELFTEST ? [] : [ROOT]
    });
}

function buildTray() {
    const image = iconImage('tray.png');
    tray = new Tray(image.isEmpty() ? iconImage('icon.png') : image);
    tray.setToolTip('RFNOTER 闪录');
    tray.setContextMenu(Menu.buildFromTemplate([
        { label: '打开主窗口', click: showWindow },
        {
            label: activeHotkey ? `快速记录（${activeHotkey}）` : '快速记录（热键被占用）',
            click: triggerQuickCapture
        },
        { type: 'separator' },
        {
            label: '开机自动启动',
            type: 'checkbox',
            checked: app.getLoginItemSettings().openAtLogin,
            click: (item) => setAutoLaunch(item.checked)
        },
        { label: '打开数据目录', click: () => shell.openPath(store.dataDir) },
        { type: 'separator' },
        { label: '退出 RFNOTER', click: () => { quitting = true; app.quit(); } }
    ]));
    tray.on('click', () => {
        if (mainWindow?.isVisible() && mainWindow.isFocused()) mainWindow.hide();
        else showWindow();
    });
}

function registerIpc() {
    ipcMain.handle('notes:read', (_event, userId) => store.read(userId));
    ipcMain.handle('notes:write', (_event, userId, notes) => store.write(userId, notes));
    ipcMain.handle('notes:list-user-ids', () => store.listUserIds());
    ipcMain.handle('app:open-data-dir', () => shell.openPath(store.dataDir));
    ipcMain.handle('app:info', () => ({
        version: app.getVersion(),
        dataDir: store.dataDir,
        hotkey: activeHotkey,
        platform: process.platform
    }));
}

async function bootstrap() {
    await app.whenReady();
    app.setAppUserModelId('com.tev6.rfnoter');

    const dataDir = path.join(app.getPath('userData'), 'data');
    store = createNoteStore(dataDir);
    // 把旧版（服务端模式）写在项目 data/ 里的笔记搬过来，避免升级后"看不见旧数据"
    const migrated = store.migrateFrom(path.join(ROOT, 'data'));
    if (migrated.length > 0) console.log(`[RFNOTER] 已迁移旧数据：${migrated.join(', ')}`);

    registerAppProtocol();
    registerIpc();
    createWindow();
    registerHotkey();

    if (!IS_SELFTEST) buildTray();
}

/* ------------------------------------------------------------------ */
/* 自检：不打开窗口，跑一遍存储 + 真实页面 + 写盘链路                    */
/* ------------------------------------------------------------------ */
async function runSelfTest() {
    const results = [];
    const check = (name, ok, extra = '') => results.push({ name, ok: !!ok, extra });

    await app.whenReady();

    // userData 已被隔离到临时目录，所以这里用的就是真实路径，只是不会碰到正式数据
    const dataDir = path.join(app.getPath('userData'), 'data');
    store = createNoteStore(dataDir);
    const isolated = createNoteStore(path.join(app.getPath('userData'), 'selftest'));

    const written = isolated.write('selftest-user', [{ id: 'n1', content: '你好' }]);
    check('store.write 写入成功', written.ok === true, JSON.stringify(written));
    const back = isolated.read('selftest-user');
    check('store.read 读回一致', back.ok && back.notes.length === 1 && back.notes[0].content === '你好');
    check('store 拒绝路径穿越', isolated.write('../evil', [])?.ok === false && isolated.fileFor('../evil') === null);
    check('store 拒绝非数组', isolated.write('selftest-user', { a: 1 })?.ok === false);
    check('store 读取不存在文件返回空', isolated.read('nobody')?.ok === true);

    const badFile = path.join(isolated.dataDir, 'notes_broken.json');
    fs.writeFileSync(badFile, '{not json', 'utf8');
    check('store 损坏文件返回错误而不是抛异常', isolated.read('broken')?.ok === false);
    fs.rmSync(badFile, { force: true });

    registerAppProtocol();
    registerIpc();
    const win = createWindow();

    const consoleErrors = [];
    // Electron 44 起只传一个事件对象（参数个数会被用来判断走新 API 还是旧 API，
    // 所以这里必须只声明一个形参，否则会触发弃用警告）
    win.webContents.on('console-message', (details) => {
        const lvl = details?.level;
        const isError = typeof lvl === 'string' ? lvl === 'error' : lvl >= 3;
        if (isError) consoleErrors.push(details?.message ?? '');
    });

    await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
    await wait(1500);

    check('页面通过 app:// 加载', win.webContents.getURL().startsWith(APP_ORIGIN));

    const desktopFlag = await win.webContents.executeJavaScript('!!(window.rfnoter && window.rfnoter.isDesktop)');
    check('preload 桥已注入', desktopFlag === true);

    const appInfo = await win.webContents.executeJavaScript('window.rfnoter.appInfo()');
    check('IPC 可用（app:info）', appInfo && typeof appInfo.dataDir === 'string', JSON.stringify(appInfo));

    const userId = await win.webContents.executeJavaScript('localStorage.getItem("userId")');
    check('渲染进程拿到 userId', typeof userId === 'string' && userId.length > 10, String(userId));

    // 先证明"控制台错误监听"真的能抓到错误，否则最后那条断言就是空转的
    await win.webContents.executeJavaScript("console.error('RFNOTER_SELFTEST_MARKER')");
    await wait(300);
    check(
        '控制台错误监听生效（探针已被捕获）',
        consoleErrors.some((m) => m.includes('RFNOTER_SELFTEST_MARKER')),
        consoleErrors.join(' | ')
    );
    consoleErrors.length = 0;

    // 真实页面里加一条笔记，验证「DOM → api.js → IPC → 落盘」整条链路
    await win.webContents.executeJavaScript(`
        document.getElementById('quick-content').value = '自检笔记';
        document.getElementById('quick-time-start').value = '09:00';
        document.getElementById('quick-time-end').value = '09:40';
        document.getElementById('quick-add-form')
            .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        true;
    `);
    await wait(800);

    const cardCount = await win.webContents.executeJavaScript("document.querySelectorAll('.note-card').length");
    check('页面上出现笔记卡片', cardCount === 1, `count=${cardCount}`);

    const onDisk = store.read(userId);
    check(
        '笔记已通过 IPC 写入真实文件',
        onDisk.ok && onDisk.notes.length === 1 && onDisk.notes[0].content === '自检笔记',
        JSON.stringify(onDisk).slice(0, 200)
    );
    check('文件位于 userData 目录', path.resolve(store.dataDir) === path.resolve(dataDir), store.dataDir);

    const saveIndicator = await win.webContents.executeJavaScript(
        "document.getElementById('save-indicator').textContent"
    );
    check('界面提示已保存', /已保存/.test(saveIndicator), saveIndicator);

    const tailwindApplied = await win.webContents.executeJavaScript(
        "getComputedStyle(document.querySelector('.note-card')).borderLeftWidth"
    );
    check('Tailwind 本地构建生效（卡片左边框 4px）', tailwindApplied === '4px', tailwindApplied);

    // 布局体检：窗口是 1180 宽，页面不能出现横向溢出把右侧按钮挤出去
    const layout = await win.webContents.executeJavaScript(`(() => {
        const root = document.documentElement;
        const btn = document.getElementById('selection-toggle-btn');
        const rect = btn ? btn.getBoundingClientRect() : null;
        return {
            innerWidth: window.innerWidth,
            clientWidth: root.clientWidth,
            scrollWidth: root.scrollWidth,
            bodyScrollWidth: document.body.scrollWidth,
            buttonRight: rect ? Math.round(rect.right) : null,
            buttonLeft: rect ? Math.round(rect.left) : null
        };
    })()`);
    check(
        '页面无横向溢出',
        layout.scrollWidth <= layout.clientWidth + 1 && layout.bodyScrollWidth <= layout.clientWidth + 1,
        JSON.stringify(layout)
    );
    check(
        '右上角按钮在可视区内',
        layout.buttonRight !== null && layout.buttonRight <= layout.clientWidth + 1 && layout.buttonLeft >= -1,
        JSON.stringify(layout)
    );

    check('页面无严重控制台错误', consoleErrors.length === 0, consoleErrors.join(' | ').slice(0, 300));

    const failed = results.filter((r) => !r.ok);
    console.log('\n===== RFNOTER 桌面端自检 =====');
    for (const r of results) {
        console.log(`${r.ok ? '✔' : '✖'} ${r.name}${r.extra && !r.ok ? `  <- ${r.extra}` : ''}`);
    }
    console.log(`----- ${results.length - failed.length}/${results.length} 通过 -----\n`);

    quitting = true;
    app.exit(failed.length === 0 ? 0 : 1);
}

/* ------------------------------------------------------------------ */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
    // 已经有实例在跑：把那个窗口叫出来就好，绝不让两份进程写同一个文件
    app.quit();
} else {
    app.on('second-instance', showWindow);
    app.on('window-all-closed', () => { /* 托盘常驻，不退出 */ });
    app.on('will-quit', () => globalShortcut.unregisterAll());

    if (IS_SELFTEST) {
        runSelfTest().catch((err) => {
            console.error('[RFNOTER] 自检异常：', err);
            app.exit(1);
        });
    } else {
        bootstrap().catch((err) => {
            console.error('[RFNOTER] 启动失败：', err);
            app.exit(1);
        });
    }
}
