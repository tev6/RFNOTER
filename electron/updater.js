/**
 * E4：更新检查（v2.13.0）。
 *
 * 目标不是"自动装上"，而是**让用户知道有新版**——这是无代码签名的情况下
 * Windows 上唯一能做到的一步：
 *
 *   electron-updater 的一键更新在 Windows 上走的是 NSIS 静默安装，安装前会校验
 *   安装包的签名。没有代码签名证书就必然失败，且失败发生在"已经下载了 100MB"
 *   之后，对用户是纯损失。所以本模块**只做检查 + 引导下载**，绝不自动下载安装。
 *
 * 检查走 GitHub Releases API（仓库 public，不需要 token）。
 *
 * 为什么不用 electron-updater 那套 latest.yml：它同样要求 release 里带
 * latest.yml 并做签名/哈希校验，在无签名路线下拿不到额外收益，却要多一个
 * 运行时依赖（这个项目主进程刻意保持零运行时 npm 依赖）。
 *
 * 已知限制：未认证的 GitHub API 限流 60 次/小时（按 IP）。本模块靠节流把调用
 * 压到"每天最多几次"，并且**任何失败都静默降级**——检查更新绝不打扰记录。
 */
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_REPO = 'tev6/RFNOTER';
export const RELEASES_PAGE = `https://github.com/${DEFAULT_REPO}/releases`;

/** 同一次会话内两次自动检查之间至少要隔这么久。 */
export const CHECK_THROTTLE_MS = 6 * 60 * 60 * 1000;
/** 手动点「检查更新」时的最短间隔，防止连点把限流额度打光。 */
export const MANUAL_THROTTLE_MS = 30 * 1000;
/** 网络请求超时。检查更新不值得让用户等，超时就当没检查到。 */
export const REQUEST_TIMEOUT_MS = 8000;

/**
 * 解析版本号成可比较的数字数组，并保留预发布标记。
 *
 * 只认 `1.2.3` / `v1.2.3` / `1.2.3-beta.1` 这几种形态。解析不出来就返回 null，
 * 由调用方当成"无法判断"处理——**绝不把解析失败当成"有新版本"**，
 * 否则一个畸形的 tag 就能天天弹提示。
 */
export function parseVersion(raw) {
    const text = String(raw ?? '').trim().replace(/^v/i, '');
    if (!text) return null;
    const matched = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(text);
    if (!matched) return null;
    return {
        numbers: [Number(matched[1]), Number(matched[2]), Number(matched[3])],
        prerelease: matched[4] ?? null
    };
}

/**
 * 比较两个版本号：a > b 返回正数，a < b 返回负数，相等返回 0。
 * 任一侧无法解析返回 null（调用方据此放弃判断）。
 *
 * 预发布版本的规则按 semver：`2.14.0-beta.1 < 2.14.0`。
 */
export function compareVersions(a, b) {
    const left = parseVersion(a);
    const right = parseVersion(b);
    if (!left || !right) return null;
    for (let i = 0; i < 3; i += 1) {
        if (left.numbers[i] !== right.numbers[i]) return left.numbers[i] - right.numbers[i];
    }
    if (left.prerelease === right.prerelease) return 0;
    if (left.prerelease === null) return 1;   // 正式版 > 预发布
    if (right.prerelease === null) return -1;
    return left.prerelease < right.prerelease ? -1 : 1;
}

/**
 * 从 GitHub Releases API 的响应体里提取"最新正式版"。
 *
 * 刻意跳过 draft 与 prerelease：用户日常用的应该是稳定版，
 * 预发布只在自己手动去 release 页拿时装。
 *
 * 返回 null 表示"这份响应里没有可用的版本信息"。
 */
export function pickLatestRelease(payload, { includePrerelease = false } = {}) {
    if (!payload || typeof payload !== 'object') return null;
    const candidates = Array.isArray(payload) ? payload : [payload];
    let best = null;
    for (const item of candidates) {
        if (!item || typeof item !== 'object') continue;
        if (item.draft === true) continue;
        if (item.prerelease === true && !includePrerelease) continue;
        const tag = item.tag_name;
        if (!parseVersion(tag)) continue;
        if (!best || compareVersions(tag, best.tag_name) > 0) best = item;
    }
    if (!best) return null;
    const asset = pickInstallerAsset(best.assets);
    return {
        version: String(best.tag_name).replace(/^v/i, ''),
        tag: best.tag_name,
        name: typeof best.name === 'string' && best.name.trim() ? best.name.trim() : best.tag_name,
        notes: typeof best.body === 'string' ? best.body : '',
        publishedAt: best.published_at ?? null,
        pageUrl: typeof best.html_url === 'string' && best.html_url
            ? best.html_url
            : `${RELEASES_PAGE}/tag/${best.tag_name}`,
        downloadUrl: asset?.url ?? null,
        downloadName: asset?.name ?? null,
        downloadSize: typeof asset?.size === 'number' ? asset.size : null,
        downloadSizeText: formatBytes(asset?.size)
    };
}

/** 在 release 的附件里挑出 Windows 安装包（用于"去下载"直接给文件）。 */
export function pickInstallerAsset(assets) {
    if (!Array.isArray(assets)) return null;
    const exe = assets.filter((a) => a && typeof a?.name === 'string' && /\.exe$/i.test(a.name));
    if (exe.length === 0) return null;
    // 优先 Setup 包，其次是体积最大的那个（避免误选到 blockmap 之类）
    const setup = exe.find((a) => /setup/i.test(a.name));
    const chosen = setup ?? exe.slice().sort((a, b) => (b.size ?? 0) - (a.size ?? 0))[0];
    return { name: chosen.name, url: chosen.browser_download_url ?? null, size: chosen.size ?? null };
}

/** 人类可读的体积，弹窗里显示下载大小用。 */
export function formatBytes(bytes) {
    const value = Number(bytes);
    if (!Number.isFinite(value) || value <= 0) return '';
    const mb = value / 1024 / 1024;
    if (mb >= 1) return `${mb.toFixed(1)} MB`;
    return `${Math.max(1, Math.round(value / 1024))} KB`;
}

/**
 * 检查状态文件：记住"上次检查时间"和"已经被用户看过的版本"。
 *
 * 为什么要落盘：① 节流要跨进程重启生效，否则每次启动都查一次，白白消耗限流额度；
 * ② 用户点过"知道了"的版本不该每次启动又冒出来。
 *
 * 读写都容错——状态文件坏了只该导致"这次重新检查一遍"，绝不能让应用起不来。
 */
export function createUpdateState(file) {
    function read() {
        try {
            const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (!parsed || typeof parsed !== 'object') return {};
            return parsed;
        } catch {
            return {};
        }
    }

    function write(patch) {
        try {
            const merged = { ...read(), ...patch };
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, JSON.stringify(merged, null, 2), 'utf8');
            return merged;
        } catch {
            return null;
        }
    }

    return {
        file,
        read,
        write,
        lastCheckAt: () => {
            const value = Number(read().lastCheckAt);
            return Number.isFinite(value) ? value : 0;
        },
        dismissedVersion: () => {
            const value = read().dismissedVersion;
            return typeof value === 'string' ? value : null;
        }
    };
}

/**
 * 创建更新检查器。
 *
 * @param {object} options
 * @param {string} options.currentVersion 当前版本（app.getVersion()）
 * @param {string} [options.repo] GitHub 仓库，形如 owner/name
 * @param {ReturnType<typeof createUpdateState>} [options.state] 状态文件读写
 * @param {typeof fetch} [options.fetchImpl] 注入用，测试里替换成假 fetch
 * @param {object} [options.logger] 有 info/warn/error 的对象
 * @param {() => number} [options.now] 注入用时钟
 */
export function createUpdateChecker({
    currentVersion,
    repo = DEFAULT_REPO,
    state = null,
    fetchImpl = globalThis.fetch,
    logger = null,
    now = () => Date.now()
} = {}) {
    const log = (level, message) => logger?.[level]?.(message);

    /**
     * 真正发起一次检查。**不节流**——节流由上层 check() 负责，
     * 这样自检和测试可以直接验证"查得对不对"。
     *
     * 任何异常都被吞掉并转成 { ok:false, reason }：检查更新失败不是错误，
     * 只是"不知道有没有新版"，用户不该看到任何提示。
     */
    async function fetchLatest({ includePrerelease = false } = {}) {
        const url = `https://api.github.com/repos/${repo}/releases?per_page=10`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        try {
            const response = await fetchImpl(url, {
                headers: {
                    // GitHub API 强制要求 User-Agent，缺失会直接 403
                    'User-Agent': `RFNOTER/${currentVersion}`,
                    'Accept': 'application/vnd.github+json'
                },
                signal: controller.signal
            });
            if (!response.ok) {
                // 403/429 多半是限流，属于"过会儿再试"，不是故障
                log('warn', `检查更新失败：HTTP ${response.status}`);
                return { ok: false, reason: `HTTP ${response.status}` };
            }
            const payload = await response.json();
            const latest = pickLatestRelease(payload, { includePrerelease });
            if (!latest) return { ok: false, reason: '响应里没有可识别的版本' };
            return { ok: true, latest };
        } catch (err) {
            // 断网、DNS 失败、超时都走这里。桌面端用户可能常年离线，这很正常。
            const reason = err?.name === 'AbortError' ? '请求超时' : (err?.message ?? String(err));
            log('warn', `检查更新失败：${reason}`);
            return { ok: false, reason };
        } finally {
            clearTimeout(timer);
        }
    }

    /** 把"最新版"与当前版本比一下，整理成界面直接能用的结构。 */
    function evaluate(latest) {
        const comparison = compareVersions(latest.version, currentVersion);
        if (comparison === null) {
            return { hasUpdate: false, reason: '版本号无法比较' };
        }
        return {
            hasUpdate: comparison > 0,
            currentVersion,
            latestVersion: latest.version,
            tag: latest.tag,
            name: latest.name,
            notes: latest.notes,
            publishedAt: latest.publishedAt,
            pageUrl: latest.pageUrl,
            downloadUrl: latest.downloadUrl,
            downloadName: latest.downloadName,
            downloadSize: latest.downloadSize,
            downloadSizeText: formatBytes(latest.downloadSize)
        };
    }

    return {
        currentVersion,

        /**
         * 节流版检查：自动检查受 CHECK_THROTTLE_MS 约束，手动检查受
         * MANUAL_THROTTLE_MS 约束。被节流时不发请求，直接返回
         * { ok:true, skipped:true }——对调用方来说"跳过"不是失败。
         */
        async check({ force = false } = {}) {
            const last = state ? state.lastCheckAt() : 0;
            const gap = now() - last;
            const limit = force ? MANUAL_THROTTLE_MS : CHECK_THROTTLE_MS;
            if (last > 0 && gap < limit) {
                return { ok: true, skipped: true, throttledForMs: limit - gap };
            }
            const result = await fetchLatest();
            // 只有"真的问过服务器"才记时间。失败也记：否则断网时会每次启动都重试，
            // 白白拖慢启动。
            state?.write({ lastCheckAt: now() });
            if (!result.ok) return { ok: false, reason: result.reason, checked: true };
            const evaluated = evaluate(result.latest);
            log('info', `检查更新：当前 ${currentVersion} / 最新 ${evaluated.latestVersion}`
                + ` → ${evaluated.hasUpdate ? '有新版本' : '已是最新'}`);
            return { ok: true, skipped: false, checked: true, ...evaluated };
        },

        /** 供自检/测试直接调用，绕过节流。 */
        fetchLatest,
        evaluate,
        pickLatestRelease
    };
}
