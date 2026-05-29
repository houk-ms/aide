# Hermes Agent — Skills, Tools & Extensibility Architecture

Source: `github.com/NousResearch/hermes-agent` (v0.15.1, 2026-05-29)

---

## 1. What Is a "Skill"?

A **skill** is an on-demand knowledge document (Markdown file) that teaches the agent how to handle a specific task. It's the agent's **procedural memory** — "how to do things" rather than "what things are" (that's memory).

### Key Properties

| Property | Detail |
|----------|--------|
| Format | YAML frontmatter + Markdown body (`SKILL.md`) |
| Location | `~/.hermes/skills/<category>/<skill-name>/SKILL.md` |
| Token cost | **Zero until loaded** — progressive disclosure |
| Size | Can be hundreds of lines (unlike memory which is capped at ~2,200 chars) |
| Standard | Compatible with [agentskills.io](https://agentskills.io/specification) open standard |
| Activation | Slash command (`/skill-name`) or agent self-loads via `skill_view()` |

### SKILL.md Format (Concrete Example)

```yaml
---
name: deploy-k8s
description: Deploy services to Kubernetes clusters with rollback support
version: 1.0.0
author: Platform Team
license: MIT
platforms: [macos, linux]          # Optional — restrict to OS
metadata:
  hermes:
    tags: [deployment, kubernetes, devops]
    category: devops
    requires_toolsets: [terminal]   # Only show when terminal is available
    fallback_for_tools: [web_search]  # Hide when web_search exists
    config:
      - key: k8s.context
        description: "Default kubectl context"
        default: "production"
        prompt: "Which kubectl context?"
required_environment_variables:
  - name: KUBECONFIG
    prompt: "Path to kubeconfig"
    help: "Usually ~/.kube/config"
    required_for: "cluster access"
---

# Deploy to Kubernetes

## When to Use
When user asks to deploy a service, roll back, or check deployment status.

## Procedure
1. Verify kubectl context with `kubectl config current-context`
2. Run `kubectl apply -f manifests/`
3. Watch rollout: `kubectl rollout status deployment/<name>`

## Pitfalls
- Common failure: ImagePullBackOff. Fix: check registry credentials
- Watch for namespace mismatch

## Verification
Run `kubectl get pods -l app=<name>` to confirm running state.
```

### Directory Structure

```
~/.hermes/skills/
├── devops/
│   └── deploy-k8s/
│       ├── SKILL.md              # Main instructions (required)
│       ├── references/           # Additional docs
│       ├── templates/            # Output formats
│       ├── scripts/              # Helper scripts
│       └── assets/               # Supplementary files
├── .hub/                         # Skills Hub state
│   ├── lock.json
│   ├── quarantine/
│   └── audit.log
└── .bundled_manifest             # Tracks seeded bundled skills
```

---

## 2. Discovery, Installation & Management

### Discovery Sources (9 Integrated Registries)

| Source ID | Example | Trust Level |
|-----------|---------|-------------|
| `official` | `official/security/1password` | Builtin trust |
| `skills-sh` | `skills-sh/vercel-labs/json-render/json-render-react` | Community |
| `well-known` | `well-known:https://mintlify.com/docs/.well-known/skills/mintlify` | Community |
| `github` | `openai/skills/k8s` | Trusted (for known repos) |
| `clawhub` | ClawHub marketplace entries | Community |
| `claude-marketplace` | `anthropics/skills`, `aiskillstore/marketplace` | Community |
| `lobehub` | LobeHub agent entries converted to skills | Community |
| `browse-sh` | `browse-sh/airbnb.com/search-listings-ddgioa` | Community |
| `url` | `https://example.com/SKILL.md` | Community |

Default GitHub taps (no setup needed): `openai/skills`, `anthropics/skills`, `huggingface/skills`, `garrytan/gstack`.

### Installation CLI

```bash
hermes skills install openai/skills/k8s              # From GitHub tap
hermes skills install official/security/1password    # Official optional
hermes skills install https://example.com/SKILL.md   # Direct URL
hermes skills search react --source skills-sh        # Search
hermes skills browse --source official               # Browse catalog
hermes skills tap add myorg/skills-repo              # Add custom tap
```

### Security Scanning

All hub-installed skills go through automated security scanning:
- Data exfiltration detection
- Prompt injection patterns
- Destructive commands
- Supply-chain signals

`--force` overrides non-dangerous policy blocks. Dangerous verdicts **cannot** be overridden.

### Agent Self-Management (`skill_manage` tool)

The agent **autonomously creates skills** after complex tasks:

```python
SKILL_MANAGE_SCHEMA = {
    "name": "skill_manage",
    "parameters": {
        "properties": {
            "action": {"enum": ["create", "patch", "edit", "delete", "write_file", "remove_file"]},
            "name": {"type": "string"},       # max 64 chars
            "content": {"type": "string"},    # full SKILL.md text
            "old_string": {"type": "string"}, # for patch action
            "new_string": {"type": "string"},
            "file_path": {"type": "string"},  # for write_file/remove_file
            "file_content": {"type": "string"},
            "category": {"type": "string"},
        }
    }
}
```

**Triggers for agent skill creation:**
- After 5+ tool call tasks completed successfully
- When the agent hit errors and found the working path
- When user corrected its approach
- When it discovered a non-trivial workflow

---

## 3. Relationship: Skills vs MCP Tools vs Plugins

These are **three distinct extensibility layers**:

| Layer | What It Is | Runtime Behavior | Who Creates |
|-------|-----------|------------------|-------------|
| **Skills** | Markdown knowledge docs | Injected into context as instructions (token cost) | User, agent, or hub install |
| **Tools** | Function-calling schemas + handlers | Registered in tool registry, called by LLM | Built-in code or plugins |
| **MCP Servers** | External processes exposing tools via MCP protocol | Tools auto-registered at startup via discovery | Any MCP-compatible server |
| **Plugins** | Python packages with `register(ctx)` | Can register tools, hooks, platforms, providers | Developers |

### How They Interact

```
┌─────────────────────────────────────────────────────────────┐
│                    Agent Loop (LLM)                          │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Skills → injected as context text when agent loads them    │
│                                                             │
│  Tool Registry ← built-in tools                            │
│               ← MCP server tools (mcp_<server>_<tool>)     │
│               ← plugin-registered tools                    │
│                                                             │
│  Plugins → lifecycle hooks (pre/post tool, pre/post LLM)   │
│          → context engines, memory providers, platforms     │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**Skills don't provide tools** — they provide *instructions* that guide the agent on how/when to use existing tools. A skill might say "use `kubectl apply` via the terminal tool" but doesn't register any new callable function.

---

## 4. Marketplace / Registry

### Skills Hub (agentskills.io)

- Official community hub: [agentskills.io](https://agentskills.io/)
- CLI: `hermes skills browse`, `hermes skills search`
- Integrated with 9 sources (see above)
- Custom taps: any GitHub repo with `skills/<name>/SKILL.md` structure

### MCP Server Discovery

- Nous-approved MCP catalog with interactive picker: `optional-mcps/` directory
- The `mcporter` skill discovers MCP servers from other clients (Claude Desktop, Cursor)
- External registries: [mcpfinder.dev](https://mcpfinder.dev), [mcp.so](https://mcp.so)

### Plugins

- No centralized marketplace (yet)
- Distributed via pip (`hermes_agent.plugins` entry point group)
- Or placed in `~/.hermes/plugins/<name>/`
- `hermes plugins install/remove/list` CLI commands

---

## 5. Runtime Loading

### Skills — Progressive Disclosure (3 Levels)

```
Level 0: skills_list()           → [{name, description, category}, ...]  (~3k tokens)
Level 1: skill_view(name)        → Full SKILL.md content + metadata      (varies)
Level 2: skill_view(name, path)  → Specific reference file               (varies)
```

The agent starts with Level 0 (summary). Only loads full content when it actually needs the skill. This minimizes token waste.

**Conditional activation:**
- `requires_toolsets: [terminal]` — show only when terminal toolset is active
- `fallback_for_tools: [web_search]` — hide when web_search exists (fallback pattern)
- `platforms: [macos, linux]` — OS filtering

### MCP Tools — Startup Discovery

```python
# tools/mcp_tool.py → discover_mcp_tools()
def discover_mcp_tools() -> List[str]:
    """Entry point: load config, connect to MCP servers, register tools."""
    servers = _load_mcp_config()              # Read ~/.hermes/config.yaml
    # For each server: spawn connection, call list_tools(), register in tool registry
    register_mcp_servers(servers)             # Parallel connection to all servers
```

Flow:
1. Read `mcp_servers` from `~/.hermes/config.yaml`
2. Spawn connection per server (parallel, background event loop)
3. Initialize MCP session → call `list_tools()`
4. Register each tool as `mcp_{server_name}_{tool_name}` in Hermes tool registry
5. Apply include/exclude filters from config

### Plugins — `register(ctx)` Pattern

```python
# hermes_cli/plugins.py → PluginManager.discover_and_load()
# Scans: <repo>/plugins/, ~/.hermes/plugins/, ./.hermes/plugins/, pip entry points
# For each: imports __init__.py, calls register(ctx)

def register(ctx):
    ctx.register_tool(name="my_tool", toolset="my-toolset",
                      schema=MY_SCHEMA, handler=my_handler)
    ctx.register_hook("pre_tool_call", my_observer)
    ctx.register_hook("on_session_start", my_init)
    ctx.register_command("/mycommand", handler=my_slash_handler)
```

Plugin `register()` is called **exactly once** at startup. The `PluginContext` facade allows:
- `register_tool()` — add tools to agent
- `register_hook()` — lifecycle events
- `register_command()` — slash commands
- `register_cli_command()` — `hermes <plugin> <subcommand>`
- `register_platform()` — gateway adapters (Telegram, Discord, etc.)
- `register_context_engine()` — custom context management
- `register_memory_provider()` — memory backends
- `register_image_gen_provider()`, `register_browser_provider()`, `register_tts_provider()`, etc.

---

## 6. Config Format

### Main config: `~/.hermes/config.yaml`

```yaml
# MCP Servers
mcp_servers:
  filesystem:
    command: "npx"
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    env: {}
    timeout: 120
    connect_timeout: 60
    tools:
      include: [read_file, write_file]   # Allowlist (optional)
      # exclude: [delete_file]           # Or denylist
      resources: true                    # Enable resource utility tools
      prompts: true                      # Enable prompt utility tools
    enabled: true
    supports_parallel_tool_calls: false

  github:
    command: "npx"
    args: ["-y", "@modelcontextprotocol/server-github"]
    env:
      GITHUB_PERSONAL_ACCESS_TOKEN: "${GITHUB_TOKEN}"

  remote-api:
    url: "https://my-server.example.com/mcp"
    headers:
      Authorization: "Bearer ${API_KEY}"
    auth: oauth                          # OAuth 2.1 PKCE support
    timeout: 180

# Skills configuration
skills:
  external_dirs:                         # Additional skill directories
    - ~/.agents/skills
    - /home/shared/team-skills
    - ${SKILLS_REPO}/skills

# Plugin configuration
plugins:
  disabled: [plugin-name]                # Disable specific plugins

# Toolsets (enable/disable groups of tools)
toolsets:
  - terminal
  - web
  - skills
  - memory
```

### Plugin manifest: `plugin.yaml`

```yaml
name: calculator
description: Scientific calculator and unit conversion
version: 1.0.0
kind: standalone              # standalone | backend | exclusive | platform
author: Your Name
```

### Skill bundles: `~/.hermes/skill-bundles/<slug>.yaml`

```yaml
name: backend-dev
description: Backend feature work — review, test, PR workflow.
skills:
  - github-code-review
  - test-driven-development
  - github-pr-workflow
instruction: |
  Always start by writing failing tests, then implement.
```

---

## Key Design Insights

1. **Skills = instructions, not code.** They're injected into the LLM context as text. Zero runtime overhead until loaded.

2. **Agent self-improves.** After complex tasks, the agent autonomously creates skills via `skill_manage`. Skills also self-improve during use (the agent patches them when it finds better approaches).

3. **MCP is the tool extensibility layer.** External tools connect via MCP protocol. The agent sees them identically to built-in tools.

4. **Plugins are the deep integration layer.** For lifecycle hooks, custom providers, platform adapters, and anything that needs Python code execution.

5. **Progressive disclosure everywhere.** Skills use 3-level loading. Tools use toolsets that can be conditionally enabled. This keeps context windows manageable.

6. **Security-first for external content.** All hub-installed skills are scanned. MCP tool descriptions are scanned for prompt injection. Plugin hooks can't crash the agent (errors swallowed).

7. **Decentralized distribution.** No single mandatory marketplace. Skills can come from GitHub repos, direct URLs, well-known endpoints, or community hubs. Custom taps are just Git repos.
