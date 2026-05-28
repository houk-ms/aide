# Job

调度子系统。驱动定时任务执行。

## 职责

Job 是系统主动运行的驱动力。没有 Job，系统只能被动等用户打开对话。

## 内置 Jobs（MVP）

| Job | 频率 | 做什么 |
|-----|------|--------|
| 晨间聚合 | 每天早上 (可配) | 拉取所有新信息，Agent 分析生成今日任务列表 |
| 定时轮询 | 每 15 分钟 | 检查有无新信息（邮件、消息、PR 等），有则创建/更新 Task |
| 日终对账 | 每天下班前 (可配) | Agent 回顾今天信息流，补建遗漏任务，更新状态，生成日报 |

## 执行模型

Job 触发后需要 Agent（LLM）来分析数据和做决策。具体流程：

```
Job 触发 (cron)
  → 创建一个临时 Agent session（无用户交互，纯后台）
  → System prompt: "你是 Aide 后台调度 Agent，任务是 {job.instruction}"
  → 注入 L0 Identity + 相关 context
  → Agent 调用 tools (ask_work_iq / fetch_work_iq / GitHub tools)
  → Agent 分析结果，决定创建/更新 Task、写入 Memory
  → Session 结束，释放资源
```

**关键设计：Job session 是无交互的。** Agent 不会问用户问题，所有写操作自动执行（Job 的 permission 级别固定为"通知"——执行后在 Dashboard 显示摘要）。

### 成本控制

每次 Job 执行 = 1 次 LLM 调用。控制策略：
- 定时轮询先做规则预过滤：只有确实有新数据时才启动 Agent session
- 晨间聚合和日终对账每天各 1 次，成本可接受
- Job session 不注入 L1 检索结果（节省 token），只注入 L0 + job 指令

## Schema

```typescript
interface Job {
  id: string;
  name: string;
  cron: string;              // cron 表达式
  instruction: string;       // 给 Agent 的指令（"检查新邮件，识别需要我处理的事项"）
  enabled: boolean;
  lastRunAt: Date | null;
  lastResult: 'success' | 'failed' | null;
  lastSummary: string | null; // 上次执行结果摘要
}
```

## 实现方案

本地单用户，一个简单的 timer + cron 解析器即可：
- Main process 内 JobScheduler 模块，启动时加载所有 enabled jobs
- 到点触发：规则预过滤 → 有新数据 → 创建 Agent session → 分析 → 写 Task/Memory
- 串行执行（不并发）
- 失败记录日志，下次重试

## 决策

- **App 关闭时 Job 停止，不补跑。** 下次打开后晨间聚合自然会拉到所有未处理信息，无遗漏风险。
