# Relation

用户工作关系网络。简单实体，帮 Agent 理解优先级和沟通方式。

## Schema

```typescript
interface Relation {
  id: string;
  name: string;
  role: 'manager' | 'peer' | 'report' | 'external' | 'stakeholder';
  org?: string;              // 所在组织/团队
  title?: string;            // 职位
  email?: string;
  teamsId?: string;
  timezone?: string;
  expertise?: string[];      // 擅长领域
  communicationStyle?: string; // "偏好简短邮件" / "喜欢 Teams 语音"
  notes?: string;            // Agent/用户补充的备注
  createdAt: Date;
  updatedAt: Date;
}
```

## Agent 如何使用 Relation

- **优先级判断**：manager 发来的任务 > peer 发来的
- **沟通方式选择**：根据对方偏好选择邮件/Teams/其他
- **专长路由**：需要某领域帮助时，知道该找谁
- **上下文理解**："A 说的那个事"——Agent 知道 A 是谁、什么角色

## 数据来源

- 用户手动配置核心关系（老板、直接同事）
- Agent 从日常信息流中自动识别新人物，提议添加
- Agent 从交互中逐渐补充属性（观察到 A 总是用 Teams 回复 → 记录沟通偏好）
