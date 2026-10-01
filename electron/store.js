import fs from 'node:fs';
import path from 'node:path';

export const USER_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * 笔记文件存储。与 server.js 的接口保持同样的语义（返回 {ok, ...}），
 * 但直接落在本地磁盘上，不需要 HTTP 服务。
 */
export function createNoteStore(dataDir) {
    fs.mkdirSync(dataDir, { recursive: true });

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

    return { dataDir, fileFor, read, write, listUserIds, migrateFrom };
}
