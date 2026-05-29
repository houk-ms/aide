# Architecture

系统全局架构。

## 技术栈

- **Runtime**: Electron (main + renderer)
- **语言**: TypeScript 全栈
- **AI 引擎**: GitHub Copilot SDK
- **外部连接**: MCP 协议
- **存储**: 本地 SQLite + 文件系统

## 进程模型

```
┌─────────────────────────────────────────────┐
│ Electron Main Process                        │
│                                              │
│  ┌──────────┐  ┌──────────┐  ┌───────────┐ │
│  │ Agent    │  │ Job      │  │ Connection│ │
│  │ (SDK)    │  │ Scheduler│  │ Manager   │ │
│  └──────────┘  └──────────┘  └───────────┘ │
│                                              │
│  ┌──────────┐  ┌──────────┐  ┌───────────┐ │
│  │ Memory   │  │ Task     │  │ SQLite    │ │
│  │ Store    │  │ Store    │  │ DB        │ │
│  └──────────┘  └──────────┘  └───────────┘ │
│                                              │
│  ┌──────────────────────────────────────┐   │
│  │ MCP Servers                          │   │
│  │ • @microsoft/workiq (M365 全覆盖)   │   │
│  │ • GitHub MCP Server                  │   │  │ • 用户安装的 MCP（来自 Registry）   │   │
  └──────────────────────────────────────┘   │
  ┌──────────────────────────────────────┐   │
  │ Skills (SDK skillDirectories)        │   │
  │ • 内置 / 社区 / 本地 SKILL.md        │   ││  └──────────────────────────────────────┘   │
└──────────────────────┬──────────────────────┘
                       │ IPC
┌──────────────────────▼──────────────────────┐
│ Electron Renderer Process                    │
│                                              │
│  [Task List] │ [Chat Panel]                  │
│  (React + Zustand + Tailwind + shadcn/ui)    │
└──────────────────────────────────────────────┘
```

## 数据流

### 信息采集（Job 驱动）

```
Job Scheduler (cron)
  → 触发 Connection 轮询
  → MCP Server 调 Graph API / GitHub API / ...
  → 返回原始数据
  → Agent 分析：是否包含新 Task？
  → 是 → 创建 Task，写入 SQLite
  → 沉淀观察到的信息 → Memory
```

### 用户对话处理

```
用户输入 (Renderer)
  → IPC → Main Process
  → Agent (Copilot SDK session)
    → 加载上下文 (Memory L0 + L1 检索 + Task + Project + Relation)
    → SDK 推理循环
    → 调用 Custom Tools (store_memory, create_task, send_email, ...)
    → 返回结果
  → IPC → Renderer 展示
```

## 存储设计

### SQLite Schema 概览

| 表 | 核心字段 | 说明 |
|---|---|---|
| `tasks` | id, title, status, priority, source, project_id, created_at | 任务 |
| `memory_entries` | id, layer, content, source, status, tags, project_id, created_at | 记忆（L0/L1/L2 统一表） |
| `memory_fts` | (FTS5 虚拟表) | 记忆全文检索 |
| `projects` | id, name, repo_path, docs_path, description | 项目 |
| `relations` | id, name, role, org, preferences | 人际关系 |
| `jobs` | id, name, cron, instruction, enabled, last_run, last_result | 调度任务 |

### 文件系统

```
~/.aide/
├── aide.db              # SQLite 主数据库
├── sessions/            # Copilot SDK session 数据（SDK 自管理）
├── skills/              # 已安装的 Skill（SKILL.md 包，SDK 从此目录加载）
└── logs/                # 运行日志
```

### 可扩展性（Skill + MCP）

Aide 的能力可被持续扩展，而非写死在代码里。两类平级扩展点：

- **Skill**：`SKILL.md` 包，放入 `~/.aide/skills/`，通过 SDK 的 `SessionConfig.skillDirectories` 自动加载，按 description 匹配后注入 context。
- **MCP Server**：外部工具提供者，可从 `registry.modelcontextprotocol.io` 搜索并一键安装，配置注入 session。

详见 docs/skill.md。

## 模块通信

Main process 内各模块通过直接函数调用（同一进程），不需要事件总线或消息队列。保持简单。

Renderer ↔ Main 通过 Electron IPC，暴露类型安全的 API：

```typescript
// preload 暴露给 renderer 的 API
interface AideAPI {
  tasks: { list, get, update, markSeen, snooze, ... }
  chat: { send, getHistory, confirmAction, ... }
  memory: { getL0, searchL1, update, delete, ... }
  jobs: { list, toggle, getLastSummary, ... }
  connections: { getStatus, authenticate, ... }
  projects: { list, get, update, ... }
  relations: { list, get, update, ... }
}
```
