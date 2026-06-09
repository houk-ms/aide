# UI

Electron desktop app. React 19 frontend, Zustand state, Tailwind CSS v4.

## Design principles

1. **No page navigation** — the user's core actions (reviewing tasks + talking to the Agent) happen in one window; there are no routes to navigate
2. **Chat is always one click away** — the message composer is the primary surface; from anywhere you can drop into a conversation with the Agent
3. **A task is a context, not a page** — clicking a task switches the Agent's working context and loads that task's conversation
4. **The Agent shows up proactively** — background Jobs discover work, update the task list, and post into chat without being asked

## Layout

A fixed three-zone shell: a persistent left sidebar, a main area that swaps between three modes, and a Settings drawer that overlays from the right.

```
┌────────────────┬────────────────────────────────────────────┐
│  Aide   [Manage]│  ← main area header (drag region)          │
├────────────────┼────────────────────────────────────────────┤
│ NEW TASKS    2 │                                            │
│  P0 ● API docs │   MAIN AREA — one of three modes:          │
│  P1 ● PR #351  │                                            │
│                │   1. Dashboard (Overview)                  │
│ IN PROGRESS  5 │   2. General chat                          │
│  P0 Fix bug    │   3. Task chat                             │
│  P1 Design doc │                                            │
│  P2 …          │                                            │
│  + 3 more      │                                            │
│                │                                            │
│ [Ask Aide…]    │   [ composer / cards / timeline ]          │
└────────────────┴────────────────────────────────────────────┘
```

The window is frameless; the top `52px` strip of each panel is a drag region (`drag-region` / `no-drag` classes).

## Left sidebar — `TaskPanel` (always visible, 260px)

The sidebar is the navigation spine. It does **not** include the Done/history list — completed work lives in the Dashboard.

**Header**
- `Aide` logo + wordmark — click to go Home (Dashboard)
- `Manage` button (sliders icon) — opens the Settings drawer

**New tasks** (always shown)
- Tasks that are `pending`/`in_progress` and have never been opened (`seenAt === null`)
- Accent count badge

**In progress**
- Tasks that are `pending`/`in_progress` and have been seen (`seenAt !== null`)
- Tasks with unseen activity (`lastActivityAt` newer than `seenAt`) float to the top
- Visible cap of **10** items; the rest collapse behind a `+N more` toggle (expand / Collapse)

**Per-item anatomy**
- Priority chip: `P0` (dark/solid), `P1` (sage), `P2` (muted grey)
- A pulsing accent dot when the task is `in_progress`
- Title (truncated)
- A `new` dot for never-seen tasks, or an activity dot when there's unseen activity
- Hover quick actions: **Done** (check) and **Snooze** (clock → tomorrow 9:00)
- Right-click context menu: **Done**, **Cancel**, **Lower priority** (→ P2), **Snooze to tomorrow**, **Snooze to next Monday**

**Bottom (pinned)**
- `Tell Aide what you need` button → switches the main area to **General chat**

## Main area — three modes

`MainArea` chooses what to render from `taskStore` (`selectedTaskId`, `viewMode`):

- A task is selected → **Task chat**
- No task, `viewMode === 'chat'` → **General chat**
- No task, `viewMode === 'dashboard'` (default) → **Dashboard**

### Mode 1: Dashboard (`DashboardView`, "Overview")

The landing surface and the place to review history. Three sections:

- **New tasks** — card grid of never-seen tasks (title + priority tag, description, source, due date, relative time). Hover actions: Complete / Dismiss.
- **In progress** — card grid of seen-but-open tasks, with a subtle per-priority color tint and "Started …" timestamp.
- **Completed** — a vertical **timeline grouped by date**, newest first. Controls:
  - Time-range tabs: **This week** / **This month** / **Custom** (date-range pickers)
  - Each day toggles between **N completed** and **N dismissed** views
  - **Daily report** button per past day generates a report card from that day's tasks

Clicking any card/row selects the task and switches to Task chat.

### Mode 2: General chat (`ChatPanel`, no task)

- Header: back arrow + `Aide`
- Free conversation; the Agent answers from L0/L1 Memory and tools
- Background `job:completed` summaries are injected here as Agent messages

### Mode 3: Task chat (`ChatPanel`, task selected)

- **`TaskHeader`**: back arrow, task title, **Done** + **Cancel** quick buttons, and a one-line metadata bar — priority badge, source (with an `↗` link to the external system when present), status, due date (red when overdue)
- **`TaskActivityPanel`**: a collapsible card pinned at the top of the conversation showing the task's activity timeline (progress / status change / blocker / needs-reply / note, each with a colored dot, timestamp, and optional `sourceRef`)
- **First-message trigger**: the first time a task is opened, the Agent is asked to post an opening message explaining what the task is and how it suggests handling it — the conversation itself is the "details panel"

## Chat composer & message rendering

Shared by General and Task chat (`ChatPanel`):

- **Messages**: rendered as bubbles; Agent replies use Markdown (`react-markdown` + `remark-gfm`); copy-to-clipboard on hover
- **Streaming**: the Agent's in-flight turn streams deltas; a typing indicator shows before text arrives
- **Tool calls**: the current turn renders a `ToolCallsRow` showing each tool invocation and its running/done status
- **Stop**: a stop button interrupts an in-progress stream
- **Attachments**: add via the paperclip button or paste; previewed as chips (images show a thumbnail) above the composer
- **Model picker**: a selector in the composer toolbar with a short featured list plus an "other models" expansion; selection is persisted via `window.aide.models.setSelected`
- **Empty state**: shown when a conversation has no messages yet

### Confirmation interaction (`ActionCard`)

When the Agent needs approval before a write operation, the pending action renders inline in chat with buttons:

- **Confirm** (label adapts: "Confirm send" for email/Teams, "Confirm submit" for reviews/comments, otherwise "Confirm")
- **Edit** — loads the draft into the composer for editing, then re-confirm
- **Cancel** — discards the action

Decisions flow through `confirmAction(id, 'confirm' | 'modify' | 'cancel')`; the message then shows `Confirmed` / `Cancelled`.

## Settings drawer (`SettingsDrawer`)

Not a page — a right-side overlay (`620px`) titled **Manage**, opened from the sidebar. Tabs:

- **Connections** — grouped into two stacked sections:
  - **Sources** (where Aide reads work from): Microsoft (Work IQ via `npx`) and GitHub (`gh` CLI) auth status, account switching, connect/disconnect
  - **Channels** (how Aide reaches you and takes commands): WeChat — QR sign-in, connection status, two-way chat
- **Jobs** — scheduled background jobs (toggles / frequency / per-job result delivery)
- **Projects** — project list and linked repos/docs
- **Memory** — browse/edit/delete the Agent's stored memories
- **Preferences** — language, theme, notification preferences

## Onboarding (`OnboardingWizard`)

Shown full-screen when `preferences.onboardingComplete` is false. Steps: **Welcome → GitHub → Microsoft → Done**. On finish it sets `onboardingComplete` and kicks off the `world-sync` job to bootstrap projects.

## Event-driven updates

`App.tsx` holds a single stable subscription to main-process events and updates stores accordingly:

| Event | Effect |
|-------|--------|
| `task:created` / `task:updated` / `task:activity` | Re-fetch tasks |
| `chat:message` | Append to the active conversation |
| `chat:stream` / `chat:stream-end` | Stream deltas / finalize + refresh history |
| `chat:pending-action` | Add a confirmation card |
| `chat:tool-use` | Update the tool-call row for the active context |
| `job:completed` / `job:failed` | Refresh tasks; surface a summary/warning in General chat |
| `connection:status` | Refresh connection status |

Snoozed tasks are also re-fetched on a 60-second interval so they reappear when due.

## Agent proactive behavior

| Trigger | What the Agent does |
|---------|---------------------|
| Background job finishes | Delivers its summary to the job's chosen Channels — posts into General chat (`desktop`) and/or sends to WeChat (`wechat`) — and refreshes the task list |
| New / updated task | Appears in **New tasks** (sidebar + Dashboard) with a `new` marker |
| Task activity | Surfaces an activity dot and updates the Task activity panel |
| Job failure | Posts a warning in General chat prompting a connection check |

## Tech selection

| Decision | Choice | Rationale |
|----------|--------|-----------|
| UI framework | React 19 | Mature ecosystem |
| State management | Zustand | Lightweight stores (`taskStore`, `chatStore`, `settingsStore`) |
| Styling | Tailwind CSS v4 | Fast iteration; OKLCH color tokens |
| Icons | lucide-react | Consistent line icons |
| Chat rendering | react-markdown + remark-gfm, streaming | Streamed Markdown Agent replies |
| IPC | Electron `contextBridge` typed API (`window.aide`) | Type-safe main↔renderer |
