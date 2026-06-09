# Memory

Memory subsystem design.

## Design principles

1. **Unbounded information growth vs. a finite context window** — the core tension, which mandates a retrieval layer
2. **Some memories must always be present** — the core profile is injected into every session, not dependent on retrieval
3. **Dual-channel writes** — the agent writes proactively + the system fills gaps with a narrow scope, complementary coverage
4. **Zero ML dependency** — no local neural embedding model; uses FTS5 + structured tags
5. **The user owns the data** — every memory can be viewed, edited, and deleted
6. **Don't redo the SDK's work** — the SDK manages in-session conversation history and compaction; Memory manages cross-session persistent knowledge
7. **Errors are correctable** — when a memory is wrong there must be a mechanism to detect and fix it; a wrong memory must not propagate indefinitely

## Layered architecture

| Layer | Name | Role | Loading strategy | Write method | Capacity |
|---|---|---|---|---|---|
| L0 | Identity | The user's core profile | Injected into the system prompt at session start | Agent-driven + direct user edits | 1K chars hard limit |
| L1 | Knowledge | Long-term learned facts, conventions, experience | Top-K retrieved each turn, injected into the user message | Agent-driven + gap-fill extraction at session end | Unbounded |
| L2 | Archive | Archived history | Usually not loaded, retrieved on demand | System-automatic (session end / Task completion) | Unbounded |

The three layers have clear roles: L0 is always present, L1 is retrieved by relevance, L2 only triggers when history is queried. Working memory does not belong to the Memory system — it's managed by the Task entity + the SDK session.

### L0 Identity

The user's core identity information, injected in full into the system prompt at every session start. Not dependent on retrieval.

**Layering criterion**: with no context at all (not knowing what the user wants to do), does the agent need to know this? Yes → L0, no → L1.

Content types:
- Name, role, organization
- Core work preferences (communication style, language, timezone)
- Key constraints ("never...", "I always...")
- Tool-environment summary (OS, primary editor, common tech stack)

Capacity management: a 1K-character hard limit. L0 is injected in full every turn, so it must stay at the "a few core facts" size. When full, the agent must merge or evict old entries before writing new content. The hard limit forces quality — keep only the most important.

Format: structured Markdown, divided into sections. Both the agent and the user can edit it directly.

### L1 Knowledge

The long-term accumulated knowledge base, the main body of the Memory system.

Content types:
- Facts the user has corrected (written with the highest priority)
- Work conventions ("this project's deployment process is...")
- Technical knowledge ("this API's rate limit is...")
- Interpersonal information ("Zhang San approves the budget")
- Recurring patterns

Loading logic: each turn, the system uses the user's current message as a query to retrieve the top-K relevant memories and injects them into the user message (not the system prompt, to protect the KV cache).

### L2 Archive

The archived-history layer, accessed infrequently.

Content types:
- Summaries of completed Tasks (what was done, conclusions, key decisions)
- Session summaries not bound to a Task (archives of free-form conversation)
- A timeline of historical events

Loading logic: usually not loaded. Two situations trigger retrieval:
1. The user explicitly asks about history ("how did we fix that bug last week?")
2. The system detects that the current problem is highly relevant to a historical task

When a Task completes: the Task's accumulated working state is archived to L2, and the Task entity keeps only metadata (title, time, status, associations). The detailed content lives in L2.

## Division of labor with the Copilot SDK

| Responsibility | Who handles it |
|------|------|
| In-session conversation history | SDK (auto-persisted) |
| Context-window compaction | SDK (automatic compaction at 80%/95%) |
| Session recovery | SDK (`resumeSession()`) |
| Cross-session user profile | Memory L0 |
| Cross-session knowledge accumulation | Memory L1 |
| History archiving and retrieval | Memory L2 |
| Task working state | The Task entity's own fields |

**SDK hook usage:**
- `onSessionStart` → inject L0 Identity + the active Task's working state (from the Task entity)
- `onUserPromptSubmitted` → use the user message as a query, retrieve and inject L1 Knowledge
- `onSessionEnd` → get the session summary → update the Task working state; trigger gap-fill extraction

## Write mechanism

### Channel 1: Agent-driven writes

The agent writes in real time via the memory tool.

Tool design:
```
memory_write:
  action: add | update | remove
  layer: L0 | L1           # the agent can only write L0 and L1
  content: string           # new content
  target_id?: string        # specify the target for update/remove
  tags?: string[]           # structured tags (Project association, classification)
```

Write guidance (injected into the system prompt):
- **Do record**: user corrections, explicit preferences, stable facts, tool environment, relationships
- **Don't record**: task progress, transient in-session state, information that expires quickly, data that can be queried live from external systems
- **Format**: declarative facts, not instructions ("the user prefers concise replies" ✓, "always reply concisely" ✗)

**Error-correction rule**: when the user corrects the agent, the agent must not only write the correct fact but also **check whether an existing wrong memory caused this error**. If so, update or remove it. It can't just add the new one and ignore the old.

### Channel 2: System gap-fill extraction

At session end, the system does a **narrow-scope** extraction (not a full extraction of all knowledge):

1. Check whether the user corrected the agent but the agent didn't call memory_write → backfill into L1
2. Check whether the user explicitly stated a preference/fact but the agent didn't store it → backfill into L1
3. Generate a session summary → file into L2 (if the session is bound to a Task, also update the Task working state)

It **does not** do a full "extract all implicit knowledge from the conversation" — that produces a flood of low-quality/duplicate entries and is hard to deduplicate.

### Automatic L2 writes

L2 Archive is written automatically by the system on specific events:
- Session ends → the session summary is filed into L2
- Task completes → the Task working state is archived to L2, and the Task entity clears its detailed state

## Retrieval mechanism

L1 and L2 retrieval uses FTS5 + structured filtering.

### Retrieval methods

1. **FTS5 full-text search** — BM25 ranking, handles keywords, proper nouns, names, technical terms
2. **Structured filtering** — narrows the candidate set by Project association, tags, and time range

The two result sets are fused and ranked by:
- FTS5 BM25 relevance score
- Time decay (recent items weighted slightly, not aggressively)
- Source trustworthiness (user correction > agent-driven > system-automatic)

**Why there's no vector search:** v1 doesn't introduce HRR or embeddings. FTS5 + structured tags cover most retrieval scenarios. If real-world use reveals insufficient retrieval quality (poor semantic-approximation matching), we'll evaluate introducing a solution then. We don't add unverified components just to "look complete".

### Injection method

Retrieval results are injected into the user message (following the Hermes Holographic pattern), not polluting the system prompt:

```
<memory-context>
[relevant retrieved memory entries]
</memory-context>

[the user's actual message]
```

## Storage design

A single SQLite database.

```sql
CREATE TABLE memory_entries (
  id          TEXT PRIMARY KEY,
  layer       TEXT NOT NULL,        -- 'L0' | 'L1' | 'L2'
  content     TEXT NOT NULL,
  source      TEXT NOT NULL,        -- 'agent' | 'system' | 'user'
  status      TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'inactive'
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  task_id     TEXT,                 -- the Task an L2 archive is associated with
  project_id  TEXT,                 -- associated Project (for retrieval filtering)
  tags        TEXT,                 -- JSON array
  recall_count INTEGER DEFAULT 0,  -- number of times hit by retrieval

  FOREIGN KEY (task_id) REFERENCES tasks(id),
  FOREIGN KEY (project_id) REFERENCES projects(id)
);

-- FTS5 index
CREATE VIRTUAL TABLE memory_fts USING fts5(
  content,
  tags,
  content='memory_entries',
  content_rowid='rowid'
);
```

## Forgetting strategy

**L0**: no automatic forgetting. A 1K-character hard limit; when full, the agent manages it itself (merge/delete).

**L1**: no proactive deletion. Corrected entries are marked `status = 'inactive'` (preserving the audit trail, but no longer returned by retrieval). If the volume eventually grows large enough to degrade retrieval quality, consider merging semantically duplicate entries.

**L2**: kept permanently. It's the user's work history and should not be deleted by the system.

**The user can always manually delete any entry in any layer.**

## Observability

The Memory system must be inspectable, not a black box:

- **Retrieval logs**: each turn's query, returned results, and scores are recorded in a local log (for debugging)
- **Citation transparency**: when the agent uses memory information, it should note the source in its answer ("according to earlier records...")
- **User queries**: the user can ask "which memories did you use this turn?" and the agent can list them
- **Memory panel**: the UI lets you browse all memories and see recall_count, source, and status

## User control

- **View**: the Memory panel shows all memories, grouped by layer, with search and filtering
- **Edit**: L0 is edited directly (the user profile). L1 content and tags can be edited
- **Delete**: any entry can be deleted
- **Correct**: when the user corrects the agent in conversation, the agent proactively updates the relevant memory (including cleaning up the wrong old entry)
- **Export**: full export to JSON/Markdown

## Relationships with other entities

- **Task** → a Task maintains its own working state; archived to L2 on completion; L1 entries can be tagged with an associated Task
- **Project** → L1 entries can be tagged with an associated Project (used for retrieval filtering)
- **Connection** → not directly involved in Memory (it's on the tool side), but information obtained from a Connection can be written to L1
- **Skill** → not involved in Memory (tool side)
- **Job** → when generating daily/weekly reports, retrieves Task summaries within the time range from L2

## To be refined

- How large to set top-K for L1 retrieval (context budget allocation)
- The token-budget cap for memory-context injection
- The concrete prompt design for gap-fill extraction
- How to display L0 usage (referencing Hermes's percentage display)
- The criteria for evaluating an upgrade path when FTS5 retrieval quality is insufficient
