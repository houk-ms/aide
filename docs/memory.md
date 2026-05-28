# Memory

记忆子系统设计。

## 设计原则

1. **信息无限增长 vs context window 有限** — 核心矛盾，决定了必须有检索层
2. **部分记忆必须永远在场** — 核心档案每次 session 固定注入，不依赖检索
3. **双通道写入** — agent 主动记 + 系统窄范围补漏，互补覆盖
4. **零 ML 依赖** — 不依赖本地 neural embedding model，用 FTS5 + 结构化标签
5. **用户拥有数据** — 所有记忆可查看、编辑、删除
6. **不重复 SDK 的活** — SDK 管 session 内对话历史和压缩，Memory 管跨 session 持久知识
7. **错误可修正** — 记忆出错时必须有机制发现和修正，不能让错误记忆无限传播

## 分层架构

| 层 | 名称 | 定位 | 加载策略 | 写入方式 | 容量 |
|---|---|---|---|---|---|
| L0 | Identity | 用户核心档案 | session 启动注入 system prompt | agent 主动 + 用户直接编辑 | 8K chars 硬限 |
| L1 | Knowledge | 长期学到的事实、惯例、经验 | 每轮对话检索 top-K 注入 user message | agent 主动 + session 结束补漏提取 | 无上限 |
| L2 | Archive | 历史记录归档 | 通常不加载，按需检索 | 系统自动（session 结束/Task 完成） | 无上限 |

三层分工明确：L0 永远在场，L1 按相关性检索，L2 只在追问历史时触发。Working memory 不属于 Memory 系统——由 Task 实体 + SDK session 管理。

### L0 Identity

用户核心身份信息，每次 session 启动时全量注入 system prompt。不依赖检索。

**分层判断标准**：这个信息在没有任何上下文（不知道用户要做什么）的情况下，agent 是否需要知道？是 → L0，否 → L1。

内容类型：
- 姓名、角色、所在组织
- 核心工作偏好（沟通风格、语言、时区）
- 关键约束（"永远不要..."、"我总是..."）
- 工具环境摘要（OS、主力编辑器、常用技术栈）

容量管理：8K 字符硬限。满时 agent 必须合并或淘汰旧条目才能写入新内容。硬限迫使质量——只留最重要的。

格式：结构化 Markdown，分 section。agent 和用户都可直接编辑。

### L1 Knowledge

长期积累的知识库，Memory 系统的主体。

内容类型：
- 用户纠正过的事实（最高优先级写入）
- 工作惯例（"这个项目的部署流程是..."）
- 技术知识（"这个 API 的 rate limit 是..."）
- 人际关系信息（"张三负责审批预算"）
- 反复出现的模式

加载逻辑：每轮对话，系统以用户当前消息为 query 检索 top-K 条相关记忆，注入 user message 中（不是 system prompt，保护 KV cache）。

### L2 Archive

历史记录归档层，低频访问。

内容类型：
- 已完成 Task 的摘要（做了什么、结论、关键决策）
- 不绑定 Task 的 session 摘要（自由对话的归档）
- 历史事件时间线

加载逻辑：通常不加载。两种情况触发检索：
1. 用户明确追问历史（"上周那个 bug 是怎么解决的？"）
2. 系统检测到当前问题与历史任务高度相关

Task 完成时：Task 的累积工作状态归档到 L2，Task 实体只保留元数据（标题、时间、状态、关联）。详细内容在 L2。

## 与 Copilot SDK 的分工

| 职责 | 谁管 |
|------|------|
| Session 内对话历史 | SDK（自动持久化） |
| Context window 压缩 | SDK（80%/95% 自动 compaction） |
| Session 恢复 | SDK（`resumeSession()`） |
| 跨 session 用户档案 | Memory L0 |
| 跨 session 知识积累 | Memory L1 |
| 历史归档和检索 | Memory L2 |
| Task 工作状态 | Task 实体自有字段 |

**SDK 钩子使用：**
- `onSessionStart` → 注入 L0 Identity + 当前活跃 Task 的工作状态（来自 Task 实体）
- `onUserPromptSubmitted` → 以用户消息为 query，检索 L1 Knowledge 注入
- `onSessionEnd` → 获取 session summary → 更新 Task 工作状态；触发补漏提取

## 写入机制

### 通道一：Agent 主动写入

Agent 通过 memory tool 实时写入。

Tool 设计：
```
memory_write:
  action: add | update | remove
  layer: L0 | L1           # agent 只能写 L0 和 L1
  content: string           # 新内容
  target_id?: string        # update/remove 时指定目标
  tags?: string[]           # 结构化标签（Project 关联、分类）
```

写入指导（注入 system prompt）：
- **该记**：用户纠正、明确偏好、稳定事实、工具环境、人际关系
- **不该记**：任务进度、session 内临时状态、会快速过期的信息、可从外部系统实时查询的数据
- **格式**：陈述性事实，不是指令（"用户偏好简洁回复" ✓，"总是简洁回复" ✗）

**错误修正规则**：当用户纠正 agent 时，agent 不仅要写入正确事实，还要**检查是否有已存在的错误记忆导致了这次错误**。如果有，update 或 remove 它。不能只加新的不管旧的。

### 通道二：系统补漏提取

Session 结束时，系统做**窄范围**提取（不是全量提取所有知识）：

1. 检查对话中是否有用户纠正 agent 但 agent 没有调用 memory_write 的情况 → 补写入 L1
2. 检查是否有用户明确声明偏好/事实但 agent 没存的情况 → 补写入 L1
3. 生成 session 摘要 → 归入 L2（如果 session 绑定 Task，同时更新 Task 工作状态）

**不做**全量"从对话中提取所有隐含知识"——这会产生大量低质量/重复条目，且去重困难。

### L2 的自动写入

L2 Archive 由系统在特定事件时自动写入：
- Session 结束 → session 摘要归入 L2
- Task 完成 → Task 工作状态归档到 L2，Task 实体清理详细状态

## 检索机制

L1 和 L2 的检索采用 FTS5 + 结构化过滤。

### 检索方式

1. **FTS5 全文搜索** — BM25 排序，处理关键词、专有名词、人名、技术术语
2. **结构化过滤** — 基于 Project 关联、标签、时间范围缩小候选集

两路结果融合排序：
- FTS5 BM25 相关性得分
- 时间衰减（近期轻微加权，不激进）
- 来源可信度（用户纠正 > agent 主动 > 系统自动）

**为什么没有向量搜索：** v1 不引入 HRR 或 embedding。FTS5 + 结构化标签能覆盖大部分检索场景。如果实际使用中发现检索质量不足（语义近似匹配差），再评估引入方案。不为"看起来完整"加未验证的组件。

### 注入方式

检索结果注入 user message（参考 Hermes Holographic 模式），不污染 system prompt：

```
<memory-context>
[检索到的相关记忆条目]
</memory-context>

[用户的实际消息]
```

## 存储设计

单一 SQLite 数据库。

```sql
CREATE TABLE memory_entries (
  id          TEXT PRIMARY KEY,
  layer       TEXT NOT NULL,        -- 'L0' | 'L1' | 'L2'
  content     TEXT NOT NULL,
  source      TEXT NOT NULL,        -- 'agent' | 'system' | 'user'
  status      TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'inactive'
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  task_id     TEXT,                 -- L2 归档关联的 Task
  project_id  TEXT,                 -- 关联 Project（检索过滤用）
  tags        TEXT,                 -- JSON array
  recall_count INTEGER DEFAULT 0,  -- 被检索命中次数

  FOREIGN KEY (task_id) REFERENCES tasks(id),
  FOREIGN KEY (project_id) REFERENCES projects(id)
);

-- FTS5 索引
CREATE VIRTUAL TABLE memory_fts USING fts5(
  content,
  tags,
  content='memory_entries',
  content_rowid='rowid'
);
```

## 遗忘策略

**L0**：不自动遗忘。硬限 8K，满时 agent 自己管理（合并/删除）。

**L1**：不主动删除。被纠正的条目标记 `status = 'inactive'`（保留审计链，但不再被检索返回）。如果未来量大到检索质量下降，考虑合并语义重复条目。

**L2**：永久保留。用户工作历史，不该被系统删除。

**用户始终可以手动删除任何层的任何条目。**

## 可观测性

Memory 系统必须是可检视的，不能是黑盒：

- **检索日志**：每轮检索的 query、返回结果、分数记录在本地日志（debug 用）
- **引用透明**：agent 在使用记忆信息时，应在回答中注明来源（"根据之前的记录..."）
- **用户查询**：用户可以问"你这轮用了哪些记忆？"，agent 能列出
- **Memory 面板**：UI 上可浏览所有记忆，看到 recall_count、来源、状态

## 用户控制

- **查看**：Memory 面板展示所有记忆，按层分组，支持搜索和过滤
- **编辑**：L0 直接编辑（用户档案）。L1 可编辑内容和标签
- **删除**：任何条目都可删除
- **纠正**：对话中纠正 agent 时，agent 主动更新相关记忆（含清理错误旧条目）
- **导出**：全量导出为 JSON/Markdown

## 与其他实体的关系

- **Task** → Task 自己维护工作状态；完成时归档到 L2；L1 条目可标记关联 Task
- **Project** → L1 条目可标记关联 Project（用于检索过滤）
- **Relation** → 人际关系知识存在 L1
- **Connection** → 不直接参与 Memory（tool 侧），但从 Connection 获取的信息可写入 L1
- **Skill** → 不参与 Memory（tool 侧）
- **Job** → 日报/周报生成时，从 L2 检索时间范围内的 Task 摘要

## 待细化

- L1 检索的 top-K 取多少（上下文预算分配）
- memory-context 注入的 token 预算上限
- 补漏提取的具体 prompt 设计
- L0 使用率展示方式（参考 Hermes 的百分比显示）
- 当 FTS5 检索质量不足时的升级路径评估标准
