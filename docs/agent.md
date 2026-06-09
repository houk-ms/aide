# Agent

The Agent engine design. Built on the Copilot SDK.

## Provided by the SDK (we don't rebuild these)

- The reasoning loop (receive → understand → plan → execute → feedback)
- Tool orchestration
- Session persistence and recovery
- Multi-turn conversation with automatic context-window compaction
- In-session conversation history management

## What we build on top of the SDK

### 1. System prompt assembly

The Agent's system prompt is assembled dynamically, not a static string:

```
[fixed]   Role definition + behavioral guidelines
[dynamic] L0 Identity (loaded from Memory, injected every time)
[dynamic] Current Task context (if there's an active Task)
[dynamic] Relevant Project summary
```

**Token budget**: the system prompt's total budget is ~3K tokens. Fixed part ~1K, L0 Identity ~0.5K (1K chars ≈ 0.5K tokens), dynamic context ~1K. Everything else is reserved for the conversation.

### 2. Context injection strategy

When handling a Task, the following is injected via the SDK's `onSessionStart` hook:
- The Task's own metadata and source info
- Relevant docs/code snippets from the associated Project
- L1 Knowledge retrieval results (similarity search based on the Task content)

**Truncation priority** (cut from the bottom when over budget): Task metadata > Project summary > L1 retrieval results. The Task's own information is always kept complete.

### 3. Custom tool definitions

The Agent gains its capabilities through the SDK's Custom Tools mechanism:

**MCP Server tools (external systems):**

| Tool | Purpose | Source |
|------|------|------|
| `ask_work_iq` | Natural-language query of M365 data | Work IQ |
| `fetch_work_iq` | Structured entity reads | Work IQ |
| `create_entity_work_iq` | Create an entity (send email, create event, etc.) | Work IQ |
| `update_entity_work_iq` | Update an entity | Work IQ |
| `do_action_work_iq` | Perform an action (accept a meeting, etc.) | Work IQ |
| `delete_entity_work_iq` | Delete an entity | Work IQ |
| GitHub tools | Issues, PRs, Repos operations | GitHub MCP |

**Internal tools (local modules):**

| Tool | Purpose | Subsystem |
|------|------|-----------|
| `memory_write` | Write memory (add/update/remove) | Memory |
| `memory_search` | Retrieve past memories | Memory |
| `create_aide_task` | Create a new Aide task | Task |
| `update_aide_task` | Update Aide task status | Task |
| `find_related_task` | De-dup check before creating a task | Task |
| `add_task_activity` | Append an entry to a task's activity timeline | Task |
| `get_task_activities` | Read a task's activity timeline | Task |
| `query_aide_tasks` | Query the Aide task list | Task |
| `query_projects` | Query projects | Project |
| `manage_project` | Create/update a project | Project |
| `manage_job` | Create/update a scheduled job | Job |
| `manage_preferences` | Read/update user preferences | Preferences |
| `generate_report` | Generate daily/weekly reports | Report |
| `search_skills` | Search the skill marketplace | Skill |
| `install_skill` | Install a Skill from the marketplace or a local folder | Skill |
| `list_installed_skills` | List installed Skills and their enabled state | Skill |
| `browser_navigate` | Open a URL in the controlled browser | Browser |
| `browser_click` | Click an element by CSS selector | Browser |
| `browser_type` | Type text into an input field | Browser |
| `browser_read` | Read text / current URL / page title | Browser |
| `browser_screenshot` | Capture the current page as an image | Browser |

**Design questions**:
- Should the tool list be injected statically or selected dynamically by Task type? (token-cost consideration)
- Confirmation for write operations: which tool calls require user confirmation? Implemented via the SDK's `onPermissionRequest`

### 3.5 Skill loading (extensible capabilities)

Beyond built-in Custom Tools, the Agent gains extensible capabilities through the SDK's native Skill mechanism:

- When creating a session, set `skillDirectories` (pointing at `~/.aide/skills/` etc.); the SDK automatically scans for `SKILL.md`
- At startup only the Skill's `name + description` is loaded; the body is injected on demand when matched (the `skill.invoked` event)
- A Skill can declare `allowed_tools`, ship its own local tool, and depend on an MCP server

This turns "adding a new capability" from "changing code" into "installing a Skill / configuring an MCP". See docs/skill.md for details.

### 3.6 Browser automation

The Agent can drive a real Chromium browser (via Playwright) to operate web apps that have no API. The browser launches visibly so the user can watch what happens. Exposed through the `browser_navigate` / `browser_click` / `browser_type` / `browser_read` / `browser_screenshot` tools, with the browser lifecycle (launch, isolated context, cleanup) managed internally. Screen understanding via vision and full mouse/keyboard computer-use are still on the roadmap.

### 4. Autonomy-level control

Graded autonomy implemented via the SDK's permission system:

| Level | Behavior | Example |
|------|------|------|
| Auto | Execute directly, no asking | Read email, retrieve info, update task status |
| Notify | Tell the user after executing | Store memory, create a low-priority task |
| Confirm | Ask before executing | Send email, send message, modify code, delete task |

**Default rules**: hard-coded in the code (read ops = auto, memory = notify, write ops = confirm). MVP has no user customization. Post-MVP exposes configuration under Settings > Preferences.

### 5. The relationship between Session and Task

- A single Task may be handled across multiple Sessions (resumed after interruption)
- Associated via the SDK's `sessionId`: `task-{taskId}-{attemptNumber}`
- When a Session ends, the content to be written to Memory is extracted via the `onSessionEnd` hook

**Session recovery strategy**: always try `resumeSession()`. The SDK automatically restores the full conversation history. If the session is corrupted (very rare), create a new session and inject the previous session's summary from the L2 Archive.
