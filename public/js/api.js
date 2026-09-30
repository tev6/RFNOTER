import { generateUUID } from './utils.js';

const API_BASE = '/api';
const DEEPSEEK_URL = 'https://api.deepseek.com/v1/chat/completions';
export const REQUEST_TIMEOUT_MS = 60000;
const USER_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export const MAX_TOKENS = 4000;

/**
 * API 密钥只放在内存里（v1.2.0 起不再写入 localStorage），刷新页面即失效。
 * 这是有意的安全取舍：XSS 或本地文件泄露都拿不到密钥。
 */
let memoryApiKey = null;

export function setApiKey(key) {
    memoryApiKey = typeof key === 'string' && key.trim() !== '' ? key.trim() : null;
}

export function getApiKey() {
    return memoryApiKey;
}

/** 结构化 API 错误：retryable 决定上层要不要重试，status 用来给出人话提示。 */
export class ApiError extends Error {
    constructor(message, { status = 0, retryable = false, cause = null } = {}) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        this.retryable = retryable;
        this.cause = cause;
    }
}

let userId = localStorage.getItem('userId');
if (!userId || !USER_ID_RE.test(userId)) {
    userId = generateUUID() + '-' + Date.now();
    localStorage.setItem('userId', userId);
}

export function getUserId() {
    return userId;
}

const notesKey = () => `notes_${userId}`;
const pendingKey = () => `notes_${userId}_pending`;

function readLocalNotes() {
    try {
        const raw = localStorage.getItem(notesKey());
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
        console.warn('[RFNOTER] 本地笔记解析失败', e);
        return [];
    }
}

function writeLocalNotes(notes) {
    try {
        localStorage.setItem(notesKey(), JSON.stringify(notes));
    } catch (e) {
        console.warn('[RFNOTER] 本地笔记写入失败（可能超出配额）', e);
    }
}

function setPending(value) {
    try {
        if (value) localStorage.setItem(pendingKey(), '1');
        else localStorage.removeItem(pendingKey());
    } catch { /* ignore */ }
}

/** 只写本地副本，不发网络请求（用于展开/收起这类纯界面状态）。 */
export function saveNotesLocally(notes) {
    writeLocalNotes(notes);
}

export function hasPendingChanges() {
    return localStorage.getItem(pendingKey()) === '1';
}

/**
 * 覆盖本地副本前先留一份备份，避免「服务器为空 + 用户选择不导入」这类操作把旧数据抹掉。
 */
export function backupLocalNotes() {
    const notes = readLocalNotes();
    if (notes.length === 0) return null;
    const key = `${notesKey()}_backup_${Date.now()}`;
    try {
        localStorage.setItem(key, JSON.stringify(notes));
        // 注意：localStorage 的键不能用 Object.keys() 枚举，必须用 length/key(i)
        const backups = [];
        for (let i = 0; i < localStorage.length; i += 1) {
            const candidate = localStorage.key(i);
            if (candidate && candidate.startsWith(`${notesKey()}_backup_`)) backups.push(candidate);
        }
        backups.sort();
        backups.slice(0, Math.max(0, backups.length - 3)).forEach((k) => localStorage.removeItem(k));
    } catch (e) {
        console.warn('[RFNOTER] 本地备份失败', e);
        return null;
    }
    return key;
}

/**
 * 加载笔记。返回结构里带上「数据从哪来」，让界面能如实告诉用户状态。
 *
 * 同步策略（服务端为唯一真源，本地只做离线副本）：
 * 1. 请求失败        -> 用本地副本，标记 offline
 * 2. 本地有待同步改动 -> 用本地副本（它更新），并提示需要推送到服务端
 * 3. 服务端为空 + 本地有数据 -> 用本地副本，交给界面询问是否导入（绝不静默覆盖）
 * 4. 其他            -> 用服务端数据
 */
export async function loadNotes() {
    const local = readLocalNotes();
    const pending = hasPendingChanges();

    let serverNotes;
    try {
        const res = await fetch(`${API_BASE}/notes/${userId}`, {
            headers: { Accept: 'application/json' }
        });
        if (!res.ok) {
            const detail = await res.json().catch(() => ({}));
            throw new Error(detail.error || `HTTP ${res.status}`);
        }
        const data = await res.json();
        if (!Array.isArray(data)) throw new Error('服务器返回的数据格式不正确');
        serverNotes = data;
    } catch (e) {
        console.warn('[RFNOTER] 服务端加载失败，改用本地副本', e);
        return { notes: local, source: 'local', offline: true, pending, error: e.message };
    }

    if (pending && local.length > 0) {
        return { notes: local, source: 'local', offline: false, pending: true, needPush: true };
    }
    if (serverNotes.length === 0 && local.length > 0) {
        return {
            notes: local,
            source: 'local',
            offline: false,
            pending: false,
            needImportConfirm: true,
            localCount: local.length
        };
    }
    return { notes: serverNotes, source: 'server', offline: false, pending: false };
}

/**
 * 保存笔记。本地先落盘（保证任何情况下都不丢），再尝试同步到服务端。
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function saveNotesToServer(notes) {
    writeLocalNotes(notes);
    try {
        const res = await fetch(`${API_BASE}/notes/${userId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(notes)
        });
        if (!res.ok) {
            const detail = await res.json().catch(() => ({}));
            throw new Error(detail.error || `HTTP ${res.status}`);
        }
        setPending(false);
        return { ok: true };
    } catch (e) {
        console.warn('[RFNOTER] 服务端保存失败，已保留本地副本', e);
        setPending(true);
        return { ok: false, error: e.message };
    }
}

function requestWithTimeout(url, options) {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, REQUEST_TIMEOUT_MS);
    return fetch(url, { ...options, signal: controller.signal })
        .catch((err) => {
            if (timedOut) {
                throw new ApiError(`请求超时（${REQUEST_TIMEOUT_MS / 1000} 秒），请检查网络后重试`, { retryable: true, cause: err });
            }
            throw new ApiError(`网络请求失败：${err.message}`, { retryable: true, cause: err });
        })
        .finally(() => clearTimeout(timer));
}

/**
 * 调用 DeepSeek。只对「网络错误 / 429 / 5xx」重试，401、400 这类不可重试的错误立刻抛出，
 * 避免用户为「密钥无效」白等 3 秒。
 */
export async function callDeepSeekAPI(apiKey, model, prompt, temperature) {
    const maxRetries = 3;
    let lastError;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await requestSummary(apiKey, model, prompt, temperature);
        } catch (error) {
            lastError = error;
            console.warn(`[RFNOTER] API 调用失败 (尝试 ${attempt}/${maxRetries}):`, error.message);
            if (!error.retryable || attempt >= maxRetries) break;
            await new Promise((resolve) => setTimeout(resolve, 1000 * Math.pow(2, attempt - 1)));
        }
    }
    throw lastError;
}

async function requestSummary(apiKey, model, prompt, temperature) {
    const response = await requestWithTimeout(DEEPSEEK_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
            model,
            messages: [
                { role: 'system', content: '你是一个专业的笔记总结助手，请根据用户提供的笔记内容生成高质量的总结。' },
                { role: 'user', content: prompt }
            ],
            temperature,
            max_tokens: MAX_TOKENS,
            stream: false
        })
    });

    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const detail = errorData?.error?.message || response.statusText || '未知错误';
        const retryable = response.status === 429 || response.status >= 500;
        throw new ApiError(`API 错误 ${response.status}：${detail}`, { status: response.status, retryable });
    }

    const data = await response.json().catch(() => null);
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim() === '') {
        throw new ApiError('AI 返回内容为空，请稍后重试或更换模型', { status: 0, retryable: true });
    }
    return content;
}

/** 尽量从服务端拉取可用模型列表；失败时返回空数组，由界面回退到内置列表。 */
export async function fetchAvailableModels(apiKey) {
    if (!apiKey) return [];
    try {
        const res = await requestWithTimeout('https://api.deepseek.com/models', {
            headers: { Authorization: `Bearer ${apiKey}` }
        });
        if (!res.ok) return [];
        const data = await res.json();
        const ids = (data?.data || []).map((item) => item?.id).filter((id) => typeof id === 'string');
        return [...new Set(ids)];
    } catch (e) {
        console.warn('[RFNOTER] 获取模型列表失败', e.message);
        return [];
    }
}
