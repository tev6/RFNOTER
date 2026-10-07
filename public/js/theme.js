/**
 * 主题：亮色 / 暗色 / 跟随系统。
 *
 * 三条约定，改动前先看：
 *
 * 1. **类名不变，只换颜色值。** 暗色状态挂在 `<html class="dark">` 上，而具体颜色是
 *    CSS 变量（见 tailwind.config.js 里那段说明）。所以这里只负责一件事：
 *    决定 html 上有没有 dark 这个类。
 *
 * 2. **偏好存在 localStorage 的 'theme' 键里，取值只能是 system / light / dark。**
 *    js/theme-boot.js 会在首次绘制前读同一个键把类挂上（普通脚本，不能引 ESM）。
 *    两边的键名与取值必须一致，test/theme.test.js 有一条用例专门比对这一点。
 *
 * 3. **切换顺序是 跟随系统 → 常暗 → 常亮 → 跟随系统。**
 *    刻意让"第一下点击"落到常暗：最需要手动换肤的场景是深夜（系统还是亮色），
 *    这时一下就能变暗；反过来先给常亮的话，第一下点了没任何变化，像坏了一样。
 *
 * 桌面端还会顺手把选择同步给主进程（`nativeTheme.themeSource`），
 * 这样 Windows 的标题栏也跟着变，不会出现"窗口是黑的、标题栏是白的"。
 */

export const THEME_STORAGE_KEY = 'theme';

/** 三个模式。'system' 是默认值，也是唯一一个会跟着系统走的。 */
export const THEME_MODES = ['system', 'light', 'dark'];

/** 界面上给用户看的名字。 */
export const THEME_LABELS = { system: '跟随系统', light: '常亮', dark: '常暗' };

/** 顶栏按钮用的 Font Awesome 图标。 */
const THEME_ICONS = { system: 'fa-desktop', light: 'fa-sun-o', dark: 'fa-moon-o' };

/** 点击轮换顺序（见文件头第 3 条）。 */
export const THEME_CYCLE = ['system', 'dark', 'light'];

/** 把任何脏值收敛到合法模式，默认跟随系统。 */
export function normalizeMode(value) {
    return THEME_MODES.includes(value) ? value : 'system';
}

/** 点一下按钮之后该是哪个模式。 */
export function nextMode(mode) {
    const index = THEME_CYCLE.indexOf(normalizeMode(mode));
    return THEME_CYCLE[(index + 1) % THEME_CYCLE.length];
}

/** 模式 + 系统偏好 → 实际该用哪套配色。 */
export function resolveTheme(mode, prefersDark) {
    const normalized = normalizeMode(mode);
    if (normalized === 'system') return prefersDark ? 'dark' : 'light';
    return normalized;
}

/** 读存储里的模式。存储不可用（隐私模式）时一律当跟随系统，绝不抛异常。 */
export function readMode(storage = safeStorage()) {
    try {
        return normalizeMode(storage?.getItem(THEME_STORAGE_KEY));
    } catch {
        return 'system';
    }
}

/** 写回存储；失败就静默放弃——记不住偏好不该影响使用。 */
export function writeMode(mode, storage = safeStorage()) {
    try {
        storage?.setItem(THEME_STORAGE_KEY, normalizeMode(mode));
    } catch {
        /* ignore */
    }
}

/** 换肤期间挂在 <html> 上的临时类，对应的 CSS 在 index.html 里。 */
export const SWITCHING_CLASS = 'theme-switching';

/**
 * 把主题落到 DOM 上。只动两处：
 *   - `<html class="dark">`：给 Tailwind 的 dark: 变体看；
 *   - `style.colorScheme`：让原生滚动条、日期选择器跟着变暗。
 *
 * 为什么中间要插一段"关掉过渡"：
 * 颜色是由**继承下来的 CSS 变量**算出来的，而界面上很多元素带 transition-colors/all。
 * Chromium 在"变量变了 + 该属性正在过渡"时不会把过渡收尾，那些元素会一直停在旧颜色上
 * （实测等 400ms 仍是旧色，.date-header 就卡在浅色）。加临时类 + 强制一次样式重算，
 * 颜色当场到位；同一帧内摘掉临时类，用户看不到这个中间态。
 */
export function applyTheme(theme, root = defaultRoot()) {
    if (!root) return theme;
    root.classList.add(SWITCHING_CLASS);
    root.classList.toggle('dark', theme === 'dark');
    root.style.colorScheme = theme;
    // 读一次布局属性，逼浏览器在这里就把样式算完（此时过渡是关着的）
    void root.offsetWidth;
    root.classList.remove(SWITCHING_CLASS);
    return theme;
}

function defaultRoot() {
    return typeof document !== 'undefined' ? document.documentElement : null;
}

function safeStorage() {
    try {
        return typeof localStorage !== 'undefined' ? localStorage : null;
    } catch {
        return null;
    }
}

function defaultMatchMedia() {
    try {
        return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
            ? window.matchMedia('(prefers-color-scheme: dark)')
            : null;
    } catch {
        return null;
    }
}

/**
 * 一次性接线：读偏好 → 应用 → 绑定按钮 → 监听系统变化。
 *
 * 依赖全部由参数注入（与 initRender 同样的理由）：静态导入的模块会在多个测试用例间
 * 共享，模块级抓 DOM 会让第二个用例操作到第一个用例的 document。
 *
 * @returns {{getMode: Function, setMode: Function, cycle: Function, theme: Function, dispose: Function}}
 */
export function initTheme({
    root = defaultRoot(),
    button = null,
    icon = null,
    storage = safeStorage(),
    matchMedia = defaultMatchMedia(),
    bridge = (typeof window !== 'undefined' ? window.rfnoter : null)
} = {}) {
    let mode = readMode(storage);

    const prefersDark = () => {
        try {
            return Boolean(matchMedia?.matches);
        } catch {
            return false;
        }
    };

    /** 当前实际生效的配色（'light' / 'dark'），跟随系统时会随系统变。 */
    const currentTheme = () => resolveTheme(mode, prefersDark());

    const syncButton = () => {
        if (icon) icon.className = `fa ${THEME_ICONS[mode]}`;
        if (button) {
            const next = THEME_LABELS[nextMode(mode)];
            button.dataset.themeMode = mode;
            button.setAttribute('aria-label', `主题：${THEME_LABELS[mode]}，点击切换到${next}`);
            button.title = `主题：${THEME_LABELS[mode]}（点击切换到「${next}」）`;
        }
    };

    /** 把模式同步给主进程，让 Windows 标题栏跟着换色（网页端没有这个桥，跳过）。 */
    const syncNativeTheme = () => {
        try {
            bridge?.setThemeSource?.(mode);
        } catch { /* 主进程没实现也不该影响界面 */ }
    };

    const render = () => {
        applyTheme(currentTheme(), root);
        syncButton();
    };

    const setMode = (next, { persist = true } = {}) => {
        mode = normalizeMode(next);
        if (persist) writeMode(mode, storage);
        render();
        syncNativeTheme();
        return mode;
    };

    const cycle = () => setMode(nextMode(mode));

    if (button) button.addEventListener('click', cycle);
    render();

    // 跟随系统时，系统配色一变就要跟着变；显式模式下这个事件无影响（结果一样）
    const onSystemChange = () => render();
    matchMedia?.addEventListener?.('change', onSystemChange);
    // 老版 Chromium/Safari 只有 addListener，Electron 44 用不到，留着兜底
    if (typeof matchMedia?.addEventListener !== 'function') matchMedia?.addListener?.(onSystemChange);

    return {
        getMode: () => mode,
        getTheme: currentTheme,
        setMode,
        cycle,
        dispose: () => {
            if (button) button.removeEventListener('click', cycle);
            matchMedia?.removeEventListener?.('change', onSystemChange);
            if (typeof matchMedia?.removeEventListener !== 'function') matchMedia?.removeListener?.(onSystemChange);
        }
    };
}
