# Ctx Archive — append-only 上下文记录器

把 VS Code Copilot Chat(内置 agent)的**聊天记录 + agent 操作**(工具调用、文件编辑)以
append-only 方式归档,设计对齐 DeepSeek Harness 的会话持久化机制(事件溯源 + 只追加日志)。
作为VSCode插件运行

## 目前已知问题  

1.时间总轴对齐问题
2.各个对话时间显示问题
3.对话块概览显示异常（未去除系统环境参数

## 工作原理

VS Code 自身会把每个 Chat 会话以 append-only OT 日志写入:

```
%APPDATA%\Code\User\workspaceStorage\<工作区>\chatSessions\<会话id>.jsonl
```

(kind0 初始快照 + kind1 增量 patch + kind2 完整值快照,只追加、不覆盖)

本插件跟踪这些文件(记住每个文件的字节偏移,只处理新增字节),重放后提取事件,
转写为自有归档(默认 `E:\Code\Agent\ctx-archive\<会话id>.jsonl`):

- 首行 `header`(会话 id、标题、模型、来源、归档时间)
- 之后每行一个事件,`seq` 连续递增:`user` / `assistant` / `tool` / `edit` / `thinking` / `note`
- **已提交行永不重写**;每批追加后 `fsync`;读取时跳过末尾撕裂行(崩溃安全)

## 使用

1. 构建:`npm install && npm run compile`
2. 按 `F5` 启动扩展开发宿主(Extension Development Host)
3. 正常使用 Copilot Chat —— 会话自动被记录

### 图形回溯面板

命令面板运行 `Ctx Archive: 打开图形回溯面板`(或点击状态栏 `$(history) 回溯`),
打开图形化界面:

- 左侧:归档会话列表(按标题 / ID 搜索)
- 主区:事件时间轴视图 —— 每条事件带时间戳与类型徽章(输入 / 助手 / 工具 / 结果 / 编辑 / 思考 / 注释)
- 概览折叠:各对话块默认仅显示内容概览(工具调用隐藏指令参数);点击块展开完整内容,分四个区块:
  - **概述**:完整描述文本与状态(工具 / 退出码 / 耗时)
  - **预览**:格式化视图(气泡 / 卡片 / 可展开指令与明细)
  - **原始内容**:事件完整 JSON
  - **来源**:事件溯源信息(类型 / seq / 请求 / 时间 / 工具 / 会话 / 归档文件 / 原始来源 / 模型)
- 统计条:会话时长 · 轮次数 · 工具调用数 · 结果条数 · 事件总数
- 工具栏:开启/暂停记录、导出 Markdown、刷新
- 底部:向当前会话追加注释

> 注:工具返回结果随新归档格式记录;更早归档的会话可能只有调用描述。
> 可通过面板工具栏「重建归档」或命令 `Ctx Archive: 重建归档(提取工具结果)`
> 从原始会话数据重新生成全部归档(保留手动注释,旧文件备份为 `.bak`)。

### 状态栏按钮(常驻入口)

窗口左下角状态栏有两个按钮:

- `● 记录中 / ○ 已暂停` 记录开关,点击切换
- `$(history) 回溯` 一键打开图形回溯面板

> 注:曾尝试通过 VS Code `chat/input/status` 菜单把按钮放入聊天输入框,
> 但在 VS Code 1.139.1 上该菜单渲染出的按钮点击不触发命令(官方兼容性问题),
> 故改用状态栏作为可靠入口;快捷键 `Ctrl+Alt+H` 与聊天 `@ctxlog` 同样可用。

### 聊天界面集成(`@ctxlog`)

| 输入 | 效果 |
|------|------|
| `@ctxlog /on` `/off` | 开启/暂停记录 |
| `@ctxlog /status` | 查看记录状态 |
| `@ctxlog /list` | 列出归档会话(带"图形回溯"与"导出"按钮) |
| `@ctxlog /replay 编号` | 在聊天中回溯(支持编号 / 标题关键词 / 会话 ID) |
| `@ctxlog 内容` | 追加一条注释到当前会话归档 |

### 命令

| 命令 | 说明 |
|------|------|
| `Ctx Archive: 打开图形回溯面板` | 图形化会话浏览与回溯 |
| `Ctx Archive: 列出已归档会话` | QuickPick 列表(图形回溯 / 导出 Markdown / 打开原始 JSONL) |
| `Ctx Archive: 导出会话为 Markdown` | 派生 Markdown 视图(`exports/*.md`) |
| `Ctx Archive: 打开归档目录` | 在资源管理器打开归档目录 |
| `Ctx Archive: 开启/暂停记录` | 全局开关 |

## 配置(`settings.json`)

| 键 | 默认 | 说明 |
|----|------|------|
| `ctxArchive.outputDir` | `E:\Code\Agent\ctx-archive` | 归档输出目录 |
| `ctxArchive.recordingEnabled` | `true` | 是否自动记录 |
| `ctxArchive.pollIntervalMs` | `5000` | 轮询 chatSessions 的间隔 |

## 已知限制

- 数据源 `chatSessions/*.jsonl` 是 VS Code 内部文件,格式无兼容承诺;解析失败的行会被
  跳过不丢数据,但新版 VS Code 若改变格式,插件可能需要适配。
- 快照去重按"同一请求的响应条目数"近似进行;极端情况下若 VS Code 重写快照列表可能产生
  少量重复条目。
- 归档永不删除(append-only 精神),需要清理时请手动操作归档目录。

## 安全

- 插件**零运行时依赖**:只使用 Node 内置模块 + vscode API。
- devDependencies(typescript / @types/*)仅本地编译用,不打包进 .vsix,安装时建议
  `npm install --ignore-scripts`。
