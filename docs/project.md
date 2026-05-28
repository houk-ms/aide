# Project

用户工作项目的上下文信息。简单实体，为 Agent 处理 Task 时提供背景。

## Schema

```typescript
interface Project {
  id: string;
  name: string;
  description: string;       // 一句话描述项目是什么
  repoPath?: string;         // 本地代码仓库路径
  docsPath?: string;         // 文档目录路径
  techStack?: string;        // 技术栈摘要
  team?: string[];           // 核心成员（关联 Relation）
  notes?: string;            // Agent/用户补充的项目备注
  createdAt: Date;
  updatedAt: Date;
}
```

## Agent 如何使用 Project

当 Agent 处理一个 Task 时，如果 Task 关联了 Project：
1. 将 `description` + `techStack` + `notes` 注入上下文
2. 如果需要看代码，通过 `repoPath` 定位
3. 如果需要查文档，通过 `docsPath` 搜索

## 决策

- **不自动索引**。只存路径，Agent 需要时按需读取文件。避免复杂的索引维护。
- **维护方式**：用户在 Settings 中手动创建 Project 并指定路径。Agent 在日常对话中补充 `description`、`techStack`、`notes` 等软信息。
