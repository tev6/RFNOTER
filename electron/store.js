import fs from 'node:fs';
import path from 'node:path';

export const USER_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** 备份目录名（放在数据目录里，这样"拷走 data 目录"就一并带走了备份）。 */
export const BACKUP_DIR_NAME = 'backups';

/** 同一份数据最多每小时备份一次：再密没有意义，只会把磁盘塞满。 */
export const BACKUP_INTERVAL_MS = 60 * 60 * 1000;

/** 轮转策略：保留最近这些份，外加最近这些天每天一份。 */
export const KEEP_RECENT = 24;
export const KEEP_DAILY_DAYS = 30;

function stampFor(date) {
    const pad = (value) => String(value).padStart(2, '0');
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
        + `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function dayKey(timestamp) {
    const date = new Date(timestamp);
    const pad = (value) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * 笔记文件存储。与 server.js 的接口保持同样的语义（返回 {ok, ...}），
 * 但直接落在本地磁盘上，不需要 HTTP 服务。
 */
export function createNoteStore(dataDir) {
    fs.mkdirSync(dataDir, { recursive: true });
    const backupsDir = path.join(dataDir, BACKUP_DIR_NAME);

    /** userId 非法时返回 null，避免 `..` 之类的路径穿越。 */
    function fileFor(userId) {
        if (typeof userId !== 'string' || !USER_ID_RE.test(userId)) return null;
        return path.join(dataDir, `notes_${userId}.json`);
    }

    function read(userId) {
        const filePath = fileFor(userId);
        if (!filePath) return { ok: false, error: 'userId 非法（只允许字母、数字、下划线和连字符）' };
        if (!fs.existsSync(filePath)) return { ok: true, notes: [], exists: false };
        try {
            const raw = fs.readFileSync(filePath, 'utf8');
            if (raw.trim() === '') return { ok: true, notes: [], exists: true };
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) {
                return { ok: false, error: '笔记文件格式错误：根节点不是数组' };
            }
            return { ok: true, notes: parsed, exists: true };
        } catch (err) {
            return { ok: false, error: `读取失败：${err.message}` };
        }
    }

    /** 先写临时文件再 rename，避免写到一半崩溃导致文件损坏。 */
    function write(userId, notes) {
        const filePath = fileFor(userId);
        if (!filePath) return { ok: false, error: 'userId 非法（只允许字母、数字、下划线和连字符）' };
        if (!Array.isArray(notes)) return { ok: false, error: '笔记数据必须是数组' };
        const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
        try {
            fs.writeFileSync(tmpPath, JSON.stringify(notes, null, 2), 'utf8');
            fs.renameSync(tmpPath, filePath);
            return { ok: true, count: notes.length, filePath };
        } catch (err) {
            try { fs.rmSync(tmpPath, { force: true }); } catch { /* ignore */ }
            return { ok: false, error: `写入失败：${err.message}` };
        }
    }

    /** 列出目录里已有的 userId，按文件修改时间倒序。 */
    function listUserIds() {
        let entries = [];
        try {
            entries = fs.readdirSync(dataDir);
        } catch {
            return [];
        }
        return entries
            .map((name) => {
                const matched = /^notes_(.+)\.json$/.exec(name);
                if (!matched || !USER_ID_RE.test(matched[1])) return null;
                try {
                    const stat = fs.statSync(path.join(dataDir, name));
                    return { userId: matched[1], mtimeMs: stat.mtimeMs, size: stat.size };
                } catch {
                    return null;
                }
            })
            .filter(Boolean)
            .sort((a, b) => b.mtimeMs - a.mtimeMs);
    }

    /* ---------------------------------------------------------------- */
    /* 备份与轮转                                                        */
    /* ---------------------------------------------------------------- */

    /** 列出某个用户的备份，按时间倒序。 */
    function listBackups(userId) {
        if (typeof userId !== 'string' || !USER_ID_RE.test(userId)) return [];
        let names = [];
        try {
            names = fs.readdirSync(backupsDir);
        } catch {
            return [];
        }
        // 用字面前缀匹配而不是正则：userId 里可能有正则元字符，虽然白名单已经挡掉了
        const prefix = `notes_${userId}-`;
        return names
            .filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
            .map((name) => {
                const full = path.join(backupsDir, name);
                try {
                    const stat = fs.statSync(full);
                    return { name, path: full, mtimeMs: stat.mtimeMs, size: stat.size };
                } catch {
                    return null;
                }
            })
            .filter(Boolean)
            .sort((a, b) => b.mtimeMs - a.mtimeMs);
    }

    /**
     * 轮转：保留「最近 KEEP_RECENT 份」+「最近 KEEP_DAILY_DAYS 天每天一份」。
     *
     * 只按份数保留的话，隔几天再看就只剩最后几十次保存的粒度；
     * 只按天保留的话，今天之内删错了就找不回来。两层都要。
     */
    function pruneBackups(userId, keepRecent = KEEP_RECENT, keepDays = KEEP_DAILY_DAYS) {
        const files = listBackups(userId);
        const keep = new Set();
        files.slice(0, keepRecent).forEach((file) => keep.add(file.name));

        const seenDays = new Set();
        for (const file of files) {
            const day = dayKey(file.mtimeMs);
            if (seenDays.has(day)) continue;
            if (seenDays.size >= keepDays) break;
            seenDays.add(day);
            keep.add(file.name);
        }

        let pruned = 0;
        for (const file of files) {
            if (keep.has(file.name)) continue;
            try {
                fs.rmSync(file.path, { force: true });
                pruned += 1;
            } catch { /* 删不掉就留着，不影响主流程 */ }
        }
        return pruned;
    }

    /**
     * 备份当前的笔记文件。
     *
     * @param {string} userId
     * @param {{force?: boolean, now?: number}} options force=绕过限流（导入/大量删除前用）
     * @returns {{ok:boolean, skipped?:string, file?:string, count?:number, valid?:boolean, pruned?:number, error?:string}}
     */
    function backup(userId, { force = false, now = Date.now() } = {}) {
        const filePath = fileFor(userId);
        if (!filePath) return { ok: false, error: 'userId 非法（只允许字母、数字、下划线和连字符）' };
        if (!fs.existsSync(filePath)) return { ok: true, skipped: 'no-file' };

        const existing = listBackups(userId);
        if (!force && existing.length > 0 && now - existing[0].mtimeMs < BACKUP_INTERVAL_MS) {
            return { ok: true, skipped: 'throttled', kept: existing.length };
        }

        // 文件名精确到秒。同一秒里连续备份两次（比如"删除前强制备份"紧跟着
        // "写入后的小时备份"）会撞名，那时后一份会静默盖掉前一份——
        // 而前一份恰恰是最该留下的。所以撞名就加序号。
        const stamp = stampFor(new Date(now));
        let name = `notes_${userId}-${stamp}.json`;
        let target = path.join(backupsDir, name);
        for (let attempt = 1; fs.existsSync(target); attempt += 1) {
            name = `notes_${userId}-${stamp}-${attempt}.json`;
            target = path.join(backupsDir, name);
        }
        try {
            fs.mkdirSync(backupsDir, { recursive: true });
            const data = fs.readFileSync(filePath);
            if (data.length === 0) return { ok: true, skipped: 'empty' };
            const tmp = `${target}.tmp`;
            fs.writeFileSync(tmp, data);
            fs.renameSync(tmp, target);
        } catch (err) {
            return { ok: false, error: `备份失败：${err.message}` };
        }

        // 复制完再校验一次：内容坏了也要留下这份副本当证据，但要让调用方知道它不可用
        let valid = false;
        let count = 0;
        try {
            const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
            if (Array.isArray(parsed)) {
                valid = true;
                count = parsed.length;
            }
        } catch { /* valid 保持 false */ }

        const pruned = pruneBackups(userId);
        return { ok: true, file: name, path: target, count, valid, pruned };
    }

    /** 把旧版数据目录里的笔记搬过来（只在目标不存在时复制）。 */
    function migrateFrom(legacyDir) {
        if (!legacyDir || path.resolve(legacyDir) === path.resolve(dataDir)) return [];
        const copied = [];
        let entries = [];
        try {
            entries = fs.readdirSync(legacyDir);
        } catch {
            return copied;
        }
        for (const name of entries) {
            const matched = /^(notes_.+\.json)$/.exec(name);
            if (!matched) continue;
            const target = path.join(dataDir, matched[1]);
            if (fs.existsSync(target)) continue;
            try {
                fs.copyFileSync(path.join(legacyDir, matched[1]), target);
                copied.push(matched[1]);
            } catch { /* 复制失败就跳过，不影响启动 */ }
        }
        return copied;
    }

    return {
        dataDir, backupsDir, fileFor, read, write, listUserIds, migrateFrom,
        backup, listBackups, pruneBackups
    };
}

