import express from 'express';
import path from 'node:path';
import fs from 'node:fs';

const ROOT = import.meta.dirname;
const DEFAULT_DATA_DIR = path.join(ROOT, 'data');
const USER_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * 创建一个 RFNOTER express 应用。
 * @param {{ dataDir?: string, maxBody?: string }} [options]
 */
export function createApp(options = {}) {
    const dataDir = options.dataDir || process.env.RFNOTER_DATA_DIR || DEFAULT_DATA_DIR;
    const maxBody = options.maxBody || process.env.RFNOTER_MAX_BODY || '5mb';

    fs.mkdirSync(dataDir, { recursive: true });

    const app = express();
    app.disable('x-powered-by');
    app.use(express.json({ limit: maxBody }));
    app.use(express.static(path.join(ROOT, 'public')));

    /**
     * 把 userId 解析成数据文件路径。
     * 只允许字母/数字/下划线/连字符，彻底堵死 `..` 与路径分隔符造成的目录穿越。
     */
    function resolveNotesFile(userId) {
        if (typeof userId !== 'string' || !USER_ID_RE.test(userId)) return null;
        return path.join(dataDir, `notes_${userId}.json`);
    }

    function readNotesFile(filePath) {
        if (!fs.existsSync(filePath)) return [];
        const raw = fs.readFileSync(filePath, 'utf8');
        if (raw.trim() === '') return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
            throw new Error('笔记文件格式错误：根节点不是数组');
        }
        return parsed;
    }

    /** 先写临时文件再 rename，避免写一半被中断导致数据文件损坏。 */
    function writeNotesFileAtomic(filePath, notes) {
        const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
        try {
            fs.writeFileSync(tmpPath, JSON.stringify(notes, null, 2), 'utf8');
            fs.renameSync(tmpPath, filePath);
        } catch (err) {
            try { fs.rmSync(tmpPath, { force: true }); } catch { /* ignore */ }
            throw err;
        }
    }

    app.get('/api/notes/:userId', (req, res) => {
        const filePath = resolveNotesFile(req.params.userId);
        if (!filePath) {
            return res.status(400).json({ error: 'userId 非法（只允许字母、数字、下划线和连字符）' });
        }
        try {
            res.json(readNotesFile(filePath));
        } catch (err) {
            console.error('[RFNOTER] 读取笔记失败:', err.message);
            res.status(500).json({ error: `读取笔记失败：${err.message}` });
        }
    });

    app.post('/api/notes/:userId', (req, res) => {
        const filePath = resolveNotesFile(req.params.userId);
        if (!filePath) {
            return res.status(400).json({ error: 'userId 非法（只允许字母、数字、下划线和连字符）' });
        }
        if (!Array.isArray(req.body)) {
            return res.status(400).json({ error: '请求体必须是笔记数组' });
        }
        try {
            writeNotesFileAtomic(filePath, req.body);
            res.json({ success: true, count: req.body.length });
        } catch (err) {
            console.error('[RFNOTER] 写入笔记失败:', err.message);
            res.status(500).json({ error: `写入笔记失败：${err.message}` });
        }
    });

    app.use('/api', (req, res) => {
        res.status(404).json({ error: `接口不存在: ${req.method} ${req.originalUrl}` });
    });

    // eslint-disable-next-line no-unused-vars -- express 靠 4 个参数识别错误中间件
    app.use((err, req, res, next) => {
        const status = err.status || err.statusCode || 500;
        const message = status === 413
            ? '请求体过大，笔记数量或单条内容超出限制'
            : err.message || '服务器内部错误';
        console.error('[RFNOTER] 请求处理失败:', message);
        res.status(status).json({ error: message });
    });

    app.locals.dataDir = dataDir;
    return app;
}

/**
 * 启动服务；端口被占用时依次尝试后续端口，且回退后的服务同样带错误处理。
 */
export function startServer({ port = readPort(process.env.PORT), host = process.env.HOST || '0.0.0.0', attempts = 5 } = {}) {
    return new Promise((resolve, reject) => {
        const app = createApp();
        const tryListen = (currentPort, remaining) => {
            const server = app.listen(currentPort, host);
            server.once('listening', () => {
                if (host === '0.0.0.0' || host === '::') {
                    console.warn('[RFNOTER] 正在监听所有网卡，同局域网设备可直接访问（笔记接口未做鉴权，请勿在不可信网络中运行）');
                }
                console.log(`RFNOTER server running at http://localhost:${currentPort}`);
                resolve(server);
            });
            server.once('error', (err) => {
                if (err.code === 'EADDRINUSE' && remaining > 0) {
                    console.warn(`[RFNOTER] 端口 ${currentPort} 被占用，尝试 ${currentPort + 1} ...`);
                    tryListen(currentPort + 1, remaining - 1);
                } else {
                    reject(err);
                }
            });
        };
        tryListen(port, attempts);
    });
}

/** 环境变量是字符串，直接 +1 会变成 "30001"，这里统一转成数字。 */
function readPort(raw) {
    const parsed = Number.parseInt(raw ?? '', 10);
    return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : 3000;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);
if (isMain) {
    startServer().catch((err) => {
        console.error('[RFNOTER] 启动失败:', err.message);
        process.exitCode = 1;
    });
}
