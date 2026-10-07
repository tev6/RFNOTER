# RFNOTER 数据格式说明

写给想直接读数据、或者自己写脚本分析的人。**不需要改这个项目的一行代码**。

---

## 1. 数据存在哪

| 形态 | 位置 |
| --- | --- |
| 桌面端 | `%APPDATA%\rfnoter\data\notes_<userId>.json` |
| 网页端 | 项目目录下的 `data/notes_<userId>.json`（可用 `RFNOTER_DATA_DIR` 改） |
| 浏览器副本 | localStorage 键 `notes_<userId>`，另有 `notes_<userId>_pending` 标记未落盘 |
| 日志（桌面端） | `%APPDATA%\rfnoter\logs\main.log` |

`<userId>` 是首次打开时生成的 UUID。同一个目录下可以有多个 `notes_*.json`（多用户），
桌面端启动时会**沿用已存在文件里的 userId**，不会新建。

> 桌面端还有一个 `window-state.json`（窗口尺寸与位置），与笔记无关，删掉只会重置窗口大小。

## 2. 文件结构

整个笔记文件就是**一个 JSON 数组**，没有外层包装：

```jsonc
[
  {
    "id": "0c945035-e430-41bf-80e1-eec2f33c95c0", // UUID，只含字母/数字/下划线/连字符
    "date": "2026-07-12",       // 本地时区的 YYYY-MM-DD
    "timeStart": "09:20",       // HH:MM，24 小时制
    "timeEnd": "10:40",         // 允许跨天：结束时间早于开始时间表示次日
    "content": "CS",            // 标题，必填
    "tag": "",                  // 可选，最多 20 个单位（一个汉字算 2）
    "color": "note1",           // '' | note1..note5 | ai
    "details": "",              // 可选，纯文本（可含换行）
    "expanded": false,          // 界面上是否展开了详情（纯 UI 状态）
    "createdAt": 1783823902657, // 毫秒时间戳
    "updatedAt": 1783823902657
  }
]
```

**写入是原子的**：先写 `notes_xxx.json.tmp` 再 rename，所以不会读到写了一半的文件。
看到 `.tmp` 残留说明进程被强杀，可以安全删除。

### 关于 `color`

| 值 | 颜色 | 用途 |
| --- | --- | --- |
| `""` | 无（默认蓝） | 默认值，**不等于** `note1` |
| `note1` | 蓝 | |
| `note2` | 绿 | |
| `note3` | 橙 | |
| `note4` | 红 | |
| `note5` | 紫 | |
| `ai` | 紫 | AI 总结保存成的笔记 |

### 关于跨天

`timeStart: "23:10"` + `timeEnd: "00:20"` 表示从前一天 23:10 到次日 00:20，
时长按 **70 分钟**算（而不是负数）。`date` 记的是**开始时间所在的那一天**。

---

## 3. 导出格式

界面上「导出」提供三种，都可以从文件系统直接拿到：

| 格式 | 文件名 | 特点 |
| --- | --- | --- |
| JSON | `rfnoter-backup-YYYY-MM-DD.json` | 无损，带 `version`/`exportTime`/`noteCount` 包装，可再导入 |
| Markdown | `rfnoter-notes-YYYY-MM-DD.md` | 按日期分节，包含时长、标签、详情 |
| CSV | `rfnoter-notes-YYYY-MM-DD.csv` | UTF-8 **带 BOM**、CRLF，Excel 直接打开不乱码 |

CSV 的列固定为：

```text
日期,星期,开始,结束,时长(分钟),标题,标签,颜色,详情,记录时间
```

时长由起止时间算出（跨天按绕圈计算）；`记录时间` 是 `createdAt` 的本地可读形式。

---

## 4. 自己写脚本分析

### Node.js：算时长排行

```js
import fs from 'node:fs';
import path from 'node:path';

const dir = path.join(process.env.APPDATA, 'rfnoter', 'data');
const file = fs.readdirSync(dir).find((f) => f.startsWith('notes_') && f.endsWith('.json'));
const notes = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));

const minutes = (clock) => {
    const [h, m] = clock.split(':').map(Number);
    return h * 60 + m;
};
const duration = (note) => {
    const start = minutes(note.timeStart);
    const end = minutes(note.timeEnd);
    return end >= start ? end - start : end + 1440 - start;  // 跨天
};

const byTitle = new Map();
for (const note of notes) {
    byTitle.set(note.content, (byTitle.get(note.content) || 0) + duration(note));
}
console.table(
    [...byTitle.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([title, mins]) => ({ 标题: title, 小时: +(mins / 60).toFixed(1) }))
);
```

### 现成的分析脚本

仓库里有一个只读的分析脚本，输出复用率、每天覆盖时长、断档、标签/颜色使用率等：

```bash
node scripts/analyze-usage.mjs          # 桌面端数据目录
node scripts/analyze-usage.mjs ./data   # 网页端数据目录
```

### 用 Excel / pandas 分析

导出 CSV 后直接用：

```python
import pandas as pd
df = pd.read_csv('rfnoter-notes-2026-10-06.csv', encoding='utf-8-sig')  # 注意 -sig
print(df.groupby('标题')['时长(分钟)'].sum().sort_values(ascending=False).head(20))
```

> `encoding='utf-8-sig'` 是为了吃掉 BOM；用 `utf-8` 会让第一列列名变成 `\ufeff日期`。

---

## 5. 边界与约定

| 情况 | 行为 |
| --- | --- |
| 文件不存在 | 视为空列表，不报错 |
| 文件损坏（非法 JSON） | 返回错误而不是抛异常；界面提示读取失败并回退到 localStorage 副本 |
| `timeStart`/`timeEnd` 非法 | `null`，时长按 0 处理 |
| 时长为 0 | 合法（例如"洗澡"随手记），统计时会体现为 0 分钟 |
| 标题里的 `+` | **没有特殊含义**，就是普通字符（用来表示"同时做多件事"是使用习惯） |
| 手动编辑文件 | 可以，但请保证仍是合法 JSON 数组；程序写回时只认自己认识的字段 |

## 6. 想直接改数据？

1. **先备份**：复制一份 `notes_*.json`（程序也在自动备份，见第 7 节）
2. 关闭应用（托盘菜单 →「退出闪录」），否则内存里的数据会把你的改动覆盖掉
3. 改完再打开

程序不做格式迁移，也不写版本号到数据文件里——**字段只增不改**是目前的兼容策略。

## 7. 自动备份

程序会把当前数据原样复制到 `<数据目录>/backups/`，文件名形如：

```
notes_3f2a-1759000000000-20261007-135842.json
        └ userId ────────┘ └─ 年月日-时分秒 ─┘
```

**什么时候备份**

| 时机 | 说明 |
| --- | --- |
| 每次启动 | 打开应用时先留一份"打开之前的样子" |
| 每次写入后 | 但同一份数据**最多每小时一次**，不会把磁盘塞满 |
| 笔记数腰斩时 | 批量删除、导入时选「替换」之前**强制**留一份，不受限流约束 |

**保留多少**

保留**最近 24 份** + **最近 30 天每天一份**，其余自动删除。
双层是刻意的：只按份数留，隔几天就只剩最后几十次保存的粒度；只按天留，今天误删了找不回来。

**怎么恢复**

1. 托盘菜单 →「打开备份目录」
2. 按文件名里的时间挑一份，复制出来
3. 关掉应用，把它改名成 `notes_<你的userId>.json` 覆盖回上一级目录（原文件先挪走）
4. 重新打开

> `userId` 就是主文件名 `notes_xxxx.json` 里的 `xxxx`（通常是 `3f2a-1759000000000` 这种）。
> 备份是原样复制，所以恢复不需要任何转换。

**注意**

- 源文件若已损坏，备份下来的那份也是坏的（原样复制），日志里会标注「内容无法解析」——
  这时请往前找更早的那份
- 备份目录就在数据目录里，因此「把整个 data 目录拷到别的盘」等于连备份一起带走了。
  但它仍在同一块磁盘上，**不能替代异地备份**
