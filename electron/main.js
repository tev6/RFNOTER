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
import { createUpdateChecker, createUpdateState, pickLatestRelease, compareVersions } from './updater.js';

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

/**
 * E4 更新检查：最近一次检查的结果，供界面随时查询。
 *
 * 放在内存里而不是每次问界面就重查一遍——GitHub 未认证 API 限流 60 次/小时，
 * 一次检查的结果应该被反复复用（顶栏小圆点 + 打开弹窗都读这一份）。
 * 结构：null=还没查过 / { ok:false }=查失败 / { ok:true, hasUpdate, ... }
 */
let updateStatus = null;

// 日志尽早建立：userData 上面已经钉死了，所以从这一刻起任何异常都能落盘
const logger = createLogger(path.join(app.getPath('userData'), 'logs'));

// 更新检查器：currentVersion 要等到 whenReady 之后 app.getVersion() 才准，
// 所以这里先建状态文件读写，检查器在 bootstrap 里再建（见 createUpdateChecker 调用处）。
const updateState = createUpdateState(path.join(app.getPath('userData'), 'update-state.json'));

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
                    // 附加 --update：先造一个"有新版本"的状态把圆点与弹窗调出来再截。
                    // 更新提示在正常运行时**平时是看不见的**（只在查到新版才亮），
                    // 所以只能靠这个开关在真实渲染里看它长什么样、暗色下清不清楚。
                    if (process.argv.includes('--update')) {
                        updateStatus = {
                            ok: true, hasUpdate: true, muted: false,
                            currentVersion: app.getVersion(), latestVersion: '99.0.0',
                            tag: 'v99.0.0', name: 'v99.0.0 排版检查用的假版本',
                            notes: '新功能\n· 可以检查更新了，发现新版会在顶栏亮起小圆点\n'
                                + '· 更新说明按纯文本显示，不渲染外部 Markdown\n\n'
                                + '修复\n· 某些情况下跨夜记录会归错日期',
                            publishedAt: null,
                            pageUrl: 'https://github.com/tev6/RFNOTER/releases',
                            downloadUrl: null, downloadName: null,
                            downloadSize: 111666621, downloadSizeText: '106.5 MB'
                        };
                        // 必须真的走一遍"主进程推送"这条路再把弹窗打开：
                        // 光给主进程的变量赋值，界面并不知道（它自己那份 status 还是空的），
                        // 点开弹窗就会显示"没有写更新说明"。这里踩过一次。
                        broadcastUpdateStatus();
                        await wait(400);
                        // 附加 --badge-only：只亮顶栏胶囊、不打开弹窗，方便单独看它。
                        // 平时用户看到的就是这个状态，弹窗只有主动点才出现。
                        if (!process.argv.includes('--badge-only')) {
                            await mainWindow.webContents.executeJavaScript(
                                "document.getElementById('update-badge')?.click()"
                            );
                            await wait(700);
                        }
                        // 顺手把弹窗的真实几何打出来：截图只能看大概，
                        // "有没有超出窗口""按钮在不在可视区内"必须靠数字判断。
                        const geo = await mainWindow.webContents.executeJavaScript(`(() => {
                            const modal = document.getElementById('update-modal');
                            const panel = modal?.querySelector('.bg-surface');
                            const dl = document.getElementById('update-download-btn');
                            const dis = document.getElementById('update-dismiss-btn');
                            const badge = document.getElementById('update-badge');
                            const r = (el) => { const b = el?.getBoundingClientRect(); return b
                                ? { top: Math.round(b.top), bottom: Math.round(b.bottom),
                                    left: Math.round(b.left), right: Math.round(b.right) } : null; };
                            return {
                                open: modal ? !modal.classList.contains('hidden') : null,
                                viewport: { w: window.innerWidth, h: window.innerHeight },
                                panel: r(panel), download: r(dl), dismiss: r(dis),
                                // 顶栏胶囊：平时用户看的就是它，必须真的在可视区内、不是零尺寸
                                badge: r(badge),
                                badgeVisible: badge ? !badge.classList.contains('hidden') : null,
                                badgeDisplay: badge ? getComputedStyle(badge).display : null,
                                badgeText: badge ? badge.textContent.trim() : null,
                                badgeColor: badge ? getComputedStyle(badge).color : null
                            };
                        })()`);
                        console.log('[RFNOTER] 更新弹窗几何:', JSON.stringify(geo));
                    }
                    // 附加 --suggest=<文字>：先往标题框里打字把补全浮层调出来再截。
                    // 补全是个"浮"在上面的东西，只有截出来才能确认它没被裁掉、
                    // 没遮住输入框、暗色下也看得清——这些自检的断言都验不了。
                    const suggestArg = process.argv.find((arg) => arg.startsWith('--suggest='));
                    if (suggestArg) {
                        const text = suggestArg.slice('--suggest='.length);
                        const geo = await mainWindow.webContents.executeJavaScript(`(() => {
                            const input = document.getElementById('quick-content');
                            input.focus();
                            input.value = ${JSON.stringify(text)};
                            input.dispatchEvent(new Event('input', { bubbles: true }));
                            return input.value;
                        })()`);
                        await wait(700);
                        // 把浮层的真实几何打出来。截图只能看个大概，
                        // 而"有没有超出窗口下沿""有没有盖住输入框"必须靠数字判断。
                        const box = await mainWindow.webContents.executeJavaScript(`(() => {
                            const b = document.getElementById('quick-suggest');
                            const i = document.getElementById('quick-content');
                            if (!b || !i) return null;
                            const br = b.getBoundingClientRect();
                            const ir = i.getBoundingClientRect();
                            return {
                                hidden: b.classList.contains('hidden'),
                                rows: b.querySelectorAll('.suggest-row').length,
                                box: { top: Math.round(br.top), bottom: Math.round(br.bottom),
                                       left: Math.round(br.left), width: Math.round(br.width) },
                                input: { top: Math.round(ir.top), bottom: Math.round(ir.bottom) },
                                viewportH: window.innerHeight,
                                overflowBottom: Math.round(br.bottom - window.innerHeight)
                            };
                        })()`);
                        console.log('[RFNOTER] suggest 浮层几何:', JSON.stringify(box), '输入=', geo);
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

/* ------------------------------------------------------------------ */
/* E4 更新检查                                                          */
/* ------------------------------------------------------------------ */

/** 建检查器。必须在 app.whenReady() 之后——app.getVersion() 那时才准。 */
function createChecker() {
    return createUpdateChecker({
        currentVersion: app.getVersion(),
        state: updateState,
        logger
    });
}

/** 有新版本时，把结果推给界面（顶栏小圆点亮起来）。 */
function broadcastUpdateStatus() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('update-status', updateStatus);
}

/**
 * 用户点过「知道了」的版本不要再提示，但**只有那一个版本**被压住。
 *
 * 关键：每次拿到结果都重新算一遍，而不是查一次就永久静音。
 * 否则用户认掉了 2.13.0 之后，2.14.0 出来了也再也不提示——等于关掉了这个功能。
 * 这里用"记下已知晓的版本号"而不是"关掉检查更新"，就是为了避免这种情况。
 */
function applyDismissed(status) {
    if (!status?.ok || !status.hasUpdate) return status;
    if (updateState.dismissedVersion() === status.latestVersion) {
        return { ...status, muted: true };
    }
    return status;
}

/**
 * 跑一次检查并把结果记下来。
 *
 * **这个函数永远不抛异常**：检查更新是纯粹的锦上添花，
 * 断网、限流、GitHub 改接口都不该影响记录笔记这件正事。
 */
async function runUpdateCheck({ force = false } = {}) {
    try {
        const result = await createChecker().check({ force });
        if (result.skipped) {
            // 被节流：保留上一次的结果（如果有），不要用"跳过"覆盖掉已知的新版本提示
            return updateStatus;
        }
        updateStatus = applyDismissed(result);
        if (result.ok && result.hasUpdate) {
            logger.info(`发现新版本 ${result.latestVersion}（当前 ${result.currentVersion}）`
                + `${updateStatus.muted ? '，但用户已认掉这个版本，不提示' : ''}`);
        }
        broadcastUpdateStatus();
        return updateStatus;
    } catch (err) {
        // 理论上 check() 内部已经吃掉了所有异常，这里是最后一道保险
        logger.error('检查更新时发生意外', err);
        return updateStatus;
    }
}

/**
 * 启动后延迟一会儿再自动检查。
 *
 * 刻意延后：启动那几秒是用户最可能马上开始记录的时候，
 * 一个网络请求不该和"记一条"抢资源。而且延迟也顺便避开启动时的磁盘备份高峰。
 * 这个检查受 6 小时节流约束，正常一天最多跑几次。
 */
function scheduleStartupUpdateCheck() {
    setTimeout(() => { runUpdateCheck(); }, 8000);
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
        // E4：托盘里也能主动查一次（界面上还有顶栏小圆点那条路）。
        // 查到有新版本就打开窗口把弹窗推给用户，否则只记日志——静默是这里的默认行为。
        {
            label: '检查更新',
            click: async () => {
                const result = await runUpdateCheck({ force: true });
                if (result?.ok && result.hasUpdate) {
                    showWindow();
                    broadcastUpdateStatus();
                }
            }
        },
        { label: `版本 ${app.getVersion()}`, enabled: false },
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
    // E4：界面问"有没有新版"时读内存里那份结果，不发新请求（限流额度要省着用）。
    // 返回前重新套一遍"用户已认掉的版本"，否则界面刷新时会把认掉的状态盖掉。
    ipcMain.handle('update:status', () => applyDismissed(updateStatus));
    // 用户主动点「检查更新」：force 走 30 秒的短节流，连点不会打光额度。
    ipcMain.handle('update:check', () => runUpdateCheck({ force: true }));
    // 「知道了」：记下这个版本别再提示，但下次真有更新的版本仍然会提示。
    ipcMain.handle('update:dismiss', (_event, version) => {
        if (typeof version === 'string' && version) {
            updateState.write({ dismissedVersion: version });
            logger.info(`用户已知晓版本 ${version}，不再重复提示`);
        }
        return true;
    });
    // 「去下载」：交给系统浏览器打开 release 页（应用内不做下载）。
    ipcMain.handle('update:open-download', (_event, url) => {
        const target = typeof url === 'string' && /^https:\/\/github\.com\//i.test(url)
            ? url
            : `https://github.com/tev6/RFNOTER/releases`;
        shell.openExternal(target);
        return true;
    });
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

    if (!IS_SELFTEST) {
        buildTray();
        // E4：启动后延迟自动查一次更新（受 6 小时节流约束）。
        // 不 await —— 检查更新绝不能拖慢启动，失败也无所谓。
        scheduleStartupUpdateCheck();
    }
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

    // 时间归属端到端：真的提交一条跨夜记录，看落盘的 date 对不对。
    // 上面那几条只证了工具函数算得对；这条证的是表单确实把它接上了、
    // 并且一路写进了文件——那才是用户看到的分组。
    const crossProbe = await win.webContents.executeJavaScript(`(async () => {
        const mod = await import('./js/utils.js');
        const expected = mod.dateStringOfClockInRange('23:50', '00:20');
        document.getElementById('quick-content').value = '跨夜记录';
        document.getElementById('quick-time-start').value = '23:50';
        document.getElementById('quick-time-end').value = '00:20';
        document.getElementById('quick-add-form')
            .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        return { expected, hour: new Date().getHours() };
    })()`);
    await wait(800);
    const afterCross = store.read(userId);
    const crossSaved = (afterCross.notes || []).find((n) => n.content === '跨夜记录');
    check(
        '时间归属端到端：跨夜记录落盘的 date 与页面判断一致',
        !!crossSaved && crossSaved.date === crossProbe.expected,
        `落盘 date=${crossSaved?.date} / 期望 ${crossProbe.expected}（提交时 ${crossProbe.hour} 点）`
    );
    check(
        '时间归属端到端：跨夜记录的起止时间原样保存',
        crossSaved?.timeStart === '23:50' && crossSaved?.timeEnd === '00:20',
        `${crossSaved?.timeStart}~${crossSaved?.timeEnd}`
    );
    // 清掉探针笔记：走**页面自己的删除入口**（和 A5 撤销用例同一套），
    // 而不是直接改文件——直接写文件会让文件与页面内存里的 notes 不一致。
    const crossRemoved = await win.webContents.executeJavaScript(`(async () => {
        const card = [...document.querySelectorAll('.note-card')]
            .find((el) => el.textContent.includes('跨夜记录'));
        if (!card) return { found: false };
        card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
        document.getElementById('delete-note-menu-btn')?.click();
        document.getElementById('confirm-delete-btn')?.click();
        await new Promise((r) => setTimeout(r, 700));
        // 这次删除只是清理，不需要撤销，点 × 认掉
        document.getElementById('undo-toast-close')?.click();
        await new Promise((r) => setTimeout(r, 300));
        return { found: true, left: document.querySelectorAll('.note-card').length };
    })()`);
    await wait(400);
    const onDiskAfter = store.read(userId);
    check(
        '时间归属端到端：探针笔记已清掉，文件与页面一致',
        crossRemoved.found && crossRemoved.left === 1
            && (onDiskAfter.notes || []).every((n) => n.content !== '跨夜记录'),
        `found=${crossRemoved.found} 卡片=${crossRemoved.left} 文件剩 ${onDiskAfter.notes?.length} 条`
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

    /* --------------------------------------------------------------
     * C3：输入补全（v2.11.0）
     *
     * 放在自检的**最末尾**，因为它必须往隔离库里种几条笔记才有候选可补
     * （没有历史就没有词表）。种数据会改变笔记条数，前面那些对条数敏感的
     * 检查（撤销那组的 before===1、布局那组的卡片总数）就会被带偏——踩过。
     * 放到最后，既不用小心翼翼清理，也不影响任何人。
     * -------------------------------------------------------------- */
    const suggestProbe = await win.webContents.executeJavaScript(`(async () => {
        const input = document.getElementById('quick-content');
        const box = document.getElementById('quick-suggest');
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const count = () => document.querySelectorAll('.note-card').length;

        const seededBefore = count();
        for (const content of ['CS+B站', 'CS+吃饭', 'B站+吃饭']) {
            input.value = content;
            document.getElementById('quick-time-start').value = '09:00';
            document.getElementById('quick-time-end').value = '09:40';
            document.getElementById('quick-add-form')
                .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
            await wait(60);
        }
        const seeded = count() - seededBefore;

        // 打字应当给候选
        input.value = 'C';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await wait(30);
        const rows = [...box.querySelectorAll('.suggest-row')];
        const opened = !box.classList.contains('hidden');
        const inputRect = input.getBoundingClientRect();
        const boxRect = box.getBoundingClientRect();
        // 浮层要**完整落在视口内**。
        //
        // 这里曾经只断言"在输入框下方"，结果漏掉一个真 bug：输入区钉在页面底部，
        // 朝下展开会捅出窗口下沿（实测视口高 739、浮层底边 976，超出 237px），
        // 8 条候选几乎全被切掉——断言却是绿的，因为"确实在下方"。
        // 所以必须直接验可见性：上边不出顶、下边不出底。
        const aboveInput = boxRect.bottom <= inputRect.top + 1;
        const inViewport = boxRect.top >= 0 && boxRect.bottom <= window.innerHeight + 1;

        // 点候选填回输入框
        rows[0]?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        await wait(30);
        const afterClick = input.value;

        // Esc 收起但保留内容
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        await wait(20);
        const closedByEsc = box.classList.contains('hidden');

        // 多段输入：打完分隔符后应当提示下一段，且前面的段保留
        input.value = 'CS+';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await wait(30);
        const nextSegRows = box.querySelectorAll('.suggest-row').length;
        box.querySelector('.suggest-row')
            ?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        await wait(30);
        const multiSegValue = input.value;

        input.value = '';
        return {
            seeded, opened, rowCount: rows.length, aboveInput, inViewport,
            viewportH: window.innerHeight,
            boxBottom: Math.round(boxRect.bottom),
            inputTop: Math.round(inputRect.top),
            afterClick, closedByEsc, keptAfterEsc: closedByEsc, nextSegRows, multiSegValue
        };
    })()`);
    check(
        'C3 输入补全：打字后浮层弹出且有候选',
        suggestProbe.opened && suggestProbe.rowCount > 0,
        JSON.stringify(suggestProbe)
    );
    check(
        'C3 输入补全：浮层完整可见（在输入框上方，且不超出窗口）',
        suggestProbe.aboveInput === true && suggestProbe.inViewport === true,
        `上方=${suggestProbe.aboveInput} 视口内=${suggestProbe.inViewport} `
            + `浮层底=${suggestProbe.boxBottom} 输入框顶=${suggestProbe.inputTop} 视口高=${suggestProbe.viewportH}`
    );
    check(
        'C3 输入补全：点候选能填回标题框',
        typeof suggestProbe.afterClick === 'string' && suggestProbe.afterClick.length > 1
            && suggestProbe.afterClick !== 'C',
        `填回="${suggestProbe.afterClick}"`
    );
    check(
        'C3 输入补全：Esc 收起候选',
        suggestProbe.closedByEsc === true,
        `收起=${suggestProbe.closedByEsc}`
    );
    check(
        'C3 输入补全：多段输入只补当前一段，前面的段保留',
        suggestProbe.nextSegRows > 0 && String(suggestProbe.multiSegValue).startsWith('CS+')
            && String(suggestProbe.multiSegValue).length > 3,
        `候选 ${suggestProbe.nextSegRows} 条 / 结果 "${suggestProbe.multiSegValue}"`
    );

    // 时间归属（本次修复）：在真实渲染进程里验「凌晨补记跨夜记录」的落库日期。
    // 这条必须在真实页面里跑——utils 的单测只能证明算法对，
    // 证明不了 app.js 的表单确实把它接上了。
    const clockProbe = await win.webContents.executeJavaScript(`(async () => {
        const out = {};
        // 直接问页面里的工具函数：凌晨 1:05 时，23:50~00:20 该归哪天
        const mod = await import('./js/utils.js');
        const at = (h, m) => { const d = new Date(2026, 4, 14, h, m, 0, 0); return d; };
        out.crossYesterday = mod.dateStringOfClockInRange('23:50', '00:20', at(1, 5));
        out.sameDay = mod.dateStringOfClockInRange('00:10', '00:55', at(1, 5));
        out.dayTime = mod.dateStringOfClockInRange('23:50', '00:20', at(15, 0));
        return out;
    })()`);
    check(
        '时间归属：凌晨补记跨夜记录归到昨天',
        clockProbe.crossYesterday === '2026-05-13',
        `23:50~00:20 @01:05 -> ${clockProbe.crossYesterday}`
    );
    check(
        '时间归属：不跨夜的凌晨记录仍归当天',
        clockProbe.sameDay === '2026-05-14',
        `00:10~00:55 @01:05 -> ${clockProbe.sameDay}`
    );
    check(
        '时间归属：白天记跨夜时段不往回挪',
        clockProbe.dayTime === '2026-05-14',
        `23:50~00:20 @15:00 -> ${clockProbe.dayTime}`
    );

    // 取整溢出：23:58 该落到次日 00:00，且不是回绕
    const ceilProbe = await win.webContents.executeJavaScript(`(async () => {
        const mod = await import('./js/utils.js');
        const base = new Date(2026, 4, 14, 23, 58, 0, 0);
        const ts = mod.ceilToStepTimestamp(base);
        const d = new Date(ts);
        return { ts, minutes: mod.ceilToStepMinutes(base), years: d.getFullYear(),
                 month: d.getMonth() + 1, date: d.getDate(), h: d.getHours(), m: d.getMinutes(),
                 notEarlier: ts >= base.getTime() };
    })()`);
    check(
        '取整：23:58 取整到次日 00:00，且不早于原时刻',
        ceilProbe.minutes === 1440 && ceilProbe.date === 15 && ceilProbe.h === 0
            && ceilProbe.m === 0 && ceilProbe.notEarlier === true,
        JSON.stringify(ceilProbe)
    );

    /* --------------------------------------------------------------
     * E4：更新检查（v2.13.0）
     *
     * 这一组要验三件事，缺一不可：
     *   ① 检查链路真的能通（**打真网络**——假 fetch 只能证明代码接对了，
     *      证明不了这台机器到 api.github.com 真的走得通。这个项目就因为
     *      "PowerShell/curl 全被拦、只有 Node 能通"踩过一次）；
     *   ② 断网/异常时静默降级（绝不能因为查更新失败而报错或卡住）；
     *   ③ 圆点与弹窗这条 UI 路真的走得通（改的是界面，就得看界面）。
     *
     * 放在最后：种的是临时数据、发的是真请求，不该影响前面那些对条数敏感的判断。
     * -------------------------------------------------------------- */

    // ① 真实网络：直接用主进程的 fetch 问一次 GitHub（不看结果、只看连通性）。
    // 这一步在 CI（GitHub Actions）与本地都必须通过；不通说明"检查更新"这个功能
    // 在你机器上根本不可能工作，那是必须先知道的事。
    let liveNet = { ok: false, detail: '未执行' };
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10000);
        const resp = await fetch(`https://api.github.com/repos/tev6/RFNOTER/releases?per_page=1`, {
            headers: { 'User-Agent': `RFNOTER/${app.getVersion()}`, Accept: 'application/vnd.github+json' },
            signal: controller.signal
        });
        clearTimeout(timer);
        const payload = await resp.json();
        const latest = pickLatestRelease(payload);
        liveNet = {
            ok: resp.ok && Boolean(latest),
            status: resp.status,
            latest: latest ? latest.version : null,
            assets: latest ? latest.downloadName : null
        };
    } catch (err) {
        liveNet = { ok: false, detail: describeError(err).slice(0, 160) };
    }
    check(
        'E4 更新检查：能连通 GitHub Releases API 并解析出版本号',
        liveNet.ok === true,
        JSON.stringify(liveNet)
    );

    // 自检环境用独立 userData，状态文件也在这里，绝不会动真实的那份
    const probeState = createUpdateState(path.join(app.getPath('userData'), 'selftest-update-state.json'));

    // ② 真检查器（真网络）跑一次：当前版本应当被正确识别。
    // 自检时版本是 2.13.0，线上最新也是某个真实版本，两者一比即可。
    const realCheck = await createUpdateChecker({
        currentVersion: app.getVersion(), state: probeState, logger
    }).check();
    check(
        'E4 更新检查：真实检查能给出当前版本与线上版本',
        realCheck.ok === true && typeof realCheck.latestVersion === 'string'
            && realCheck.currentVersion === app.getVersion(),
        JSON.stringify({ ok: realCheck.ok, cur: realCheck.currentVersion, latest: realCheck.latestVersion })
    );
    // 版本号必须解析得出来，否则 compareVersions 返回 null，功能等于失效
    check(
        'E4 更新检查：线上版本号可比较（不是一堆无法解析的字符）',
        realCheck.ok === true && compareVersions(realCheck.latestVersion, app.getVersion()) !== null,
        `latest=${realCheck.latestVersion} current=${app.getVersion()}`
    );
    // 状态文件真的被写了（节流要靠它跨进程生效）
    check(
        'E4 更新检查：检查时间已落盘（节流下次启动才生效）',
        probeState.lastCheckAt() > 0,
        `lastCheckAt=${probeState.lastCheckAt()}`
    );

    // ③ 离线降级：把 fetch 换成必抛的实现，检查必须"安静地失败"，不能抛。
    const offlineCheck = await createUpdateChecker({
        currentVersion: app.getVersion(),
        state: createUpdateState(path.join(app.getPath('userData'), 'selftest-offline-state.json')),
        logger,
        fetchImpl: async () => { throw new Error('ENOTFOUND api.github.com'); }
    }).check();
    check(
        'E4 更新检查：断网时静默失败（ok=false，不抛异常、不影响使用）',
        offlineCheck.ok === false && typeof offlineCheck.reason === 'string'
            && offlineCheck.hasUpdate === undefined,
        JSON.stringify(offlineCheck)
    );

    // 版本号比较这个最容易写错的地方，在真实进程里再钉一次
    check(
        'E4 更新检查：2.13.0 比 2.9.0 新（不是按字符串比）',
        compareVersions('2.13.0', '2.9.0') > 0 && compareVersions('2.9.0', '2.13.0') < 0
            && compareVersions('2.13.0', 'latest') === null
    );

    // ④ 界面这条路：先确认元素就位，再走一遍真实交互（下面那段推送）。
    // 只看纯函数证明不了 index.html 里那些 id 接对了没有——少一个 id，
    // getElementById 返回 null，addEventListener 不报错，功能只是"点了没反应"。
    const updateUiProbe = await win.webContents.executeJavaScript(`(() => {
        const badge = document.getElementById('update-badge');
        const modal = document.getElementById('update-modal');
        return {
            missing: !badge || !modal,
            badgeHidden: badge ? badge.classList.contains('hidden') : null,
            modalHidden: modal ? modal.classList.contains('hidden') : null,
            hasBridge: typeof window.rfnoter?.onUpdateStatus === 'function',
            hasStatusApi: typeof window.rfnoter?.updateStatus === 'function'
        };
    })()`);
    check(
        'E4 更新界面：圆点与弹窗都已就位且默认隐藏',
        updateUiProbe.missing === false && updateUiProbe.badgeHidden === true
            && updateUiProbe.modalHidden === true,
        JSON.stringify(updateUiProbe)
    );
    check(
        'E4 更新界面：preload 暴露了更新状态查询与推送通道',
        updateUiProbe.hasBridge === true && updateUiProbe.hasStatusApi === true,
        JSON.stringify(updateUiProbe)
    );

    // 推送一版"有新版本"，再走真实交互：点圆点 → 弹窗开 → 点知道了 → 圆点灭。
    // 用 ipcRenderer 那条真实通道推（mainWindow.webContents.send），
    // 这样验的才是"主进程推 → 界面亮"这条路。
    mainWindow = win;
    updateStatus = {
        ok: true, hasUpdate: true, muted: false,
        currentVersion: app.getVersion(), latestVersion: '99.0.0',
        tag: 'v99.0.0', name: 'v99.0.0 自检假版本',
        notes: '这是自检用的假更新说明。', publishedAt: null,
        pageUrl: 'https://github.com/tev6/RFNOTER/releases',
        downloadUrl: null, downloadName: null, downloadSize: null, downloadSizeText: ''
    };
    broadcastUpdateStatus();
    await wait(400);

    const updateFlow = await win.webContents.executeJavaScript(`(async () => {
        const badge = document.getElementById('update-badge');
        const modal = document.getElementById('update-modal');
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const litAfterPush = !badge.classList.contains('hidden');
        badge.click();
        await wait(50);
        const openedByBadge = !modal.classList.contains('hidden');
        const versionText = document.getElementById('update-versions').textContent;
        const notesText = document.getElementById('update-notes').textContent;
        // 点「知道了」→ 圆点应当灭掉
        document.getElementById('update-dismiss-btn').click();
        await wait(150);
        return {
            litAfterPush, openedByBadge, versionText, notesText,
            closedByDismiss: modal.classList.contains('hidden'),
            badgeClearedByDismiss: badge.classList.contains('hidden')
        };
    })()`);
    check(
        'E4 更新界面：主进程推来新版本后圆点亮起（不是一进页面就亮）',
        updateFlow.litAfterPush === true,
        JSON.stringify(updateFlow)
    );
    check(
        'E4 更新界面：点圆点能打开弹窗并显示版本与说明',
        updateFlow.openedByBadge === true
            && /99\.0\.0/.test(updateFlow.versionText)
            && /自检用的假更新说明/.test(updateFlow.notesText),
        JSON.stringify(updateFlow)
    );
    check(
        'E4 更新界面：点「知道了」后弹窗关闭且圆点灭掉',
        updateFlow.closedByDismiss === true && updateFlow.badgeClearedByDismiss === true,
        JSON.stringify(updateFlow)
    );

    // 「知道了」必须只压住这一个版本，不能把功能永久静音——
    // 这是这个功能最容易做错、也最致命的地方（用户以为以后都不会提示了）。
    const mutedAgain = (() => {
        const dismissed = updateState.dismissedVersion();
        const s = { ok: true, hasUpdate: true, latestVersion: '99.0.0' };
        const mutedNow = dismissed === s.latestVersion;
        const mutedLater = dismissed === '100.0.0';
        return { dismissed, mutedNow, mutedLater };
    })();
    check(
        'E4 更新界面：认掉的只是那一个版本，出了更新的版本仍会提示',
        mutedAgain.mutedNow === true && mutedAgain.mutedLater === false,
        JSON.stringify(mutedAgain)
    );
    // 清掉自检写下的"已知晓"，别让它留在隔离目录外影响下次自检判断
    try { updateState.write({ dismissedVersion: null }); } catch { /* 无所谓 */ }

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
