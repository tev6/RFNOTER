/**
 * D4 暗色模式：主题模块的单元测试。
 *
 * 除了纯函数，这里还干三件"守门"的活：
 *   1. 真的把 js/theme-boot.js 跑起来（jsdom + window.eval），验证"首帧前上色"这条路；
 *   2. 比对 theme-boot.js 与 theme.js 用的键名/取值 —— 两边一旦走岔，就会出现
 *      "启动那一下是亮的、随后被 JS 改成暗的"这种闪烁，而且不报任何错；
 *   3. 比对 tailwind.config.js 引用的 CSS 变量与 index.html 里定义的变量，
 *      少定义一个，就会有一批颜色变成透明。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import {
    THEME_MODES, THEME_LABELS, THEME_STORAGE_KEY, THEME_CYCLE,
    SWITCHING_CLASS, normalizeMode, nextMode, resolveTheme, readMode, writeMode, applyTheme, initTheme
} from '../public/js/theme.js';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const BOOT_SOURCE = read('../public/js/theme-boot.js');
const INDEX_HTML = read('../public/index.html');
const TAILWIND_CONFIG = read('../public/tailwind.config.js');

/** 造一个"够用"的 MediaQueryList 替身（jsdom 没有 matchMedia）。 */
function fakeMatchMedia(prefersDark) {
    return {
        matches: prefersDark,
        media: '(prefers-color-scheme: dark)',
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {}
    };
}

/* ------------------------------------------------------------------ */
/* 纯函数                                                              */
/* ------------------------------------------------------------------ */

test('D4 主题：脏值一律收敛成"跟随系统"，不抛异常', () => {
    assert.equal(normalizeMode('dark'), 'dark');
    assert.equal(normalizeMode('light'), 'light');
    assert.equal(normalizeMode('system'), 'system');
    for (const bad of [null, undefined, '', 'DARK', 'blue', 0, {}, []]) {
        assert.equal(normalizeMode(bad), 'system', `${JSON.stringify(bad)} 应该落到 system`);
    }
});

test('D4 主题：点击顺序是 跟随系统 → 常暗 → 常亮 → 跟随系统', () => {
    assert.deepEqual(THEME_CYCLE, ['system', 'dark', 'light']);
    assert.equal(nextMode('system'), 'dark', '第一下必须能直接变暗（深夜场景）');
    assert.equal(nextMode('dark'), 'light');
    assert.equal(nextMode('light'), 'system');
    assert.equal(nextMode('乱七八糟'), 'dark', '脏值按 system 处理');
    // 轮换一圈必须回到原地，否则按钮会越点越偏
    let mode = 'system';
    for (let i = 0; i < THEME_CYCLE.length; i += 1) mode = nextMode(mode);
    assert.equal(mode, 'system');
});

test('D4 主题：只有"跟随系统"看系统偏好，显式选择压过系统', () => {
    assert.equal(resolveTheme('system', true), 'dark');
    assert.equal(resolveTheme('system', false), 'light');
    assert.equal(resolveTheme('light', true), 'light', '系统是暗的也要听用户的');
    assert.equal(resolveTheme('dark', false), 'dark');
    assert.equal(resolveTheme(undefined, true), 'dark');
});

test('D4 主题：存储读不出来/写不进去都不能影响使用', () => {
    const broken = {
        getItem() { throw new Error('localStorage 被禁用了'); },
        setItem() { throw new Error('localStorage 被禁用了'); }
    };
    assert.equal(readMode(broken), 'system');
    assert.equal(writeMode('dark', broken), undefined, '写失败静默放弃即可');
    assert.equal(readMode({ getItem: () => 'dark' }), 'dark');
    assert.equal(readMode({ getItem: () => null }), 'system');
});

test('D4 主题：applyTheme 只管两件事 —— html.dark 与 colorScheme', () => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>');
    const root = dom.window.document.documentElement;

    applyTheme('dark', root);
    assert.equal(root.classList.contains('dark'), true);
    assert.equal(root.style.colorScheme, 'dark');

    applyTheme('light', root);
    assert.equal(root.classList.contains('dark'), false);
    assert.equal(root.style.colorScheme, 'light');
});

/* ------------------------------------------------------------------ */
/* initTheme：接线                                                        */
/* ------------------------------------------------------------------ */

test('D4 主题：initTheme 换肤、记住偏好，并把选择同步给主进程', () => {
    const dom = new JSDOM('<!doctype html><html><body><button id="b"></button><i id="i"></i></body></html>');
    const { window } = dom;
    const root = window.document.documentElement;
    const button = window.document.getElementById('b');
    const icon = window.document.getElementById('i');

    const store = new Map();
    const storage = {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, v)
    };
    const pushed = [];
    const bridge = { setThemeSource: (mode) => pushed.push(mode) };

    const controller = initTheme({
        root, button, icon, storage,
        matchMedia: fakeMatchMedia(false),
        bridge
    });

    assert.equal(controller.getMode(), 'system');
    assert.equal(root.classList.contains('dark'), false);
    assert.equal(icon.className, 'fa fa-desktop');
    assert.match(button.title, /跟随系统/);
    assert.match(button.title, /常暗/, '提示里要写清下一站是哪儿');

    button.dispatchEvent(new window.Event('click'));
    assert.equal(controller.getMode(), 'dark');
    assert.equal(root.classList.contains('dark'), true);
    assert.equal(root.style.colorScheme, 'dark');
    assert.equal(icon.className, 'fa fa-moon-o');
    assert.equal(store.get(THEME_STORAGE_KEY), 'dark', '偏好要落盘，重开还是暗的');
    assert.deepEqual(pushed, ['dark'], '桌面端要顺手把标题栏也换掉');
    assert.equal(button.dataset.themeMode, 'dark');

    button.dispatchEvent(new window.Event('click'));
    assert.equal(controller.getMode(), 'light');
    assert.equal(root.classList.contains('dark'), false);
    assert.equal(icon.className, 'fa fa-sun-o');
    assert.equal(store.get(THEME_STORAGE_KEY), 'light');
    assert.deepEqual(pushed, ['dark', 'light']);

    button.dispatchEvent(new window.Event('click'));
    assert.equal(controller.getMode(), 'system');
    assert.deepEqual(pushed, ['dark', 'light', 'system'], '"跟随系统"必须原样传给主进程');
    assert.equal(store.get(THEME_STORAGE_KEY), 'system');

    controller.dispose();
});

test('D4 主题：启动时按存下来的偏好直接上色，不用等用户点', () => {
    const dom = new JSDOM('<!doctype html><html><body><button id="b"></button></body></html>');
    const { window } = dom;
    const root = window.document.documentElement;
    let current = null;
    const controller = initTheme({
        root,
        button: window.document.getElementById('b'),
        storage: { getItem: () => current, setItem: () => {} },
        matchMedia: fakeMatchMedia(false)
    });

    assert.equal(root.classList.contains('dark'), false);
    controller.setMode('dark');
    assert.equal(root.classList.contains('dark'), true);
    // 再起一次（同一个磁盘偏好），应该一上来就是暗的
    const root2 = window.document.createElement('html');
    current = 'dark';
    initTheme({ root: root2, storage: { getItem: () => current, setItem: () => {} }, matchMedia: fakeMatchMedia(false) });
    assert.equal(root2.classList.contains('dark'), true);
});

test('D4 主题：模式与文案表要对齐，别漏了某一档', () => {
    assert.deepEqual(Object.keys(THEME_LABELS).sort(), [...THEME_MODES].sort());
    assert.deepEqual([...THEME_CYCLE].sort(), [...THEME_MODES].sort());
});

/* ------------------------------------------------------------------ */
/* theme-boot.js：首次绘制前上色                                          */
/* ------------------------------------------------------------------ */

/** 在 jsdom 里真跑一遍引导脚本（window.eval 模拟 <script> 同步执行）。 */
function runBoot({ stored, prefersDark = false }) {
    const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
        url: 'http://localhost/',
        runScripts: 'outside-only'
    });
    const { window } = dom;
    window.matchMedia = (query) => ({
        matches: prefersDark && String(query).includes('dark'),
        media: query,
        addEventListener() {},
        removeEventListener() {}
    });
    if (stored !== undefined) window.localStorage.setItem(THEME_STORAGE_KEY, stored);
    window.eval(BOOT_SOURCE);
    return window;
}

test('D4 主题引导：存了常暗，首帧就是暗的', () => {
    const window = runBoot({ stored: 'dark' });
    assert.equal(window.document.documentElement.classList.contains('dark'), true);
    assert.equal(window.document.documentElement.style.colorScheme, 'dark');
});

test('D4 主题引导：存了常亮，即使系统是暗的也保持亮', () => {
    const window = runBoot({ stored: 'light', prefersDark: true });
    assert.equal(window.document.documentElement.classList.contains('dark'), false);
    assert.equal(window.document.documentElement.style.colorScheme, 'light');
});

test('D4 主题引导：跟随系统时取系统偏好，脏值也按跟随系统处理', () => {
    assert.equal(runBoot({ stored: 'system', prefersDark: true }).document.documentElement
        .classList.contains('dark'), true);
    assert.equal(runBoot({ stored: 'system', prefersDark: false }).document.documentElement
        .classList.contains('dark'), false);
    assert.equal(runBoot({ prefersDark: true }).document.documentElement
        .classList.contains('dark'), true, '没存过时要看系统');
    assert.equal(runBoot({ stored: 'DARK', prefersDark: true }).document.documentElement
        .classList.contains('dark'), true, '脏值按跟随系统处理');
});

test('D4 主题引导：和 theme.js 用的是同一个键、同一套取值', () => {
    assert.ok(BOOT_SOURCE.includes(`'${THEME_STORAGE_KEY}'`), '引导脚本读的键必须和 theme.js 一致');
    for (const mode of THEME_MODES) {
        assert.ok(BOOT_SOURCE.includes(`'${mode}'`), `引导脚本里缺少模式 ${mode}`);
    }
    // 上面几个 runBoot 用例正是用 theme.js 的常量往 localStorage 里写、再看引导脚本的结果，
    // 所以这里再加一条"顺序也要一致"就足够了
    assert.ok(BOOT_SOURCE.includes('prefers-color-scheme: dark'));
});

/* ------------------------------------------------------------------ */
/* 换肤的"接线"别断了：变量表 / Tailwind 配置 / 页面里的白底                 */
/* ------------------------------------------------------------------ */

function variablesIn(block) {
    return new Set([...block.matchAll(/(--c-[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
}

test('D4 主题：tailwind.config 引用的每个颜色变量，两套主题里都定义了', () => {
    const referenced = new Set([...TAILWIND_CONFIG.matchAll(/var\((--c-[a-z0-9-]+)\)/g)].map((m) => m[1]));
    assert.ok(referenced.size >= 13, `应该引用到十几个变量，实际 ${referenced.size}`);

    const rootBlock = INDEX_HTML.match(/:root\s*\{([\s\S]*?)\}/)?.[1] ?? '';
    const darkBlock = INDEX_HTML.match(/html\.dark\s*\{([\s\S]*?)\}/)?.[1] ?? '';
    const lightVars = variablesIn(rootBlock);
    const darkVars = variablesIn(darkBlock);

    for (const name of referenced) {
        assert.ok(lightVars.has(name), `:root 里缺 ${name}`);
        assert.ok(darkVars.has(name), `html.dark 里缺 ${name}`);
    }
    assert.deepEqual([...lightVars].sort(), [...darkVars].sort(), '两套主题的变量集合必须一模一样');
    assert.ok(TAILWIND_CONFIG.includes("darkMode: 'class'"), '暗色变体挂在 html.dark 上，必须配 darkMode: class');
});

test('D4 主题：界面里不该再出现不透明的 bg-white（那是不会跟着换肤的白块）', () => {
    const opaqueWhite = /bg-white(?![-\/\w])/;
    assert.ok(!opaqueWhite.test(INDEX_HTML), 'index.html 里还有不透明的 bg-white，应改用 bg-surface');
    for (const rel of ['../public/js/app.js', '../public/js/render.js', '../public/js/stats-view.js']) {
        assert.ok(!opaqueWhite.test(read(rel)), `${rel} 里还有不透明的 bg-white，应改用 bg-surface`);
    }
    // 反过来，彩色/深色底上的半透明白是故意的，不能被一起改掉
    assert.ok(INDEX_HTML.includes('bg-white/20'), '彩色徽标上的半透明白要保留');
});

test('D4 主题：换肤时临时关掉过渡，否则带 transition 的元素会卡在旧颜色上', async () => {
    // 这条是实测踩出来的：界面颜色由继承的 CSS 变量算出，而不少元素带 transition-colors/all。
    // Chromium 在"变量变了 + 该属性正在过渡"时不会把过渡收尾，元素会一直停在旧色
    // （.date-header 等 400ms 仍是浅色）。所以 applyTheme 必须先把过渡关掉。
    const dom = new JSDOM('<!doctype html><html><body></body></html>');
    const root = dom.window.document.documentElement;
    const seen = [];
    const observer = new dom.window.MutationObserver((records) => {
        for (const record of records) seen.push(`${record.attributeName}:${record.oldValue}`);
    });
    observer.observe(root, { attributes: true, attributeFilter: ['class'], attributeOldValue: true });

    applyTheme('dark', root);
    await new Promise((resolve) => setTimeout(resolve, 0));
    observer.disconnect();

    assert.ok(
        seen.includes(`class:${SWITCHING_CLASS}`),
        '改 dark 之前必须已经在 <html> 上挂了临时类，否则过渡会把颜色卡住'
    );
    assert.equal(root.classList.contains(SWITCHING_CLASS), false, '同一帧内必须摘掉临时类');
    assert.equal(root.classList.contains('dark'), true);

    // CSS 那边也得真有这条规则，光加类名没用
    assert.match(
        INDEX_HTML,
        /html\.theme-switching[^{]*\{[^}]*transition:\s*none\s*!important/,
        'index.html 里必须有 .theme-switching 关闭过渡的规则'
    );
});
