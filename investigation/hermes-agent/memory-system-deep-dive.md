# Hermes Agent Memory System — Deep Dive

Source: `github.com/NousResearch/hermes-agent`, `tools/memory_tool.py`, `agent/prompt_builder.py`, `agent/system_prompt.py`, `agent/agent_runtime_helpers.py`

---

## 1. Tool Schema (Exact)

```python
MEMORY_SCHEMA = {
    "name": "memory",
    "description": (
        "Save durable information to persistent memory that survives across sessions. "
        "Memory is injected into future turns, so keep it compact and focused on facts "
        "that will still matter later.\n\n"
        "WHEN TO SAVE (do this proactively, don't wait to be asked):\n"
        "- User corrects you or says 'remember this' / 'don't do that again'\n"
        "- User shares a preference, habit, or personal detail (name, role, timezone, coding style)\n"
        "- You discover something about the environment (OS, installed tools, project structure)\n"
        "- You learn a convention, API quirk, or workflow specific to this user's setup\n"
        "- You identify a stable fact that will be useful again in future sessions\n\n"
        "PRIORITY: User preferences and corrections > environment facts > procedural knowledge. "
        "The most valuable memory prevents the user from having to repeat themselves.\n\n"
        "Do NOT save task progress, session outcomes, completed-work logs, or temporary TODO "
        "state to memory; use session_search to recall those from past transcripts.\n"
        "If you've discovered a new way to do something, solved a problem that could be "
        "necessary later, save it as a skill with the skill tool.\n\n"
        "TWO TARGETS:\n"
        "- 'user': who the user is -- name, role, preferences, communication style, pet peeves\n"
        "- 'memory': your notes -- environment facts, project conventions, tool quirks, lessons learned\n\n"
        "ACTIONS: add (new entry), replace (update existing -- old_text identifies it), "
        "remove (delete -- old_text identifies it).\n\n"
        "SKIP: trivial/obvious info, things easily re-discovered, raw data dumps, and temporary task state."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ["add", "replace", "remove"],
                "description": "The action to perform."
            },
            "target": {
                "type": "string",
                "enum": ["memory", "user"],
                "description": "Which memory store: 'memory' for personal notes, 'user' for user profile."
            },
            "content": {
                "type": "string",
                "description": "The entry content. Required for 'add' and 'replace'."
            },
            "old_text": {
                "type": "string",
                "description": "Short unique substring identifying the entry to replace or remove."
            },
        },
        "required": ["action", "target"],
    },
}
```

**Registry registration:**
```python
registry.register(
    name="memory",
    toolset="memory",
    schema=MEMORY_SCHEMA,
    handler=lambda args, **kw: memory_tool(
        action=args.get("action", ""),
        target=args.get("target", "memory"),
        content=args.get("content"),
        old_text=args.get("old_text"),
        store=kw.get("store")),
    check_fn=check_memory_requirements,
    emoji="🧠",
)
```

---

## 2. The `memory_tool()` Dispatcher (Complete Logic)

```python
def memory_tool(
    action: str,
    target: str = "memory",
    content: str = None,
    old_text: str = None,
    store: Optional[MemoryStore] = None,
) -> str:
    """Single entry point for the memory tool. Dispatches to MemoryStore methods."""
    if store is None:
        return tool_error("Memory is not available.")

    if target not in {"memory", "user"}:
        return tool_error(f"Invalid target '{target}'. Use 'memory' or 'user'.")

    if action == "add":
        if not content:
            return tool_error("Content is required for 'add' action.")
        result = store.add(target, content)

    elif action == "replace":
        if not old_text:
            return tool_error("old_text is required for 'replace' action.")
        if not content:
            return tool_error("content is required for 'replace' action.")
        result = store.replace(target, old_text, content)

    elif action == "remove":
        if not old_text:
            return tool_error("old_text is required for 'remove' action.")
        result = store.remove(target, old_text)

    else:
        return tool_error(f"Unknown action '{action}'. Use: add, replace, remove")

    return json.dumps(result, ensure_ascii=False)
```

---

## 3. MemoryStore Class — Core Implementation

### Initialization & Limits
```python
class MemoryStore:
    def __init__(self, memory_char_limit: int = 2200, user_char_limit: int = 1375):
        self.memory_entries: List[str] = []
        self.user_entries: List[str] = []
        self.memory_char_limit = memory_char_limit   # ~800 tokens
        self.user_char_limit = user_char_limit       # ~500 tokens
        self._system_prompt_snapshot: Dict[str, str] = {"memory": "", "user": ""}
```

### File Locations
- `~/.hermes/memories/MEMORY.md` — agent's personal notes
- `~/.hermes/memories/USER.md` — user profile facts

### Entry Delimiter
```python
ENTRY_DELIMITER = "\n§\n"
```

---

## 4. `add()` — Complete Flow

```python
def add(self, target: str, content: str) -> Dict[str, Any]:
    content = content.strip()
    if not content:
        return {"success": False, "error": "Content cannot be empty."}

    # 1. Security scan
    scan_error = _scan_memory_content(content)
    if scan_error:
        return {"success": False, "error": scan_error}

    with self._file_lock(self._path_for(target)):
        # 2. Re-read from disk under lock (picks up writes from other sessions)
        self._reload_target(target)

        entries = self._entries_for(target)
        limit = self._char_limit(target)

        # 3. Reject exact duplicates
        if content in entries:
            return self._success_response(target, "Entry already exists (no duplicate added).")

        # 4. Check capacity
        new_entries = entries + [content]
        new_total = len(ENTRY_DELIMITER.join(new_entries))

        if new_total > limit:
            current = self._char_count(target)
            return {
                "success": False,
                "error": f"Memory at {current:,}/{limit:,} chars. Adding this entry ({len(content)} chars) would exceed the limit.",
                "current_entries": entries,
                "usage": f"{current:,}/{limit:,}",
            }

        # 5. Append and persist
        entries.append(content)
        self._set_entries(target, entries)
        self.save_to_disk(target)

    return self._success_response(target, "Entry added.")
```

---

## 5. `replace()` — Substring Matching Logic

```python
def replace(self, target: str, old_text: str, new_content: str) -> Dict[str, Any]:
    old_text = old_text.strip()
    new_content = new_content.strip()

    # Security scan on new content
    scan_error = _scan_memory_content(new_content)
    if scan_error:
        return {"success": False, "error": scan_error}

    with self._file_lock(self._path_for(target)):
        self._reload_target(target)
        entries = self._entries_for(target)
        
        # SUBSTRING MATCH: `old_text in entry` (Python's `in` operator)
        matches = [(i, e) for i, e in enumerate(entries) if old_text in e]

        if not matches:
            return {"success": False, "error": f"No entry matched '{old_text}'."}

        # CONFLICT: multiple non-identical matches → error
        if len(matches) > 1:
            unique_texts = {e for _, e in matches}
            if len(unique_texts) > 1:
                previews = [e[:80] + "..." for _, e in matches]
                return {"success": False, "error": "Multiple entries matched. Be more specific.", "matches": previews}
            # All identical duplicates — replace first one

        idx = matches[0][0]
        # Capacity check for new content
        test_entries = entries[:]
        test_entries[idx] = new_content
        new_total = len(ENTRY_DELIMITER.join(test_entries))
        if new_total > limit:
            return {"success": False, "error": "Replacement would exceed limit."}

        entries[idx] = new_content  # ENTIRE entry replaced, not substring within it
        self._set_entries(target, entries)
        self.save_to_disk(target)

    return self._success_response(target, "Entry replaced.")
```

**Key insight:** `old_text` is a **substring used to IDENTIFY which entry**, not to replace text within it. The entire matched entry is replaced by `new_content`.

---

## 6. `remove()` — Same Pattern

```python
def remove(self, target: str, old_text: str) -> Dict[str, Any]:
    # Same substring matching as replace
    matches = [(i, e) for i, e in enumerate(entries) if old_text in e]
    # Same conflict handling (multiple non-identical = error)
    # If match found: entries.pop(idx), save_to_disk()
```

---

## 7. File I/O — Atomic Writes

```python
@staticmethod
def _read_file(path: Path) -> List[str]:
    """No locking needed: writes use atomic rename."""
    raw = path.read_text(encoding="utf-8")
    entries = [e.strip() for e in raw.split(ENTRY_DELIMITER)]
    return [e for e in entries if e]

@staticmethod
def _write_file(path: Path, entries: List[str]):
    """Atomic temp-file + rename."""
    content = ENTRY_DELIMITER.join(entries) if entries else ""
    fd, tmp_path = tempfile.mkstemp(dir=str(path.parent), suffix=".tmp", prefix=".mem_")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(content)
        f.flush()
        os.fsync(f.fileno())
    atomic_replace(tmp_path, path)
```

---

## 8. When Is Memory Updated? — LIVE During Conversation

Memory is updated **during the conversation** (live), not at session end:

1. Agent calls `memory` tool during normal turn execution
2. `invoke_tool()` dispatches to `memory_tool()`
3. Each mutation calls `self.save_to_disk(target)` immediately
4. Disk write is atomic (temp file + rename + fsync)

**However:** The system prompt is NOT updated mid-session. The `_system_prompt_snapshot` is frozen at session start (`load_from_disk()` time). This preserves the LLM prefix cache.

Exception: After **context compression**, `invalidate_system_prompt()` reloads from disk:
```python
def invalidate_system_prompt(agent: Any) -> None:
    agent._cached_system_prompt = None
    if agent._memory_store:
        agent._memory_store.load_from_disk()
```

---

## 9. System Prompt Guidance — What Triggers Memory Use

### `MEMORY_GUIDANCE` (injected into system prompt when memory tool is available):
```python
MEMORY_GUIDANCE = (
    "You have persistent memory across sessions. Save durable facts using the memory "
    "tool: user preferences, environment details, tool quirks, and stable conventions. "
    "Memory is injected into every turn, so keep it compact and focused on facts that "
    "will still matter later.\n"
    "Prioritize what reduces future user steering — the most valuable memory is one "
    "that prevents the user from having to correct or remind you again. "
    "User preferences and recurring corrections matter more than procedural task details.\n"
    "Do NOT save task progress, session outcomes, completed-work logs, or temporary TODO "
    "state to memory; use session_search to recall those from past transcripts. "
    "Specifically: do not record PR numbers, issue numbers, commit SHAs, 'fixed bug X', "
    "'submitted PR Y', 'Phase N done', file counts, or any artifact that will be stale "
    "in 7 days. If a fact will be stale in a week, it does not belong in memory. "
    "If you've discovered a new way to do something, solved a problem that could be "
    "necessary later, save it as a skill with the skill tool.\n"
    "Write memories as declarative facts, not instructions to yourself. "
    "'User prefers concise responses' ✓ — 'Always respond concisely' ✗. "
    "'Project uses pytest with xdist' ✓ — 'Run tests with pytest -n 4' ✗. "
    "Imperative phrasing gets re-read as a directive in later sessions and can "
    "cause repeated work or override the user's current request."
)
```

### Injection point:
```python
# system_prompt.py → build_system_prompt_parts()
if "memory" in agent.valid_tool_names:
    tool_guidance.append(MEMORY_GUIDANCE)
```

---

## 10. Memory in the System Prompt — Frozen Snapshot

```
══════════════════════════════════════════════
MEMORY (your personal notes) [67% — 1,474/2,200 chars]
══════════════════════════════════════════════
User's project is a Rust web service at ~/code/myapi using Axum + SQLx
§
This machine runs Ubuntu 22.04, has Docker and Podman installed
```

The `%` usage indicator lets the agent know when to start consolidating.

---

## 11. Automatic Memory Updates (Non-Agent-Initiated)

**The built-in memory has NO automatic updates.** Only the agent calling the tool triggers writes.

When external providers are active, a bridge notifies them:
```python
# After memory tool executes:
if agent._memory_manager and function_args.get("action") in {"add", "replace"}:
    agent._memory_manager.on_memory_write(action, target, content)
```

External providers also have automatic hooks:
- `sync_turn()` — after each completed turn
- `on_session_end()` — when conversation ends
- `on_pre_compress()` — before context compression
- `prefetch()` — before each API call

---

## 12. Growth & Pruning — Hard Limits, No Auto-Pruning

Files are **bounded by character limits** (2,200 / 1,375). When full, `add()` returns an error with all current entries, expecting the agent to consolidate via `replace`/`remove`.

**No automatic pruning, eviction, or LRU.** The agent must self-manage.

Deduplication at load time:
```python
self.memory_entries = list(dict.fromkeys(self.memory_entries))
```

---

## 13. Contradictions — No Built-in Detection

The built-in system has **no contradiction detection**. Both "User prefers dark mode" and "User prefers light mode" can coexist. The tool schema tells the agent to use `replace` for updates, relying on LLM judgment.

External providers (Holographic) offer `contradict` action for explicit conflict detection.

---

## 14. MEMORY.md vs USER.md

| | MEMORY.md | USER.md |
|---|---|---|
| Target | `"memory"` | `"user"` |
| Purpose | Agent's notes | User profile |
| Content | Environment, conventions, quirks, lessons | Name, role, preferences, style |
| Limit | 2,200 chars | 1,375 chars |

---

## 15. Security Scanning

```python
_MEMORY_THREAT_PATTERNS = [
    (r'ignore\s+(previous|all|above|prior)\s+instructions', "prompt_injection"),
    (r'you\s+are\s+now\s+', "role_hijack"),
    (r'do\s+not\s+tell\s+the\s+user', "deception_hide"),
    (r'system\s+prompt\s+override', "sys_prompt_override"),
    (r'disregard\s+(your|all|any)\s+(instructions|rules|guidelines)', "disregard_rules"),
    (r'curl\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)', "exfil_curl"),
    (r'wget\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)', "exfil_wget"),
    (r'cat\s+[^\n]*(\.env|credentials|\.netrc|\.pgpass|\.npmrc|\.pypirc)', "read_secrets"),
    (r'authorized_keys', "ssh_backdoor"),
    (r'\$HOME/\.ssh|\~/\.ssh', "ssh_access"),
    (r'\$HOME/\.hermes/\.env|\~/\.hermes/\.env', "hermes_env"),
]
```

Plus invisible Unicode detection (`\u200b`, `\u200c`, `\u200d`, `\u2060`, `\ufeff`, BiDi overrides).

---

## 16. Complete Write Path

```
LLM decides to remember → emits tool_call
    ↓
invoke_tool() in agent_runtime_helpers.py
    ↓
memory_tool(action, target, content, old_text, store)
    ↓
Validates params → _scan_memory_content(content) 
    ↓
Acquires file lock → _reload_target() (re-reads disk)
    ↓
Checks duplicates / capacity / substring match
    ↓
Mutates in-memory list → save_to_disk()
    ↓
_write_file() → tempfile + fsync + atomic_replace
    ↓
Returns JSON to agent → Bridge notifies external providers
    ↓
System prompt NOT updated (frozen until next session or compression)
```
