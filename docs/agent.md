# Agent

Agent 引擎设计。基于 Copilot SDK 构建。

## SDK 已提供（不重复建设）

- 推理循环（接收 → 理解 → 规划 → 执行 → 反馈）
- 工具编排（Tool orchestration）
- Session 持久化与恢复
- 多轮对话与 context window 自动压缩
- Session 内对话历史管理

## 我们在 SDK 之上构建什么

### 1. System Prompt 组装

Agent 的 system prompt 是动态拼装的，不是静态字符串：

```
[固定] 角色定义 + 行为准则
[动态] L0 Identity（从 Memory 加载，每次注入）
[动态] 当前 Task 上下文（如果有活跃 Task）
[动态] 相关 Project 摘要
[动态] 相关 Relation 信息
```

**Token 预算**：System prompt 总预算 ~4K tokens。固定部分 ~1K，L0 Identity ~2K（8K chars ≈ 2K tokens），动态上下文 ~1K。剩余全部留给对话。

### 2. 上下文注入策略

处理一个 Task 时，通过 SDK 的 `onSessionStart` hook 注入：
- Task 本身的元数据和来源信息
- 关联 Project 的相关文档/代码片段
- 关联 Relation 的人物信息
- L1 Knowledge 检索结果（基于 Task 内容做相似度检索）

**截断优先级**（超出预算时从底部砍）：Task 元数据 > Relation > Project 摘要 > L1 检索结果。Task 自身信息永远保留完整。

### 3. Custom Tools 定义

Agent 通过 SDK 的 Custom Tools 机制获得操作能力：

**MCP Server Tools（外部系统）：**

| Tool | 作用 | 来源 |
|------|------|------|
| `ask_work_iq` | 自然语言查询 M365 数据 | Work IQ |
| `fetch_work_iq` | 结构化读取实体 | Work IQ |
| `create_entity_work_iq` | 创建实体（发邮件、建事件等） | Work IQ |
| `update_entity_work_iq` | 更新实体 | Work IQ |
| `do_action_work_iq` | 执行操作（接受会议等） | Work IQ |
| `delete_entity_work_iq` | 删除实体 | Work IQ |
| GitHub tools | Issues, PRs, Repos 操作 | GitHub MCP |

**内部 Tools（本地模块）：**

| Tool | 作用 | 对应子系统 |
|------|------|-----------|
| `memory_write` | 写入记忆（add/update/remove） | Memory |
| `memory_search` | 检索历史记忆 | Memory |
| `create_task` | 创建新任务 | Task |
| `update_task` | 更新任务状态 | Task |
| `query_tasks` | 查询任务列表 | Task |
| `generate_report` | 生成日报/周报 | Report |

**设计问题**：
- Tool 列表是固定注入还是按 Task 类型动态选择？（token 成本考虑）
- 写操作的确认机制：哪些 Tool 调用需要用户确认？通过 SDK 的 `onPermissionRequest` 实现

### 3.5 Skill 加载（可扩展能力）

除了内置 Custom Tools，Agent 还通过 SDK 原生的 Skill 机制获得可扩展能力：

- 创建 session 时设置 `skillDirectories`（指向 `~/.aide/skills/` 等），SDK 自动扫描 `SKILL.md`
- 启动时只加载 Skill 的 `name + description`，按需在匹配时注入正文（`skill.invoked` 事件）
- Skill 可声明 `allowed_tools`、自带本地 tool、依赖 MCP server

这让「加一个新能力」从「改代码」变成「装一个 Skill / 配一个 MCP」。详见 docs/skill.md。

### 4. 自主级别控制

通过 SDK 的 permission 系统实现分级自主：

| 级别 | 行为 | 示例 |
|------|------|------|
| 自动 | 直接执行，不问 | 读取邮件、检索信息、更新任务状态 |
| 通知 | 执行后告知 | 存储记忆、创建低优先级任务 |
| 确认 | 执行前问 | 发邮件、发消息、修改代码、删除任务 |

**默认规则**：硬编码在代码中（读操作=自动，记忆=通知，写操作=确认）。MVP 不做用户自定义。Post-MVP 在 Settings > Preferences 中开放配置。

### 5. Session 与 Task 的关系

- 一个 Task 可能跨多个 Session 处理（中断后恢复）
- 用 SDK 的 `sessionId` 关联：`task-{taskId}-{attemptNumber}`
- Session 结束时通过 `onSessionEnd` hook 提取要写入 Memory 的内容

**Session 恢复策略**：始终尝试 `resumeSession()`。SDK 自动恢复完整对话历史。如果 session 已损坏（极少数情况），新建 session 并从 L2 Archive 注入上次 session 摘要。
