# Memory System Redesign

## Current Issues

### 1. L2 is broken
The system writes `[Session Checkpoint]` entries every 10 messages into L2 and searches them every turn alongside L1. These are noisy, low-value entries that dominate retrieval results ("Recalled 34 times" for a checkpoint no one ever needs).

### 2. Retrieval is too broad
Every user message — including "ok", "yes", short follow-ups — triggers an FTS5 search with no minimum score. Generic words match too many entries. A people-related entry gets recalled 100+ times because generic words like "user" and "manager" appear in almost any work message.

### 3. The agent writes too freely
No clear guidance on what belongs in memory vs. elsewhere. Result: event logistics (dates, budgets, venues), task progress, and people identity data all end up as L1 entries alongside actual user knowledge. Duplicates accumulate because the agent adds without checking if the fact already exists.

### 4. Task sessions are isolated
Work done in general chat doesn't flow back to the task. If you ask the agent to create repos in general chat for a specific task, then open that task's session — the agent doesn't know the repos exist. There's no cross-session continuity for tasks.

### 5. Duplication across systems
A person's identity exists both as a Relation entity AND as an L1 memory. When one gets updated, the other doesn't.

---

## Proposed System

### Architecture

```
┌─────────────────────────────────────────────────────────┐
│                      Memory                              │
│                                                          │
│  L0 (Identity)          L1 (Knowledge)                  │
│  ─────────────          ──────────────                  │
│  Always loaded           Retrieved per-turn             │
│  Core profile            Stable user knowledge          │
│  1K char limit           Unbounded (search handles it)  │
│                                                          │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│                   Task Entity                            │
│                                                          │
│  title, status, priority, description ...               │
│  working_state (NEW)                                    │
│  ────────────────────                                   │
│  What's been done, decisions, outputs, current status   │
│  Loaded when task is active                             │
│  Updated in real-time by agent                          │
│                                                          │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│                  Relations Entity (TODO: maybe later)     │
│                                                          │
│  Structured people data: name, role, organization       │
│  Not needed for v1 — people facts live in L1 for now    │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

### Core Principle

**Memory is about the user. Task context is about the work.**

Each system has one job:
- **L0**: Who you are
- **L1**: What the agent has learned about you and your world
- **Task `working_state`**: What's happened on a specific piece of work

### What lives where

| Information | Where | Example |
|---|---|---|
| Core identity, preferences | L0 | "Name: [name]. Timezone: Asia/Shanghai. Prefers Chinese for chat." |
| Stable knowledge, conventions | L1 | "User prefers Docker Compose for local dev" |
| People (one entry per person) | L1 | "Alice: user's manager at Contoso. Prefers async. Reviews backend PRs." |
| Task relationships | L1 | "task-B is a follow-up of task-A" |
| Task progress, outputs | Task `working_state` | "Created 3 repos. Pushed to remote." |
| Event logistics | Task `working_state` | "Event: June 9 afternoon, budget confirmed" |

### What does NOT go in L1

- Task progress or outputs (→ `working_state`)
- Transient scheduling info (→ Task or nowhere)
- Session logs or checkpoints (→ nowhere)
- Anything that expires in days

---

## Retrieval Strategy

### Per-turn flow

```
User message
    │
    ▼
Extract key entities/terms (strip stop words, focus on proper nouns)
    │
    ▼
If message too short → use recent conversation context for query
    │
    ▼
FTS5 keyword search L1 only
    │
    ▼
Apply BM25 score threshold → discard weak matches
    │
    ├── Results found? → Return top matches
    │
    └── No results? → Fall back to local embedding search
                          │
                          ▼
                     Cosine similarity against all L1 entry vectors
                          │
                          ▼
                     Return top matches above similarity threshold (or nothing)
    │
    ▼
Inject as <memory-context> in user message
```

### Two-tier search

| Tier | Method | When | Cost |
|------|--------|------|------|
| Primary | FTS5 keyword (BM25) | Every turn | <1ms, 0 tokens, local SQLite |
| Fallback | Local embedding (cosine similarity) | Only when FTS5 returns nothing | 10-50ms, 0 tokens, local ONNX model |

**Why two tiers:**
- FTS5 handles most queries well (proper nouns, exact terms) and is instant
- Embedding fallback catches semantic matches ("boss" → "manager") that FTS5 misses
- Local model (e.g. `all-MiniLM-L6-v2` via `onnxruntime-node`, ~90MB) — no API calls, no network dependency

**Embedding lifecycle:**
- Entries are embedded once at write time → stored as a vector column in SQLite
- Query is embedded at search time only when FTS5 returns nothing
- Model loaded lazily on first embedding query (not at app startup) — avoids 90MB cost if user doesn't chat
- Once loaded, stays in memory for subsequent queries

### Key differences from current system

| Current | Proposed |
|---------|----------|
| Searches L1 + L2 | Searches L1 only |
| Raw user message as query | Extracted entities/terms |
| Always returns top-5 | Returns nothing if below threshold |
| Keyword only | FTS5 + local embedding fallback |
| Every message triggers search | Every message triggers search, but smarter query + threshold means most get zero results |

---

## Write Strategy

### L1 writes (agent-driven, Hermes-style)

The agent decides when to write, guided by system prompt:

1. **Search first** — before adding, search for existing entries on the same topic
2. **Update if exists** — "same topic" = same subject + same attribute. Update, don't duplicate.
3. **Add if new** — only if nothing similar exists

**Format**: One-liner declarative facts. One entry per subject.
- ✓ "User prefers concise replies"
- ✓ "Alice: user's manager at Contoso. Prefers async. Reviews backend PRs."
- ✗ "Always reply concisely"
- ✗ Multiple separate entries about the same person

**People entries**: One compact card per person. Only for people who come up repeatedly or whose relationship to the user matters for the agent's work. One-off mentions ("Bob sent me a file") don't get entries. Same person = update the existing card, don't create a new entry.

**Triggers** (agent's judgment):
- User corrects the agent (highest priority)
- User states a preference or habit
- Agent discovers a stable fact about the environment
- Agent learns a convention or relationship

### Task `working_state` writes

| Context | How it gets updated |
|---------|-------------------|
| Task session | Agent calls `update_task(taskId, { working_state: '...' })` during work. |
| General chat | Agent recognizes task-related work → calls `update_task` with relevant taskId in real-time. |

**Compaction at session end:**
If `working_state` exceeds 1500 chars when a task session ends, the agent compresses it to essential facts only (decisions, outputs, blockers) in a final LLM turn. Target: under 800 chars. This keeps context tight for the next session without losing important early decisions.

```
onSessionEnd:
  if (task.working_state.length > 1500) {
    agent: "Compress working_state to essential facts. Keep under 800 chars."
    → update_task(taskId, { working_state: compressed })
  }
```

### No more automatic writes

- ~~Session checkpoint every 10 messages~~ → removed
- ~~L2 append at session end~~ → replaced by `working_state` upsert

---

## Cross-Task Awareness

How does Task B know what Task A produced?

```
Task B session starts
    │
    ▼
L0 loaded (identity)
    │
    ▼
Task B's working_state loaded
    │
    ▼
L1 retrieval finds: "Task B is a follow-up of Task A"
    │
    ▼
Agent decides to look up Task A → calls get_task(A)
    │
    ▼
Gets Task A's working_state ("Created repos: ...")
    │
    ▼
Agent now has full context to continue
```

No system-level magic. The agent uses L1 knowledge + existing tools to bridge tasks.

---

## General Chat ↔ Task Flow

```
General Chat                          Task Entity
─────────────                         ───────────
User: "do X for task-123"            
    │                                 
Agent does the work                   
    │                                 
Agent calls update_task(              ──► working_state updated:
  taskId: "task-123",                     "Did X. Results: ..."
  status: "in_progress",              
  working_state: "Did X..."           
)                                     
    │                                 
Later: user opens task session        ◄── working_state loaded at start
Agent knows X was already done       
```

---

## Task ↔ Project Linking

### Change: `projectId` → `projectIds: string[]`

A task can span multiple projects ("update the API in backend, update the client in frontend"). Change from single foreign key to an array.

### How tasks get linked

**1. Agent sets it at creation (primary path)**

When the agent creates a task, the project list is injected into context:

```
Available projects:
- id: "proj_abc" | name: "aide" | repo: "c:\dev\aide"
- id: "proj_def" | name: "team-dashboard" | repo: "houk-ms/dashboard"
```

The agent picks one or more when calling `task_create`. Today it's blind — it doesn't see projects. Fix: inject `projects.list()` into the task-creation prompt.

**2. Heuristic auto-match (external sources)**

When a task arrives from WeChat/Telegram/email without projectIds, run a keyword match:

```typescript
function inferProjects(task: Task, projects: Project[]): string[] {
  const text = `${task.title} ${task.description}`.toLowerCase()
  return projects
    .filter(p => {
      const terms = [p.name.toLowerCase()]
      if (p.repoPath) terms.push(p.repoPath.split('/').pop()!.toLowerCase())
      return terms.some(t => text.includes(t))
    })
    .map(p => p.id)
}
```

Set if matches are found. If none, leave empty.

**3. Agent corrects on first interaction**

When a task session starts with empty `projectIds`:

```
System: This task has no linked project. If you can determine which project(s)
it belongs to from context, call task_update to set projectIds.
```

One-shot self-heal on first touch.

### Project auto-description

When a project is created without a description (user only provides name + repo path), the system asynchronously reads the repo's README and config files (package.json, Cargo.toml, etc.) and generates description + techStack via the agent. This is fire-and-forget — doesn't block the user.

```
on project create:
  if (!input.description && input.repoPath) {
    async: read README + config files → agent generates description, techStack
    → update project with auto-generated fields
  }
```

### What project linking enables

- **Code grounding**: Agent knows which repos to check for relevant files
- **Tech stack awareness**: No rediscovery ("this is Electron + TypeScript")
- **Docs path**: Agent reads project docs before guessing
- **Memory retrieval boost**: Weight L1 results related to active projects
- **Dashboard grouping**: UI can group tasks by project

---

## Implementation

| Change | Type | Description |
|--------|------|-------------|
| Add `working_state` to Task | Schema | New TEXT column on tasks table |
| Change `projectId` → `projectIds` on Task | Schema | TEXT column storing JSON array (e.g. `["proj_abc","proj_def"]`) |
| Add `inferProjects()` to task creation | Code | Auto-match projects by keyword on external task sources |
| Inject project list into agent context | Prompt | Agent sees available projects when creating tasks |
| Add project-linking hint to task session | Prompt | Agent self-heals empty `projectIds` on first interaction |
| Project auto-description on creation | Code | Async: read README + configs, agent fills description/techStack if user didn't provide |
| `working_state` compaction at session end | Code | If >1500 chars, agent summarizes to <800 chars |
| Update `update_task` tool | Code | Accept `working_state` and `projectIds` parameters |
| Load `working_state` in `onSessionStart` | Code | Inject into task session context |
| Load linked projects in `onSessionStart` | Code | Inject project details (repo, techStack, docs) for linked projects |
| Remove L2 checkpoint writes | Code | Delete the 10-message flush logic |
| Remove L2 from `searchMemory` | Code | Change `WHERE layer IN ('L1','L2')` → `WHERE layer = 'L1'` |
| Add BM25 score threshold | Code | Filter results below cutoff |
| Add local embedding fallback | Code | ONNX model for semantic search when FTS5 returns nothing |
| Embed L1 entries at write time | Code | Store vector alongside text in SQLite |
| Smarter query extraction | Code | Parse entities/terms before FTS5 |
| Update `memory_write` tool description | Prompt | Add write guidance, dedup rules |
| Update system prompt | Prompt | Memory guidance (what to store, format, dedup) |


---

## Verification Metrics

### Retrieval Quality

| Metric | How to measure | Target |
|--------|---------------|--------|
| Precision | Of memories injected per turn, how many are actually relevant to the message? | >80% (vs current ~30%) |
| Zero-result rate | % of turns where no memory is injected | 40-60% (currently ~0% — everything matches something) |
| Noise entries | Memories with recall_count > 20 that aren't genuinely useful | 0 (currently several) |

### Write Quality

| Metric | How to measure | Target |
|--------|---------------|--------|
| Duplicate rate | L1 entries with near-identical content | 0 |
| Misplaced entries | L1 entries that should be in `working_state` | 0 |
| Entry format | % of entries that are one-liner declarative facts | >90% |
| L1 entry count after 1 week | Total active entries | Fewer than current (cleaner, not bloated) |

### Task Continuity

| Metric | How to measure | Target |
|--------|---------------|--------|
| Cross-session awareness | Start a task session → does agent know what was done in general chat? | Yes (via `working_state`) |
| Task status sync | After doing work in general chat, does the task entity reflect it? | Status + `working_state` both updated |
| Cross-task handoff | Open Task B that depends on Task A → does agent find Task A's context? | Yes (via L1 relationship + `get_task`) |

### How to test

1. **Clean all current memory** (yes, required — current entries are polluted with L2 noise, duplicates, and misplaced data)
2. Use the system for 3-5 days normally
3. Check the memory panel: are entries concise, non-duplicate, user-level?
4. Try the cross-session scenario: do task work in general chat → open task session → verify awareness
5. Check retrieval: ask the agent "what memories did you use this turn?" — are they relevant?

---

## Migration

Non-issue in dev mode — only one user, no production data to preserve.

### Steps

1. Drop all `memory_entries` rows (L1 + L2)
2. Keep L0 content (identity is still valid)
3. Add `working_state` column to tasks table (initially empty)
4. Change `projectId` → `projectIds` column
5. Add `embedding` BLOB column to memory_entries
6. Start fresh with clean write guidance

---

## Test Plan

### Prerequisites

- Run `npm run dev` — app starts without crash
- DB schema version = 4 (`PRAGMA user_version` returns 4)
- Embedding model loads at startup (log: `[Memory] Embedding model loaded`)

### Test 1: Schema Migration

**Steps:**
1. Delete existing DB: `del "$env:APPDATA/aide/data/aide.db"`
2. Start app → DB created fresh at v4
3. Inspect schema:
   ```powershell
   sqlite3 "$env:APPDATA/aide/data/aide.db" ".schema memory_entries"
   sqlite3 "$env:APPDATA/aide/data/aide.db" ".schema tasks"
   sqlite3 "$env:APPDATA/aide/data/aide.db" "PRAGMA user_version"
   ```

**Expected:**
- `memory_entries` has `embedding BLOB` column
- `tasks` has `project_ids TEXT NOT NULL DEFAULT '[]'` and `working_state TEXT`
- `user_version` = 4
- No L2 entries exist

### Test 2: Memory Write + Embedding

**Steps:**
1. Chat: "Remember that my preferred CI system is GitHub Actions"
2. Query DB:
   ```powershell
   sqlite3 "$env:APPDATA/aide/data/aide.db" "SELECT id, content, length(embedding) as embed_len FROM memory_entries ORDER BY created_at DESC LIMIT 1"
   ```

**Expected:**
- Entry exists with content about GitHub Actions
- `embed_len` is non-null (should be ~3000+ chars — JSON array of 384 floats)

### Test 3: FTS5 Retrieval (keyword match)

**Steps:**
1. Write a memory: "Remember that Alice is my tech lead at Contoso"
2. In a new message, ask: "What do you know about Alice?"

**Expected:**
- Agent uses the Alice memory in its response
- Check `recall_count` increased:
  ```powershell
  sqlite3 "$env:APPDATA/aide/data/aide.db" "SELECT content, recall_count FROM memory_entries WHERE content LIKE '%Alice%'"
  ```

### Test 4: Embedding Fallback (semantic match)

**Steps:**
1. Ensure a memory exists: "My boss prefers async communication over meetings"
2. Search with different words: ask the agent "How does my manager like to communicate?"

**Expected:**
- Agent retrieves the "boss prefers async" entry even though the query uses "manager" and "communicate" instead of "boss" and "async"
- If FTS5 misses (no keyword overlap), the embedding fallback fires and finds it

### Test 5: BM25 Threshold (noise rejection)

**Steps:**
1. Send a very short message: "ok" or "yes"
2. Check that no memories are injected (agent doesn't mention recalling anything)

**Expected:**
- Short/generic messages don't trigger spurious memory recalls
- The BM25 threshold filters out weak matches

### Test 6: Working_state on Tasks

**Steps:**
1. Open a task session
2. Ask the agent to do some work, e.g. "Research options for a caching layer"
3. The agent should update working_state during the session
4. Verify:
   ```powershell
   sqlite3 "$env:APPDATA/aide/data/aide.db" "SELECT title, working_state FROM tasks WHERE working_state IS NOT NULL"
   ```

**Expected:**
- `working_state` contains a summary of what was done/decided

### Test 7: Working_state Compaction

**Steps:**
1. Manually inflate a task's working_state past 1500 chars:
   ```powershell
   sqlite3 "$env:APPDATA/aide/data/aide.db" "UPDATE tasks SET working_state = printf('%01600d', 0) WHERE id = (SELECT id FROM tasks LIMIT 1)"
   ```
2. End the task session (close the chat or switch away)
3. Re-check the working_state length:
   ```powershell
   sqlite3 "$env:APPDATA/aide/data/aide.db" "SELECT length(working_state) FROM tasks WHERE working_state IS NOT NULL ORDER BY updated_at DESC LIMIT 1"
   ```

**Expected:**
- Length is now ~830 chars (truncated to last 800 + marker prefix)

### Test 8: ProjectIds + inferProjects

**Steps:**
1. Create a project named "codeToCloud" with a repo path
2. Create a task via external source (WeChat/Telegram) with title containing "codeToCloud"
3. Check:
   ```powershell
   sqlite3 "$env:APPDATA/aide/data/aide.db" "SELECT title, project_ids FROM tasks ORDER BY created_at DESC LIMIT 1"
   ```

**Expected:**
- `project_ids` JSON array contains the codeToCloud project's ID

### Test 9: L2 Removal

**Steps:**
1. Have a long chat session (10+ messages)
2. End the session
3. Check:
   ```powershell
   sqlite3 "$env:APPDATA/aide/data/aide.db" "SELECT count(*) FROM memory_entries WHERE layer = 'L2'"
   ```

**Expected:**
- Count is 0 — no L2 entries created

### Test 10: Write Deduplication

**Steps:**
1. Tell the agent: "Remember my favorite language is TypeScript"
2. In a later message: "Remember that I prefer TypeScript"
3. Check entry count:
   ```powershell
   sqlite3 "$env:APPDATA/aide/data/aide.db" "SELECT content FROM memory_entries WHERE content LIKE '%TypeScript%'"
   ```

**Expected:**
- Only ONE entry about TypeScript (updated, not duplicated)
- This relies on the "search first, update if exists" write guidance

### Test 11: Cross-Session Task Continuity

**Steps:**
1. In general chat: "For task X, I've decided to use Redis for caching"
2. Agent should call `update_task(X, { working_state: '...' })`
3. Open task X's dedicated session

**Expected:**
- Agent knows about the Redis decision without being told again
- `working_state` contains the Redis context

### Test 12: Task Session Prompt (empty projectIds)

**Steps:**
1. Create a task with no projectIds
2. Open its session

**Expected:**
- System prompt includes guidance to set projectIds if determinable
- Agent attempts to link it to a project based on context

### Smoke Test Sequence (quick validation)

1. `npm run dev` — no crash
2. Log shows `[Memory] Embedding model loaded`
3. General chat → no crash, agent responds
4. Write a memory → DB has entry with embedding
5. Search with paraphrase → embedding fallback finds it
6. Open task session → working_state prompt visible
7. Long session → no L2 entries afterward

