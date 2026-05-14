# RFNOTER - Real Fast Noter

一个轻量级、快速的笔记应用，支持 AI 总结功能。

## 功能特性

- 快速添加时间戳笔记
- 按日期分组管理笔记
- 笔记编辑、删除、复制
- 颜色标记分类
- AI 智能总结（支持 DeepSeek API）
- 响应式设计，支持移动端

## 技术栈

- Node.js + Express 后端
- 前端：HTML + Tailwind CSS + 原生 JavaScript (ES Modules)
- 数据存储：本地 JSON 文件 + localStorage 降级

## 快速开始

```bash
# 安装依赖
npm install

# 启动服务器
npm start

# 访问 http://localhost:3000
```

## 项目结构

```
RFNOTER/
├── server.js              # Express 服务器
├── package.json           # 项目配置
├── public/                # 静态资源
│   ├── index.html         # 主页面
│   ├── css/
│   │   └── style.css      # 自定义样式
│   ├── js/
│   │   ├── app.js         # 主应用逻辑
│   │   ├── utils.js       # 工具函数
│   │   └── api.js         # API 接口
│   └── tailwind.config.js # Tailwind 配置
├── data/                  # 数据存储目录
└── README.md
```

## License

MIT
