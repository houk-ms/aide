# Agentic Memory Systems — Cross-Product Comparison

Research date: 2026-06-05

## Systems Studied

1. **Claude Code** (Anthropic) — coding agent in terminal
2. **OpenAI Codex CLI** — coding agent in terminal/IDE
3. **GitHub Copilot** (VS Code) — IDE-integrated coding assistant
4. **OpenClaw** — open-source autonomous agent
5. **Hermes Agent** (NousResearch) — open-source local agent

---

## Pattern Summary

| Dimension | Claude Code | Codex CLI | Copilot (VS Code) | OpenClaw | Hermes Agent |
|-----------|-------------|-----------|-------------------|----------|--------------|
| **Storage format** | Markdown files | Markdown files | Markdown files + SDK session state | SQLite + Markdown + Embeddings | Markdown files |
| **User instructions** | `CLAUDE.md` (multi-level) | `AGENTS.md` (multi-level) | `.github/copilot-instructions.md` + `.instructions.md` | Config files | N/A |
| **Auto memory** | Yes (agent writes `.md` files) | No | Yes (3 scopes: user/session/repo) | Yes (dreaming system) | Yes (memory tool) |
| **Memory location** | `~/.claude/projects/<project>/memory/` | `~/.codex/AGENTS.md` (instructions only) | `~/.copilot/` + workspace | `~/.openclaw/workspace/memory/` | `~/.hermes/memories/` |
| **Retrieval** | File read on demand | None (all loaded) | Loaded into context | Hybrid: FTS5 + Vector + BM25 | Full injection (frozen) |
| **Capacity control** | 200 lines / 25KB loaded | 32KB combined | 200 lines loaded | 10K chars MEMORY.md budget | 2200 + 1375 chars hard limit |
| **Consolidation** | Agent self-manages topic files | None | None | "Dreaming" 3-phase sleep cycle | Agent manages via tool |

---

## The 5 Popular Methods

### 1. Hierarchical Instruction Files (All systems)

Every system uses **layered markdown files** as the primary context mechanism:

```
Global scope:     ~/.claude/CLAUDE.md  |  ~/.codex/AGENTS.md  |  copilot-instructions.md
Project scope:    ./CLAUDE.md          |  ./AGENTS.md         |  .github/copilot-instructions.md
Directory scope:  subdir/CLAUDE.md     |  subdir/AGENTS.md    |  .instructions.md (path-scoped)
```

**Key insight**: Instructions walk the directory tree. Closer = higher priority. Loaded every session.

### 2. Agent-Written Auto Memory (Claude Code, Copilot, OpenClaw, Hermes)

The agent writes notes for itself as it works. No manual effort from the user.

| System | Trigger | Format | Budget |
|--------|---------|--------|--------|
| Claude Code | Agent decides during conversation | Topic `.md` files in memory dir | 200 lines / 25KB entrypoint |
| Copilot | Agent decides during conversation | Scoped `.md` files (user/session/repo) | 200 lines loaded auto |
| OpenClaw | Passive: tracks what's recalled, promotes high-frequency items | MEMORY.md + daily notes | 10K chars |
| Hermes | Agent calls memory tool (add/replace/remove) | Two files: MEMORY.md + USER.md | 2200 + 1375 chars |

**Two sub-patterns emerge:**

- **Active write** (Claude Code, Copilot, Hermes): The agent explicitly decides what to save
- **Passive promotion** (OpenClaw): System tracks what's retrieved often, automatically promotes

### 3. Scoped Loading Strategy (Selective Context Injection)

Not everything is loaded every turn. Systems differ in **when** memory enters the context:

| Loading strategy | Used by | How |
|-----------------|---------|-----|
| Always loaded (frozen) | All systems for L0/Identity | Injected at session start, never changes mid-session |
| On-demand retrieval | OpenClaw, Copilot (repo memory) | Agent reads topic files when needed |
| Per-turn retrieval | OpenClaw (active-memory extension) | Sub-agent runs memory search before each reply |
| Path-triggered | Claude Code rules, Copilot `.instructions.md` | Loaded when agent touches matching files |

### 4. Retrieval-Augmented Memory (OpenClaw)

The most sophisticated approach — full search infrastructure:

- **Chunking**: 400 tokens, 80-token overlap
- **Dual search**: FTS5 (BM25 keyword) + Vector (cosine similarity)
- **Hybrid merge**: Configurable weights + MMR diversity + temporal decay
- **Indexes**: SQLite with FTS5 virtual table + sqlite-vec extension

No other system does this at the memory layer. Others rely on loading full files.

### 5. Memory Consolidation / Forgetting (OpenClaw's "Dreaming")

Only OpenClaw has an automated **consolidation pipeline**:

```
Light Sleep → sort and stage recent recall signals
REM Sleep   → extract patterns and themes
Deep Sleep  → score candidates (6 weighted signals) → promote to MEMORY.md
```

**Promotion criteria**: score ≥ 0.8, recalled ≥ 3 times, from ≥ 3 unique queries.

**Forgetting**: Budget compaction drops oldest promoted sections when MEMORY.md exceeds limit.

Other systems rely on the agent or user to manage capacity manually.

---

## Design Dimensions to Consider

### A. What to remember (write policy)

| Priority | Content |
|----------|---------|
| Highest | User corrections ("I said X, not Y") |
| High | Explicit preferences, conventions, environment facts |
| Medium | Patterns discovered during work |
| Low | Task outcomes, procedural details |
| Never | Transient progress, secrets, data that expires quickly |

### B. When to remember (write trigger)

1. **Real-time during conversation** (Hermes, Claude Code, Copilot) — agent calls a tool
2. **Session end extraction** (Copilot SDK hooks) — system extracts missed facts
3. **Passive promotion** (OpenClaw) — system tracks recall frequency over time
4. **User manual** (all) — user edits files directly

### C. How to retrieve (read strategy)

1. **Full injection** (simple, small memory) — load everything into context
2. **Query-based top-K** (scalable) — search on each turn, inject relevant entries
3. **On-demand file read** (Claude Code topic files) — agent reads when it thinks it needs to
4. **Active recall sub-agent** (OpenClaw) — dedicated sub-agent decides what's relevant

### D. How to forget (capacity management)

1. **Hard character/line limit** (Hermes: 2200 chars, Claude Code: 200 lines)
2. **Budget compaction** (OpenClaw: drop oldest promoted sections)
3. **Agent self-manages** (Claude Code: splits into topic files)
4. **Inactive marking** (Aide current: status = 'inactive')
5. **Time-based decay** (OpenClaw: maxAgeDays = 30 for short-term)

---

## How Aide's Current System Compares

| Feature | Aide (current) | Industry best practice |
|---------|---------------|----------------------|
| Layered storage (L0/L1/L2) | ✅ Yes | ✅ Unique — no other system has 3 explicit layers |
| FTS5 search | ✅ Yes | ✅ Standard |
| Vector/embedding search | ❌ No | ⚠️ OpenClaw has it; others don't |
| Always-loaded identity | ✅ Yes (L0) | ✅ All systems do this |
| Agent-driven writes | ✅ Yes | ✅ Standard |
| Session-end gap-fill | ✅ Designed | ⚠️ Only Copilot SDK hooks support this natively |
| Auto-consolidation | ❌ No | ⚠️ Only OpenClaw does this; may be over-engineered |
| Path-scoped instructions | ❌ No | ✅ Claude Code + Codex have this |
| Error-correction cascade | ✅ Yes | ✅ Unique to Aide — good design |
| Recall tracking | ✅ Yes (recall_count) | ✅ OpenClaw does this extensively |

### Aide's Advantages
- Clean 3-layer separation (L0/L1/L2) is more principled than any competitor
- Error-correction cascade (check if wrong memory caused the error) is unique
- No ML dependency — practical for a desktop app

### Potential Gaps
- No path-scoped or project-scoped instruction loading
- No topic-file splitting for large memory (everything in one table)
- No active recall per-turn (designed but unclear if implemented)
- No consolidation/dreaming (may not need it if recall_count + manual management suffices)

---

## Recommendations (for discussion)

1. **Keep the 3-layer architecture** — it's cleaner than competitors
2. **Implement per-turn L1 retrieval** if not already active — this is what makes memory useful
3. **Consider topic-based organization** for L1 (like Claude Code's topic files) — helps the agent browse related facts
4. **Add project-scoping** — load different memories per project context
5. **Skip vector search for now** — FTS5 + tags + recall_count is sufficient; add embeddings only if retrieval quality proves insufficient
6. **Skip dreaming/consolidation** — over-engineering for a personal agent with <10K memories; manual + agent management is fine
