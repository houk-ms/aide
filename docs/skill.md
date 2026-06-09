# Skill

**A Skill is Aide's first-class unit of extension, on par with an MCP tool. It is the core mechanism that lets Aide's capabilities be continuously extended rather than hard-coded.**

## Role

Aide's goal is "extensible capabilities" — new capabilities can be installed, published, and composed, instead of changing code and recompiling every time. To that end, Aide has two peer extension points:

| Extension point | Essence | Output | Format |
|--------|------|------|------|
| **Skill** | A behavior / knowledge / context-injection unit; can declare dependencies and carry a local tool | Changes how the Agent handles a class of tasks | `SKILL.md` + frontmatter |
| **MCP Server** | An external tool provider | Returns executable tool-call results | MCP protocol (stdio / http) |

The two are **not in a hierarchy**: a Skill can depend on an MCP server, and an MCP server can be referenced by any Skill; but a Skill is itself an independent capability unit — it can inject instructions only, or ship its own tool implementation.

> Note: an early doc described a Skill as "a UI grouping view of Tools that doesn't exist at runtime". That was wrong. The Copilot SDK natively supports Skills (see below); a Skill is a real capability unit at runtime.

## Native Skill capability based on the Copilot SDK

Aide is built on `@github/copilot-sdk`, which already provides a native Skill mechanism, so **there's no need to build a custom skill loader**:

- `SessionConfig.skillDirectories: string[]` — directories from which to load Skills; the SDK automatically scans them for `SKILL.md`
- `CustomAgentConfig.skills: string[]` — a sub-agent can preload specified Skills
- When a Skill triggers, a `skill.invoked` event is emitted, injecting the `content` into the conversation
- Skill frontmatter supports fields like `allowed_tools`, `description`, `plugin_name`

This means Aide's extension architecture should be "built along the grain of the SDK": put installed Skills into `skillDirectories`, inject MCP server configuration into the session, and let the SDK handle the rest — loading / matching / injection.

## Skill package structure

```
<skill-name>/
├── SKILL.md            # required: frontmatter (metadata) + markdown instructions
├── tools/              # optional: local tool implementations the Skill ships (TypeScript)
├── mcp.json            # optional: MCP server config the Skill depends on / bundles
├── prompts/            # optional: scenario-specific prompt templates
└── assets/             # optional: icons and other resources
```

### SKILL.md frontmatter

```yaml
---
name: draft-email
description: "Draft and polish email replies. Use when the user needs to reply to email or write a formal email."
allowed_tools: [create_entity_work_iq, fetch_work_iq]
---
# The instruction body for drafting email (injected into context only when the Skill triggers)
...
```

- `name` / `description` — loaded at startup, used for semantic matching
- `description` decides when the Skill is auto-triggered; it can also be invoked explicitly by the user
- The body content is **injected on demand**, not polluting the initial context

## Loading and triggering strategy

```
At startup: scan skillDirectories, load only every Skill's name + description
          |
          v  user sends a message
Match:    semantic match on description, or explicit user reference
          |
          v  hit
Inject:   add the SKILL.md body to the context
Register: register the tools in tools/ into the session
Start:    start the MCP server the Skill depends on (if not already running)
```

This deferred loading is the industry consensus (Codex / Claude / OpenClaw), solving the "context explosion as the number of Skills grows" problem.

## Skill sources (the core of extensibility)

This turns "adding a new capability" from "changing code" into "installing a Skill / configuring an MCP". Sources use a hybrid model:

| Source | Description |
|------|------|
| **Built-in Skills** | Shipped with Aide, covering core scenarios (email drafting, summarization, daily reports, etc.) |
| **Community Skill catalog** | **Shipped**: an in-app marketplace (Settings → Skills) backed by a git-based community catalog, with search, pagination, and one-click install. Exposed to the agent via `search_skills` / `install_skill` / `list_installed_skills`. |
| **MCP Registry** | Planned: search `registry.modelcontextprotocol.io` directly and install an MCP server as a tool provider with one click |
| **Local / project Skills** | User-defined, installed from a local folder containing `SKILL.md` (or placed in `~/.aide/skills/`) |

## Existing tool inventory (built-in core capabilities)

The following built-in tools are not provided through Skills; they are the Agent's core capabilities, and Skills may reference them:

| Source | Tools |
|------|-------|
| Work IQ MCP | ask_work_iq, fetch_work_iq, search_paths_work_iq, get_schema_work_iq, create_entity_work_iq, update_entity_work_iq, delete_entity_work_iq, do_action_work_iq, fetch_blob_work_iq, upload_blob_work_iq |
| GitHub MCP | list_issues, create_issue, create_pr, review_pr |
| Internal modules | create_task, update_task, query_tasks, memory_write, memory_search, manage_job, manage_preferences, generate_report, search_skills, install_skill, list_installed_skills, browser_navigate, browser_click, browser_type, browser_read, browser_screenshot |

## Relationship with the existing system

| Existing concept | Relationship with Skill |
|----------|----------------|
| MCP tools (workiq, github) | A Skill can depend on MCP or be independent of it; an MCP server can be installed as a capability with one click |
| Internal Agent tools (manage_job, create_task, etc.) | Built-in core tools, not provided through Skills |
| Memory | A Skill can declare the memory context it needs |
| Connection | An MCP-type Skill may need to first establish a connection / authorization at install time |

## Permissions

Tools a Skill ships or depends on also go through the SDK's permission system:
- `allowed_tools` limits the range of tools the Skill can call
- Write operations / MCP calls still trigger `onPermissionRequest` (`kind: 'mcp' | 'custom-tool' | 'write'`)
- A community-sourced Skill should, before installation, show the tool permissions it declares for the user to confirm

## Open questions

1. **The implementation language for Skill tools**: TypeScript (same stack as Aide) or any language (via stdio/MCP)?
2. **Version management**: semver + lockfile, or a lightweight git ref?
3. **Security review**: how to sandbox / restrict the tool code of community Skills?
4. **Paid Skills**: do we need to consider monetization?

> Resolved: the marketplace UI ships in-app (Settings → Skills), not as a separate web surface.
