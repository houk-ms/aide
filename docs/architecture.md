# Architecture

System-wide architecture.

## Tech stack

- **Runtime**: Electron (main + renderer)
- **Language**: TypeScript everywhere
- **AI engine**: GitHub Copilot SDK
- **External connections**: MCP protocol
- **Storage**: Local SQLite + filesystem

## Process model

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
│  ┌──────────────────────────────────────┐  │
│  │ MCP Servers                          │  │
│  │ • @microsoft/workiq (full M365)      │  │
│  │ • GitHub MCP Server                  │  │
│  │ • User-installed MCP (from Registry) │  │
│  └──────────────────────────────────────┘  │
│  ┌──────────────────────────────────────┐  │
│  │ Skills (SDK skillDirectories)        │  │
│  │ • built-in / community / local       │  │
│  └──────────────────────────────────────┘  │
└──────────────────────┬──────────────────────┘
                       │ IPC
┌──────────────────────▼──────────────────────┐
│ Electron Renderer Process                    │
│                                              │
│  [Task Sidebar] │ [Dashboard / Chat]         │
│  (React + Zustand + Tailwind + lucide-react) │
└──────────────────────────────────────────────┘
```

## Data flow

### Information collection (Job-driven)

```
Job Scheduler (cron)
  → trigger Connection poll
  → MCP Server calls Graph API / GitHub API / ...
  → returns raw data
  → Agent analyzes: does it contain a new Task?
  → yes → create Task, write to SQLite
  → distill observed information → Memory
```

### User conversation handling

```
User input (Renderer)
  → IPC → Main Process
  → Agent (Copilot SDK session)
    → load context (Memory L0 + L1 retrieval + Task + Project)
    → SDK reasoning loop
    → call Custom Tools (store_memory, create_task, send_email, ...)
    → return result
  → IPC → Renderer renders
```

## Storage design

### SQLite schema overview

| Table | Key fields | Description |
|---|---|---|
| `tasks` | id, title, status, priority, source, project_id, created_at | Tasks |
| `memory_entries` | id, layer, content, source, status, tags, project_id, created_at | Memory (unified L0/L1/L2 table) |
| `memory_fts` | (FTS5 virtual table) | Full-text search over memory |
| `projects` | id, name, repo_path, docs_path, description | Projects |
| `jobs` | id, name, cron, instruction, enabled, delivery_targets, last_run, last_result | Scheduled jobs (`delivery_targets` = JSON array of Channels to push the result to) |

### Filesystem

```
~/.aide/
├── aide.db              # Main SQLite database
├── sessions/            # Copilot SDK session data (SDK-managed)
├── skills/              # Installed Skills (SKILL.md packages, loaded by the SDK from here)
└── logs/                # Runtime logs
```

### Extensibility (Skill + MCP)

Aide's capabilities can be continuously extended rather than hard-coded. Two peer extension points:

- **Skill**: a `SKILL.md` package placed in `~/.aide/skills/`, auto-loaded via the SDK's `SessionConfig.skillDirectories`, and injected into context once matched by description. Installed from the in-app community marketplace or a local folder.
- **MCP Server**: an external tool provider whose config is injected into the session. WorkIQ and GitHub ship today; one-click install from `registry.modelcontextprotocol.io` is planned.

See docs/skill.md for details.

## Module communication

Modules inside the main process call each other directly (same process) — no event bus or message queue needed. Keep it simple.

Renderer ↔ Main communicate via Electron IPC, exposing a type-safe API:

```typescript
// API exposed to the renderer via preload
interface AideAPI {
  tasks: { list, get, update, markSeen, snooze, ... }
  chat: { send, getHistory, confirmAction, ... }
  memory: { getL0, searchL1, update, delete, ... }
  jobs: { list, toggle, getLastSummary, ... }
  connections: { getStatus, authenticate, ... }
  projects: { list, get, update, ... }
  wechat: { getStatus, connect, disconnect, ... }   // WeChat channel
}
```
