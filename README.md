# RFNOTER - Real Fast Noter

一个轻量级、快速的笔记应用，支持 AI 总结功能。**支持桌面端（Electron）和网页端两种用法，共用同一套前端与数据格式。**

## 为什么是「记录过去」

绝大多数同类工具是 TODO：记录**接下来要做什么**。闪录记录的是**刚刚做了什么**。

这不是偏好问题——两者在自我调节里承担不同角色：

- **TODO 是前馈**：设定目标、外化意图，把"该做的事"从脑子里挪出去。
- **时间日志是反馈**：监测实际发生了什么，才能和目标比较、才谈得上调整。

目标设定理论指出，**没有反馈的目标会很快失效**；而"监测进展"这个动作本身，在元分析里被证明能显著提高目标达成率。所以两者不是替代关系——是**缺了另一半**。

另一个更硬的理由：人对"我花了多少时间"的估计是**系统性失准**的（计划谬误），而且知道自己在犯错也改不掉。想估得准，唯一可靠的办法是参照自己过去同类任务实际花了多久——**而那需要一份账本**。

因此这个项目的取舍很明确：

| 取舍 | 原因 |
| --- | --- |
| 只记标题，不做富文本 | 每天要记十几次，任何多余步骤都会让人放弃 |
| 记时间块，不是待办项 | 记录已发生的事实，不是待完成的承诺 |
| 本地文件，不上云 | 这是私人的生活流水，放在自己机器上最省心 |
| 不追求"全面"，追求"能坚持" | 自我追踪类工具的头号死因是记录成本，不是功能不足 |

## 功能特性

- 快速添加时间戳笔记（自动接续上一条的结束时间，**跨重启也有效**）
- **常用条目**：自动列出高频标题，点一下填入、双击直接记录
- **补记空档**：一键把起止时间铺满"上一条结束到现在"的这段空白
- 时间微调：`±5` 与「现在」按钮，`Alt+↑/↓` 微调任意时间输入
- 按日期分组管理笔记，今日默认展开；折叠日期**惰性渲染**（上千条时 DOM 节点减少 90% 以上）
- 笔记编辑、删除、复制、颜色标记
- 批量选择 + AI 智能总结（DeepSeek API）
- 导出 **JSON**（无损，可再导入）/ **Markdown**（给人读）/ **CSV**（给表格与脚本）
- **桌面端：托盘常驻 + 全局热键（默认 `Ctrl+Shift+Space`）直接跳到输入框 + 开机自启**
- 出错时写日志文件（`%APPDATA%\rfnoter\logs\`），托盘菜单可直接打开
- 响应式设计，支持移动端
- JSON 文件持久化 + localStorage 离线副本

## 技术栈

- 桌面端：Electron（通过 preload + IPC 直接读写本地文件，不需要开服务）
- 网页端：Node.js (>= 20.11) + Express，ESM
- 前端：HTML + Tailwind CSS + 原生 JavaScript (ES Modules)，两种模式共用
- 数据存储：JSON 文件为唯一真源，localStorage 作为离线副本

## 快速开始

```bash
npm install          # 安装依赖（会下载 Electron 运行时，约 100MB，仅首次）
```

### 桌面端（推荐）

```bash
npm run app          # 启动桌面应用
npm run app:selftest # 桌面端自检：26 项，含真实页面 + 落盘链路
```

也可以直接用启动器，或者双击桌面上的「RFNOTER 闪录」快捷方式：

- `RFNOTER.vbs` —— 双击即启动，不弹控制台窗口

桌面端行为：

| 项目 | 说明 |
| --- | --- |
| 数据位置 | `%APPDATA%\RFNOTER\data\notes_<userId>.json` |
| 全局热键 | 默认 `Ctrl+Shift+Space`（依次尝试 `Alt+Shift+N`、`Ctrl+Alt+N`，都占用时托盘里会标注） |
| 关闭窗口 | 收进托盘，不退出（否则全局热键就失效了）；真正退出在托盘菜单里 |
| 托盘菜单 | 打开主窗口 / 快速记录 / 开机自动启动 / 打开数据目录 / 退出 |
| 单实例 | 第二次启动只会唤起已有窗口，避免两个进程写同一个文件 |

### 网页端

```bash
npm start            # 启动服务，访问 http://localhost:3000
```

可选环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 监听端口，被占用时自动向后尝试 |
| `HOST` | `0.0.0.0` | 监听地址；只想本机访问可设为 `127.0.0.1` |
| `RFNOTER_DATA_DIR` | `./data` | 数据目录 |
| `RFNOTER_MAX_BODY` | `5mb` | 单次保存请求的体积上限 |

> 网页端默认监听所有网卡（方便手机访问），且接口没有鉴权。请勿在不可信的局域网中运行。桌面端不需要联网、不开端口。

### 测试

```bash
npm test                          # 全部 52 个用例
node --test test/utils.test.js    # 纯函数
node --test test/server.test.js   # 服务端路由 / 路径穿越 / 413 回归
node --test test/app.smoke.test.js    # jsdom 网页端交互
node --test test/app.desktop.test.js  # jsdom 桌面端（IPC）交互
node --test test/electron-store.test.js # 桌面端文件存储
```

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

1. 读写失败 → 使用本地副本，顶部显示「离线模式 · 数据仅保存在本机」。
2. 本地存在未同步改动（`_pending` 标记）→ 以本地为准，并尝试写回真源。
3. 真源为空而本地有数据 → **弹窗询问是否导入**，绝不静默覆盖；选择不导入时会先自动备份本地副本。
4. 其余情况 → 以真源数据为准。

「真源」在桌面端是本地文件（走 IPC），在网页端是服务端文件（走 `/api`）。
保存时先写 localStorage 再写真源；写失败会显示「未同步到服务器，点击重试」，不会再假装成功。

API 密钥自 v1.2.0 起只存在内存中（`memoryApiKey`），刷新页面后需要重新输入。

## 项目结构

```
RFNOTER/
├── electron/                    # 桌面端
│   ├── main.js                  # 主进程：窗口 / 托盘 / 全局热键 / IPC / 自检
│   ├── preload.cjs              # contextBridge 暴露 window.rfnoter
│   ├── store.js                 # 本地文件读写（原子写 + userId 白名单）
│   └── assets/                  # 图标（png / ico）
├── server.js                    # 网页端 Express 服务器（createApp / startServer）
├── RFNOTER.vbs                  # 双击启动器（纯 ASCII，勿加中文）
├── package.json                 # 项目配置
├── public/                      # 静态资源（两种模式共用）
│   ├── index.html               # 主页面（含 Tailwind 内联样式层与 CSP）
│   ├── flash-noter-tutorial.md  # 应用内「帮助」加载的教程
│   ├── vendor/                  # 本地化的 Tailwind 与 Font Awesome（离线可用）
│   ├── js/
│   │   ├── app.js               # 主应用逻辑
│   │   ├── utils.js             # 纯函数工具（日期/转义/净化/Markdown）
│   │   └── api.js               # 存储适配层（桌面 IPC / 网页 HTTP）+ DeepSeek 调用
│   └── tailwind.config.js       # Tailwind 配置
├── test/                        # node:test 测试（52 个用例）
│   ├── utils.test.js            # 纯函数
│   ├── server.test.js           # 路由 / 路径穿越 / 体积上限回归
│   ├── electron-store.test.js   # 桌面端文件存储
│   ├── app.smoke.test.js        # jsdom 网页端交互
│   └── app.desktop.test.js      # jsdom 桌面端（IPC）交互
├── RFNOTER-开发规范与API文档.md   # 详细设计与 API 规范
├── RFNOTER-用户操作手册.md        # 面向使用者的说明
├── data/                        # 网页端数据目录（gitignore）
└── README.md
```

## 安全说明

- `userId` 走白名单校验（`[A-Za-z0-9_-]{1,128}`），防止目录穿越（桌面端与网页端一致）。
- 数据文件采用「写临时文件 + rename」的原子写入，避免写一半导致文件损坏。
- 笔记内容渲染前统一 `escapeHTML`；AI 输出按 Markdown 白名单渲染，HTML 格式走标签/属性白名单净化。
- 页面配置了 CSP；桌面端用 `app://` 协议加载，`'self'` 才真正生效。
- DeepSeek 密钥仅存在于当前页面内存。

## 开发提示

```bash
# 打印窗口/页面布局数据，排查响应式问题
node_modules\electron\dist\electron.exe . --layout-debug

# 让 Electron 自己截自己的窗口（比外部截图工具可靠，不受 DPI 缩放影响）
node_modules\electron\dist\electron.exe . --screenshot=out.png
```

> Windows 上如果在别的 Electron 应用（例如某些 IDE 或本工具的宿主）里启动，
> 环境变量 `ELECTRON_RUN_AS_NODE` 会被继承，导致 `electron.exe` 退化成纯 Node 而报
> `does not provide an export named 'BrowserWindow'`。先 `set ELECTRON_RUN_AS_NODE=` 即可；
> `RFNOTER.vbs` 已经处理了这一点。

## 打包安装包

```powershell
npm test                                  # 全量测试
npm run dist                              # 生成 dist\RFNOTER-Setup-<版本>.exe
```

**本机（中国大陆网络）必须先设镜像**，否则 `electron-builder` 会去 github.com 下载
Electron 与 NSIS，直接超时失败：

```powershell
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
$env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'
npm run dist
```

打包脚本**不会**因为下载失败而报出显眼的错误——务必自己确认产物：

```powershell
(Get-Item 'dist\win-unpacked\RFNOTER.exe').VersionInfo.FileVersion   # 必须是本次版本号
& 'dist\win-unpacked\RFNOTER.exe' --selftest                          # 自检通过数应随版本递增
```

## 已知待办

- 桌面端界面仍是网页版那一套（Tailwind 内联样式层 + 本地 vendor 脚本），没有做构建期 CSS 产物。
- 网页端接口没有鉴权，多设备并发写入仍是「后写覆盖先写」；桌面端因为单实例锁基本不会遇到。
- 导入导出为全量覆盖式，暂无按时间段导出。
- 打包依赖 github.com 的下载（本机不通，靠上面的镜像绕开），没有做离线化的构建缓存预置。

## License

MIT
