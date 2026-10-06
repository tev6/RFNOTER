/**
 * 极简的滚动文件日志。
 *
 * 为什么需要：桌面端没有控制台可看。主进程崩溃、写盘失败、渲染进程报错，
 * 如果只写进 stdout，用户（和以后的我）在事后是完全查不到的。
 * 目标不是做完整的日志系统，而是"出事时能知道发生过什么"。
 */
import fs from 'node:fs';
import path from 'node:path';

const MAX_BYTES = 512 * 1024;  // 单文件上限，超过就滚动
const KEEP = 2;                // 保留 main.log.1 / main.log.2

/** 把任意抛出物整理成一行能读的文本。 */
export function describeError(err) {
    if (err === null || err === undefined) return '';
    if (err instanceof Error) {
        return `${err.name}: ${err.message}${err.stack ? `\n${err.stack}` : ''}`;
    }
    if (typeof err === 'string') return err;
    try {
        return JSON.stringify(err);
    } catch {
        return String(err);
    }
}

export function createLogger(logDir) {
    const file = path.join(logDir, 'main.log');
    let usable = true;
    try {
        fs.mkdirSync(logDir, { recursive: true });
    } catch {
        // 日志目录都建不出来（权限/磁盘满）也不能影响主流程，后面静默降级成只写 stdout
        usable = false;
    }

    const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

    function rotateIfNeeded() {
        try {
            if (fs.statSync(file).size < MAX_BYTES) return;
            for (let i = KEEP - 1; i >= 1; i -= 1) {
                const from = `${file}.${i}`;
                if (fs.existsSync(from)) fs.renameSync(from, `${file}.${i + 1}`);
            }
            fs.renameSync(file, `${file}.1`);
        } catch {
            // 文件还不存在 / 被占用 / 重命名失败：都不该让记录日志这件事本身变成故障
        }
    }

    function write(level, message) {
        const line = `[${stamp()}] [${level}] ${message}\n`;
        // stdout 留着：开发态和 --selftest 能直接看到
        if (level === 'ERROR') process.stderr.write(line);
        else process.stdout.write(line);
        if (!usable) return;
        try {
            rotateIfNeeded();
            fs.appendFileSync(file, line, 'utf8');
        } catch {
            usable = false;
        }
    }

    return {
        file,
        dir: logDir,
        info: (message) => write('INFO', message),
        warn: (message) => write('WARN', message),
        error: (message, err) => write('ERROR', err === undefined ? message : `${message} :: ${describeError(err)}`)
    };
}
