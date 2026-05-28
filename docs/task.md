# Task

核心实体。系统的一切围绕 Task 运转。

## Task 来源

| 来源 | 触发方式 | 示例 |
|------|---------|------|
| Connection 轮询 | Job 定时拉信息 → Agent 识别出任务 | 收到一封需要回复的邮件 |
| 用户对话 | 用户直接告诉 agent | "帮我写个 PR review" |
| 会议纪要 | Job 拉取会议记录 → Agent 提取 action items | "你来跟进 API 变更" |
| Agent 自主发现 | Agent 在处理过程中发现关联任务 | 处理 bug 时发现需要更新文档 |

## 状态机

```
待处理 (pending)
  → 进行中 (in_progress)  -- Agent 开始处理或用户标记
  → 已取消 (cancelled)    -- 用户取消或 Agent 判断无需处理

进行中 (in_progress)
  → 已完成 (completed)    -- 处理完毕
  → 待处理 (pending)      -- 挂起，稍后再说

已完成 / 已取消 → 不可逆
```

## Schema

```typescript
interface Task {
  id: string;
  title: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
  priority: 'high' | 'medium' | 'low';
  
  // 来源追溯
  source: {
    type: 'email' | 'teams' | 'github' | 'calendar' | 'user' | 'agent';
    connectionId?: string;
    externalId?: string;      // 原始系统中的 ID
    externalUrl?: string;     // 链接回原始系统
  };
  
  // 关联
  projectId?: string;
  relatedRelationIds: string[];
  
  // 时间
  createdAt: Date;
  updatedAt: Date;
  dueDate?: Date;
  completedAt?: Date;
  
  // UI 状态
  seenAt?: Date;              // 用户首次查看时间（null = •new 标记）
  snoozedUntil?: Date;        // 延后到此时间后重新出现在 Active
  
  // Agent 处理记录
  sessionId?: string;         // 关联的 Copilot SDK session
  result?: string;            // 处理结果摘要
}
```

## 去重策略

同一件事可能从多个渠道进入（邮件 + Teams 都提到同一件事）：
- 基于 `externalId` 精确去重（同一封邮件不会创建两个 Task）
- 基于内容相似度模糊去重：Agent 创建 Task 前先 query 现有 Task，判断是否重复

## 优先级判断

Agent 根据以下因素自动排序：
- 来源人的角色（Relation：老板 > 同事 > 外部）
- 是否有明确 deadline
- 是否被催促过
- 关联项目的重要程度

用户可手动覆盖优先级。
