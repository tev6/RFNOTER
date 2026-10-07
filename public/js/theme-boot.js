/**
 * 主题引导脚本：在页面渲染之前就把暗色类挂到 <html> 上，避免"先白一下再变黑"。
 *
 * 为什么它是**普通脚本**而不是 ES 模块：
 *   <script type="module"> 默认是 defer 的，要等 HTML 解析完才执行，
 *   那时浏览器可能已经画出第一帧了 —— 深夜打开就是一道白光。
 *   普通脚本在 <head> 里同步执行，早于任何绘制。
 *
 * 为什么不能内联写在 index.html 里：CSP 的 script-src 只给了 'self'，
 * 内联脚本会被直接拒绝，而且不报错，只是悄悄不生效。
 *
 * 它读的是 localStorage 里的 'theme'（'system' | 'light' | 'dark'），
 * 与 js/theme.js 共用同一套键名和取值 —— 改动时两边必须一起改，
 * test/theme.test.js 里有一条用例专门钉住这一点。
 */
(function applyThemeBeforePaint() {
    var MODES = ['system', 'light', 'dark'];
    var mode = 'system';
    try {
        var saved = window.localStorage.getItem('theme');
        if (MODES.indexOf(saved) !== -1) mode = saved;
    } catch (e) {
        // localStorage 被禁用（隐私模式等）：退回跟随系统，不影响使用
    }

    var dark = mode === 'dark';
    if (mode === 'system') {
        dark = false;
        try {
            dark = Boolean(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
        } catch (e) {
            dark = false;
        }
    }

    var root = document.documentElement;
    root.classList.toggle('dark', dark);
    root.style.colorScheme = dark ? 'dark' : 'light';
})();
