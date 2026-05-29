# Skill Marketplace 调研报告

> 调研目标：了解业界主流 AI Agent 产品如何处理 skill/extension 体系，为 Aide 设计 skill marketplace 提供参考。

---

## 一、行业对比总结

| 维度 | OpenClaw | Hermes Agent | Codex (OpenAI) | Claude Code (Anthropic) | **Copilot SDK (Aide 用)** |
|------|----------|--------------|----------------|------------------------|---------------------------|
| **Skill 定义格式** | SKILL.md + openai.yaml | SKILL.md + config.yaml | SKILL.md + openai.yaml | SKILL.md (YAML frontmatter) | **SKILL.md（skillDirectories 加载）** |
| **Skill 与 MCP 关系** | 平级：skill=context注入，MCP=tool provider | 平级：skill=知识包，MCP=外部工具 | skill 可声明 MCP 依赖，自动安装 | skill 可声明 allowed-tools (含 MCP) | **平级：均为 SessionConfig 一等字段** |
| **Plugin 层** | 无 | 无 | 有 (skill+MCP+app 捆绑) | 有 (.claude-plugin/) | **Extensions (.github/extensions/, JSON-RPC)** |
| **Marketplace** | ClawHub (agentskills.io) | 无公开 marketplace | 内部 git catalog | Anthropic Directory + 社区 marketplace | **无（需 Aide 自建来源层）** |
| **分发协议** | git clone / npm-like | YAML 引用 | git source + TOML 配置 | git repo + /plugin install | **目录约定 + 自建安装器** |
| **加载方式** | 按需 (skill_view) | 按描述匹配注入 | tool_search 延迟加载 | 按描述匹配 / /skill 显式调用 | **skillDirectories 扫描 + 按需注入** |
| **自定义指令** | AGENTS.md | 无（靠 skill 本身） | AGENTS.md (层级覆盖) | CLAUDE.md (层级覆盖) | **AGENTS.md / copilot-instructions.md（原生加载）** |
| **MCP 注册表** | registry.modelcontextprotocol.io | config.yaml 手动 | config.toml 手动 | .mcp.json / CLI / Anthropic Directory | **mcpServers 配置 + .mcp.json 自动发现** |

> **关键结论**：Aide 用的 `@github/copilot-sdk` 和 Codex / Claude 是同一套设计哲学——SKILL.md 目录加载 + MCP 一等公民 + AGENTS.md 指令 + 延迟注入。**Aide 不需要自建 skill 加载器或 MCP 客户端，只需补齐「来源层（marketplace）+ 安装器」。**

---

## 一·五、Copilot SDK 原生扩展能力（已基于安装版本 `1.0.0-beta.4` 验证）

以下全部来自 `node_modules/@github/copilot-sdk/dist/types.d.ts` 与 `docs/extensions.md`，是事实而非推测。

### MCP（一等公民）

`SessionConfig.mcpServers: Record<string, MCPServerConfig>`，类型联合：

```ts
// stdio（本地子进程）
interface MCPStdioServerConfig {
  type?: "local" | "stdio";
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
  tools: string[];      // 允许暴露的 tool 白名单，"*" = 全部，[] = 不暴露
  timeout?: number;
}
// http / sse（远程）
interface MCPHTTPServerConfig {
  type: "http" | "sse";
  url: string;
  headers?: Record<string, string>;
  tools: string[];
  timeout?: number;
}
```

→ 任意来自 `registry.modelcontextprotocol.io` 的 MCP server 都能**声明式**加进来，无需手写 spawn / JSON-RPC。

### Skill（一等公民）

- `SessionConfig.skillDirectories: string[]` — SDK 扫描目录中的 `SKILL.md`
- `SessionConfig.disabledSkills: string[]` — 黑名单
- `CustomAgentConfig.skills: string[]` — 子 agent 预加载指定 skill（按 name 从 skillDirectories 解析，启动时 eager 注入）

### 自动发现 & 自定义指令

- `SessionConfig.enableConfigDiscovery: boolean`（默认 false）— 开启后自动发现工作目录下的 `.mcp.json`、`.vscode/mcp.json` 和 skill 目录，与显式配置合并（显式优先）
- 自定义指令文件（`.github/copilot-instructions.md`、`AGENTS.md` 等）**无论该开关如何都会从工作目录加载**
- `SessionConfig.instructionDirectories: string[]` — 额外指令目录

### Extensions（Plugin 层，进程级扩展）

`docs/extensions.md`：扩展是独立 Node 进程，通过 JSON-RPC over stdio 与 CLI 通讯。

- 发现：扫描 `.github/extensions/` 及用户配置目录下含 `extension.mjs` 的子目录
- 能力：注册 tools / hooks、监听事件、调用 SDK API
- 入口：`import { joinSession } from "@github/copilot-sdk/extension"`

### 其它相关扩展点

- `SessionConfig.commands: CommandDefinition[]` — slash command（`/name`）
- `SessionConfig.customAgents: CustomAgentConfig[]` — 子 agent（每个可有独立 tools / mcpServers / skills）
- `SessionConfig.defaultAgent.excludedTools` — 把 tool 藏在子 agent 后面，保持默认 agent context 干净
- `SessionConfig.availableTools` / `excludedTools` — tool 白/黑名单

### Aide 当前实现 vs SDK 原生能力（差距）

| 能力 | SDK 原生 | Aide 当前做法 | 建议 |
|------|----------|---------------|------|
| MCP server 接入 | `mcpServers` 声明式 | 手动 `child_process.spawn` + 自写 JSON-RPC (`src/main/agent/mcp.ts`) | 迁移到 `mcpServers`，让任意 MCP 可声明式安装 |
| Skill 加载 | `skillDirectories` | 完全未使用 | 接入 `~/.aide/skills/`，启用 skill |
| 自定义指令 | AGENTS.md / 自动加载 | 手动拼 system prompt (`buildSystemMessage`) | 可保留，但可叠加 AGENTS.md 支持 |
| 配置自动发现 | `enableConfigDiscovery` | 未使用 | 项目级 `.aide/` 可借此自动加载 |
| Marketplace / 来源 | 无 | 无 | **Aide 需自建：内置 + MCP Registry + 社区 catalog + 本地** |

---


## 二、各平台详细分析

### 2.1 OpenClaw

**核心理念**: Skill = 可复用的 context 注入单元，不是 tool 本身。

**SKILL.md 格式**:
```yaml
---
name: deploy-vercel
description: "Deploy Next.js projects to Vercel"
---
# Instructions (loaded when skill triggers)
Steps to deploy...
```

**openai.yaml (UI metadata)**:
```yaml
interface:
  display_name: "Vercel Deploy"
  icon_small: "./assets/icon.png"
  brand_color: "#000"
dependencies:
  tools:
    - type: "mcp"
      value: "vercel-mcp"
      transport: "streamable_http"
      url: "https://mcp.vercel.com/"
policy:
  allow_implicit_invocation: true
```

**加载机制**:
- 启动时只加载 name + description（用于匹配）
- 实际内容通过 `skill_view(skill_name)` 按需加载到 context
- 大量 skill 不会污染初始 context

**Marketplace (ClawHub)**:
- 公开网站：agentskills.io
- 安装方式类似 npm：`claw install skill-name`
- Skill 发布：git repo + 标准目录结构
- 分类：coding, devops, data, writing 等

**MCP 配置**:
```yaml
# .openclaw/config.yaml
mcp_servers:
  github:
    command: "npx"
    args: ["-y", "@modelcontextprotocol/server-github"]
    env:
      GITHUB_TOKEN: "${GITHUB_TOKEN}"
```

---

### 2.2 Hermes Agent (NousResearch)

**核心理念**: Skill = 可复用的知识/能力包 + 专用 tool。三层架构：Skills > MCP Servers > Plugins(Python包)。

**Skills 配置** (在 config.yaml 中引用):
```yaml
skills:
  - name: web-search
    source: hermes-skills/web-search
    config:
      api_key: "${SEARCH_API_KEY}"
  - name: code-review
    source: ./local-skills/code-review
```

**Skill 目录结构**:
```
skill-name/
├── SKILL.md          # 指令 + 触发条件
├── tools/            # 该 skill 提供的 tools
│   └── search.py
├── prompts/          # 分场景 prompt 模板
└── config.schema.json
```

**加载机制**:
- Skill 按 description 匹配自动激活
- 也可通过 `$skill-name` 显式调用
- Tools 注册到全局 registry，带 toolset 标签分组

**MCP 配置** (config.yaml):
```yaml
mcp_servers:
  filesystem:
    command: "npx"
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"]
  remote-api:
    url: "https://api.example.com/mcp"
    headers:
      Authorization: "Bearer ${TOKEN}"
```

**没有公开 Marketplace**，但遵循 agentskills.io 开放标准。

---

### 2.3 Codex (OpenAI CLI)

**核心理念**: 三层架构 — AGENTS.md (行为指令) > Skills (结构化能力包) > Plugins (skill+MCP+app 捆绑)。

**SKILL.md 格式**:
```yaml
---
name: my-skill
description: "What this skill does and when to use it"
---
# Instructions body (loaded only when skill triggers)
```

**Plugin manifest** (`.codex-plugin/plugin.json`):
```json
{
  "name": "sample",
  "description": "Plugin with MCP server and Skills",
  "skills": "./skills/",
  "mcpServers": "./.mcp.json",
  "apps": "./.app.json"
}
```

**MCP 配置** (`~/.codex/config.toml`):
```toml
[mcp_servers.docs]
command = "docs-server"
args = ["--port", "8080"]

[mcp_servers.remote-api]
type = "http"
url = "https://example.com/mcp"

[mcp_servers.docs.tools.search]
approval_mode = "approve"
```

**Marketplace**:
- 内部 git catalog（`OPENAI_CURATED_MARKETPLACE_NAME`）
- 支持自定义 marketplace source:
```toml
[marketplaces.openai-curated]
source_type = "git"
source = "/path/to/marketplace"
```
- `list_tool_suggest_discoverable_plugins()` — 模型发现缺少 tool 时推荐可安装 plugin
- 尚无公开 web marketplace

**Skill 位置**:
- `~/.codex/skills/` — 用户级
- 项目 `skills/` — 仓库级
- Plugin 内的 `skills/` — 插件提供

**延迟加载**: 大型 tool 集合通过 `tool_search` 语义搜索按需发现，小集合直接暴露。

---

### 2.4 Claude Code (Anthropic)

**核心理念**: MCP 即一切外部工具。Skill = 结构化指令包 + tool 权限声明。三个产品面共享同一引擎。

**SKILL.md 格式**:
```yaml
---
description: Deploy the application to production
disable-model-invocation: true
allowed-tools: Bash(git push *) Bash(npm run build)
context: fork
agent: Explore
arguments: [env, branch]
paths:
  - "src/api/**/*.ts"
---
Deploy $env to production on branch $branch:
1. Run the test suite
2. !`npm run build`
3. Push to deployment target
```

**Plugin 结构** (`.claude-plugin/plugin.json`):
```json
{
  "name": "my-plugin",
  "description": "What this plugin does",
  "version": "1.0.0",
  "author": { "name": "Your Name" }
}
```

Plugin 可包含: skills/, agents/, hooks/, .mcp.json, .lsp.json, monitors/, bin/, settings.json

**MCP 配置** (`.mcp.json`):
```json
{
  "mcpServers": {
    "github": {
      "type": "http",
      "url": "https://api.githubcopilot.com/mcp/",
      "headers": { "Authorization": "Bearer ${GITHUB_PAT}" }
    },
    "db": {
      "command": "npx",
      "args": ["-y", "@bytebase/dbhub", "--dsn", "${DATABASE_URL}"]
    }
  }
}
```

**Marketplace**:
- **Anthropic Directory** (claude.ai/directory): 官方审核的远程 MCP 连接器（Notion, Slack, Sentry, GitHub 等）
- **Plugin marketplaces**: git repo 形式
  - `claude-plugins-official` — 官方策划
  - `claude-community` — 社区提交
  - 自定义 marketplace via `extraKnownMarketplaces`
- 安装: `/plugin install my-plugin@claude-community`

**三层产品共享**:
- Claude.ai: Connectors (远程 MCP) via web UI → 自动同步到 Claude Code
- Claude Code: 完整 MCP + Skills + Plugins + Hooks + Subagents
- Claude Desktop: 仅 MCP servers (via claude_desktop_config.json)

**CLAUDE.md 层级**:
- `~/.claude/CLAUDE.md` — 用户级
- `./CLAUDE.md` — 项目级
- `./.claude/rules/*.md` — 路径范围规则
- `CLAUDE.local.md` — 个人本地覆盖

---

## 三、关键设计模式提取

### 3.1 Skill 的本质

所有平台的共识：**Skill ≠ Tool**。

| | Skill | Tool (MCP) |
|---|---|---|
| **本质** | 指令/知识/上下文注入 | 可执行的函数 |
| **何时加载** | 按需/匹配时注入到 context | 注册后随时可调用 |
| **产出** | 改变 agent 的行为方式 | 返回执行结果 |
| **格式** | Markdown + YAML frontmatter | JSON Schema (MCP protocol) |
| **关系** | 可以声明依赖哪些 tools | 被 skill 引用 |

**但用户的需求更进一步**: Skill 应该是和 MCP tool 平级的一等公民，不仅仅是"指令注入"。Skill 可以：
- 声明自己提供哪些 tools（不通过 MCP）
- 声明依赖哪些 MCP servers
- 包含可执行脚本
- 携带 prompt 模板

### 3.2 Marketplace 模式

| 模式 | 代表 | 优劣 |
|------|------|------|
| **Web registry** | OpenClaw (agentskills.io), Anthropic Directory | 发现性好，审核机制完善 |
| **Git catalog** | Codex, Claude community | 去中心化，版本控制天然 |
| **Config 引用** | Hermes, MCP registry API | 轻量，无需安装步骤 |

### 3.3 延迟加载（Deferred Loading）

**所有平台都采用的关键模式**：
1. 启动时只加载 metadata (name + description)
2. 实际内容/schema 按需加载
3. 通过语义搜索 (`tool_search`) 在需要时发现

这解决了 "skill 数量增长后 context 爆炸" 的问题。

### 3.4 作用域层级

所有平台都支持多级作用域：

| 级别 | 用途 |
|------|------|
| 用户/全局 | `~/` 下的配置，跨项目生效 |
| 项目/仓库 | 项目根目录，团队共享 |
| 目录/路径 | 特定文件路径范围内生效 |
| Session/临时 | 当前会话有效 |

---

## 四、MCP 注册表现状

**官方 MCP Registry API** (已验证可用):
```
GET https://registry.modelcontextprotocol.io/v0.1/servers?q=keyword&limit=N&latest=true
```

返回:
```json
{
  "servers": [{
    "name": "server-name",
    "description": "...",
    "version": "1.0.0",
    "remotes": [{"transportType": "stdio", "command": "npx", "args": [...]}],
    "repository": "https://github.com/...",
    "_meta": { "downloads": 1234 }
  }]
}
```

**Anthropic Directory**: claude.ai/directory — 官方审核的远程 MCP 服务列表。

---

## 五、对 Aide 的设计建议

### 5.1 定位

Aide 的 Skill 应该是：
- **和 MCP tool 平级的一等公民**（不是 tool 的 UI 分组）
- **可安装、可发布、可组合的能力单元**
- **同时支持"指令型 skill"和"tool-provider skill"**

### 5.2 建议架构

```
aide-skill/
├── skill.yaml            # 元数据 (name, description, version, author, tags)
├── SKILL.md              # 指令内容（注入 context 的部分）
├── tools/                # 可选：该 skill 提供的本地 tools
│   └── handler.ts        # Tool implementation
├── mcp.json              # 可选：该 skill 依赖或捆绑的 MCP servers
├── prompts/              # 可选：prompt 模板
└── assets/               # 可选：图标等
```

### 5.3 Skill 来源（Marketplace 策略）

推荐混合模式：

1. **内置 skills**: 随 Aide 发布，覆盖核心场景
2. **MCP Registry 集成**: 直接搜索 registry.modelcontextprotocol.io，一键安装 MCP server 作为 tool provider
3. **社区 skill registry**: 类似 agentskills.io，git-based catalog
4. **本地/项目 skills**: 用户自定义，项目级别 `.aide/skills/`

### 5.4 加载策略

```
┌─────────────────────────────────────┐
│ 启动时加载: name + description only │
│ (所有已安装 skill 的 metadata)       │
└─────────────┬───────────────────────┘
              │ 用户发消息
              ▼
┌─────────────────────────────────────┐
│ 匹配: 基于 description 语义匹配     │
│ 或用户显式引用 $skill-name          │
└─────────────┬───────────────────────┘
              │ 命中
              ▼
┌─────────────────────────────────────┐
│ 注入: 将 SKILL.md 内容加入 context  │
│ 注册: 将 tools/ 中的 tool 注册      │
│ 启动: 启动依赖的 MCP servers        │
└─────────────────────────────────────┘
```

### 5.5 与现有系统的关系

| 现有概念 | 与 Skill 的关系 |
|----------|----------------|
| MCP tools (workiq, github) | Skill 可以依赖 MCP，也可以独立于 MCP |
| Agent tools (manage_job 等) | 内置 tools，不通过 skill 提供 |
| Memory | Skill 可以有自己的持久状态 |
| Connection | MCP skill 安装时可能需要 connection |

### 5.6 落地路线（基于 Copilot SDK，分阶段）

SDK 已提供 skill / MCP 的「运行时」，Aide 只需补「来源层 + 安装器 + UI」。建议顺序：

**Phase A — 打通 SDK 原生扩展点（不引入 marketplace）**
1. 在 `getOrCreateSession` 的 `SessionConfig` 中加入 `skillDirectories: ['~/.aide/skills/']`，先放 1-2 个内置 SKILL.md 验证加载与触发。
2. 把 `src/main/agent/mcp.ts` 的手动 spawn 迁移到 SDK 原生 `mcpServers` 声明式配置（保留现有 workiq/github，验证等价）。
3. 验证 `skill.invoked` 事件与 tool 注册链路。

**Phase B — 来源层（marketplace 后端）**
1. MCP Registry 集成：调 `registry.modelcontextprotocol.io`，把搜索结果转成 `MCPServerConfig` 写入 `~/.aide/mcp.json`。
2. 社区 Skill catalog：git-based，`install` = clone 到 `~/.aide/skills/<name>/`。
3. 安装清单（lockfile）：记录已装 skill / MCP 的 name、来源、版本、声明的 tool 权限。

**Phase C — UI 与安全**
1. Settings 增加「能力 / Skill」tab：列出已装、可搜索安装、显示每个 skill 声明的 tool 权限。
2. 安装前权限确认；社区 skill 的 tool 代码沙箱策略。
3. 卸载 / 禁用（用 `disabledSkills`）。

### 5.7 关键架构决策

- **不重造轮子**：skill 加载、MCP 客户端、context 注入全部交给 SDK；Aide 只做「装 / 配 / 管」。
- **声明式优先**：能力以配置（`mcpServers` / `skillDirectories`）表达，而非硬编码进 `tools.ts`。
- **来源可插拔**：内置 / MCP Registry / 社区 catalog / 本地，统一安装到 `~/.aide/{skills,mcp.json}`。

---

## 六、开放问题

1. **Skill 的 tool 实现语言**: TypeScript (与 Aide 同栈) vs. 任意语言 (via stdio/MCP)？
2. **版本管理**: semver + lockfile？还是轻量 git ref？
3. **安全审核**: 社区 skill 的 tool 代码如何沙箱？
4. **UI 呈现**: marketplace 界面是 in-app 还是 web？
5. **付费 skill**: 是否需要考虑商业化？
6. **MCP 迁移风险**: 现有 workiq 的 EULA 自动接受 / HIDDEN_TOOLS 过滤逻辑在迁移到 SDK 原生 `mcpServers` 后如何保留？
