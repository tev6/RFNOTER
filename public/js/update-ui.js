/**
 * E4：更新提示界面（v2.13.0）。
 *
 * 分工：主进程负责"上网查、比较版本、记住用户认掉了哪个版本"
 * （electron/updater.js），这里只负责**把结果画出来**。
 * 所以本模块是纯 UI，不含任何版本比较逻辑——两边各有一套比较规则迟早会打架。
 *
 * 交互设计（用户原话倾向："静默检查 + 顶栏出个小圆点，不弹窗打扰"）：
 *
 *   - 平时顶栏什么都不显示，绝不主动弹窗打断记录；
 *   - 查到新版本时，统计按钮旁边亮起一个**小圆点**（带 title 提示）；
 *   - 点小圆点才打开弹窗，里面有版本号、更新说明、「去下载」「知道了」；
 *   - 「去下载」只是用系统浏览器打开 release 页——无代码签名做不了应用内静默安装。
 *
 * 网页端没有 window.rfnoter，整个模块直接不接线（initUpdateUI 里判掉），
 * 这样同一份 public/ 在浏览器里也不会报错。
 */

/** 主进程推来的状态里，是否真的该显示"有新版本"。 */
export function shouldShowBadge(status) {
    return Boolean(status?.ok && status.hasUpdate && !status.muted);
}

/**
 * 把 release 说明裁成适合弹窗显示的纯文本。
 *
 * 说明是 Markdown，这里**刻意不渲染**：它来自网络，渲染等于把外部内容
 * 塞进 DOM。桌面端虽然 contextIsolation 开着，但没必要开这个口子——
 * 用户要的是"值不值得更新"，纯文本足够。
 */
export function formatReleaseNotes(notes, { maxChars = 600 } = {}) {
    const text = String(notes ?? '')
        .replace(/\r\n/g, '\n')
        .replace(/^#{1,6}\s*/gm, '')          // 标题符号
        .replace(/\*\*(.+?)\*\*/g, '$1')      // 粗体
        .replace(/^\s*[-*+]\s+/gm, '· ')      // 列表项
        .replace(/`([^`]*)`/g, '$1')          // 行内代码
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    if (text.length <= maxChars) return text;
    return `${text.slice(0, maxChars).trimEnd()}…`;
}

/** 弹窗上那行"当前 x.y.z → 最新 a.b.c"。 */
export function describeVersions(status) {
    if (!status?.ok) return '';
    return `当前 ${status.currentVersion} → 最新 ${status.latestVersion}`;
}

/**
 * 一次性接线。
 *
 * 依赖全部由参数注入（与 initTheme / initRender 同样的理由：静态导入的模块
 * 在多个测试用例间共享，模块级抓 DOM 会让第二个用例操作到第一个用例的 document）。
 *
 * @returns {{render: Function, open: Function, close: Function, badgeVisible: Function, dispose: Function}}
 */
export function initUpdateUI({
    bridge = (typeof window !== 'undefined' ? window.rfnoter : null),
    badge = null,
    modal = null,
    versionLabel = null,
    notesLabel = null,
    downloadBtn = null,
    dismissBtn = null,
    closeBtn = null,
    titleLabel = null
} = {}) {
    let status = null;
    /**
     * 用户在本窗口里点过「知道了」的版本。
     *
     * 为什么要额外记一份：状态有两个来源（主进程推送 + 启动时主动拉一次），
     * 而"拉"是异步的，可能在用户点完「知道了」之后才返回，
     * 于是把一个**没有 muted 标记的旧状态**盖回来，圆点又亮了。
     * 实测踩过：自检里"点知道了 → 圆点灭"这条断言就是这么红的。
     * 本地记下认掉的版本号，就能在任何来源的状态上重新压一遍。
     */
    let dismissedLocally = null;

    const isOpen = () => Boolean(modal) && !modal.classList.contains('hidden');

    /** 统一入口：任何来源的状态都先按"本地已认掉的版本"压一遍再渲染。 */
    const render = (next) => {
        if (next !== undefined) status = next;
        const effective = status?.ok && status.hasUpdate && !status.muted
            && dismissedLocally === status.latestVersion
            ? { ...status, muted: true }
            : status;
        const show = shouldShowBadge(effective);

        if (badge) {
            badge.classList.toggle('hidden', !show);
            // Tailwind 的 hidden 是 display:none，光摘掉它按钮会退回 inline（块级流里的 inline），
            // 里面的图标与文字就不居中。显式给一个 flex 才能按设计排。
            badge.classList.toggle('inline-flex', show);
            if (show) {
                badge.title = `有新版本 ${effective.latestVersion}（当前 ${effective.currentVersion}）`;
                badge.setAttribute('aria-label', badge.title);
            }
        }
        if (titleLabel && show) {
            titleLabel.textContent = `发现新版本 ${effective.latestVersion}`;
        }
        if (versionLabel && effective?.ok) {
            versionLabel.textContent = describeVersions(effective);
        }
        if (notesLabel) {
            const notes = formatReleaseNotes(effective?.notes);
            notesLabel.textContent = notes || '（这个版本没有写更新说明）';
        }
        if (downloadBtn) {
            // 有直链就直接给安装包，省掉用户在 release 页里找附件那一步
            const size = effective?.downloadSizeText ? `（${effective.downloadSizeText}）` : '';
            downloadBtn.textContent = `去下载${size}`;
            downloadBtn.disabled = !effective?.ok;
        }
        return effective;
    };

    const open = () => {
        if (!modal) return;
        render();
        modal.classList.remove('hidden');
    };

    const close = () => {
        if (modal) modal.classList.add('hidden');
    };

    const onBadgeClick = () => open();
    const onClose = () => close();

    /**
     * 「知道了」：告诉主进程别再提示这个版本，然后立刻把圆点灭掉。
     *
     * 注意**只压住这一个版本号**：主进程记的是 dismissedVersion，
     * 下次真出了更新的版本仍会提示（见 main.js 的 applyDismissed）。
     */
    const onDismiss = async () => {
        const version = status?.latestVersion;
        close();
        if (version) {
            dismissedLocally = version;
            try {
                await bridge?.dismissUpdate?.(version);
            } catch { /* 记不住偏好不该影响使用 */ }
        }
        render();
    };

    const onDownload = async () => {
        if (!status?.ok) return;
        try {
            // 优先给安装包直链；没有附件时退回 release 页（后者永远存在）
            await bridge?.openDownload?.(status.downloadUrl || status.pageUrl);
        } catch { /* 打不开浏览器就当没点 */ }
        close();
    };

    badge?.addEventListener('click', onBadgeClick);
    closeBtn?.addEventListener('click', onClose);
    dismissBtn?.addEventListener('click', onDismiss);
    downloadBtn?.addEventListener('click', onDownload);

    // 主进程查到新版本会推过来（启动后台检查完成时用户可能已经开着窗口了）
    try {
        bridge?.onUpdateStatus?.((pushed) => {
            render(pushed);
            // 如果弹窗正开着，让内容跟着刷新，避免显示上一个版本的信息
            if (isOpen()) render(pushed);
        });
    } catch { /* 桥没实现也不影响使用 */ }

    // 主动拉一次当前状态：启动检查可能在本模块接线**之前**就完成了，
    // 只靠推送会漏掉那一刻的结果（这是实测会踩的时序问题）。
    (async () => {
        try {
            const current = await bridge?.updateStatus?.();
            if (current) render(current);
        } catch { /* 拿不到就不显示，下次推来再说 */ }
    })();

    return {
        render,
        open,
        close,
        badgeVisible: () => Boolean(badge) && !badge.classList.contains('hidden'),
        dispose: () => {
            badge?.removeEventListener('click', onBadgeClick);
            closeBtn?.removeEventListener('click', onClose);
            dismissBtn?.removeEventListener('click', onDismiss);
            downloadBtn?.removeEventListener('click', onDownload);
        }
    };
}
