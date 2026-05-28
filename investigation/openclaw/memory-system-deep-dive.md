# OpenClaw Memory System — Deep Technical Analysis

## 1. Storage Format & Directory Structure

### File Layout (in agent workspace, default `~/.openclaw/workspace`)

```
~/.openclaw/workspace/
├── MEMORY.md                          # Long-term memory (curated, durable facts)
├── memory/
│   ├── YYYY-MM-DD.md                  # Daily notes (working layer)
│   ├── YYYY-MM-DD-<slug>.md           # Slugged variant daily notes
│   ├── .dreams/
│   │   ├── short-term-recall.json     # Short-term recall tracking store
│   │   ├── phase-signals.json         # Dreaming phase reinforcement signals
│   │   ├── short-term-promotion.lock  # File-based lock for concurrent access
│   │   └── session-corpus/
│   │       └── YYYY-MM-DD.txt         # Redacted session transcripts
│   └── dreaming/
│       ├── light/
│       │   └── YYYY-MM-DD.md          # Light dreaming phase reports
│       ├── deep/
│       │   └── YYYY-MM-DD.md          # Deep dreaming phase reports  
│       └── rem/
│           └── YYYY-MM-DD.md          # REM dreaming phase reports
├── DREAMS.md                          # Dream Diary (human-readable summaries)
└── ...
```

### Index Storage

```
~/.openclaw/memory/<agentId>.sqlite    # Per-agent SQLite database
```

### SQLite Schema (from `packages/memory-host-sdk/src/host/memory-schema.ts`)

```sql
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY,
  source TEXT NOT NULL DEFAULT 'memory',
  hash TEXT NOT NULL,
  mtime INTEGER NOT NULL,
  size INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'memory',
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  hash TEXT NOT NULL,
  model TEXT NOT NULL,
  text TEXT NOT NULL,
  embedding TEXT NOT NULL,    -- JSON-serialized float array
  updated_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path);
CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source);

-- FTS5 virtual table (when hybrid search enabled)
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  text,
  id UNINDEXED,
  path UNINDEXED,
  source UNINDEXED,
  model UNINDEXED,
  start_line UNINDEXED,
  end_line UNINDEXED
  -- tokenize='trigram case_sensitive 0'  (for CJK)
  -- or unicode61 (default)
);

-- Vector table (sqlite-vec extension)
-- Table: chunks_vec

-- Embedding cache table
-- Table: embedding_cache
```

### Short-Term Recall Store Schema (`memory/.dreams/short-term-recall.json`)

```typescript
type ShortTermRecallStore = {
  version: 1;
  updatedAt: string;  // ISO timestamp
  entries: Record<string, ShortTermRecallEntry>;
};

type ShortTermRecallEntry = {
  key: string;              // e.g. "memory:memory/2026-04-03.md:1:2"
  path: string;             // e.g. "memory/2026-04-03.md"
  startLine: number;
  endLine: number;
  source: "memory";
  snippet: string;          // The recalled text
  recallCount: number;      // How many times recalled
  dailyCount: number;       // Daily ingestion signal count
  groundedCount: number;    // Grounded backfill signals
  totalScore: number;       // Cumulative retrieval scores
  maxScore: number;         // Highest single retrieval score
  firstRecalledAt: string;  // ISO timestamp
  lastRecalledAt: string;   // ISO timestamp
  queryHashes: string[];    // Up to 32 unique query hashes
  recallDays: string[];     // Up to 16 distinct days recalled
  conceptTags: string[];    // Derived concept tags from snippet/path
  claimHash?: string;       // Content-based dedup hash
  promotedAt?: string;      // When promoted to MEMORY.md
};
```

### Phase Signal Store Schema (`memory/.dreams/phase-signals.json`)

```typescript
type ShortTermPhaseSignalStore = {
  version: 1;
  updatedAt: string;
  entries: Record<string, ShortTermPhaseSignalEntry>;
};

type ShortTermPhaseSignalEntry = {
  key: string;
  lightHits: number;    // Times seen in light dreaming
  remHits: number;      // Times seen in REM dreaming
  lastLightAt?: string;
  lastRemAt?: string;
};
```

---

## 2. Memory Types

OpenClaw distinguishes the following memory layers:

### Long-Term Memory (`MEMORY.md`)
- **Purpose**: Durable facts, preferences, standing decisions, compact summaries
- **Loaded**: At the start of every DM session (injected into bootstrap prompt)
- **Budget**: Truncated if it exceeds the bootstrap file budget (default ~10,000 chars)
- **Written by**: Deep dreaming phase (automatic) or manual curation

### Short-Term / Working Memory (`memory/YYYY-MM-DD.md`)
- **Purpose**: Daily notes, observations, session summaries, raw context
- **Loaded**: Today's and yesterday's notes loaded automatically
- **Indexed**: Available via `memory_search` and `memory_get` tools
- **NOT injected** into the normal bootstrap prompt on every turn

### Session Memory (experimental)
- **Source**: `"sessions"` in the index
- **Purpose**: Session transcripts indexed for recall
- **Stored in**: `memory/.dreams/session-corpus/YYYY-MM-DD.txt`

### Dream Diary (`DREAMS.md`)
- **Purpose**: Human-readable dreaming sweep summaries
- **Written by**: Light, Deep, and REM phases
- **Not loaded into context** automatically

### Memory-LanceDB (alternative plugin)
Categorized long-term memory with explicit categories:
```typescript
const MEMORY_CATEGORIES = ["preference", "fact", "decision", "entity", "other"] as const;

type MemoryEntry = {
  id: string;
  text: string;
  vector: number[];
  importance: number;        // 0-1 scale
  category: MemoryCategory;
  createdAt: number;
};
```

### Memory Wiki (extension: `memory-wiki`)
Structured knowledge pages with kinds:
```typescript
type WikiPageKind = "synthesis" | "entity" | "concept" | "source" | "report";
```

---

## 3. Memory Creation Triggers

### Automatic Capture (memory-lancedb plugin)
- Configured via `autoCapture: boolean` in plugin config
- Monitors conversation messages via `before_prompt_build` hook
- Uses a cursor (`AutoCaptureCursor`) tracking `nextIndex` and `lastMessageFingerprint`
- Captures up to `captureMaxChars` (default 500) per entry
- Categorizes with LLM classification into preference/fact/decision/entity/other

### Short-Term Recall Recording (memory-core)
**Trigger**: Every time `memory_search` returns results, the system records those results as recall signals:

```typescript
function queueShortTermRecallTracking(params: {
  workspaceDir?: string;
  query: string;
  rawResults: MemorySearchResult[];
  surfacedResults: MemorySearchResult[];
  timezone?: string;
}): void {
  // Best-effort, fire-and-forget
  void recordShortTermRecalls({
    workspaceDir: params.workspaceDir,
    query: params.query,
    results: trackingResults,
    timezone: params.timezone,
  }).catch(() => {});
}
```

This is the key insight: **memory is NOT explicitly saved by the agent**. Instead, the system passively tracks what gets recalled, and frequently-recalled items get promoted.

### Daily Memory Signals (dreaming ingestion)
- Light/REM phases ingest daily memory files and session transcripts
- `ingestDailyMemorySignals()` scans recent files within `lookbackDays`
- `ingestSessionTranscriptSignals()` processes session corpus files

### Explicit Storage (memory-lancedb)
The `memory_store` tool allows explicit save:
```typescript
{
  name: "memory_store",
  parameters: {
    text: string,          // Information to remember
    importance: number,    // 0-1, default 0.7
    category: MemoryCategory
  }
}
```

### Custom Triggers
The `memory-lancedb` config supports `customTriggers?: string[]` for pattern-based capture.

---

## 4. Retrieval / Search Mechanism

### Two Search Backends

#### Builtin Engine (`memory-core`)
Three search modes combined:

1. **FTS5 Full-Text Search** (keyword/BM25):
   ```typescript
   // Tokenizes query, builds AND query
   buildFtsQuery("hello world") → '"hello" AND "world"'
   
   // Tokenizer options: "unicode61" (default) or "trigram" (CJK)
   // Scoring: BM25 rank → normalized score
   bm25RankToScore(rank) → relevance / (1 + relevance)
   ```

2. **Vector Search** (embedding similarity):
   ```typescript
   // Uses cosine similarity with sqlite-vec acceleration
   // Falls back to in-process cosine when sqlite-vec unavailable
   searchVector({
     db, vectorTable: "chunks_vec",
     providerModel, queryVec, limit,
     snippetMaxChars: 200,
     ensureVectorReady
   })
   ```

3. **Hybrid Search** (combined):
   ```typescript
   mergeHybridResults({
     vector: vectorResults,
     keyword: keywordResults,
     vectorWeight: number,   // configurable
     textWeight: number,     // configurable
     mmr: { enabled, lambda },           // Maximal Marginal Relevance
     temporalDecay: { enabled, halfLifeDays }  // Recency bias
   })
   ```

#### Search Flow in `MemoryIndexManager.search()`:
1. If no embedding provider → FTS-only mode
2. If FTS unavailable → vector-only mode
3. Otherwise → hybrid:
   - Run vector search (cosine similarity KNN)
   - Run keyword search (FTS5 BM25)
   - Merge with configurable weights
   - Apply MMR diversity
   - Apply temporal decay
   - Filter by `minScore`
   - Return top `maxResults`

#### Fallback Broadening:
```typescript
// If exact AND query returns nothing, fall back to per-keyword queries
const keywords = extractKeywords(cleaned, { ftsTokenizer });
// Search each keyword independently
```

#### QMD Backend (alternative)
External process-based search with modes: `"query"`, `"search"`, `"vsearch"`

#### LanceDB Backend (alternative)
Pure vector search using LanceDB:
```typescript
const vector = await embeddings.embed(normalizeRecallQuery(query, recallMaxChars));
const results = await db.search(vector, limit, minScore);
```

### Supported Embedding Providers
- OpenAI (`text-embedding-3-small` default)
- Custom OpenAI-compatible endpoints
- Built-in provider adapters (multiple auto-selectable)
- Configurable dimensions

### Indexing Pipeline
1. **Chunking**: `chunkMarkdown(content, { tokens: 400, overlap: 80 })`
2. **Embedding**: Batch embed chunks (max 8000 tokens per batch)
3. **Storage**: Write to chunks table + vector table + FTS table
4. **File watching**: FSWatcher with 1.5s debounce triggers reindex
5. **Auto-reindex**: Provider/model/config change → full rebuild

---

## 5. Memory Consolidation / Summarization ("Dreaming")

Dreaming is the **background memory consolidation system** — opt-in, disabled by default.

### Three Cooperative Phases (executed in order: Light → REM → Deep)

#### Light Phase
- **Purpose**: Sort and stage recent short-term material
- **Reads from**: Short-term recall state, recent daily files, session transcripts
- **Lookback**: `lookbackDays` (default 2)
- **Deduplication**: Cosine similarity threshold (default 0.9)
- **Writes**: Managed `## Light Sleep` block in DREAMS.md
- **Records**: Phase reinforcement signals
- **NEVER writes to MEMORY.md**

#### REM Phase
- **Purpose**: Extract patterns, reflective signals, theme summaries
- **Reads from**: Short-term recall entries within lookback window
- **Writes**: Managed `## REM Sleep` block
- **Records**: REM reinforcement signals for deep ranking
- **NEVER writes to MEMORY.md**

#### Deep Phase
- **Purpose**: Score candidates and promote to long-term memory
- **THE ONLY PHASE that writes to MEMORY.md**
- **Threshold gates** (all must pass):
  - `minScore` ≥ 0.8
  - `minRecallCount` ≥ 3
  - `minUniqueQueries` ≥ 3
- **Rehydrates** snippets from live daily files before writing (stale/deleted snippets skipped)
- Writes promoted entries to `MEMORY.md`
- Writes `## Deep Sleep` summary to `DREAMS.md`

### Deep Ranking Signals (6 weighted components + phase boost)

| Signal              | Weight | Description                                       |
|---------------------|--------|---------------------------------------------------|
| Frequency           | 0.24   | How many short-term signals accumulated           |
| Relevance           | 0.30   | Average retrieval quality score                   |
| Query diversity     | 0.15   | Distinct query/day contexts that surfaced it      |
| Recency             | 0.15   | Time-decayed freshness (half-life 14 days)        |
| Consolidation       | 0.10   | Multi-day recurrence strength                     |
| Conceptual richness | 0.06   | Concept-tag density from snippet/path             |

**Phase reinforcement boost** from `phase-signals.json`:
- Light hit boost: max 0.06 (decays with 14-day half-life)
- REM hit boost: max 0.09 (decays with 14-day half-life)

### Scheduling
- Default cron: `0 3 * * *` (3 AM daily)
- Auto-managed cron job: `"Memory Dreaming Promotion"`
- Configurable timezone
- Can be toggled via `/dreaming on|off` command

### Recovery Mode
When memory health drops below threshold:
```typescript
{
  enabled: true,
  triggerBelowHealth: 0.35,
  lookbackDays: 30,
  maxRecoveredCandidates: 20
}
```

---

## 6. Forgetting / Pruning

### Budget Compaction (`memory-budget.ts`)
When `MEMORY.md` exceeds `memoryFileMaxChars` (default 10,000):
```typescript
compactMemoryForBudget({
  existingMemory: string,
  newSection: string,
  budgetChars: number
}) → { compacted: string, droppedDates: string[] }
```
- Parses MEMORY.md into blocks (preserved vs. promotion sections)
- Drops **oldest promoted sections first** to make room
- Never drops non-promotion content (manual entries are "preserved" blocks)

### Explicit Forgetting (`memory_forget` tool, memory-lancedb)
```typescript
{
  name: "memory_forget",
  description: "Delete specific memories. GDPR-compliant.",
  parameters: {
    query?: string,    // Search to find memory
    memoryId?: string  // Direct ID delete
  }
}
```
- By ID: direct delete
- By query: embed query → vector search (high threshold 0.7) → find matches → delete

### Short-Term Pruning
- `maxAgeDays` (default 30): Entries older than this are excluded from ranking
- Stale lock cleanup: Locks older than 60s are considered stale
- Phase signal cleanup: Signals for entries no longer in the recall store are deleted
- `removeGroundedShortTermCandidates()`: Clears grounded backfill entries

### Grounded Backfill Rollback
```bash
openclaw memory rem-backfill --rollback           # Remove grounded diary entries
openclaw memory rem-backfill --rollback-short-term # Remove staged short-term candidates
```

---

## 7. Context Loading Strategy

### Bootstrap (session start)
1. **`MEMORY.md`** — Full content loaded (truncated if over budget)
2. **Today's daily note** — `memory/YYYY-MM-DD.md` auto-loaded
3. **Yesterday's daily note** — Also auto-loaded
4. **Slugged variants** — `memory/YYYY-MM-DD-<slug>.md` files included

### Active Memory Recall (per-turn, `active-memory` extension)
A **blocking memory sub-agent** runs before each response:

```mermaid
flowchart LR
  U["User Message"] --> Q["Build Memory Query"]
  Q --> R["Active Memory Sub-Agent"]
  R -->|NONE| M["Main Reply"]
  R -->|relevant summary| I["Append Hidden System Context"]
  I --> M["Main Reply"]
```

The sub-agent:
- Uses only configured memory tools (`memory_search`, `memory_get`)
- Returns `NONE` or a compact plain-text summary
- Injected as hidden `active_memory_plugin` system context

### Tool-Based On-Demand Recall
The agent can explicitly call:
- **`memory_search`**: Semantic/hybrid search across all indexed memory
  - Parameters: `query`, `maxResults`, `minScore`, `corpus` (memory|wiki|sessions|all)
- **`memory_get`**: Exact file read with pagination
  - Parameters: `path`, `from` (line), `lines`, `corpus`
  - Default 120 lines, with truncation/continuation metadata

### Context Budget
```typescript
const DEFAULT_MEMORY_READ_LINES = 120;
const DEFAULT_MEMORY_READ_MAX_CHARS = 10_000;
const DEFAULT_MEMORY_FILE_MAX_CHARS = 10_000; // For MEMORY.md budget compaction
```

---

## 8. Code Structure — Key Files and Roles

### Core Memory Engine
```
extensions/memory-core/
├── index.ts                          # Plugin entry point, registers tools/capabilities
├── runtime-api.ts                    # Public exports for other modules
├── src/
│   ├── memory/
│   │   ├── manager.ts               # MemoryIndexManager — main search/index class
│   │   ├── manager-search.ts        # searchVector(), searchKeyword() implementations
│   │   ├── manager-embedding-ops.ts # Chunk indexing, embedding, FTS writes
│   │   ├── manager-sync-ops.ts      # File sync, watch, reindex logic
│   │   ├── manager-cache.ts         # Embedding cache management
│   │   ├── manager-db.ts            # SQLite database lifecycle
│   │   ├── manager-batch-state.ts   # Batch embedding state
│   │   ├── manager-reindex-state.ts # Reindex trigger detection
│   │   ├── manager-atomic-reindex.ts # Atomic reindex with retry
│   │   ├── search-manager.ts        # FallbackMemoryManager, BorrowedMemoryManager
│   │   ├── hybrid.ts                # buildFtsQuery(), mergeHybridResults(), BM25
│   │   ├── mmr.ts                   # Maximal Marginal Relevance diversity
│   │   ├── temporal-decay.ts        # Time-based score decay
│   │   ├── embeddings.ts            # createEmbeddingProvider()
│   │   ├── provider-adapters.ts     # Built-in embedding provider registry
│   │   ├── qmd-manager.ts           # QMD external process backend
│   │   └── index.ts                 # Barrel exports
│   ├── tools.ts                     # memory_search and memory_get tool implementations
│   ├── tools.shared.ts              # MemorySearchSchema, MemoryGetSchema
│   ├── short-term-promotion.ts      # Recall tracking, ranking, promotion logic
│   ├── dreaming.ts                  # Cron management, sweep trigger, promotion
│   ├── dreaming-phases.ts           # Light/REM/Deep phase implementations
│   ├── dreaming-narrative.ts        # Dream diary narrative generation
│   ├── dreaming-markdown.ts         # Phase block writing to DREAMS.md
│   ├── dreaming-repair.ts           # Audit and repair dreaming artifacts
│   ├── dreaming-command.ts          # /dreaming slash command handler
│   ├── dreaming-shared.ts           # Shared dreaming utilities
│   ├── memory-budget.ts             # MEMORY.md compaction logic
│   ├── cli.ts                       # CLI command registration
│   └── cli.runtime.ts               # CLI command implementations
```

### Memory Host SDK
```
packages/memory-host-sdk/src/
├── engine-storage.ts                 # Storage exports (chunk, hash, list, read)
├── runtime-files.ts                  # Runtime file access contract
├── host/
│   ├── memory-schema.ts             # ensureMemoryIndexSchema() — SQLite DDL
│   ├── internal.ts                  # listMemoryFiles, chunkMarkdown, cosineSimilarity
│   ├── read-file.ts                 # readMemoryFile(), readAgentMemoryFile()
│   ├── read-file-shared.ts          # buildMemoryReadResult(), pagination logic
│   ├── backend-config.ts            # resolveMemoryBackendConfig()
│   ├── status-format.ts             # resolveMemoryFtsState(), resolveMemoryCacheSummary()
│   └── types.ts                     # MemorySearchManager interface, MemorySearchResult
```

### Memory State (plugin registration)
```
src/plugins/memory-state.ts           # Plugin capability registration, prompt building
src/memory-host-sdk/dreaming.ts       # Dreaming config types and defaults
src/config/types.memory.ts            # MemoryConfig, MemoryBackend types
src/memory/root-memory-files.ts       # MEMORY.md path resolution
```

### Alternative Backends
```
extensions/memory-lancedb/
├── index.ts                          # LanceDB vector store plugin (memory_recall, memory_store, memory_forget)
├── config.ts                         # MemoryConfig type, categories, schema validation
└── lancedb-runtime.ts                # LanceDB module loader

extensions/memory-wiki/
├── src/
│   ├── query.ts                      # Wiki page search/get
│   ├── memory-palace.ts              # Structured knowledge visualization
│   └── markdown.ts                   # Wiki markdown parsing
```

### Active Memory (auto-recall)
```
extensions/active-memory/
└── index.ts                          # Blocking sub-agent recall before each response
```

---

## 9. Configuration Reference

```json
{
  "agents": {
    "defaults": {
      "workspace": "~/.openclaw/workspace",
      "memorySearch": {
        "enabled": true,
        "store": {
          "path": "~/.openclaw/memory/{agentId}.sqlite",
          "vector": { "enabled": true, "extensionPath": null },
          "fts": { "tokenizer": "unicode61" }
        },
        "chunking": { "tokens": 400, "overlap": 80 },
        "query": {
          "minScore": 0,
          "hybrid": {
            "enabled": true,
            "vectorWeight": 0.7,
            "textWeight": 0.3,
            "candidateMultiplier": 3,
            "mmr": { "enabled": true, "lambda": 0.7 },
            "temporalDecay": { "enabled": true, "halfLifeDays": 14 }
          }
        },
        "sync": { "watch": true, "onSessionStart": true, "onSearch": true },
        "extraPaths": [],
        "sources": ["memory"],
        "experimental": { "sessionMemory": false }
      }
    }
  },
  "plugins": {
    "entries": {
      "memory-core": {
        "config": {
          "dreaming": {
            "enabled": false,
            "frequency": "0 3 * * *",
            "timezone": null,
            "phases": {
              "light": {
                "enabled": true,
                "lookbackDays": 2,
                "limit": 100,
                "dedupeSimilarity": 0.9,
                "sources": ["daily", "sessions", "recall"]
              },
              "deep": {
                "enabled": true,
                "limit": 10,
                "minScore": 0.8,
                "minRecallCount": 3,
                "minUniqueQueries": 3,
                "recencyHalfLifeDays": 14,
                "maxAgeDays": 30
              },
              "rem": {
                "enabled": true,
                "lookbackDays": 2,
                "limit": 25,
                "minPatternStrength": 0.5
              }
            }
          }
        }
      }
    }
  },
  "memory": {
    "backend": "builtin",
    "citations": "auto"
  }
}
```

---

## 10. Key Design Principles

1. **Passive over explicit**: Memory isn't saved by commands — it's tracked by *recall frequency*. What gets searched often gets promoted.

2. **Separation of concerns**: Working memory (daily notes) vs. durable memory (MEMORY.md) vs. index (SQLite) are distinct layers.

3. **Sleep metaphor**: Consolidation mimics human sleep cycles — Light (sort), REM (reflect), Deep (commit).

4. **Budget-aware**: Long-term memory auto-compacts when full, dropping oldest promoted sections first.

5. **Hybrid retrieval**: Never relies on just one search method — combines vector similarity + keyword matching + temporal decay + diversity (MMR).

6. **Explainability**: Every promotion is auditable via DREAMS.md, CLI commands, and the recall store.

7. **Graceful degradation**: No embedding provider? Falls back to FTS-only. No sqlite-vec? Falls back to in-process cosine. No FTS? Still has vector search.

8. **File-based locking**: Uses atomic file operations for concurrent access to the recall store (process-safe with stale lock detection).
