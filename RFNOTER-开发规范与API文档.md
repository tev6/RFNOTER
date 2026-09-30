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
| 项目名称 | RFNOTER (Real Fast Noter) |
| 当前版本 | v1.2.0 |
| 架构形式 | 模块化（HTML + CSS + JS 分离）+ Node.js 后端 |
| 技术栈 | HTML5 + Tailwind CSS v3 (CDN) + Font Awesome 4.7 + ES6 Modules + Express.js |
| 数据存储 | 服务端文件系统（`data/` 目录）+ localStorage 备份 |
| 外部依赖 | `cdn.tailwindcss.com`、`cdn.jsdelivr.net` (Font Awesome)、`api.deepseek.com` |

### 1.2 架构演进

- **v1.1.x**：单 HTML 文件（约 2500 行），所有代码集成在一个文件中
- **v1.2.0**：模块化拆分：
  - `public/index.html` — 页面结构与样式
  - `public/js/app.js` — 应用主逻辑
  - `public/js/utils.js` — 工具函数
  - `public/js/api.js` — API 调用与数据持久化
  - `server.js` — Express 后端服务

---

## 2. 文件结构

```
RFNOTER/
├── public/
│   ├── index.html              # 主页面
│   ├── tailwind.config.js      # Tailwind 配置
│   ├── css/
│   │   └── style.css           # 自定义样式（如有）
│   └── js/
│       ├── app.js              # 应用主逻辑（~1300 行）
│       ├── utils.js            # 工具函数（~97 行）
│       └── api.js              # API 调用与数据持久化（~98 行）
├── data/                       # 服务端数据目录（运行时创建）
│   └── notes_{userId}.json     # 用户笔记数据文件
├── server.js                   # Express 后端服务
├── package.json                # 项目配置
├── v1.1.2.0.html               # 旧版本单文件（归档）
├── flash-noter-tutorial.md     # 帮助教程
├── RFNOTER-用户操作手册.md      # 用户文档
└── RFNOTER-开发规范与API文档.md  # 本文档
```

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
  mergeMethod: string;    // 固定值 "time"
}

interface ApiConfig {
  model: string;          // 'deepseek-chat' | 'deepseek-coder'
  temperature: number;    // 0.0 ~ 1.0
  maxTokens: number;      // 固定值 2000
}
```

### 3.4 存储键名规范

| 键名 | 位置 | 类型 | 说明 |
|------|------|------|------|
| `userId` | localStorage | string | 用户唯一标识，格式：`UUID-时间戳` |
| `notes_${userId}` | localStorage | string (JSON) | 笔记数组备份 |
| `notes_${userId}.json` | 服务端 `data/` | JSON 文件 | 主数据源 |

> ⚠️ **v1.2.0 变更**：`deepseek_api_key` 已从 localStorage 中移除，改为内存存储。

---

## 4. 全局变量与配置

### 4.1 CONFIG 常量对象

```javascript
const CONFIG = {
    MAX_SELECTION: 100,              // 最大选择笔记数
    API_TIMEOUT: 30000,              // API 调用超时（毫秒）
    DEFAULT_DURATION_MINUTES: 40,    // 默认笔记持续时间
    TAG_LIMIT: 20,                   // 标签最大字符单位
    MAX_CONTENT_LENGTH: 5000,        // 内容最大长度
    MAX_DETAILS_LENGTH: 10000,       // 详情最大长度
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
| `loadNotesFromServer()` | 无 | `Promise<Note[]>` | 从服务端加载笔记，失败回退 localStorage |
| `saveNotesToServer(notes)` | `Note[]` | `Promise<boolean>` | 保存笔记到服务端，同时备份 localStorage |
| `callDeepSeekAPI(apiKey, model, prompt, temperature)` | `string, string, string, number` | `Promise<string>` | 调用 DeepSeek API，带重试和超时 |

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
├── initQuickInput()        # 初始化快速输入区
├── loadNotesFromServer()   # 从服务端加载笔记（失败回退 localStorage）
├── renderNotes()           # 渲染笔记列表
├── bindEventListeners()    # 绑定核心事件
├── bindAIEventListeners()  # 绑定 AI 相关事件
└── initImportExport()      # 初始化导入导出（v1.2.0 新增）
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
<meta http-equiv="Content-Security-Policy" content="
    default-src 'self';
    script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.tailwindcss.com;
    style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net;
    font-src 'self' https://cdn.jsdelivr.net;
    connect-src 'self' https://api.deepseek.com;
    img-src 'self' data:;
">
```

### 10.3 待修复安全问题

| 风险点 | 现状 | 建议 |
|--------|------|------|
| HTML 格式输出 | 仍直接 `innerHTML` 注入 AI 返回内容 | 对 HTML 格式输出添加 DOMPurify 过滤 |
| 外部 CDN | 依赖第三方 CDN 可用性 | 考虑添加 fallback 或本地备份 |
| `generateUUID` | 使用 `Math.random()`，非加密安全 | 使用 `crypto.randomUUID()`（需检查兼容性） |

---

## 11. 开发约束与注意事项

### 11.1 模块化约束

- 使用 ES6 Module (`type="module"`) 导入导出
- `app.js` 依赖 `utils.js` 和 `api.js`
- `api.js` 依赖 `utils.js`（`generateUUID`）
- 服务端 `server.js` 使用 CommonJS（`require`）

### 11.2 数据持久化约束

- 主数据源：服务端文件系统（`data/notes_${userId}.json`）
- 备份：localStorage（`notes_${userId}`）
- API 密钥：仅内存存储，页面刷新后丢失
- 单条数据大小受浏览器 localStorage 限制（通常 5~10 MB）

### 11.3 性能注意事项

- `renderNotes()` 仍为全量渲染，用于初始加载和编辑后重渲染
- `quickAddNote()` 和 `deleteNote()` 使用增量渲染（`renderNoteElement` / `removeNoteElement`）
- 日期分组折叠状态通过 DOM class 切换，不持久化

### 11.4 已知代码异味

| 位置 | 问题 | 说明 |
|------|------|------|
| `buildPrompt` | 「可以夸大」疑似笔误 | 语义上应为「不可以夸大」 |
| `showSummaryResult` | HTML 格式直接注入 | 仍存在 XSS 风险 |
| `generateUUID` | 非加密安全 | 使用 `Math.random()` |

### 11.5 扩展预留接口

| 预留点 | 说明 |
|--------|------|
| `Ctrl + 点击` | 多选逻辑预留，当前未实现 |
| `Shift + 点击` | 区间选择预留，当前未实现 |
| 拖放功能 | 已完全禁用 |
| IndexedDB | 当前使用文件系统 + localStorage，可预留迁移接口 |

---

> 📄 本文档版本：v1.2.0  
> 最后更新：2026-05-16
