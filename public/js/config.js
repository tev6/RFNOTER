/**
 * 全局常量。
 *
 * 单独成模块的原因：渲染、选择、统计等模块都要用同一份取值，
 * 而这些值和"会话状态"不是一类东西（它们是只读的）。
 */
import { REQUEST_TIMEOUT_MS, isDesktopApp } from './api.js';

/**
 * 笔记的真源叫什么，两种形态下说法不同：
 * 桌面端写的是本机文件，网页端写的才是服务器。提示语必须跟着变，
 * 否则桌面端用户会看到一句"未同步到服务器"而完全不知道在说谁。
 */
export const STORE_LABEL = isDesktopApp ? '本地文件' : '服务器';

/** 笔记 id 只允许这些字符，用来挡住拼进选择器/路径的注入。 */
export const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** 集中管理常量（延续 v1.2.0 的 CONFIG 约定）。 */
export const CONFIG = {
    MAX_SELECTION: 100,               // 单次 AI 总结最多可选笔记数
    API_TIMEOUT: REQUEST_TIMEOUT_MS,  // API 超时（真实值来自 api.js）
    DEFAULT_DURATION_MINUTES: 40,     // 快速添加的默认时长
    TAG_LIMIT: 20,                    // 标签上限（一个汉字算 2 个单位）
    MAX_CONTENT_LENGTH: 5000,         // 导入时标题最大长度
    MAX_DETAILS_LENGTH: 10000,        // 导入时详情最大长度
    ANIMATION_DURATION: 200,          // 删除动画时长（毫秒）
    COLOR_MAP: {
        'note1': '#3b82f6',
        'note2': '#10b981',
        'note3': '#f59e0b',
        'note4': '#ef4444',
        'note5': '#8b5cf6',
        'ai': '#8b5cf6',
        '': '#3b82f6'
    }
};
