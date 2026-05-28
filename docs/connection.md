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

### Work IQ 提供的 Tools

| Tool | 用途 | 对应我们的场景 |
|------|------|---------------|
| `ask_work_iq` | 自然语言查询 M365 数据 | 晨间聚合、信息检索 |
| `fetch_work_iq` | 结构化读取实体 | 精确拉取邮件/事件/消息 |
| `create_entity_work_iq` | 创建实体 | 发邮件、创建日历事件 |
| `update_entity_work_iq` | 更新实体 | 更新事件、标记邮件已读 |
| `delete_entity_work_iq` | 删除实体 | 取消事件 |
| `do_action_work_iq` | 执行操作 | 接受/拒绝会议邀请 |
| `fetch_blob_work_iq` | 下载文件 | 获取 OneDrive/SharePoint 文档 |
| `get_schema_work_iq` | Schema 发现 | Agent 自主探索可用数据结构 |
| `search_paths_work_iq` | 搜索路径 | 查找可访问的资源路径 |

### ADO 怎么办

Work IQ 目前不覆盖 ADO。两个选项：
1. MVP 不接 ADO，先做 M365 + GitHub
2. 后续等 Work IQ 扩展或用社区 ADO MCP Server

**决定：MVP 不接 ADO。** M365 + GitHub 已经覆盖核心场景。

## 认证

Work IQ 使用 Microsoft Entra (Azure AD) OAuth，需要 tenant admin consent。首次使用时弹出授权对话框。

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
