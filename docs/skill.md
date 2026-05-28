# Skill

**不是独立子系统，是 Tool 的 UI 分组视图。**

## 定位

在 Copilot SDK 架构下，Agent 直接调用 tools，不经过"Skill"层。所谓 Skill 只是前端 Settings 页面里对 tools 的逻辑分组，方便用户理解 Agent 能做什么。运行时不存在 Skill 的概念。

## Tool 分组（UI 展示用）

| 分组 | 包含的 Tools | 来源 |
|------|-------------|------|
| M365 查询 | ask_work_iq, fetch_work_iq, search_paths_work_iq, get_schema_work_iq | Work IQ MCP Server |
| M365 写操作 | create_entity_work_iq, update_entity_work_iq, delete_entity_work_iq, do_action_work_iq | Work IQ MCP Server |
| M365 文件 | fetch_blob_work_iq, upload_blob_work_iq | Work IQ MCP Server |
| GitHub | list_issues, create_issue, create_pr, review_pr | GitHub MCP Server |
| 任务 | create_task, update_task, query_tasks | 内部模块 |
| 记忆 | memory_write, memory_search | 内部模块 |
| 日报 | generate_report | 内部模块 |

## Tool 注册

所有 tools 在 Agent session 创建时一次性注册到 SDK。Agent 根据当前 Task 自主决定调用哪些——这是 SDK 推理循环的职责。

```typescript
const session = await client.createSession({
  tools: [
    ...workiqTools,       // Work IQ MCP Server (M365 全覆盖)
    ...githubTools,       // GitHub MCP Server
    ...internalTools,     // task, memory, report
  ],
});
```

如果 tool 总数过多导致推理质量下降，可以按 Task 关联的 Connection 做动态裁剪（只注入相关 tools）。MVP 先全量注入，观察效果再决定是否裁剪。
