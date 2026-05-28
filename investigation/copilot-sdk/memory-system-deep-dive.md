# GitHub Copilot SDK — Session Persistence, Memory & Context Management Deep Dive

**Repository:** `github.com/github/copilot-sdk`  
**Languages:** TypeScript (Node.js), Python, Go, Rust, Java, .NET  
**Architecture:** SDK → JSON-RPC → Copilot CLI (server mode)

---

## 1. Session Persistence

### How It Works

Sessions follow a lifecycle: **Create → Active → Paused → Resume**

```
~/.copilot/session-state/
└── {sessionId}/
    ├── checkpoints/           # Conversation history snapshots
    │   ├── 001.json          # Initial state
    │   ├── 002.json          # After first interaction
    │   └── ...               # Incremental checkpoints
    ├── plan.md               # Agent's planning state (if any)
    └── files/                # Session artifacts
        ├── analysis.md       # Files the agent created
        └── notes.txt         # Working documents
```

### What Gets Persisted

| Data | Persisted? | Notes |
|------|------------|-------|
| Conversation history | ✅ Yes | Full message thread |
| Tool call results | ✅ Yes | Cached for context |
| Agent planning state | ✅ Yes | `plan.md` file |
| Session artifacts | ✅ Yes | In `files/` directory |
| Provider/API keys | ❌ No | Security: must re-provide |
| In-memory tool state | ❌ No | Tools should be stateless |

### Key API (TypeScript)

```typescript
import { CopilotClient } from "@github/copilot-sdk";

const client = new CopilotClient();

// Create a resumable session with a specific ID
const session = await client.createSession({
    sessionId: "user-123-task-456",  // Provide your own ID for persistence
    model: "gpt-4.1",
    onPermissionRequest: approveAll,
});

// Send messages (state is persisted automatically)
await session.sendAndWait({ prompt: "Hello" });

// Disconnect — releases in-memory resources, preserves disk state
await session.disconnect();

// Resume later (full conversation history restored)
const resumed = await client.resumeSession("user-123-task-456", {
    onPermissionRequest: approveAll,
});

// List all sessions
const sessions = await client.listSessions();

// Filter by repository
const repoSessions = await client.listSessions({ repository: "owner/repo" });

// Permanently delete (irreversible)
await client.deleteSession("user-123-task-456");
```

### `disconnect()` vs `deleteSession()`

- **`disconnect()`** — Releases in-memory resources but keeps session data on disk for later resumption.
- **`deleteSession()`** — Permanently removes everything: conversation history, planning state, artifacts.

### Session Resume Metadata (from generated types)

```typescript
interface SessionResumeData {
    alreadyInUse?: boolean;          // Session was in use by another client
    context?: WorkingDirectoryContext; // Updated working directory and git context
    // When true, pending tool calls remain pending after resume
    // When false (default), pending work is interrupted
}
```

### Session Forking

Sessions can be **forked** — creating a branch from a specific point in conversation:

```typescript
const fork = await client.rpc.sessions.fork({ sessionId: session.sessionId });
// fork.sessionId is a new session with the parent's history cloned
const forkedSession = await client.resumeSession(fork.sessionId, { ... });

// Fork to a specific event (exclude events after boundary)
const fork = await client.rpc.sessions.fork({
    sessionId: session.sessionId,
    toEventId: boundaryEventId,  // Everything after this is excluded
});
```

### Context-Aware Session Lookup

```typescript
// Find the most relevant prior session for a working directory
const result = await client.rpc.sessions.getLastForContext({
    workingDirectory: "/path/to/project",
});
// result.sessionId — most relevant session, or undefined
```

---

## 2. Built-in "Memory" Concept

### The SDK has a `PermissionRequestMemory` type

The SDK defines a **memory permission** system — the agent can request to store/vote on "facts":

```typescript
// From nodejs/src/generated/session-events.ts
interface PermissionPromptRequestMemory {
    kind: "memory";
    action?: PermissionRequestMemoryAction;   // "store" | "vote"
    direction?: PermissionRequestMemoryDirection; // Vote direction
    fact: string;                              // The fact being stored or voted on
    subject?: string;                          // Topic/subject of the memory (store only)
    citations?: string;                        // Source references (store only)
    reason?: string;                           // Reason for the vote (vote only)
    toolCallId?: string;                       // Tool call that triggered this
}
```

This means the Copilot CLI **has built-in memory operations** — it can store facts and recall them. But this is mediated through the permission system (your app approves/denies memory operations).

### What this means for us

The SDK surfaces memory operations as permission requests. You can:
1. Observe what the agent wants to remember
2. Approve/deny memory storage
3. Build your own storage on top of these signals

**However**: The built-in memory is Copilot's own system. There's no documented API to **inject** memories or **query** the memory store directly from your app code.

---

## 3. Context Window Management

### Infinite Sessions (Automatic Compaction)

**Enabled by default.** The SDK automatically manages context window limits via LLM-powered summarization.

```typescript
interface InfiniteSessionConfig {
    enabled?: boolean;                      // Default: true
    backgroundCompactionThreshold?: number; // Default: 0.80 (80% context usage)
    bufferExhaustionThreshold?: number;     // Default: 0.95 (95% — blocks until done)
}

// Usage
const session = await client.createSession({
    model: "gpt-4.1",
    infiniteSessions: {
        enabled: true,
        backgroundCompactionThreshold: 0.80,
        bufferExhaustionThreshold: 0.95,
    },
});
```

### How Compaction Works

1. At **80% context usage** → background compaction starts (async, session continues)
2. At **95% context usage** → forced compaction (blocks until done)
3. Older messages are summarized by an LLM into a condensed form
4. Checkpoints are saved for recovery

### Compaction Events

```typescript
// session.compaction_start
interface CompactionStartData {
    conversationTokens?: number;
    systemTokens?: number;
    toolDefinitionsTokens?: number;
}

// session.compaction_complete
interface SessionCompactionCompleteData {
    success: boolean;
    summaryContent?: string;          // LLM-generated summary of compacted history
    preCompactionTokens?: number;
    postCompactionTokens?: number;
    preCompactionMessagesLength?: number;
    messagesRemoved?: number;
    tokensRemoved?: number;
    checkpointNumber?: number;        // Checkpoint snapshot for recovery
    checkpointPath?: string;          // File path of checkpoint
    compactionTokensUsed?: {          // Cost of compaction itself
        inputTokens?: number;
        outputTokens?: number;
        model?: string;
        duration?: number;            // ms
    };
}
```

### Truncation (Fallback when compaction isn't enabled)

```typescript
interface TruncationData {
    tokenLimit: number;
    preTruncationMessagesLength: number;
    preTruncationTokensInMessages: number;
    postTruncationMessagesLength: number;
    postTruncationTokensInMessages: number;
    messagesRemovedDuringTruncation: number;
    tokensRemovedDuringTruncation: number;
    performedBy: string;  // e.g., "BasicTruncator"
}
```

### Manual Compaction

You can trigger compaction explicitly:

```typescript
// TypeScript
const result = await session.rpc.history.compact();
// result: { success, tokensRemoved, messagesRemoved, contextWindow }

// Java
session.compact();  // Triggers immediate summarization
```

### Context Window Usage Monitoring

```typescript
// session.usage_info event (ephemeral — not persisted)
interface UsageInfoData {
    tokenLimit: number;        // Max tokens for the model
    currentTokens: number;     // Current tokens in context
    messagesLength: number;    // Current message count
    systemTokens?: number;
    conversationTokens?: number;
    toolDefinitionsTokens?: number;
}

// RPC for on-demand context info
interface HistoryCompactContextWindow {
    tokenLimit: number;
    currentTokens: number;
    messagesLength: number;
    systemTokens?: number;
    conversationTokens?: number;
    toolDefinitionsTokens?: number;
}
```

### Re-tokenize on Resume

```rust
// Rust RPC — re-tokenize session messages against a model
session.rpc.metadata.recompute_context_tokens(model_id)
// Returns token totals; useful for getting initial context usage on resume
```

---

## 4. Hooks / Lifecycle Events

### Available Hooks

```typescript
interface SessionHooks {
    onPreToolUse?: PreToolUseHandler;
    onPreMcpToolCall?: PreMcpToolCallHandler;
    onPostToolUse?: PostToolUseHandler;
    onUserPromptSubmitted?: UserPromptSubmittedHandler;
    onSessionStart?: SessionStartHandler;
    onSessionEnd?: SessionEndHandler;
    onErrorOccurred?: ErrorOccurredHandler;
}
```

### `onSessionStart` — Key for Memory Injection

```typescript
type SessionStartHandler = (
    input: SessionStartHookInput,
    invocation: { sessionId: string }
) => Promise<SessionStartHookOutput | void>;

interface SessionStartHookInput {
    timestamp: number;
    cwd: string;
    source: "startup" | "resume" | "new";
    initialPrompt?: string;
    workingDirectory: string;
}

interface SessionStartHookOutput {
    additionalContext?: string;   // ← INJECT MEMORY HERE
    modifiedConfig?: object;      // Override session configuration
}
```

**This is the primary extension point for memory injection.** On every session start/resume, you can load relevant memories and inject them as `additionalContext`.

### `onSessionEnd` — Key for Memory Extraction

```typescript
type SessionEndHandler = (
    input: SessionEndHookInput,
    invocation: { sessionId: string }
) => Promise<SessionEndHookOutput | void>;

interface SessionEndHookInput {
    reason: "complete" | "error" | "abort" | "timeout" | "user_exit";
    finalMessage?: string;
    error?: string;
    timestamp: number;
    cwd: string;
}

interface SessionEndHookOutput {
    suppressOutput?: boolean;
    cleanupActions?: string[];
    sessionSummary?: string;  // ← PERSIST SUMMARY FOR FUTURE REFERENCE
}
```

### `onPostToolUse` — Observe Tool Results

```typescript
interface PostToolUseHookInput {
    toolName: string;
    toolResult: unknown;
    // ... can observe what tools returned and extract facts
}
```

### `onUserPromptSubmitted` — Intercept/Modify Prompts

```typescript
interface UserPromptSubmittedHookInput {
    prompt: string;
}

interface UserPromptSubmittedHookOutput {
    modifiedPrompt?: string;  // ← AUGMENT PROMPT WITH MEMORIES
}
```

---

## 5. Multi-Turn Conversation State

### What is persisted across turns (within a session)

- Full conversation history (user messages, assistant messages, tool calls/results)
- Planning state (`plan.md`)
- Session artifacts (files created by the agent)
- Compaction checkpoints

### Getting Events/History

```typescript
// Get all session events (the full event log)
const events = await session.getEvents();

// History truncation RPC
await session.rpc.history.truncate({ toEventId: someEventId });
// Removes that event and all later events
```

### Stateful Conversations (test confirms)

```typescript
// Multi-turn state is maintained:
const first = await session.sendAndWait({ prompt: "What is 1+1?" });
// → "2"
const second = await session.sendAndWait({ prompt: "Now double that" });
// → "4" (remembers context from first message)
```

---

## 6. Tools / Skills as Memory Access Points

### Custom Tool Definition (TypeScript)

```typescript
import { defineTool } from "@github/copilot-sdk";

const memoryTool = defineTool("recall_memory", {
    description: "Recall stored memories about a topic",
    parameters: z.object({
        topic: z.string().describe("The topic to recall memories about"),
    }),
    handler: async ({ topic }) => {
        // Your custom memory retrieval logic
        const memories = await myMemoryStore.query(topic);
        return { memories };
    },
});

const session = await client.createSession({
    tools: [memoryTool],
    onPermissionRequest: approveAll,
});
```

### Tool Interface

```typescript
interface Tool<TArgs = unknown> {
    name: string;
    description?: string;
    parameters?: ZodSchema<TArgs> | Record<string, unknown>;
    handler?: ToolHandler<TArgs>;
    overridesBuiltInTool?: boolean;
    skipPermission?: boolean;  // Execute without permission prompt
}
```

### ToolInvocation Context

```python
@dataclass
class ToolInvocation:
    session_id: str
    tool_call_id: str
    tool_name: str
    arguments: dict
```

### Skills System

The SDK has a `skills` concept — preloadable context files:

```typescript
// Custom agents can specify skills to preload
interface CustomAgentConfig {
    name: string;
    prompt: string;
    tools?: string[] | null;
    skills?: string[];          // Skill names to preload into agent context
    mcpServers?: object;
}
```

Skills emit `skill.invoked` events:
```rust
struct SkillInvokedData {
    name: String,
    content: String,           // Full content injected into conversation
    description: Option<String>,
    path: String,              // Path to SKILL.md
    allowed_tools: Vec<String>,
    plugin_name: Option<String>,
}
```

---

## 7. Session Management API Summary

### Client-Level Methods

| Method | Description |
|--------|-------------|
| `createSession(config)` | Create a new session |
| `resumeSession(sessionId, config)` | Resume existing session |
| `listSessions(filter?)` | List all sessions |
| `deleteSession(sessionId)` | Permanently delete session data |
| `getSessionMetadata(sessionId)` | Get session metadata |
| `rpc.sessions.fork({sessionId, toEventId?})` | Fork a session |
| `rpc.sessions.getLastForContext({workingDirectory})` | Find relevant session |

### Session-Level Methods

| Method | Description |
|--------|-------------|
| `sendAndWait(options)` | Send message, wait for response |
| `send(options)` | Send without waiting |
| `on(handler)` | Subscribe to events |
| `getEvents()` | Get full event history |
| `disconnect()` | Release resources, preserve state |
| `abort()` | Cancel current processing |
| `rpc.history.compact()` | Manual compaction |
| `rpc.history.truncate({toEventId})` | Truncate history |
| `rpc.metadata.recomputeContextTokens(modelId)` | Re-tokenize |

### SessionConfig (TypeScript)

```typescript
interface SessionConfig {
    sessionId?: string;
    model?: string;
    streaming?: boolean;
    tools?: Tool[];
    availableTools?: string[];      // Allowlist of built-in tool names
    excludedTools?: string[];       // Blocklist of built-in tool names
    systemMessage?: SystemMessageConfig;
    hooks?: SessionHooks;
    infiniteSessions?: InfiniteSessionConfig;
    onPermissionRequest: PermissionHandler;
    createSessionFsProvider?: (session) => SessionFsProvider;
    agents?: CustomAgentConfig[];   // Sub-agent definitions
    skillDirectories?: string[];    // Directories to load skills from
}
```

---

## 8. Streaming & State

### Event-Driven Architecture

All state changes are communicated via session events. Key event types:

```typescript
// Message events
"user.message"               // User sent a message
"assistant.message"          // Complete assistant response
"assistant.message_delta"    // Streaming chunk

// Tool events
"tool.call"                  // Agent wants to call a tool
"tool.result"                // Tool execution result

// Lifecycle events
"session.idle"               // Session is idle (done processing)
"session.compaction_start"   // Compaction began
"session.compaction_complete" // Compaction finished
"session.truncation"         // Truncation occurred
"session.usage_info"         // Context window stats (ephemeral)
"session.resume"             // Session was resumed
"session.context_changed"    // Working directory changed

// Hook events
"hook.start"                 // Hook invocation began
"hook.end"                   // Hook invocation completed
```

### Event Subscription (TypeScript)

```typescript
session.on((event) => {
    switch (event.type) {
        case "assistant.message_delta":
            process.stdout.write(event.data.deltaContent);
            break;
        case "session.compaction_complete":
            console.log(`Compacted: removed ${event.data.tokensRemoved} tokens`);
            break;
        case "session.usage_info":
            console.log(`Context: ${event.data.currentTokens}/${event.data.tokenLimit}`);
            break;
    }
});
```

### Event Persistence

- Most events are **persisted** to disk in `events.jsonl`
- Events marked `ephemeral: true` are transient (not persisted)
- `session.usage_info` is ephemeral

---

## 9. Extension Points for Custom Persistence/Memory

### A. SessionFsProvider — Custom Storage Backend

The most powerful extension point. Replaces the default filesystem with YOUR storage:

```typescript
interface SessionFsProvider {
    readFile(path: string): Promise<string>;
    writeFile(path: string, content: string, mode?: number): Promise<void>;
    appendFile(path: string, content: string, mode?: number): Promise<void>;
    exists(path: string): Promise<boolean>;
    stat(path: string): Promise<SessionFsFileInfo>;
    mkdir(path: string, recursive: boolean, mode?: number): Promise<void>;
    readdir(path: string): Promise<string[]>;
    readdirWithTypes(path: string): Promise<SessionFsReaddirWithTypesEntry[]>;
    rm(path: string, recursive: boolean, force: boolean): Promise<void>;
    rename?(src: string, dest: string): Promise<void>;
    
    // Optional SQLite support
    sqlite?: SessionFsSqliteProvider;
}

interface SessionFsSqliteProvider {
    query(sql: string, params?: Record<string, unknown>): Promise<SqliteQueryResult>;
    exists(path: string): Promise<boolean>;
}
```

Usage:
```typescript
const client = new CopilotClient({
    sessionFs: {
        initialCwd: "/path/to/workspace",
        sessionStatePath: ".session-state",
        conventions: "posix",
        capabilities: { sqlite: true },
    },
});

const session = await client.createSession({
    createSessionFsProvider: (session) => new MyCloudStorageProvider(session.sessionId),
    onPermissionRequest: approveAll,
});
```

This means you can back sessions with:
- Cloud storage (S3, Azure Blob, GCS)
- Databases
- In-memory stores
- Virtual filesystems
- Any custom storage

### B. Hooks for Memory Layer

```typescript
const session = await client.createSession({
    hooks: {
        // Inject memories at session start
        onSessionStart: async (input, { sessionId }) => {
            const memories = await myMemoryDB.getRelevant(sessionId, input.cwd);
            return {
                additionalContext: formatMemoriesAsContext(memories),
            };
        },
        
        // Observe/modify user prompts (augment with RAG)
        onUserPromptSubmitted: async (input, { sessionId }) => {
            const relevant = await myMemoryDB.search(input.prompt);
            return {
                modifiedPrompt: `${input.prompt}\n\n[Relevant context: ${relevant}]`,
            };
        },
        
        // Extract facts from tool results
        onPostToolUse: async (input, { sessionId }) => {
            await extractAndStoreFacts(sessionId, input.toolName, input.toolResult);
            return null;
        },
        
        // Save session summary on end
        onSessionEnd: async (input, { sessionId }) => {
            const summary = await generateSessionSummary(sessionId);
            await myMemoryDB.saveSessionSummary(sessionId, summary);
            return { sessionSummary: summary };
        },
    },
});
```

### C. Custom Tools for Memory Access

```typescript
const storeMemory = defineTool("store_memory", {
    description: "Store an important fact for future reference",
    parameters: z.object({
        fact: z.string(),
        topic: z.string(),
        importance: z.enum(["low", "medium", "high"]),
    }),
    handler: async ({ fact, topic, importance }, invocation) => {
        await myMemoryDB.store({ fact, topic, importance, sessionId: invocation.sessionId });
        return { stored: true };
    },
    skipPermission: true,  // No user approval needed
});

const recallMemory = defineTool("recall_memory", {
    description: "Recall stored memories about a topic",
    parameters: z.object({
        query: z.string(),
        limit: z.number().optional(),
    }),
    handler: async ({ query, limit }) => {
        return await myMemoryDB.search(query, limit ?? 5);
    },
    skipPermission: true,
});
```

### D. Docker Volume Mount for Container Persistence

```yaml
volumes:
  - session-data:/root/.copilot/session-state
```

---

## 10. Summary: What the SDK Provides vs What We Must Build

### SDK Provides

| Capability | Details |
|------------|---------|
| **Session persistence** | Full conversation history to disk, resumable |
| **Session forking** | Branch conversations from any point |
| **Context-aware session lookup** | Find most relevant session for a directory |
| **Automatic context compaction** | LLM-powered summarization at configurable thresholds |
| **Truncation fallback** | Hard truncation when compaction isn't enabled |
| **Session events** | Full event stream with persistence |
| **Lifecycle hooks** | `onSessionStart`, `onSessionEnd`, `onPreToolUse`, `onPostToolUse`, `onUserPromptSubmitted`, `onErrorOccurred` |
| **Custom tools** | Define tools the agent can call back into your code |
| **Custom filesystem provider** | Replace underlying storage with any backend |
| **Memory permission events** | Observe when agent wants to store/recall facts |
| **Usage monitoring** | Token counts, context window stats |
| **Manual compaction** | Programmatic history compaction |

### We Must Build

| Capability | Why |
|------------|-----|
| **Cross-session memory** | SDK sessions are isolated; no shared memory between sessions |
| **Semantic memory retrieval** | No vector search, embeddings, or semantic matching |
| **Structured knowledge graph** | No entity/relation modeling beyond flat facts |
| **Memory importance/decay** | No scoring, aging, or relevance ranking |
| **Memory consolidation** | No automatic synthesis of related facts |
| **User preference learning** | No automatic extraction of patterns |
| **Proactive memory injection** | Must use hooks to inject at the right time |
| **Memory conflict resolution** | No handling of contradictory facts |
| **Memory scoping** | Must implement our own project/user/global scoping |
| **Memory search & indexing** | Must implement our own query layer |

### Architecture for a Memory Layer on Top of Copilot SDK

```
┌─────────────────────────────────────────────┐
│              Your Application                │
├─────────────────────────────────────────────┤
│         Memory Layer (YOU BUILD)             │
│  ┌─────────┐ ┌──────────┐ ┌─────────────┐  │
│  │ Semantic │ │ Knowledge│ │  Memory     │  │
│  │ Search   │ │ Graph    │ │  Scoping    │  │
│  └─────────┘ └──────────┘ └─────────────┘  │
├─────────────────────────────────────────────┤
│    Integration Layer (hooks + tools)         │
│  onSessionStart → inject memories           │
│  onPostToolUse  → extract facts             │
│  onSessionEnd   → save summary              │
│  custom tools   → agent-initiated memory    │
├─────────────────────────────────────────────┤
│         GitHub Copilot SDK                   │
│  Sessions, Compaction, Events, Tools         │
├─────────────────────────────────────────────┤
│         Copilot CLI (JSON-RPC)              │
│  LLM calls, built-in tools, context mgmt   │
└─────────────────────────────────────────────┘
```
