# RFNOTER - Real Fast Noter

一个轻量级、快速的笔记应用，支持 AI 总结功能。

## 功能特性

- 快速添加时间戳笔记（自动接续上一条的结束时间）
- 按日期分组管理笔记，今日默认展开，新增/删除走增量渲染
- 笔记编辑、删除、复制、颜色标记
- 批量选择 + AI 智能总结（DeepSeek API）
- JSON 一键导出 / 导入（支持合并或替换）
- 响应式设计，支持移动端
- 服务端 JSON 文件持久化 + 本地离线副本

## 技术栈

- 后端：Node.js (>= 20.11) + Express，ESM
- 前端：HTML + Tailwind CSS (Play CDN) + 原生 JavaScript (ES Modules)
- 数据存储：服务端 JSON 文件为唯一真源，localStorage 作为离线副本

## 快速开始

```bash
# 安装依赖
npm install

# 启动服务器
npm start

# 访问 http://localhost:3000

# 运行测试
npm test
```

可选环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 监听端口，被占用时自动向后尝试 |
| `HOST` | `0.0.0.0` | 监听地址；只想本机访问可设为 `127.0.0.1` |
| `RFNOTER_DATA_DIR` | `./data` | 数据目录 |
| `RFNOTER_MAX_BODY` | `5mb` | 单次保存请求的体积上限 |

> 服务默认监听所有网卡（方便手机访问），且接口没有鉴权。请勿在不可信的局域网中运行。

## 数据模型与同步策略

每条笔记：

```jsonc
{
  "id": "uuid",              // 只允许字母/数字/下划线/连字符
  "date": "2026-05-14",      // 本地时区的 YYYY-MM-DD
  "timeStart": "09:00",
  "timeEnd": "09:40",        // 允许跨天（结束时间早于开始时间）
  "content": "标题",
  "tag": "标签",             // 上限 20 个单位，一个汉字算 2 个
  "color": "note1",          // note1..note5 / "ai" / ""（默认无颜色）
  "details": "详细信息",
  "expanded": false,         // 界面状态，只写本地
  "createdAt": 1715000000000,
  "updatedAt": 1715000000000
}
```

localStorage 键名：

| 键名 | 说明 |
| --- | --- |
| `userId` | 用户标识（`UUID-时间戳`） |
| `notes_${userId}` | 笔记的本地副本 |
| `notes_${userId}_pending` | 存在未同步改动时的标记 |
| `notes_${userId}_backup_*` | 覆盖本地副本前自动留下的备份（最多 3 份） |

同步规则（`public/js/api.js`）：

1. 服务端请求失败 → 使用本地副本，顶部显示「离线模式 · 数据仅保存在本机」。
2. 本地存在未同步改动（`_pending` 标记）→ 以本地为准，并尝试推送到服务端。
3. 服务端为空而本地有数据 → **弹窗询问是否导入**，绝不静默覆盖；选择不导入时会先自动备份本地副本。
4. 其余情况 → 以服务端数据为准。

保存时先写本地再写服务端；服务端失败会显示「未同步到服务器，点击重试」，不会再假装成功。

API 密钥自 v1.2.0 起只存在内存中（`memoryApiKey`），刷新页面后需要重新输入。

## 项目结构

```
RFNOTER/
├── server.js                    # Express 服务器（createApp / startServer）
├── package.json                 # 项目配置
├── public/                      # 静态资源
│   ├── index.html               # 主页面（含 Tailwind 内联样式层与 CSP）
│   ├── flash-noter-tutorial.md  # 应用内「帮助」加载的教程
│   ├── js/
│   │   ├── app.js               # 主应用逻辑
│   │   ├── utils.js             # 纯函数工具（日期/转义/净化/Markdown）
│   │   └── api.js               # 同步层 + DeepSeek 调用
│   └── tailwind.config.js       # Tailwind 配置
├── test/                        # node:test 测试
│   ├── utils.test.js            # 纯函数
│   ├── server.test.js           # 路由 / 路径穿越 / 体积上限回归
│   └── app.smoke.test.js        # jsdom 交互冒烟测试
├── RFNOTER-开发规范与API文档.md   # 详细设计与 API 规范
├── RFNOTER-用户操作手册.md        # 面向使用者的说明
├── data/                        # 数据存储目录（gitignore）
└── README.md
```

## 安全说明

- `userId` 走白名单校验（`[A-Za-z0-9_-]{1,128}`），防止目录穿越。
- 数据文件采用「写临时文件 + rename」的原子写入，避免写一半导致文件损坏。
- 笔记内容渲染前统一 `escapeHTML`；AI 输出按 Markdown 白名单渲染，HTML 格式走标签/属性白名单净化。
- 页面配置了 CSP；DeepSeek 密钥仅存在于当前页面内存。

## 已知待办

- 前端仍使用 Tailwind Play CDN，断网首次打开会没有样式；后续可改为构建期产出 CSS。
- 服务端接口没有鉴权，多设备并发写入仍是「后写覆盖先写」。
- 导入导出为全量覆盖式，暂无按时间段导出。

## License

MIT
