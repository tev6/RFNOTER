# RFNOTER 开发规范与 API 文档

> 版本：v1.2.0  
> 适用对象：开发者 / 维护人员  
> 语言：中文

---

## 目录

1. [项目概述](#1-项目概述)
2. [文件结构](#2-文件结构)
3. [数据模型](#3-数据模型)
4. [全局变量与配置](#4-全局变量与配置)
5. [核心函数 API](#5-核心函数-api)
6. [AI 总结模块规范](#6-ai-总结模块规范)
7. [数据导入导出](#7-数据导入导出)
8. [事件绑定与生命周期](#8-事件绑定与生命周期)
9. [样式规范](#9-样式规范)
10. [安全规范](#10-安全规范)
11. [开发约束与注意事项](#11-开发约束与注意事项)

---

## 1. 项目概述

### 1.1 基本信息

| 属性 | 值 |
|------|-----|
| 项目名称 | RFNOTER（应用内显示名：闪录） |
| 当前版本 | v2.4.0 |
| 架构形式 | 模块化前端 + **双运行形态**：Electron 桌面端（默认）/ Express 网页端，共用同一套 `public/` |
| 技术栈 | HTML5 + Tailwind CSS v3（本地 vendor）+ Font Awesome 4.7（本地 vendor）+ ES6 Modules + Electron 44 / Express 4 |
| 数据存储 | 桌面端：`%APPDATA%\RFNOTER\data\`；网页端：`data/` 目录；两者都以 localStorage 作为离线副本 |
| 外部依赖 | 仅 `api.deepseek.com`（AI 总结）。Tailwind 与 Font Awesome 已本地化，离线可用 |

### 1.2 架构演进

- **v1.1.x**：单 HTML 文件（约 2500 行），所有代码集成在一个文件中，纯 localStorage
- **v1.2.0**：模块化拆分：
  - `public/index.html` — 页面结构与样式
  - `public/js/app.js` — 应用主逻辑
  - `public/js/utils.js` — 工具函数
  - `public/js/api.js` — API 调用与数据持久化
  - `server.js` — Express 后端服务
- **v2.1.0**：修数据同步/安全问题，引入测试（见 §11.5）
- **v2.2.0**：新增 Electron 桌面端（见 §11.6）
  - `electron/main.js` / `preload.cjs` / `store.js` — 主进程、桥、文件存储
  - `api.js` 变为**存储适配层**：有 `window.rfnoter` 走 IPC 读写本地文件，没有则走 `/api`
  - 静态资源本地化到 `public/vendor/`，桌面端离线可用
  - 前端业务逻辑（`app.js` / `utils.js` / `index.html`）**零改动复用**
- **v2.3.0**：按真实使用数据（1133 条 / 97 天）优化录入路径与渲染（见 §11.8）
  - 常用条目快捷条、时间接续提示与「补记空档」
  - 折叠分组惰性渲染：DOM 节点 24,812 → 1,391
- **v2.4.0**：导出格式、时间微调、错误日志与 CI（见 §11.9）
  - `public/js/exporters.js`（纯函数）、`electron/logger.js`（滚动文件日志）
  - `.github/workflows/ci.yml`：Node 20/24 矩阵 + 桌面自检 + tag 打包

---

## 2. 文件结构

```
RFNOTER/
├── electron/                   # 桌面端（v2.2.0）
│   ├── main.js                 # 主进程：窗口/托盘/热键/IPC/自检
│   ├── preload.cjs             # contextBridge 暴露 window.rfnoter
│   ├── store.js                # 本地文件读写（原子写 + userId 白名单）
│   └── assets/                 # icon.png / icon.ico / tray.png
├── public/
│   ├── index.html              # 主页面（两种形态共用）
│   ├── tailwind.config.js      # Tailwind 配置
│   ├── flash-noter-tutorial.md # 应用内「帮助」加载的教程
│   ├── vendor/                 # 本地化的 Tailwind 3.4.16 与 Font Awesome 4.7
│   └── js/
│       ├── app.js              # 应用主逻辑
│       ├── utils.js            # 工具函数
│       └── api.js              # 存储适配层 + DeepSeek 调用
├── test/                       # node:test 测试（52 个用例）
│   ├── utils.test.js
│   ├── electron-store.test.js
│   ├── server.test.js
│   ├── app.smoke.test.js       # jsdom：网页端
│   └── app.desktop.test.js     # jsdom：桌面端（IPC）
├── data/                       # 网页端数据目录（运行时创建）
│   └── notes_{userId}.json
├── server.js                   # Express 后端（网页端）
├── RFNOTER.vbs                 # 桌面端双击启动器（必须保持纯 ASCII）
├── package.json                # 项目配置
├── v1.1.2.0.html               # 旧版本单文件（归档）
├── RFNOTER-用户操作手册.md      # 用户文档
└── RFNOTER-开发规范与API文档.md  # 本文档
```

> 已移除：`public/css/style.css`（从未被 index.html 引用，样式实际在 index.html 内联的
> `<style type="text/tailwindcss">` 里）。

---

## 3. 数据模型

### 3.1 Note 对象结构

```typescript
interface Note {
  id: string;           // UUID v4 格式，唯一标识
  date: string;         // 日期，格式 "YYYY-MM-DD"
  timeStart: string;    // 开始时间，格式 "HH:MM"（24小时制）
  timeEnd: string;      // 结束时间，格式 "HH:MM"（24小时制）
  content: string;      // 笔记标题/主要内容，最大 5000 字符
  tag: string;          // 标签，最多20字符单位（中文计2）
  color: string;        // 颜色标记键名：'note1'|'note2'|'note3'|'note4'|'note5'|'ai'|''
  details: string;      // 详细信息，最大 10000 字符
  expanded: boolean;    // 详情区域是否展开
  createdAt: number;    // 创建时间戳（毫秒）
  updatedAt: number;    // 最后更新时间戳（毫秒）
}
```

### 3.2 导出数据结构

```typescript
interface ExportData {
  version: string;      // 导出版本，如 "1.2.0"
  exportTime: string;   // ISO 8601 格式导出时间
  noteCount: number;    // 笔记数量
  notes: Note[];        // 笔记数组
}
```

### 3.3 AI 总结请求配置

```typescript
interface SummaryRequestData {
  selectedNotes: SelectedNoteItem[];
  summaryConfig: SummaryConfig;
  apiConfig: ApiConfig;
}

interface SelectedNoteItem {
  date: string;
  timeRange: string;      // 格式："HH:MM ~ HH:MM"
  content: string;
  tag: string;
  details: string;
}

interface SummaryConfig {
  style: string;          // '简洁摘要' | '详细报告' | '记忆回溯'
  format: string;         // '纯文本' | 'Markdown格式' | 'HTML格式'
  customPrompt: string;   // 用户自定义提示词（可选）
}

interface ApiConfig {
  model: string;          // 'deepseek-flash' | 'deepseek-v4-pro'（可在界面里自动刷新）
  temperature: number;    // 0.0 ~ 1.0
}
```

> ⚠️ **v2.1.0 变更**：移除了从未使用的 `mergeMethod` 与 `apiConfig.maxTokens`（token 上限统一由 `api.js` 的 `MAX_TOKENS` 控制）；模型名更新为当前可用的 `deepseek-flash` / `deepseek-v4-pro`。

### 3.4 存储键名规范

| 键名 | 位置 | 类型 | 说明 |
|------|------|------|------|
| `userId` | localStorage | string | 用户唯一标识，格式：`UUID-时间戳` |
| `notes_${userId}` | localStorage | string (JSON) | 笔记数组离线副本 |
| `notes_${userId}_pending` | localStorage | `'1'` | 存在未同步改动时的标记（v2.1.0） |
| `notes_${userId}_backup_*` | localStorage | string (JSON) | 覆盖本地副本前的自动备份，最多 3 份（v2.1.0） |
| `notes_${userId}.json` | 真源文件 | JSON 文件 | 主数据源，见下表 |

真源文件的位置随运行形态而变：

| 运行形态 | 真源路径 | 说明 |
|----------|----------|------|
| 桌面端（Electron） | `%APPDATA%\RFNOTER\data\notes_${userId}.json` | 由 `electron/store.js` 读写，走 IPC |
| 网页端（Express） | `<项目>/data/notes_${userId}.json` | 由 `server.js` 读写，走 `/api` |

> ⚠️ **v1.2.0 变更**：`deepseek_api_key` 已从 localStorage 中移除，改为内存存储。
>
> ⚠️ **v2.2.0 变更**：桌面端首次启动时若真源目录为空、而同目录下存在旧版
> `notes_*.json`（例如从网页端迁移过来），会沿用其中最新的那个 `userId`
> 并询问是否导入，避免出现「新身份 + 旧数据看不见」。

---

## 4. 全局变量与配置

### 4.1 CONFIG 常量对象

```javascript
const CONFIG = {
    MAX_SELECTION: 100,              // 最大选择笔记数
    API_TIMEOUT: REQUEST_TIMEOUT_MS, // API 调用超时（真实值来自 api.js，60 秒）
    DEFAULT_DURATION_MINUTES: 40,    // 默认笔记持续时间
    TAG_LIMIT: 20,                   // 标签最大字符单位
    MAX_CONTENT_LENGTH: 5000,        // 内容最大长度（导入校验用）
    MAX_DETAILS_LENGTH: 10000,       // 详情最大长度（导入校验用）
    ANIMATION_DURATION: 200,         // 动画持续时间（毫秒）
    COLOR_MAP: {
        'note1': '#3b82f6',          // 蓝色
        'note2': '#10b981',          // 绿色
        'note3': '#f59e0b',          // 橙色
        'note4': '#ef4444',          // 红色
        'note5': '#8b5cf6',          // 紫色
        'ai': '#8b5cf6',             // AI 总结（紫色）
        '': '#3b82f6'                // 默认蓝色
    }
};
```

### 4.2 应用状态变量

| 变量名 | 类型 | 初始值 | 说明 |
|--------|------|--------|------|
| `notes` | `Note[]` | `[]` | 所有笔记数组 |
| `currentNoteId` | `string \| null` | `null` | 当前操作的笔记 ID |
| `lastEndTime` | `number \| null` | `null` | 最后笔记结束时间戳 |
| `selectedNotes` | `Set<string>` | `new Set()` | 选中的笔记 ID 集合 |
| `currentSummaryConfig` | `object` | `{}` | 当前总结请求配置 |
| `currentSummaryResult` | `string \| null` | `null` | 当前总结结果文本 |
| `selectionMode` | `boolean` | `false` | 是否处于选择模式 |
| `dateGroupNotesMap` | `Map<Element, string[]>` | `new Map()` | 日期分组到笔记 ID 的映射 |

> ⚠️ **v1.2.0 变更**：已移除 `lastClickedNoteId` 死代码。

### 4.3 DOM 元素引用

| 变量名 | 对应 DOM ID | 说明 |
|--------|-------------|------|
| `notesContainer` | `notes-container` | 笔记列表容器 |
| `emptyState` | `empty-state` | 空状态提示 |
| `noteModal` | `note-modal` | 编辑笔记模态框 |
| `contextMenu` | `context-menu` | 右键菜单 |
| `deleteModal` | `delete-modal` | 删除确认模态框 |
| `saveIndicator` | `save-indicator` | 保存状态提示 |
| `quickAddForm` | `quick-add-form` | 快速添加表单 |
| `colorSubmenu` | `color-submenu` | 颜色子菜单 |
| `selectionToggleBtn` | `selection-toggle-btn` | 选择模式切换按钮 |
| `selectionModeHint` | `selection-mode-hint` | 选择模式提示条 |
| `aiSummaryFloatBtn` | `ai-summary-float-btn` | AI 总结浮动按钮 |
| `aiSummaryModal` | `ai-summary-modal` | AI 总结配置模态框 |
| `aiResultModal` | `ai-result-modal` | AI 总结结果模态框 |
| `exportBtn` | `export-btn` | 导出按钮 |
| `importBtn` | `import-btn` | 导入按钮 |
| `importFileInput` | `import-file-input` | 文件输入（隐藏） |

---

## 5. 核心函数 API

### 5.1 初始化与生命周期

#### `initQuickInput()`

初始化底部快速输入区的时间和日期。

- **参数**：无
- **返回值**：无
- **副作用**：设置 `quick-date`、`quick-time-start`、`quick-time-end` 的值
- **逻辑**：
  - 日期固定为今日（中文格式："X月X日"）
  - 开始时间：优先使用 `lastEndTime`，否则取当前时间向上取整到 5 分钟
  - 结束时间：开始时间 + `CONFIG.DEFAULT_DURATION_MINUTES` 分钟

#### `renderNotes()`

全量渲染笔记列表到 DOM。

- **参数**：无
- **返回值**：无
- **副作用**：清空并重建 `notesContainer`
- **渲染逻辑**：
  1. 按 `createdAt` 降序排序
  2. 按 `date` 分组
  3. 对每个日期组：创建日期标题 → 创建该日所有笔记卡片
  4. 非今日的日期组默认折叠
  5. 若处于选择模式，重新绑定日期分组点击事件

#### `updateEmptyState()`

更新空状态显示。

- **参数**：无
- **返回值**：无
- **副作用**：显示/隐藏 `emptyState` 和 `notesContainer`

### 5.2 增量渲染函数（v1.2.0 新增）

#### `renderNoteElement(note)`

将单条笔记插入到 DOM 的对应位置，不触发全量重渲染。

- **参数**：`note: Note`
- **返回值**：无
- **逻辑**：
  1. 查找笔记日期对应的日期分组
  2. 若分组存在：插入到该分组第一个笔记之前
  3. 若分组不存在：创建新日期分组并插入到正确排序位置
  4. 更新选择模式事件绑定

#### `removeNoteElement(noteId)`

从 DOM 中移除单条笔记元素。

- **参数**：`noteId: string`
- **返回值**：无
- **逻辑**：
  1. 移除笔记卡片 DOM 元素
  2. 若该日期组最后一条笔记被移除，同时移除日期分组
  3. 否则更新日期分组的笔记计数

#### `findDateGroupElement(date)`

查找指定日期的日期分组 DOM 元素。

- **参数**：`date: string` — "YYYY-MM-DD"
- **返回值**：`HTMLElement \| null`

### 5.3 笔记 CRUD

#### `quickAddNote(e)`

快速添加新笔记。

- **参数**：`e: Event`
- **返回值**：无
- **前置条件**：非选择模式
- **副作用**：向 `notes` 数组头部添加新 Note，调用 `saveNotes()`，使用 `renderNoteElement()` 增量渲染，更新 `lastEndTime`

#### `saveNote()`

保存编辑后的笔记。

- **参数**：无（从 DOM 表单读取）
- **返回值**：无
- **副作用**：更新 `notes` 数组，调用 `saveNotes()` 和 `renderNotes()`
- **v1.2.0 修复**：移除 `setTimeout(() => renderNotes(), 100)` 的重复渲染

#### `deleteNote()`

删除当前选中的笔记。

- **参数**：无（依赖 `currentNoteId`）
- **返回值**：无
- **副作用**：从 `notes` 数组移除笔记，使用 `removeNoteElement()` 增量移除 DOM
- **v1.2.0 修复**：动画延迟期间使用 `noteId` 查找而非索引，避免索引偏移问题

#### `duplicateNote()`

复制当前笔记。

- **参数**：无（依赖 `currentNoteId`）
- **返回值**：无
- **副作用**：创建新 Note 并插入 `notes` 头部

### 5.4 选择与 AI 总结

#### `toggleSelectionMode()`

切换选择模式状态。

- **参数**：无
- **返回值**：无
- **副作用**：切换 `selectionMode`，更新按钮 UI

#### `handleNoteSelection(event, noteId)`

笔记卡片的点击事件处理器。

- **参数**：`event: MouseEvent`, `noteId: string`
- **返回值**：无
- **行为**：
  - 选择模式：切换选中状态（上限 `CONFIG.MAX_SELECTION`）
  - 非选择模式 + 双击：打开编辑模态框

#### `bindDateGroupSelectionEvents()`

绑定日期分组选择事件。

- **参数**：无
- **返回值**：无
- **v1.2.0 修复**：绑定前先 `removeEventListener`，避免事件累积

#### `generateSummary()`

生成 AI 总结（主入口）。

- **参数**：无
- **返回值**：`Promise<void>`
- **流程**：
  1. 验证 API 密钥
  2. 调用 `setApiKey()` 将密钥存入内存（不再持久化）
  3. 收集配置并构建 `requestData`
  4. 调用 `buildPrompt()` 和 `callDeepSeekAPI()`
  5. 显示结果或错误

### 5.5 数据导入导出（v1.2.0 新增）

#### `exportNotes()`

导出所有笔记为 JSON 文件下载。

- **参数**：无
- **返回值**：无
- **导出格式**：

```json
{
  "version": "1.2.0",
  "exportTime": "2026-05-16T12:00:00.000Z",
  "noteCount": 42,
  "notes": [ /* Note[] */ ]
}
```

- **文件名**：`rfnoter-backup-YYYY-MM-DD.json`

#### `validateNoteImport(data)`

校验导入数据的完整性和安全性。

- **参数**：`data: any` — 解析后的 JSON 数据
- **返回值**：`{ valid: boolean, errors: string[], notes: Note[] }`
- **校验规则**：
  - 数据必须为对象且包含 `notes` 数组
  - 每条笔记必须包含有效的 `id`（字符串）、`date`、`timeStart`、`timeEnd`、`content`
  - 字符串字段进行长度截断（`content` ≤ 5000，`details` ≤ 10000，`tag` ≤ 20）
  - 使用 `String()` 强制转换，防止原型链污染
  - `expanded` 使用 `Boolean()` 转换
  - 时间戳使用 `typeof` 检查，无效时回退到 `Date.now()`

#### `importNotes()`

触发文件选择对话框。

- **参数**：无
- **返回值**：无
- **副作用**：触发隐藏的 `<input type="file">` 点击

#### `handleFileImport(event)`

处理文件导入。

- **参数**：`event: Event` — 文件选择事件
- **返回值**：`Promise<void>`
- **流程**：
  1. 校验文件扩展名为 `.json`
  2. 读取并解析 JSON
  3. 调用 `validateNoteImport()` 校验数据
  4. 去重：过滤掉已存在的笔记 ID
  5. 弹出确认对话框：合并或替换
  6. 保存并重新渲染

#### `initImportExport()`

初始化导入导出事件监听。

- **参数**：无
- **返回值**：无
- **绑定事件**：
  - `exportBtn click` → `exportNotes()`
  - `importBtn click` → `importNotes()`
  - `importFileInput change` → `handleFileImport()`

### 5.6 工具函数（utils.js）

| 函数 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `generateUUID()` | 无 | `string` | 生成 UUID v4 |
| `getCurrentDateString()` | 无 | `string` | 格式 "YYYY-MM-DD" |
| `formatRelativeTime(timestamp)` | `number` | `string` | 相对时间文本 |
| `formatDateForDisplay(dateString)` | `string` | `string` | 短格式日期 |
| `calculateTimeDuration(startTime, endTime)` | `string, string` | `number` | 间隔分钟数，支持跨天 |
| `formatDuration(minutes)` | `number` | `string` | 可读时长文本 |
| `trimTagToLimit(text)` | `string` | `string` | 截断标签到限制长度 |
| `escapeHTML(str)` | `string` | `string` | HTML 实体转义（v1.2.0 新增） |
| `markdownToHtml(md)` | `string` | `string` | Markdown 转 HTML，先 escape 再替换（v1.2.0 修复） |
| `isTodayDate(dateString)` | `string` | `boolean` | 判断是否为今天 |
| `groupNotesByDate(notes)` | `Note[]` | `Record<string, Note[]>` | 按日期分组 |

### 5.7 API 模块（api.js）

| 函数 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `setApiKey(key)` | `string` | 无 | 将 API 密钥存入内存（v1.2.0 变更） |
| `getApiKey()` | 无 | `string \| null` | 从内存获取 API 密钥 |
| `loadNotes()` | 无 | `Promise<LoadResult>` | 按同步策略加载笔记，返回值带上数据来源与冲突标记（v2.1.0） |
| `saveNotesToServer(notes)` | `Note[]` | `Promise<{ok, error?}>` | 先写本地副本，再同步服务端；失败会置 `_pending` 标记（v2.1.0） |
| `saveNotesLocally(notes)` | `Note[]` | 无 | 只写本地副本，不发网络请求（v2.1.0） |
| `backupLocalNotes()` | 无 | `string \| null` | 覆盖本地副本前备份，最多保留 3 份（v2.1.0） |
| `hasPendingChanges()` | 无 | `boolean` | 是否存在未同步改动（v2.1.0） |
| `fetchAvailableModels(apiKey)` | `string` | `Promise<string[]>` | 拉取账号可用模型列表（v2.1.0） |
| `callDeepSeekAPI(apiKey, model, prompt, temperature)` | `string, string, string, number` | `Promise<string>` | 调用 DeepSeek API；只有网络错误/429/5xx 才重试（v2.1.0） |
| `ApiError` | — | `Error` | 带 `status` / `retryable` 的结构化错误（v2.1.0） |

`LoadResult` 结构：

```typescript
interface LoadResult {
  notes: Note[];
  source: 'server' | 'filesystem' | 'local';  // 'filesystem' 为桌面端（v2.2.0）
  offline: boolean;             // 真源不可用，用的是本地副本
  pending: boolean;             // 本地有未同步改动
  needPush?: boolean;           // 需要把本地改动写回真源
  needImportConfirm?: boolean;  // 真源为空而本地有数据，需用户确认是否导入
  localCount?: number;
  error?: string;
}
```

#### 存储适配层（v2.2.0）

`api.js` 在模块加载时判断一次运行形态，之后 `loadNotes()` / `saveNotesToServer()` 内部走不同分支，
**对 `app.js` 完全透明**：

```javascript
const desktopBridge = (typeof window !== 'undefined' && window.rfnoter?.isDesktop)
    ? window.rfnoter : null;
export const isDesktopApp = desktopBridge !== null;
```

| 分支 | 真源 | 失败时的表现 |
|------|------|--------------|
| 桌面端 | `window.rfnoter.readNotes/writeNotes`（IPC → `electron/store.js`） | 置 `_pending`，提示「未同步」 |
| 网页端 | `fetch('/api/notes/:userId')` | 同上 |

> ⚠️ 因为 `desktopBridge` 是模块加载时读取的，**测试桌面端分支时必须用独立进程**
> （见 `test/app.desktop.test.js` 顶部注释），同一个进程里混跑会拿到第一次的形态。

### 5.8 桌面端模块（electron/，v2.2.0）

#### `electron/main.js`

| 职责 | 说明 |
|------|------|
| 窗口 | 1180×840，`show:false` + `ready-to-show` 再显示；另有 2 秒兜底强制显示，避免「进程活着但看不见窗口」 |
| 页面加载 | 自定义 `app://` 协议（`registerSchemesAsPrivileged` + `protocol.handle`）。**不能用 `file://`**：Chromium 会拒绝 `fetch` 本地文件（帮助文档会打不开），CSP 的 `'self'` 也失效 |
| 托盘 | 打开主窗口 / 快速记录 / 开机自启 / 打开数据目录 / 退出；关闭窗口 = 收进托盘 |
| 全局热键 | 依次尝试 `Control+Shift+Space` → `Alt+Shift+N` → `Control+Alt+N`，全部占用时托盘菜单会标注 |
| 单实例 | `app.requestSingleInstanceLock()`，第二次启动只唤起已有窗口 |
| 开机自启 | `app.setLoginItemSettings()`，托盘菜单里勾选 |
| 自检 | `--selftest`：19 项，含真实页面加载、IPC 落盘、布局体检、控制台错误探针 |
| 调试 | `--layout-debug` 打印窗口/页面布局数据；`--screenshot=<path>` 让 Electron 自己截自己的窗口（比外部截图工具可靠，不受 DPI 缩放影响） |

IPC 通道：

| 通道 | 方向 | 签名 |
|------|------|------|
| `notes:read` | renderer → main | `(userId) => {ok, notes, exists}` |
| `notes:write` | renderer → main | `(userId, notes) => {ok, count?, error?}` |
| `notes:list-user-ids` | renderer → main | `() => [{userId, mtimeMs, size}]`（按修改时间倒序） |
| `app:info` | renderer → main | `() => {version, dataDir, hotkey, platform}` |
| `app:open-data-dir` | renderer → main | `() => void` |
| `quick-capture` | main → renderer | 热键触发，渲染进程收到后聚焦 `#quick-content` |

#### `electron/preload.cjs`

`contextBridge.exposeInMainWorld('rfnoter', {...})` 只暴露上面这几个方法；
`contextIsolation: true` + `nodeIntegration: false`，页面拿不到 Node。

> 必须用 `.cjs` 后缀：`package.json` 是 `"type": "module"`，而 preload 走 CommonJS。

#### `electron/store.js`

与 `server.js` 同样的语义（返回 `{ok, ...}`），但直接落盘：

| 方法 | 说明 |
|------|------|
| `fileFor(userId)` | `userId` 白名单 `[A-Za-z0-9_-]{1,128}`，非法返回 `null` |
| `read(userId)` | 不存在 → `{ok:true, notes:[], exists:false}`；损坏 → `{ok:false, error}` |
| `write(userId, notes)` | 先写 `.tmp` 再 `rename`，原子替换 |
| `listUserIds()` | 列出目录内合法文件，按 mtime 倒序 |
| `migrateFrom(dir)` | 把旧版目录里的 `notes_*.json` 搬到数据目录（只补齐缺失项，不覆盖） |

---

## 6. AI 总结模块规范

### 6.1 Prompt 构建规范

#### 系统消息

```
你是一个专业的笔记总结助手，请根据用户提供的笔记内容生成高质量的总结。
```

#### 用户消息结构

```
你是一个专业的笔记总结助手，擅长将分散的笔记信息整理成有结构的总结。

以下是{N}条笔记，按时间顺序排序：

1. 【YYYY-MM-DD HH:MM ~ HH:MM】 [标签：XXX]
标题：<笔记标题>
详情：<笔记详情>

2. 【...】
...

总结要求：
1. 总结风格：<风格名称>
2. 风格细则：<风格细则>
3. 输出格式必须遵循：<格式>
4. <自定义提示词 或 默认提示词>
5. 保持原始信息的准确性
6. 如有矛盾信息，请注明
7. 用中文输出

请直接给出总结内容，不需要额外的说明文字。
```

#### 风格细则映射

| 风格 | 细则 |
|------|------|
| 简洁摘要 | `根据所选风格输出` |
| 详细报告 | `根据所选风格输出` |
| 记忆回溯 | `采用记忆回溯口吻，细节充分、节奏舒缓、积极客观，但必须基于原始笔记，可以夸大` |

> ⚠️ 注意：「可以夸大」疑似笔误，应为「不可以夸大」。

### 6.2 API 调用规范

| 属性 | 值 |
|------|-----|
| 端点 | `POST https://api.deepseek.com/v1/chat/completions` |
| 认证 | `Authorization: Bearer {apiKey}` |
| Content-Type | `application/json` |
| 超时 | 30 秒（`createTimeoutSignal` 降级方案） |
| 最大重试 | 3 次 |
| 退避策略 | 指数退避：1s, 2s, 4s |

#### 超时降级方案（v1.2.0 新增）

```javascript
function createTimeoutSignal(timeoutMs) {
    if (typeof AbortSignal.timeout === 'function') {
        return AbortSignal.timeout(timeoutMs);
    }
    const controller = new AbortController();
    setTimeout(() => controller.abort(
        new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    ), timeoutMs);
    return controller.signal;
}
```

### 6.3 错误码映射

| HTTP 状态码 | 用户提示 |
|-------------|----------|
| 401 | API密钥无效，请检查并重新输入 |
| 429 | 请求过于频繁，请稍后再试 |
| 500 | AI服务暂时不可用，请稍后重试 |
| timeout | 请求超时，请检查网络连接后重试 |
| network | 网络连接失败，请检查网络连接 |
| 其他 | 显示原始错误消息 |

### 6.4 结果渲染规范

| 输出格式 | 渲染方式 |
|----------|----------|
| 纯文本 | `textContent = summary` |
| Markdown格式 | 简单替换：`\n`→`<br>`，`#标题`→`<strong>`，`**粗体**`→`<strong>`，`*斜体*`→`<em>` |
| HTML格式 | `innerHTML = summary`（⚠️ 仍存在 XSS 风险） |

---

## 7. 数据导入导出

### 7.1 导出流程

```
用户点击导出按钮
    ↓
构造 ExportData 对象
    ↓
JSON.stringify → Blob
    ↓
创建临时下载链接 → 自动下载
    ↓
显示「已导出笔记」提示
```

### 7.2 导入流程

```
用户点击导入按钮 → 触发文件选择
    ↓
校验文件扩展名 (.json)
    ↓
读取文件内容 → JSON.parse
    ↓
validateNoteImport() 校验
    ↓
去重（过滤已存在的 ID）
    ↓
确认对话框：合并 / 替换
    ↓
更新 notes 数组 → saveNotes() → renderNotes()
    ↓
显示导入成功提示
```

### 7.3 导入校验规则

| 字段 | 校验 | 失败处理 |
|------|------|----------|
| `id` | 必须为字符串且非空 | 跳过该笔记，记录错误 |
| `date` | 必须为字符串且非空 | 跳过该笔记，记录错误 |
| `timeStart` | 必须为字符串且非空 | 跳过该笔记，记录错误 |
| `timeEnd` | 必须为字符串且非空 | 跳过该笔记，记录错误 |
| `content` | 必须为字符串且非空 | 跳过该笔记，记录错误 |
| `content` 长度 | 截断到 5000 字符 | 自动截断 |
| `details` 长度 | 截断到 10000 字符 | 自动截断 |
| `tag` 长度 | 截断到 20 字符单位 | 自动截断 |
| `expanded` | `Boolean()` 转换 | 非布尔值转为布尔值 |
| `createdAt`/`updatedAt` | `typeof === 'number'` | 无效时回退 `Date.now()` |

---

## 8. 事件绑定与生命周期

### 8.1 应用启动流程

```
DOMContentLoaded
├── bindEventListeners()    # 先绑事件：数据万一异常，界面也不会变成点不动的死图
├── bindAIEventListeners()  # 绑定 AI 相关事件
├── initImportExport()      # 初始化导入导出（v1.2.0 新增）
├── initQuickInput()        # 初始化快速输入区
├── initDesktopBridge()     # 桌面端：注册全局热键回调（v2.2.0）
└── await initializeNotes() # 加载 + 对账（可能弹「是否导入」确认）
    ├── loadNotes()         # 桌面端走 IPC，网页端走 /api
    ├── normalizeNote()     # 补齐字段、校验 id / 日期 / 时间
    ├── saveNotes()         # 用户确认导入、或本地有未同步改动时写回真源
    ├── renderNotes()       # 渲染笔记列表
    └── updateSyncStatus()  # 刷新顶部同步状态徽标
```

### 8.2 核心事件绑定清单

| 事件源 | 事件类型 | 处理函数 | 说明 |
|--------|----------|----------|------|
| `quick-add-form` | `submit` | `quickAddNote` | 快速添加笔记 |
| `save-note-btn` | `click` | `saveNote` | 保存编辑 |
| `cancel-note-btn` | `click` | `closeNoteModal` | 取消编辑 |
| `confirm-delete-btn` | `click` | `deleteNote` | 确认删除 |
| `cancel-delete-btn` | `click` | `closeDeleteModal` | 取消删除 |
| `selection-toggle-btn` | `click` | `toggleSelectionMode` | 切换选择模式 |
| `clear-selection-btn` | `click` | `clearSelection` | 清空选择 |
| `export-btn` | `click` | `exportNotes` | 导出笔记（v1.2.0 新增） |
| `import-btn` | `click` | `importNotes` | 导入笔记（v1.2.0 新增） |
| `import-file-input` | `change` | `handleFileImport` | 处理文件导入（v1.2.0 新增） |
| `aiSummaryFloatBtn` | `click` | `openAISummaryModal` | 打开 AI 总结 |
| `generate-summary-btn` | `click` | `generateSummary` | 生成总结 |
| `cancel-summary-btn` | `click` | `closeAISummaryModal` + `exitSelectionMode` | 取消总结 |
| `toggle-api-config` | `click` | `toggleApiConfig` | 展开/折叠高级设置 |
| `toggle-api-key` | `click` | `toggleApiKeyVisibility` | 切换密钥可见性 |
| `temperature` | `input` | `updateTemperatureValue` | 更新温度显示 |
| `copy-summary-btn` | `click` | `copySummaryToClipboard` | 复制结果 |
| `save-as-note-btn` | `click` | `saveSummaryAsNote` | 保存为新笔记 |
| `regenerate-summary-btn` | `click` | `regenerateSummary` | 重新生成 |
| `adjust-config-btn` | `click` | `backToConfig` | 返回配置 |
| `retry-summary-btn` | `click` | `retrySummary` | 重试 |
| `back-to-config-btn` | `click` | `backToConfig` | 返回配置 |
| `edit-note-menu-btn` | `click` | `openEditModal` | 右键菜单-编辑 |
| `duplicate-note-menu-btn` | `click` | `duplicateNote` | 右键菜单-复制 |
| `delete-note-menu-btn` | `click` | `openDeleteModal` | 右键菜单-删除 |
| `color-menu-btn` | `mouseenter` / `click` | `showColorSubmenu` | 显示颜色子菜单 |
| `document` | `click` | `closeContextMenu` | 点击空白处关闭右键菜单 |
| `document` | `keydown(Escape)` | 关闭所有模态框/退出选择模式 | 全局 ESC 键 |

### 8.3 模态框关闭行为

| 模态框 | 点击外部关闭 | ESC 关闭 | 关闭后副作用 |
|--------|-------------|----------|-------------|
| 编辑笔记 (`note-modal`) | ✓ | ✓ | 无 |
| 删除确认 (`delete-modal`) | ✓ | ✓ | 无 |
| AI 总结配置 (`ai-summary-modal`) | ✓ | ✓ | 退出选择模式 |
| AI 总结结果 (`ai-result-modal`) | ✓ | ✓ | 退出选择模式 |
| 帮助 (`help-modal`) | ✓ | ✓ | 无 |

---

## 9. 样式规范

### 9.1 Tailwind 自定义配置

```javascript
tailwind.config = {
  theme: {
    extend: {
      colors: {
        primary: '#3b82f6',
        danger: '#ef4444',
        success: '#10b981',
        ai: '#8b5cf6',
        note1: '#3b82f6',
        note2: '#10b981',
        note3: '#f59e0b',
        note4: '#ef4444',
        note5: '#8b5cf6'
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif']
      },
      animation: {
        'fade-in': 'fadeIn 0.2s ease-in-out',
        'fade-out': 'fadeOut 0.2s ease-in-out',
        'slide-in': 'slideIn 0.25s ease-out',
        'slide-up': 'slideUp 0.25s ease-out',
        'bounce-in': 'bounceIn 0.3s ease-out',
        'pulse': 'pulse 1.5s ease-in-out infinite'
      }
    }
  }
}
```

### 9.2 自定义工具类

| 类名 | 定义 | 用途 |
|------|------|------|
| `.note-card` | 相对定位、内边距、圆角、阴影、左边框、光标指针 | 笔记卡片基础样式 |
| `.note-card.selected` | 紫色圆环、淡紫背景 | 选中状态 |
| `.btn` | 按钮基础样式（内边距、圆角、过渡、焦点环、点击缩放） | 所有按钮 |
| `.btn-primary` | 蓝色背景白字 | 主要操作 |
| `.btn-secondary` | 灰色背景 | 次要操作 |
| `.btn-ai` | 紫色背景白字 | AI 相关操作 |
| `.input-field` | 输入框基础样式 | 所有输入框 |
| `.textarea-field` | 文本域基础样式 | 多行输入 |
| `.tag` | 标签样式（小字、圆角、灰底） | 笔记标签 |
| `.ai-tag` | AI 标签样式（紫底紫字、边框） | AI 相关标签 |
| `.color-dot` | 颜色圆点（可点击、悬停缩放） | 颜色选择器 |
| `.date-header` | 日期标题（可点击、按压缩放） | 日期分组标题 |
| `.date-header.selected` | 选中状态的日期标题 | 选择模式下 |
| `.duration-badge` | 时间间隔徽章 | 显示时长 |

### 9.3 响应式断点

| 断点 | 范围 | 布局调整 |
|------|------|----------|
| 手机 | ≤ 640px | 单列布局，时间选择器纵向排列，减小内边距 |
| 平板 | 641px ~ 768px | 6 列网格布局 |
| 桌面 | > 768px | 12 列网格布局 |
| 小屏手机 | ≤ 480px | 进一步调整输入区布局 |

---

## 10. 安全规范

### 10.1 已修复的安全问题（v1.2.0）

| Issue | 修复措施 | 状态 |
|-------|----------|------|
| XSS 漏洞 | `utils.js` 新增 `escapeHTML()`，`markdownToHtml()` 先转义再替换 | ✅ 已修复 |
| API Key 明文存储 | 移除 `localStorage` 存储，改为内存变量 `memoryApiKey` | ✅ 已修复 |
| CSP 缺失 | `index.html` 添加 `<meta http-equiv="Content-Security-Policy">` | ✅ 已修复 |
| HTML 格式直接注入 | 仍存在风险，Markdown/纯文本输出已安全 | ⚠️ 部分修复 |

### 10.2 CSP 配置

```html
<!-- v2.2.0：Tailwind 与 Font Awesome 已本地化，不再需要 CDN 域名 -->
<meta http-equiv="Content-Security-Policy" content="
    default-src 'self';
    script-src 'self' 'unsafe-eval';
    style-src 'self' 'unsafe-inline';
    font-src 'self';
    img-src 'self' data:;
    connect-src 'self' https://api.deepseek.com;
">
```

> `'unsafe-eval'` 是 Tailwind Play CDN 版本在浏览器里编译 CSS 所必需的。
> 桌面端用 `app://` 协议加载页面，否则 `'self'` 没有意义（`file://` 是不透明源）。

### 10.3 待修复安全问题

| 风险点 | 现状 | 建议 |
|--------|------|------|
| 外部 CDN | 依赖第三方 CDN 可用性 | 考虑添加 fallback 或本地备份 |
| 接口无鉴权 | `app.listen` 监听所有网卡，同网段可直接读写笔记接口 | 需要局域网使用时加一层访问令牌，或改为 `HOST=127.0.0.1` |

> ✅ **v2.1.0 已修复**：
> - HTML 格式输出改为 `sanitizeHtml()` 白名单净化（不再直接 `innerHTML`）。
> - `generateUUID` 优先使用 `crypto.randomUUID()`。
> - 服务端 `userId` 白名单校验，堵死 `..%2F` 目录穿越（原可读写任意 `*.json`）。
> - 数据文件改为「临时文件 + rename」原子写入。
> - `POST` 体积上限提升到 5MB（原 `express.json()` 默认 100KB 会静默失败）。

---

## 11. 开发约束与注意事项

### 11.1 模块化约束

- 使用 ES6 Module (`type="module"`) 导入导出
- `app.js` 依赖 `utils.js` 和 `api.js`
- `api.js` 依赖 `utils.js`（`generateUUID`）
- 服务端 `server.js` 也使用 ESM（`package.json` 里 `"type": "module"`，Node ≥ 20.11）
- 桌面端 `electron/main.js` 同样用 ESM；**但 `preload.cjs` 必须是 CommonJS**（`.cjs` 后缀）
- `app.js` 顶部对 `window.rfnoter` 的使用是**可选**的，网页端没有这个对象也必须能跑

### 11.2 数据持久化约束

- 主数据源（真源）：桌面端 `%APPDATA%\RFNOTER\data\`，网页端 `data/`，写入均为原子操作
- 备份：localStorage（`notes_${userId}`），另有 `_pending` 未同步标记与 `_backup_*` 自动备份
- API 密钥：仅内存存储，页面刷新后丢失
- 同步失败不会静默：界面顶部会显示「离线模式 / 有改动未同步」，保存提示可点击重试

### 11.3 性能注意事项

- `renderNotes()` 为全量渲染，用于初始加载和编辑后重渲染；`quickAddNote()` / `deleteNote()` 走增量渲染
- `store.js` 的原子写入在 367KB（约 1050 条）下实测：写 7ms / 读 5ms
- 日期分组折叠状态通过 DOM class 切换，不持久化

### 11.4 已知代码异味

| 位置 | 问题 | 说明 |
|------|------|------|
| `showSummaryResult` | HTML 格式直接注入 | ✅ v2.1.0 已改为 `sanitizeHtml()` |
| `generateUUID` | 非加密安全 | ✅ v2.1.0 已优先使用 `crypto.randomUUID()` |

### 11.5 v2.1.0 主要变更

| 模块 | 变更 |
|------|------|
| `server.js` | 改为 ESM；抽出 `createApp()` / `startServer()` 便于测试；`userId` 白名单；原子写入；JSON 错误响应；端口回退修正（原 `PORT + 1` 会变成 `"30001"`） |
| `api.js` | 同步层重写（离线副本 + `_pending` 标记 + 覆盖前备份）；`ApiError` 分级重试；新增 `fetchAvailableModels` |
| `utils.js` | 日期按本地时区解析（原 `new Date('YYYY-MM-DD')` 在 UTC 以西会差一天）；新增 `sanitizeHtml` / `parseClockMinutes` / `minutesToClock` / `countWords`；`markdownToHtml` 不再把 `C# 语言` 当标题 |
| `app.js` | 启动时对账（服务端为空而本地有数据必须用户确认）；保存状态如实提示并可点击重试；`buildPrompt` 移除「可以夸大」矛盾表述；修复 AI 结果页「重新生成 / 调整配置」双双关掉弹窗的死路；颜色「默认（无颜色）」不再被回落成 `note1`；复制笔记跨天时日期跟随开始时间 |
| `index.html` | 移除 `.note-card` 上残留的 `touch-none`（手机上无法滚动列表）；更新模型选项 |
| 测试 | 新增 `test/`（node:test + jsdom），33 个用例 |

### 11.6 v2.2.0 主要变更（桌面端）

| 模块 | 变更 |
|------|------|
| `electron/main.js` | 新增：窗口、托盘、全局热键、单实例锁、开机自启、IPC、`app://` 协议、自检与调试开关 |
| `electron/preload.cjs` | 新增：`contextBridge` 暴露 `window.rfnoter` |
| `electron/store.js` | 新增：本地文件读写（原子写 + `userId` 白名单 + 旧数据迁移） |
| `api.js` | 变为存储适配层：桌面端走 IPC、网页端走 `/api`，对 `app.js` 透明 |
| `app.js` | 仅新增 `initDesktopBridge()`（热键回调聚焦输入框），业务逻辑零改动 |
| `index.html` | 引用改为本地 `vendor/`，CSP 收紧；新增 `#sync-status` 徽标 |
| `package.json` | `main` 指向 `electron/main.js`；新增 `app` / `app:selftest` 脚本；新增 devDependency `electron` |
| 依赖 | 删除死文件 `public/css/style.css`；新增 `public/vendor/`（Tailwind 3.4.16 + Font Awesome 4.7，约 640KB） |
| 测试 | 新增 `electron-store.test.js`（12）与 `app.desktop.test.js`（7），共 52 个用例 |

**Windows 特有的三个坑（都已修复，勿回退）**：

1. `ELECTRON_RUN_AS_NODE` 被继承时，`electron.exe` 会退化成纯 Node 并报
   `does not provide an export named 'BrowserWindow'`。清除时**只能用 Remove，不能置空**——
   Electron 判断的是变量**是否存在**，置空等于又把它创建回来。
2. `RFNOTER.vbs` **必须保持纯 ASCII**：VBScript 按系统 ANSI 解析，UTF-8 中文会吃掉字符串
   的结束引号，报「未结束的字符串常量」。
3. 启动器里**不能用窗口样式 0**（`SW_HIDE`）：BrowserWindow 会继承隐藏状态，
   表现为「进程活着但看不见窗口」。用样式 1。

### 11.7 v2.2.1 主要变更（体验修复）

用户实测反馈的问题，全部已加回归测试（`test/app.smoke.test.js` 末尾的「回归：…」用例）。

| 问题 | 根因 | 修复 |
|------|------|------|
| 新建笔记后看不到，必须刷新才回到顶部 | `renderNoteElement` 把新笔记插到了分组**最后一条之后**（注释写的是"最前面"，代码却用了 `lastNoteInGroup.after()`） | 改为 `dateGroupElement.after(noteElement)`；同一天内本就是 createdAt 倒序，插在标题正下方即最前 |
| 往折叠分组里加笔记等于"隐身" | 只按 `isToday` 判断是否 `hidden`，没考虑分组被手动折叠 | 插入前若分组处于 `collapsed`，先 `setDateGroupCollapsed(group, false)` 展开 |
| 选择模式进去后退不出来 | `toggleSelectionMode` 在选中 0 条时 `alert` 后直接 `return`，**走不到退出分支** | 选中 0 条时该按钮即"取消"；按钮文案随之变为「退出选择模式」；提示条的 × 也改为退出选择模式 |
| 编辑/改色/复制后滚动位置被弹回顶部 | `renderNotes()` 开头 `innerHTML = ''` 全量重建 | 重建前后记住并恢复 `window.scrollY` |
| 右键菜单靠窗口右下角会被截断 | 直接按 `clientX/clientY` 定位，没有夹回可视区 | 先显示再量 `getBoundingClientRect()`，按窗口尺寸夹回（留 8px 边距） |
| 「生成总结」连点会重复调用 API（重复扣费） | 没有并发保护 | 新增 `summaryInFlight` 标记 + `setSummaryBusy()` 禁用相关按钮，`finally` 中恢复 |
| 桌面端提示"未同步到**服务器**" | 提示语写死了服务器概念，桌面端根本没有服务器 | 新增 `STORE_LABEL`（桌面端="本地文件"，网页端="服务器"），所有提示语统一走它 |
| 左上角还是 FA 图标 + "快速笔记" | 硬编码 | 换成本地 `public/icon.png`，名字统一为「闪录」；页面标题、窗口标题、托盘提示与菜单、NSIS 快捷方式名一并改 |
| 窗口默认 1180×840 在 1280×800 屏幕上超出工作区 | 固定尺寸 | 启动时按 `screen.getPrimaryDisplay().workArea` 夹取；并记住用户调整后的尺寸/位置（`window-state.json`），换显示器后越界的位置会被丢弃 |
| `scrollIntoView` 不存在时会打断整个新增流程 | 未做保护 | 单独 `try` 包住；滚动失败不影响"笔记已加成功" |

同时清理：删除从未被引用的 `#selection-hint`（文案还在讲 Ctrl/Shift/拖拽等已移除的功能）。

### 11.8 v2.3.0 主要变更（高频录入闭环 + 渲染可扩展性）

起因是对 1133 条真实笔记做了一次使用分析，结论与产品原本的假设不同：

| 分析结论 | 数值 |
|----------|------|
| 本质是**全天候时间日志**，不是笔记应用 | 平均 11.7 条/天、覆盖 14.5 小时/天、92/97 天有记录、99.6% 当天实时记录 |
| **40.5% 的标题是重复输入的** | CS×146、B站×90、30图小河道表水×21……674 个不同标题撑起 1133 条 |
| 标签形同虚设 | 仅 7.2% 的笔记用过标签（70 个标签大多只用 1 次） |
| 颜色标记形同虚设 | 仅 2.0% 非默认色 |
| AI 总结是低频功能 | 7 次 / 14 周 = 0.51 次/周 |
| 渲染在逼近悬崖 | 1133 条 → 24,812 个 DOM 节点（折叠分组的卡片`也全生成了） |

据此做的三件事：

| 变更 | 说明 |
|------|------|
| **常用条目快捷条** | 新增 `#quick-picks`，从历史笔记现算高频标题（`computeQuickPicks()`：次数 ≥ 2、频率为主、最近 7 天加权）。单击填入、双击直接提交。**不新增存储、零迁移** |
| **时间接续与补记空档** | 新增 `getTodayLastEnd()` 从数据推导上一条结束时间（此前只靠内存里的 `lastEndTime`，重启即失效）；`updateQuickContinuity()` 渲染「上一条 22:30 结束 · 空档 40分钟」；`fillGapToNow()` 一键把起止时间铺满空档 |
| **折叠分组惰性渲染** | 新增 `lazyGroupNotes` Map：默认折叠的分组不再生成卡片 DOM，`flushLazyGroup()` 在展开时补上。**DOM 节点 24,812 → 1,391（-94%），jsdom 初始化 1982ms → 219ms** |

惰性渲染牵动了三处"靠 DOM 反推数据"的旧实现，都已改成以 `notes` 为准：

1. `updateDateGroupCount()` 原来数 DOM 兄弟节点 → 改为按 `date` 从 `notes` 统计
2. `bindDateGroupSelectionEvents()` 原来从 DOM 收集本组笔记 id（折叠组会收到空数组）→ 改为 `notes.filter(...)`
3. `createDateGroupElement()` 里日期标题的点击是内联实现、绕过 `setDateGroupCollapsed` → 已统一，否则"展开一个折叠日期是空的"

其余：`removeNoteElement(noteId, date)` 增加日期参数（折叠组里没有卡片节点，靠 DOM 找不到）；`scrollIntoView` 用 try 包住，避免滚动失败打断新增流程。

### 11.9 v2.4.0 主要变更（导出格式、时间微调、错误日志、CI）

| 变更 | 说明 |
|------|------|
| **导出格式** | 新增 `public/js/exporters.js`：`notesToJson` / `notesToMarkdown` / `notesToCsv` / `exportFilename` / `mimeFor`，全是纯函数（不碰 DOM、不持状态），可以直接单测，也不受 ESM 模块缓存影响。CSV 带 **UTF-8 BOM + CRLF**（否则 Excel 打开中文乱码），字段按 RFC 4180 转义 |
| **导出入口** | `#export-btn` 改为弹格式菜单（`#export-menu`，fixed 定位并按窗口夹回，与右键菜单同一手法），选完才真正导出 |
| **时间微调** | `.time-step-btn`（±5 分钟，只作用于结束时间）+「现在」按钮 + 两个时间输入的 `Alt+↑/↓`。`setTimeInputTo` / `stepTimeInput` 统一走 `minutesToClock`（自带 24 小时取模，23:58 + 5 → 00:03） |
| **错误日志** | 新增 `electron/logger.js`：`createLogger(dir)` 返回带滚动的文件日志（512KB × 3 份）。主进程装 `uncaughtException` / `unhandledRejection`；`createWindow` 里接 `console-message`（error 级）/ `did-fail-load` / `render-process-gone` / `unresponsive`；IPC 读写失败也记一笔。日志目录建不出来时静默降级为只写 stdout——**日志本身不能变成故障源** |
| **日志入口** | 托盘菜单新增「打开日志目录」；`app:info` 增加 `logsDir`；preload 暴露 `openLogDir` |
| **CI** | `.github/workflows/ci.yml`：`test`（Node 20/24 矩阵，验证 `engines: >=20.11` 的声明）、`selftest`（真实 Electron 跑自检）、`package`（仅 tag 或手动触发，产物上传为 artifact）。目标平台是 Windows，所以三个 job 都跑 `windows-latest`，避免平台差异带来的假信号 |

**踩到的坑（勿回退）**：

1. `Blob.prototype.text()` 按 WHATWG 规范会**吞掉开头的 BOM**，所以"CSV 到底有没有 BOM"只能验字节（`arrayBuffer()` 前三字节是否为 `EF BB BF`）；用 `startsWith('\uFEFF')` 一定失败。
2. jsdom 测试环境必须注入 `globalThis.Event = window.Event`：app.js 里的 `new Event(...)` 否则拿到的是 Node 的 `Event`，jsdom 的 `dispatchEvent` 会拒绝（`parameter 1 is not of type 'Event'`）。
3. 桌面端测试的假数据日期要用「今天」：非今天的分组默认折叠、卡片是惰性渲染的，断言 `.note-card` 数量会得到 0。

### 11.10 扩展预留接口

| 预留点 | 说明 |
|--------|------|
| `Ctrl + 点击` / `Shift + 点击` | 多选逻辑预留，当前未实现 |
| 拖放功能 | 已完全禁用 |
| IndexedDB | 当前使用文件系统 + localStorage，可预留迁移接口 |
| 独立快速捕捉小窗 | 当前热键是「呼出主窗口 + 聚焦输入框」，可改为无边框悬浮窗 |
| 自动更新 | 未接入 electron-updater |

---

> 📄 本文档版本：v2.4.0
> 最后更新：2026-10-06
