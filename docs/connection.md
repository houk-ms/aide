# Connection

外部系统连接层。通过 MCP 协议实现。

## 核心发现：Work IQ

微软官方提供了 [`@microsoft/workiq`](https://github.com/microsoft/work-iq) MCP Server，一个服务覆盖整个 M365 生态（Outlook、Teams、Calendar、SharePoint、OneDrive、People）。支持读写。

**我们不需要为每个 M365 服务单独建 MCP Server。**

## MVP Connection 架构

只需要两个 MCP Server：

| MCP Server | 覆盖范围 | 安装方式 |
|-----------|---------|---------|
| `@microsoft/workiq` (preview) | Outlook 邮件/日历、Teams 消息/会议、SharePoint/OneDrive 文档、People | `npx -y @microsoft/workiq@preview mcp` |
| GitHub MCP Server | Issues, PRs, Notifications, Repos | 社区现成实现 |

### Work IQ 提供的 Tools（experimental=true 时全部 14 个）

| Tool | 用途 | 对应我们的场景 |
|------|------|---------------|
| `accept_eula` | EULA 接受 | 内部自动处理，不暴露给 Agent |
| `ask_work_iq` | 自然语言查询 M365 数据 | 晨间聚合、信息检索、sync job |
| `list_agents` | 列出可用 agents | 暂不使用 |
| `get_debug_link` | Debug 分享链接 | 调试用 |
| `fetch_work_iq` | 结构化读取实体 | 精确拉取邮件/事件/消息 |
| `create_entity_work_iq` | 创建实体 | 发邮件、创建日历事件 |
| `update_entity_work_iq` | 更新实体 | 更新事件、标记邮件已读 |
| `delete_entity_work_iq` | 删除实体 | 取消事件 |
| `do_action_work_iq` | 执行操作 | 接受/拒绝会议邀请、发送消息 |
| `call_function_work_iq` | 调用 OData 函数 | 高级查询 |
| `get_schema_work_iq` | Schema 发现 | Agent 自主探索可用数据结构 |
| `search_paths_work_iq` | 搜索路径 | 查找可访问的资源路径 |
| `fetch_blob_work_iq` | 下载文件 | 获取 OneDrive/SharePoint 文档 |
| `upload_blob_work_iq` | 上传文件 | 上传到 OneDrive/SharePoint |

### ADO 怎么办

Work IQ 目前不覆盖 ADO。两个选项：
1. MVP 不接 ADO，先做 M365 + GitHub
2. 后续等 Work IQ 扩展或用社区 ADO MCP Server

**决定：MVP 不接 ADO。** M365 + GitHub 已经覆盖核心场景。

## 认证

Work IQ 使用 Microsoft Entra (Azure AD) OAuth，首次使用时弹出 device code 授权。

### Feature Flag（重要）

WorkIQ 默认只暴露 4 个工具（ask, list_agents, get_debug_link, accept_eula）。需要启用 experimental flag 才能注册全部 14 个工具：

```bash
npx -y @microsoft/workiq@preview config set experimental=true
```

这会写入 `~/.workiq.json`，启用 ToolRelay dispatcher（Rego policy engine），注册 entity CRUD 工具。

### Admin Consent 限制（重要）

即使 flag 开启、工具注册成功，**实际可用性受限于 Graph API 权限**：

| 工具 | 可用性 | 原因 |
|------|--------|------|
| `ask_work_iq` | ✅ 可用 | 走 M365 Copilot 通道，不同权限模型 |
| `fetch_work_iq` | ⚠️ 部分可用 | 取决于具体 Graph path 的 scope |
| entity CRUD 工具 | ❌ 不可用 | 需要 Mail.Send, Chat.ReadWrite 等 scope，企业 tenant 需 admin consent |

**结论：Aide 的 periodic-poll 和 sync job 只能依赖 `ask_work_iq`。** 如果未来获得 admin consent，entity 工具可立即生效无需代码改动。

```json
// MCP Server 配置
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

## 对其他模块的影响

- **Skill/Tools**：Agent 的 tool 列表大幅简化，M365 侧直接用 Work IQ 的 tools
- **Job**：定时轮询通过调用 `ask_work_iq` 或 `fetch_work_iq` 实现
- **Task 发现**：`ask_work_iq "What new emails need my action?"` → Agent 分析 → 创建 Task
