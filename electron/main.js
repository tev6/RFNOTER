import {
    app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain,
    nativeImage, shell, protocol, screen, nativeTheme
} from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createNoteStore } from './store.js';
import { createLogger, describeError } from './logger.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const PUBLIC_DIR = path.join(ROOT, 'public');
const ASSETS_DIR = path.join(HERE, 'assets');
const IS_SELFTEST = process.argv.includes('--selftest');
/**
 * --profile-dir=<路径>：开发用，把 userData 指到一个独立目录。
 *
 * 两个用途：① 正式版正开着时，开发实例会因单例锁直接退出，指到别处就能跑起来；
 * ② 跑截图/调试脚本时绝不碰 %APPDATA%\rfnoter 里的真实笔记。
 * 生产使用不会带这个参数，带了也只影响这一次进程。
 */
const PROFILE_DIR = process.argv.find((arg) => arg.startsWith('--profile-dir='))?.slice('--profile-dir='.length) || null;
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
} else if (PROFILE_DIR) {
    fs.mkdirSync(PROFILE_DIR, { recursive: true });
    app.setPath('userData', PROFILE_DIR);
    app.setPath('sessionData', PROFILE_DIR);
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

/**
 * 每个 userId 最近一次已知的笔记条数。
 *
 * 用途：识别"这次写入会让笔记数腰斩"的危险动作（批量删除、导入时选替换），
 * 从而在覆盖之前先强制留一份备份。放在内存里，不给每次写入增加读盘开销；
 * 启动时用备份时顺便读到的条数做初值。
 */
const lastNoteCounts = new Map();

// 日志尽早建立：userData 上面已经钉死了，所以从这一刻起任何异常都能落盘
const logger = createLogger(path.join(app.getPath('userData'), 'logs'));

// 主进程崩溃/未处理的 Promise 拒绝原本只会打到 stderr，
// 桌面端用户看不到，等于没记录 —— 这两个是最该留下痕迹的
process.on('uncaughtException', (err) => {
    logger.error('主进程未捕获异常', err);
});
process.on('unhandledRejection', (reason) => {
    logger.error('主进程未处理的 Promise 拒绝', reason);
});

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

/** 窗口尺寸/位置记忆，避免每次启动都要重新摆一遍。 */
function windowStateFile() {
    return path.join(app.getPath('userData'), 'window-state.json');
}

function loadWindowState() {
    try {
        const saved = JSON.parse(fs.readFileSync(windowStateFile(), 'utf8'));
        if (!Number.isFinite(saved.width) || !Number.isFinite(saved.height)) return null;
        return saved;
    } catch {
        return null;
    }
}

function saveWindowState() {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return;
    try {
        // 最大化时记普通尺寸，下次取消最大化能回到合适的大小
        const bounds = mainWindow.getNormalBounds();
        fs.writeFileSync(
            windowStateFile(),
            JSON.stringify({ ...bounds, maximized: mainWindow.isMaximized() }),
            'utf8'
        );
    } catch { /* 记不住就算了，不该因为写状态文件失败而影响使用 */ }
}

function createWindow() {
    // 默认尺寸必须能放进当前屏幕工作区：之前固定 1180x840，在 1280x800 这类屏幕上
    // 会超出可视范围（底部被任务栏盖住）。
    const { workArea } = screen.getPrimaryDisplay();
    const margin = 24;
    const saved = IS_SELFTEST ? null : loadWindowState();
    let width = Math.min(saved?.width ?? 1180, workArea.width - margin);
    let height = Math.min(saved?.height ?? 840, workArea.height - margin);
    width = Math.max(width, 720);
    height = Math.max(height, 520);
    // 位置也要夹回工作区内，否则换显示器/改分辨率后窗口会落在屏幕外
    let x = Number.isFinite(saved?.x) ? saved.x : undefined;
    let y = Number.isFinite(saved?.y) ? saved.y : undefined;
    if (x !== undefined && (x < workArea.x - 50 || x > workArea.x + workArea.width - 100)) x = undefined;
    if (y !== undefined && (y < workArea.y - 50 || y > workArea.y + workArea.height - 100)) y = undefined;

    mainWindow = new BrowserWindow({
        width,
        height,
        ...(x !== undefined && y !== undefined ? { x, y } : {}),
        minWidth: 720,
        minHeight: 520,
        title: '闪录',
        icon: iconImage('icon.png'),
        // 首帧底色跟着系统配色走；用户显式选的主题会在页面加载后经 IPC 同步过来。
        // 窗口是 show:false + ready-to-show 才显示的，所以这个颜色平时看不见。
        backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f172a' : '#f9fafb',
        autoHideMenuBar: true,
        show: false,
        webPreferences: {
            preload: path.join(HERE, 'preload.cjs'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    if (saved?.maximized) mainWindow.maximize();

    mainWindow.loadURL(`${APP_ORIGIN}/index.html`);

    // 渲染进程的问题原本只在 DevTools 里能看到，桌面端用户永远看不到。
    // 这里把错误级别的控制台消息、加载失败、进程崩溃都记进日志文件。
    mainWindow.webContents.on('console-message', (details) => {
        const level = details?.level;
        const isError = typeof level === 'string' ? level === 'error' : level >= 3;
        if (isError) logger.error(`[渲染进程] ${details?.message ?? ''}`);
    });
    mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
        logger.error(`页面加载失败 code=${code} ${desc} url=${url}`);
    });
    mainWindow.webContents.on('render-process-gone', (_e, details) => {
        logger.error(`渲染进程退出 reason=${details?.reason} exitCode=${details?.exitCode}`);
    });
    mainWindow.on('unresponsive', () => logger.warn('窗口无响应'));

    // 关闭 = 收进托盘（否则全局热键就没意义了）
    mainWindow.on('close', (event) => {
        saveWindowState();
        if (!quitting) {
            event.preventDefault();
            mainWindow.hide();
        }
    });
    let stateTimer = null;
    const scheduleSave = () => {
        clearTimeout(stateTimer);
        stateTimer = setTimeout(saveWindowState, 400);
    };
    mainWindow.on('resize', scheduleSave);
    mainWindow.on('move', scheduleSave);

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
        // 附加 --stats 可以先打开统计面板再截，方便检查那个全屏面板的排版
        // 附加 --dark 可以先切到暗色再截（查完会把原来的主题偏好写回去，不动用户的设置）
        const shotArg = process.argv.find((arg) => arg.startsWith('--screenshot='));
        if (shotArg) {
            const target = shotArg.slice('--screenshot='.length);
            const openStatsFirst = process.argv.includes('--stats');
            mainWindow.webContents.once('did-finish-load', async () => {
                await wait(2500);
                const wantDark = process.argv.includes('--dark');
                let themeBeforeShot = null;
                try {
                    if (wantDark) {
                        themeBeforeShot = await mainWindow.webContents.executeJavaScript(
                            "localStorage.getItem('theme')"
                        );
                        // 点顶栏按钮直到真的切到暗色（最多 3 下走完一轮），避免"本来就暗"时反而切走
                        await mainWindow.webContents.executeJavaScript(`(() => {
                            const btn = document.getElementById('theme-btn');
                            for (let i = 0; i < 3 && btn.dataset.themeMode !== 'dark'; i += 1) btn.click();
                            return btn.dataset.themeMode;
                        })()`);
                        await wait(600);
                    }
                    if (openStatsFirst) {
                        await mainWindow.webContents.executeJavaScript(
                            "document.getElementById('stats-btn')?.click()"
                        );
                        await wait(1200);
                        // 附加 --history 再点进第一个活动的历史，方便检查那个面板的排版
                        if (process.argv.includes('--history')) {
                            await mainWindow.webContents.executeJavaScript(
                                "document.querySelector('[data-stats-action=\"history\"]')?.click()"
                            );
                            await wait(1200);
                        }
                    }
                    const image = await mainWindow.webContents.capturePage();
                    fs.writeFileSync(target, image.toPNG());
                    console.log(`[RFNOTER] screenshot saved: ${target} ${image.getSize().width}x${image.getSize().height}`);
                    if (wantDark) {
                        // 只是为了截图才切的暗色，别把用户的常用主题改掉
                        await mainWindow.webContents.executeJavaScript(
                            `localStorage.setItem('theme', ${JSON.stringify(themeBeforeShot ?? 'system')})`
                        );
                        console.log('[RFNOTER] 主题偏好已还原为 ' + (themeBeforeShot ?? 'system'));
                    }
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
    tray.setToolTip('闪录');
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
        { label: '打开备份目录', click: () => shell.openPath(store.backupsDir) },
        { label: '打开日志目录', click: () => shell.openPath(logger.dir) },
        { type: 'separator' },
        { label: '退出闪录', click: () => { quitting = true; app.quit(); } }
    ]));
    tray.on('click', () => {
        if (mainWindow?.isVisible() && mainWindow.isFocused()) mainWindow.hide();
        else showWindow();
    });
}

function registerIpc() {
    ipcMain.handle('notes:read', (_event, userId) => {
        const result = store.read(userId);
        if (!result?.ok) logger.error(`读取笔记失败 user=${userId}`, result?.error);
        return result;
    });
    ipcMain.handle('notes:write', (_event, userId, notes) => {
        // 笔记数大幅减少（批量删除、导入替换）时，先把当前这份强制备份下来。
        // 用内存里的上次条数判断，不额外读盘；启动时已经把初始条数喂进来了。
        const previous = lastNoteCounts.get(userId);
        if (typeof previous === 'number' && previous >= 10
            && Array.isArray(notes) && notes.length < previous * 0.5) {
            const pre = store.backup(userId, { force: true });
            if (pre.ok && !pre.skipped) {
                logger.warn(`笔记数将从 ${previous} 降到 ${notes.length}，已先备份：${pre.file}`);
            }
        }

        const result = store.write(userId, notes);
        if (!result?.ok) {
            logger.error(`写入笔记失败 user=${userId}`, result?.error);
            return result;
        }
        lastNoteCounts.set(userId, Array.isArray(notes) ? notes.length : 0);

        // 写成功之后再顺手备份一次（内部按小时限流，绝大多数写入会直接跳过）
        const backup = store.backup(userId);
        if (!backup.ok) logger.warn(`备份失败 user=${userId}：${backup.error}`);
        else if (!backup.skipped) {
            logger.info(`已备份 ${backup.file}（${backup.count} 条`
                + `${backup.valid ? '' : '，内容无法解析'}）`
                + `${backup.pruned ? `，清理旧备份 ${backup.pruned} 份` : ''}`);
        }
        return result;
    });
    ipcMain.handle('notes:list-user-ids', () => store.listUserIds());
    ipcMain.handle('app:open-data-dir', () => shell.openPath(store.dataDir));
    ipcMain.handle('app:open-log-dir', () => shell.openPath(logger.dir));
    ipcMain.handle('app:open-backup-dir', () => shell.openPath(store.backupsDir));
    ipcMain.handle('app:backup-now', (_event, userId) => store.backup(userId, { force: true }));
    // D4 暗色模式：把界面上的选择同步给系统层。设成 'light'/'dark' 之后，
    // Windows 的标题栏与原生控件会跟着变色（'system' 则交还给系统）。
    // 它同时决定渲染进程里 prefers-color-scheme 的取值，所以「跟随系统」
    // 这一档必须老老实实传 'system'，否则会自己骗自己。
    ipcMain.handle('theme:set', (_event, mode) => {
        nativeTheme.themeSource = (mode === 'light' || mode === 'dark') ? mode : 'system';
        return nativeTheme.themeSource;
    });
    ipcMain.handle('app:info', () => ({
        version: app.getVersion(),
        dataDir: store.dataDir,
        logsDir: logger.dir,
        backupsDir: store.backupsDir,
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

    // 启动时先给"最近用的那份笔记"留一份备份：万一是新版本引入的问题，
    // 这一份就是"打开之前的样子"。内部有小时级限流，不会每次启动都堆一份。
    const recent = store.listUserIds()[0];
    if (recent) {
        const first = store.backup(recent.userId);
        if (first.ok && !first.skipped) {
            logger.info(`启动备份 ${first.file}（${first.count} 条）`);
        } else if (!first.ok) {
            logger.warn(`启动备份失败：${first.error}`);
        }
        if (typeof first.count === 'number' && first.count > 0) {
            lastNoteCounts.set(recent.userId, first.count);
        }
    }

    logger.info(`启动 v${app.getVersion()}｜数据目录=${store.dataDir}｜热键=${activeHotkey ?? '(未注册)'}`);

    if (!IS_SELFTEST) buildTray();
}

/* ------------------------------------------------------------------ */
/* 自检：不打开窗口，跑一遍存储 + 真实页面 + 写盘链路                    */
/* ------------------------------------------------------------------ */
async function runSelfTest() {
    const results = [];
    const check = (name, ok, extra = '') => results.push({ name, ok: !!ok, extra });

    await app.whenReady();

    // 日志链路也要验：写进去了、读得出来、路径在隔离目录里
    logger.info('自检：日志写入探针 LOGPROBE');
    const probeText = fs.existsSync(logger.file) ? fs.readFileSync(logger.file, 'utf8') : '';
    check('错误日志已落盘', probeText.includes('LOGPROBE'), logger.file);
    check('日志目录在隔离的 userData 内', logger.dir.startsWith(app.getPath('userData')), logger.dir);

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
    fs.writeFileSync(badFile, '{not json', 'utf8');    check('store 损坏文件返回错误而不是抛异常', isolated.read('broken')?.ok === false);
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

    // 备份（B1）：走真实的 IPC 通道强制备份一次，确认文件真的落到了备份目录里
    const backupResult = await win.webContents.executeJavaScript(
        `window.rfnoter.backupNow(${JSON.stringify(userId)})`
    );
    check(
        'IPC 备份能生成可解析的副本',
        backupResult?.ok === true && backupResult.valid === true && backupResult.count === 1,
        JSON.stringify(backupResult)
    );
    check(
        '备份文件确实存在于备份目录',
        Boolean(backupResult?.path) && fs.existsSync(backupResult.path)
            && path.resolve(path.dirname(backupResult.path)) === path.resolve(store.backupsDir)
            && path.resolve(store.backupsDir).startsWith(path.resolve(dataDir)),
        String(backupResult?.path)
    );
    const backupInfo = await win.webContents.executeJavaScript('window.rfnoter.appInfo()');
    check(
        'app:info 暴露备份目录',
        typeof backupInfo?.backupsDir === 'string' && backupInfo.backupsDir.includes('backups'),
        String(backupInfo?.backupsDir)
    );
    check(
        '写入会自动产生备份（无需手动触发）',
        store.listBackups(userId).length >= 2,
        `备份份数=${store.listBackups(userId).length}`
    );

    const saveIndicator = await win.webContents.executeJavaScript(
        "document.getElementById('save-indicator').textContent"
    );
    check('界面提示已保存', /已保存/.test(saveIndicator), saveIndicator);

    const tailwindApplied = await win.webContents.executeJavaScript(
        "getComputedStyle(document.querySelector('.note-card')).borderLeftWidth"
    );
    check('Tailwind 本地构建生效（卡片左边框 4px）', tailwindApplied === '4px', tailwindApplied);

    // 左上角 LOGO 走的是 app:// 取 public/icon.png，路径写错在开发态不一定看得出来
    const logo = await win.webContents.executeJavaScript(`(() => {
        const img = document.querySelector('header img');
        return img ? { complete: img.complete, width: img.naturalWidth, src: img.getAttribute('src') } : null;
    })()`);
    check(
        '左上角 LOGO 图片已加载',
        !!logo && logo.complete === true && logo.width > 0,
        JSON.stringify(logo)
    );

    // 任务栏/窗口标题显示的就是它
    check('窗口标题为「闪录」', win.getTitle() === '闪录', win.getTitle());

    // 统计面板：打开后四大块都要渲染出来，而且不能报错
    const statsProbe = await win.webContents.executeJavaScript(`(async () => {
        document.getElementById('stats-btn')?.click();
        await new Promise((resolve) => setTimeout(resolve, 400));
        const content = document.getElementById('stats-content');
        const text = content ? content.textContent : '';
        const result = {
            open: !document.getElementById('stats-modal')?.classList.contains('hidden'),
            ranking: text.includes('时长排行'),
            timeline: text.includes('一天时间轴'),
            hourly: text.includes('作息分布'),
            heatmap: text.includes('记录密度'),
            controls: content ? content.querySelectorAll('[data-stats-action]').length : 0,
            blocks: content ? content.querySelectorAll('[title]').length : 0,
            // 柱子高度百分比挂在 flex 项上，外层没有可参照的高度时会被算成 0 —— 实测踩过
            hourlyBars: content ? content.querySelectorAll('[data-hourly-bar]').length : 0,
            hourlyBarHeight: content
                ? Math.max(0, ...[...content.querySelectorAll('[data-hourly-bar]')]
                    .map((el) => Math.round(el.getBoundingClientRect().height)))
                : 0
        };
        document.getElementById('stats-btn')?.click();
        return result;
    })()`);
    check(
        '统计面板能打开并渲染四大块',
        statsProbe.open && statsProbe.ranking && statsProbe.timeline
            && statsProbe.hourly && statsProbe.heatmap,
        JSON.stringify(statsProbe)
    );
    check(
        '统计面板的图表与控件都画出来了',
        statsProbe.controls >= 8 && statsProbe.blocks > 0,
        `控件 ${statsProbe.controls} / 带提示的元素 ${statsProbe.blocks}`
    );
    check(
        '统计面板：作息分布的柱子有真实高度（没被 flex 压成 0）',
        statsProbe.hourlyBars === 24 && statsProbe.hourlyBarHeight > 0,
        `柱子 ${statsProbe.hourlyBars} 根 / 最高 ${statsProbe.hourlyBarHeight}px`
    );

    // A2：从统计排行点进"这件事的历史"，并且能跳回列表定位
    const historyProbe = await win.webContents.executeJavaScript(`(async () => {
        document.getElementById('stats-btn')?.click();
        await new Promise((resolve) => setTimeout(resolve, 400));
        const label = document.querySelector('[data-stats-action="history"]');
        const name = label ? label.dataset.label : null;
        label?.click();
        await new Promise((resolve) => setTimeout(resolve, 300));
        const content = document.getElementById('history-content');
        const rows = content ? content.querySelectorAll('[data-history-note-id]').length : 0;
        const opened = !document.getElementById('history-modal')?.classList.contains('hidden');
        // 点第一行应该跳回列表并定位到那条笔记
        const first = content?.querySelector('[data-history-note-id]');
        const targetId = first ? first.dataset.historyNoteId : null;
        first?.click();
        await new Promise((resolve) => setTimeout(resolve, 300));
        const located = targetId
            ? Boolean(document.querySelector('.note-card[data-note-id="' + targetId + '"]'))
            : false;
        const closed = document.getElementById('history-modal')?.classList.contains('hidden');
        document.getElementById('stats-btn')?.click();
        return { name, opened, rows, located, closed };
    })()`);
    check(
        '能打开「这件事的历史」并列出记录',
        historyProbe.opened && historyProbe.rows >= 1 && Boolean(historyProbe.name),
        JSON.stringify(historyProbe)
    );
    check(
        '从历史点一行能跳回列表并定位到那条笔记',
        historyProbe.located && historyProbe.closed === true,
        JSON.stringify(historyProbe)
    );

    // A5：删一条 → 撤销 → 回来（落盘数据也要跟着回滚）
    const undoProbe = await win.webContents.executeJavaScript(`(async () => {
        const count = () => document.querySelectorAll('.note-card').length;
        const before = count();
        const card = document.querySelector('.note-card');
        const targetId = card ? card.dataset.noteId : null;
        card?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
        document.getElementById('delete-note-menu-btn')?.click();
        document.getElementById('confirm-delete-btn')?.click();
        await new Promise((resolve) => setTimeout(resolve, 700));
        const afterDelete = count();
        const toastShown = !document.getElementById('undo-toast')?.classList.contains('hidden');
        document.getElementById('undo-toast-btn')?.click();
        await new Promise((resolve) => setTimeout(resolve, 900));
        return {
            before, afterDelete, afterUndo: count(),
            toastShown,
            toastHidden: document.getElementById('undo-toast')?.classList.contains('hidden'),
            restored: Boolean(targetId && document.querySelector('.note-card[data-note-id="' + targetId + '"]'))
        };
    })()`);
    check(
        '删除后能撤销，笔记回到列表',
        undoProbe.before === 1 && undoProbe.afterDelete === 0 && undoProbe.toastShown
            && undoProbe.afterUndo === 1 && undoProbe.restored && undoProbe.toastHidden === true,
        JSON.stringify(undoProbe)
    );
    const afterUndoOnDisk = store.read(userId);
    check(
        '撤销的结果也落盘了',
        afterUndoOnDisk.ok && afterUndoOnDisk.notes.length === 1,
        JSON.stringify(afterUndoOnDisk).slice(0, 120)
    );

    // D4 暗色模式：点按钮能换肤、颜色真的落到 CSS 上、偏好记得住、能转回跟随系统。
    // 这里断言的是**计算后的颜色**而不是"点了一下没报错"——变量换肤一旦没生效
    // （比如 Tailwind 不支持 <alpha-value>），颜色会退化成透明，下面这几条立刻就会红。
    //
    // 等待时间刻意压得很短（120ms）：换肤时 js/theme.js 会临时关掉过渡，颜色是立即到位的。
    // 哪天那个开关被去掉了，带 transition 的元素就会卡在旧颜色上 —— 这几条会当场发现。
    // 所以**不要靠调长等待时间来"修好"它**。
    const themeProbe = await win.webContents.executeJavaScript(`(async () => {
        const root = document.documentElement;
        const btn = document.getElementById('theme-btn');
        const snap = () => ({
            mode: btn.dataset.themeMode,
            title: btn.title,
            stored: localStorage.getItem('theme'),
            dark: root.classList.contains('dark'),
            colorScheme: root.style.colorScheme,
            body: getComputedStyle(document.body).backgroundColor,
            header: getComputedStyle(document.querySelector('header')).backgroundColor,
            group: getComputedStyle(document.querySelector('.date-header')).backgroundColor
        });
        const click = async () => { btn.click(); await new Promise((r) => setTimeout(r, 120)); };
        const initial = snap();
        await click();
        const dark = snap();
        await click();
        const light = snap();
        await click();
        const system = snap();
        // 顺手验一件实测踩过的事：暗色下热力图的"空格"不能和弹窗底色一样，
        // 否则整张热力图就是一片空白（浅色主题下 white 与 gray-100 是分得开的）。
        const clickUntil = async (target) => {
            for (let i = 0; i < 4 && btn.dataset.themeMode !== target; i += 1) await click();
        };
        await clickUntil('dark');
        document.getElementById('stats-btn').click();
        await new Promise((r) => setTimeout(r, 500));
        const cell = document.querySelector('#stats-content [data-heatmap-cell]');
        const dialog = document.querySelector('#stats-modal > div > div');
        const heatmap = {
            cell: cell ? getComputedStyle(cell).backgroundColor : null,
            dialog: dialog ? getComputedStyle(dialog).backgroundColor : null
        };
        document.getElementById('close-stats-btn').click();
        await new Promise((r) => setTimeout(r, 200));
        await clickUntil('system');
        return { themeBtnExists: !!btn, initial, dark, light, system, heatmap };
    })()`);

    check(
        'D4 暗色模式：点一下顶栏按钮，整页转暗（页面底 / 吸顶栏 / 日期分组三处一起变）',
        themeProbe.themeBtnExists && themeProbe.dark.mode === 'dark' && themeProbe.dark.dark === true
            && themeProbe.dark.colorScheme === 'dark'
            && themeProbe.dark.body === 'rgb(15, 23, 42)'
            && themeProbe.dark.header === 'rgba(30, 41, 59, 0.7)'
            && themeProbe.dark.group === 'rgb(30, 41, 59)',
        JSON.stringify(themeProbe.dark)
    );
    check(
        'D4 暗色模式：再点一下回到亮色，三处颜色全部还原',
        themeProbe.light.mode === 'light' && themeProbe.light.dark === false
            && themeProbe.light.colorScheme === 'light'
            && themeProbe.light.body === 'rgb(249, 250, 251)'
            && themeProbe.light.header === 'rgba(255, 255, 255, 0.7)'
            && themeProbe.light.group === 'rgb(243, 244, 246)',
        JSON.stringify(themeProbe.light)
    );
    check(
        'D4 暗色模式：偏好当场落盘，按钮提示会说明下一个状态',
        themeProbe.dark.stored === 'dark' && /点击切换到/.test(themeProbe.dark.title || ''),
        `stored=${themeProbe.dark.stored} title=${themeProbe.dark.title}`
    );
    check(
        'D4 暗色模式：热力图的空格与弹窗底色可区分（否则整张图看不见）',
        Boolean(themeProbe.heatmap?.cell) && Boolean(themeProbe.heatmap?.dialog)
            && themeProbe.heatmap.cell !== themeProbe.heatmap.dialog,
        JSON.stringify(themeProbe.heatmap)
    );
    check(
        'D4 暗色模式：第三下回到「跟随系统」，配色与启动时一致（没有残留）',
        themeProbe.system.mode === 'system' && themeProbe.system.stored === 'system'
            && themeProbe.system.dark === themeProbe.initial.dark
            && themeProbe.system.body === themeProbe.initial.body,
        JSON.stringify(themeProbe.system) + ' vs initial ' + JSON.stringify(themeProbe.initial)
    );

    // v2.3.0 新增的三块：常用条目容器、接续提示、惰性渲染
    const quick = await win.webContents.executeJavaScript(`(() => {
        const text = document.getElementById('quick-continuity-text');
        const btn = document.getElementById('quick-continue-btn');
        const picks = document.getElementById('quick-picks');
        return {
            continuity: text ? text.textContent : null,
            hasContinueBtn: !!btn,
            hasPicks: !!picks,
            dateGroups: document.querySelectorAll('.date-group').length,
            cards: document.querySelectorAll('.note-card').length
        };
    })()`);
    check(
        '接续提示读到了刚写入的笔记',
        !!quick.continuity && quick.continuity.includes('结束'),
        quick.continuity
    );
    check(
        '常用条目与补记空档的容器都在',
        quick.hasContinueBtn === true && quick.hasPicks === true,
        JSON.stringify(quick)
    );
    check(
        '卡片总数不超过笔记总数（惰性渲染没有多生成）',
        quick.cards > 0 && quick.cards <= quick.dateGroups * 50,
        `分组 ${quick.dateGroups} / 卡片 ${quick.cards}`
    );

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
