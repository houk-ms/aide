# Skill

**Skill 是 Aide 的一等扩展单元，和 MCP tool 平级。它是让 Aide 能力可被持续扩展、而非写死在代码里的核心机制。**

## 定位

Aide 的目标是「能力可扩展」——新能力可以被安装、发布、组合，而不是每次都改代码重新编译。为此 Aide 有两类平级的扩展点：

| 扩展点 | 本质 | 产出 | 格式 |
|--------|------|------|------|
| **Skill** | 行为 / 知识 / 上下文注入单元，可声明依赖、可携带本地 tool | 改变 Agent 处理某类任务的方式 | `SKILL.md` + frontmatter |
| **MCP Server** | 外部工具提供者 | 返回可执行的工具调用结果 | MCP 协议 (stdio / http) |

两者**不是从属关系**：Skill 可以依赖 MCP server，MCP server 也可以被任意 Skill 引用；但 Skill 本身是独立的能力单元，可以只注入指令、也可以自带 tool 实现。

> 注意：早期文档曾把 Skill 描述成「Tool 的 UI 分组视图，运行时不存在」。这是错误的。Copilot SDK 原生支持 Skill（见下），Skill 在运行时是真实存在的能力单元。

## 基于 Copilot SDK 的原生 Skill 能力

Aide 建在 `@github/copilot-sdk` 上，SDK 已原生提供 Skill 机制，**不需要自建 skill 加载器**：

- `SessionConfig.skillDirectories: string[]` — 指定加载 Skill 的目录，SDK 自动扫描其中的 `SKILL.md`
- `CustomAgentConfig.skills: string[]` — 子 agent 可预加载指定 Skill
- Skill 触发时发出 `skill.invoked` 事件，把 `content` 注入对话
- Skill frontmatter 支持 `allowed_tools`、`description`、`plugin_name` 等字段

这意味着 Aide 的扩展架构应「顺着 SDK 建」：把安装好的 Skill 放进 `skillDirectories`，把 MCP server 配置注入 session，剩下的加载 / 匹配 / 注入由 SDK 负责。

## Skill 包结构

```
<skill-name>/
├── SKILL.md            # 必需：frontmatter (元数据) + markdown 指令
├── tools/              # 可选：该 Skill 自带的本地 tool 实现 (TypeScript)
├── mcp.json            # 可选：该 Skill 依赖 / 捆绑的 MCP server 配置
├── prompts/            # 可选：分场景的 prompt 模板
└── assets/             # 可选：图标等资源
```

### SKILL.md frontmatter

```yaml
---
name: draft-email
description: "起草、润色邮件回复。当用户需要回邮件或写正式邮件时使用。"
allowed_tools: [create_entity_work_iq, fetch_work_iq]
---
# 起草邮件的指令正文（仅在 Skill 触发时注入 context）
...
```

- `name` / `description` — 启动时加载，用于语义匹配
- `description` 决定 Skill 何时被自动触发；也可被用户显式调用
- 正文内容**按需注入**，不污染初始 context

## 加载与触发策略

```
启动时：扫描 skillDirectories，只加载所有 Skill 的 name + description
          │
          ▼ 用户发消息
匹配：    基于 description 语义匹配，或用户显式引用
          │
          ▼ 命中
注入：    将 SKILL.md 正文加入 context
注册：    将 tools/ 中的 tool 注册到 session
启动：    启动该 Skill 依赖的 MCP server（若尚未运行）
```

这套延迟加载（deferred loading）是业界（Codex / Claude / OpenClaw）的共识做法，解决「Skill 数量增长后 context 爆炸」的问题。

## Skill 来源（可扩展性的核心）

让「加一个新能力」从「改代码」变成「装一个 Skill / 配一个 MCP」。来源采用混合模式：

| 来源 | 说明 |
|------|------|
| **内置 Skill** | 随 Aide 发布，覆盖核心场景（邮件起草、摘要、日报等） |
| **MCP Registry** | 直接搜索 `registry.modelcontextprotocol.io`，一键安装 MCP server 作为 tool provider |
| **社区 Skill catalog** | git-based 目录（类似 agentskills.io / Claude community marketplace），可发布 / 安装 |
| **本地 / 项目 Skill** | 用户自定义，放在 `~/.aide/skills/` 或项目级 `.aide/skills/` |

## 现有 Tool 清单（内置核心能力）

以下内置 tool 不通过 Skill 提供，是 Agent 的核心能力；Skill 可以引用它们：

| 来源 | Tools |
|------|-------|
| Work IQ MCP | ask_work_iq, fetch_work_iq, search_paths_work_iq, get_schema_work_iq, create_entity_work_iq, update_entity_work_iq, delete_entity_work_iq, do_action_work_iq, fetch_blob_work_iq, upload_blob_work_iq |
| GitHub MCP | list_issues, create_issue, create_pr, review_pr |
| 内部模块 | create_task, update_task, query_tasks, memory_write, memory_search, manage_job, manage_preferences, generate_report |

## 与现有系统的关系

| 现有概念 | 与 Skill 的关系 |
|----------|----------------|
| MCP tools (workiq, github) | Skill 可依赖 MCP，也可独立于 MCP；MCP server 可被一键安装为能力 |
| 内部 Agent tools (manage_job, create_task 等) | 内置核心 tool，不通过 Skill 提供 |
| Memory | Skill 可声明需要的记忆上下文 |
| Connection | MCP 类 Skill 安装时可能需要先建立 connection / 授权 |

## 权限

Skill 自带或依赖的 tool 同样走 SDK 的 permission 系统：
- `allowed_tools` 限定该 Skill 能调用的 tool 范围
- 写操作 / MCP 调用仍触发 `onPermissionRequest`（`kind: 'mcp' | 'custom-tool' | 'write'`）
- 社区来源的 Skill 在安装前应提示其声明的 tool 权限，由用户确认

## 开放问题

1. **Skill tool 的实现语言**：TypeScript（与 Aide 同栈）还是任意语言（via stdio/MCP）？
2. **版本管理**：semver + lockfile，还是轻量 git ref？
3. **安全审核**：社区 Skill 的 tool 代码如何沙箱 / 限权？
4. **UI 呈现**：marketplace 界面是 in-app 还是 web？
5. **付费 Skill**：是否需要考虑商业化？
