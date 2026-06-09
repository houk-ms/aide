# Connection

The external-systems connection layer. Implemented via the MCP protocol.

## Sources vs Channels

Connections come in two kinds (the concept and rationale live in PRODUCT.md §Sources & Channels). The Settings UI groups them accordingly:

| Kind | Examples | Transport |
|------|----------|-----------|
| **Source** | Work IQ (M365), GitHub | MCP |
| **Channel** | Aide chat (built-in), WeChat / Telegram / Discord / WhatsApp | Built-in IPC (Aide chat) / per-channel bot API |

The rest of this doc covers Sources (the MCP layer). For channel setup see docs/channel-setup.md; for Job result delivery see docs/job.md and docs/ui.md.

## Key finding: Work IQ

Microsoft officially provides [`@microsoft/workiq`](https://github.com/microsoft/work-iq), an MCP Server — a single service that covers the entire M365 ecosystem (Outlook, Teams, Calendar, SharePoint, OneDrive, People). It supports both reads and writes.

**We don't need to build a separate MCP Server for each M365 service.**

## MVP Connection architecture

Only two MCP Servers are needed:

| MCP Server | Coverage | Installation |
|-----------|---------|---------|
| `@microsoft/workiq` (preview) | Outlook mail/calendar, Teams messages/meetings, SharePoint/OneDrive documents, People | `npx -y @microsoft/workiq@preview mcp` |
| GitHub MCP Server | Issues, PRs, Notifications, Repos | Community-ready implementation |

### Tools provided by Work IQ (all 14 when experimental=true)

| Tool | Purpose | Our corresponding scenario |
|------|------|---------------|
| `accept_eula` | EULA acceptance | Handled internally, not exposed to the Agent |
| `ask_work_iq` | Natural-language query of M365 data | Morning aggregation, information retrieval, sync job |
| `list_agents` | List available agents | Not used for now |
| `get_debug_link` | Debug share link | For debugging |
| `fetch_work_iq` | Structured entity reads | Precisely pull email/event/message |
| `create_entity_work_iq` | Create an entity | Send email, create calendar event |
| `update_entity_work_iq` | Update an entity | Update event, mark email read |
| `delete_entity_work_iq` | Delete an entity | Cancel event |
| `do_action_work_iq` | Perform an action | Accept/decline meeting invites, send messages |
| `call_function_work_iq` | Call an OData function | Advanced queries |
| `get_schema_work_iq` | Schema discovery | Agent autonomously explores available data structures |
| `search_paths_work_iq` | Search paths | Find accessible resource paths |
| `fetch_blob_work_iq` | Download a file | Get OneDrive/SharePoint documents |
| `upload_blob_work_iq` | Upload a file | Upload to OneDrive/SharePoint |

### What about ADO

Work IQ doesn't currently cover ADO. Two options:
1. Don't connect ADO in the MVP; do M365 + GitHub first
2. Later, wait for Work IQ to expand or use a community ADO MCP Server

**Decision: don't connect ADO in the MVP.** M365 + GitHub already cover the core scenarios.

## Authentication

Work IQ uses Microsoft Entra (Azure AD) OAuth, prompting a device-code authorization on first use.

### Feature Flag (important)

By default WorkIQ exposes only 4 tools (ask, list_agents, get_debug_link, accept_eula). The experimental flag must be enabled to register all 14 tools:

```bash
npx -y @microsoft/workiq@preview config set experimental=true
```

This writes to `~/.workiq.json`, enabling the ToolRelay dispatcher (Rego policy engine) and registering the entity CRUD tools.

### Admin Consent limitations (important)

Even with the flag enabled and the tools registered successfully, **actual availability is limited by Graph API permissions**:

| Tool | Availability | Reason |
|------|--------|------|
| `ask_work_iq` | ✅ Available | Goes through the M365 Copilot channel, a different permission model |
| `fetch_work_iq` | ⚠️ Partially available | Depends on the scope of the specific Graph path |
| entity CRUD tools | ❌ Unavailable | Require scopes like Mail.Send, Chat.ReadWrite; enterprise tenants need admin consent |

**Conclusion: Aide's periodic-poll and sync jobs can only rely on `ask_work_iq`.** If admin consent is granted in the future, the entity tools take effect immediately with no code changes.

```json
// MCP Server configuration
{
  "workiq": {
    "command": "npx",
    "args": ["-y", "@microsoft/workiq@preview", "mcp"],
    "tools": ["*"]
  },
  "github": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-github"],
    "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" }
  }
}
```

## Impact on other modules

- **Skill/Tools**: the Agent's tool list is greatly simplified; on the M365 side it uses Work IQ's tools directly
- **Job**: periodic polling is implemented by calling `ask_work_iq` or `fetch_work_iq`
- **Task discovery**: `ask_work_iq "What new emails need my action?"` → Agent analyzes → creates a Task
