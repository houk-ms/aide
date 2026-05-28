# Hermes Agent Memory System 调研

## 核心发现

内置 Memory 极简——两个 Markdown 文件直接冻结进 system prompt。Agent 通过 `memory` tool 实时写入（add/replace/remove），容量硬限（2200+1375 字符），agent 自己负责管理空间。

## 存储

- `~/.hermes/memories/MEMORY.md` — agent 笔记（环境、惯例、经验），2200 字符上限
- `~/.hermes/memories/USER.md` — 用户档案（姓名、角色、偏好、风格），1375 字符上限
- 条目用 `§` 分隔
- 原子写入（tempfile + fsync + rename）

## 写入机制（关键！）

### Tool Schema 要点

Agent 有一个 `memory` tool，参数：
- `action`: add | replace | remove
- `target`: memory | user
- `content`: 新内容
- `old_text`: 子串匹配定位要替换/删除的条目

### 什么时候记

**完全由 LLM 决定**，system prompt 里注入了详细指导（MEMORY_GUIDANCE）：

**该记的：**
- 用户纠正你的时候（最高优先）
- 用户偏好、习惯、个人信息
- 环境事实（OS、工具、项目结构）
- 稳定惯例、API 特性、工作流

**不该记的：**
- 任务进度、session 结果、完成日志
- PR 号、commit SHA、"修了 bug X"
- 7 天内会过期的任何事实
- 临时 TODO 状态

### 记忆格式指导

写成**陈述性事实**，不是指令：
- ✓ "User prefers concise responses"
- ✗ "Always respond concisely"
- ✓ "Project uses pytest with xdist"
- ✗ "Run tests with pytest -n 4"

原因：指令式写法在后续 session 会被当作 directive，可能覆盖用户当前请求。

### replace 的工作方式

`old_text` 是**子串定位**（Python `in` 操作），找到包含该子串的条目，用 `content` **整体替换**该条目。不是替换条目内的局部文本。

### 容量管理

没有自动清理。当文件满时（add 超出字符限制），返回错误并展示所有现有条目，**让 agent 自己决定合并或删除旧条目**。

## 加载到 Context

- Session 启动时冻结进 system prompt（全量注入）
- 显示使用率百分比（如 `[67% — 1,474/2,200 chars]`），让 agent 感知容量
- **Session 内不更新** system prompt（保护 KV cache）
- Context 压缩发生时会重新加载

## 外部 Provider（插件层）

当需要更强记忆能力时：
- `sync_turn()` — 每轮对话后
- `on_session_end()` — 对话结束时
- `on_pre_compress()` — context 压缩前
- `prefetch()` — 每次 API 调用前

Holographic provider（SQLite + FTS5 + HRR 向量）注入方式：包裹在 `<memory-context>` fence 中插入 user message（不是 system prompt）。

## 安全扫描

所有写入内容经过 prompt injection 检测（正则匹配 + 不可见 Unicode 检测），拒绝可疑内容。

## 关键设计启发

1. **LLM 自主管理** — 不是系统自动记，是 agent 自己决定记什么、什么时候合并
2. **容量硬限 + 使用率展示** — 迫使 agent 精简，自然产生"只记最重要的"行为
3. **陈述性事实 > 指令** — 避免记忆变成对未来 session 的"隐性命令"
4. **7 天过期规则** — 简单但有效的过滤标准
5. **原子写入** — 防止并发/崩溃导致数据损坏
6. **冻结 system prompt** — 性能优化（KV cache），但代价是 session 内的新记忆不立即生效
