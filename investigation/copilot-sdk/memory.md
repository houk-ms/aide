# Copilot SDK Memory/Session 调研

## 核心发现

SDK 提供健壮的 session 持久化 + 自动 context 压缩，但**没有跨 session 的 memory 系统**。跨 session 记忆需要我们自建，SDK 提供了足够的钩子来集成。

## Session 持久化

### 存储
- 完整对话历史持久化到 `~/.copilot/session-state/{sessionId}/`
- 支持 `resumeSession()` 恢复
- 支持 session forking 和 context-aware lookup

### Infinite Sessions（默认启用）

自动 context 压缩：
- **80% 阈值**：触发 LLM-powered compaction（用 LLM 总结旧内容）
- **95% 阈值**：更激进的压缩
- 支持 checkpoint recovery
- 也可手动 `history.compact()` 或 hard truncation

## 内置 Memory（有限）

- `PermissionRequestMemory` 事件：agent 想存储/投票某个事实时触发
- **没有 API 直接查询或注入这个 store**
- 本质上是一个 permission-gated 的事实存储，不是通用 memory

## 集成点（我们建 Memory 用的钩子）

### 1. Lifecycle Hooks

| Hook | 时机 | 用途 |
|------|------|------|
| `onSessionStart` | session 开始 | 注入 `additionalContext`（我们的 Memory 从这里注入） |
| `onUserPromptSubmitted` | 用户发消息后 | 可以增强 prompt（附加相关记忆） |
| `onSessionEnd` | session 结束 | 拿到 `sessionSummary`（用来写入 Memory） |

### 2. Custom Tools

可以定义 agent 能调用的自定义 tool：
- `store_memory` — agent 决定记住某事时调用
- `recall_memory` — agent 需要历史信息时调用
- 完全由我们实现逻辑

### 3. SessionFsProvider

替换整个存储后端的接口：
- 可以改为写入我们的 SQLite / 云存储 / 任意位置
- 给予完全控制 session 数据存在哪里

## SDK 提供 vs 我们自建

| 能力 | SDK 提供 | 我们自建 |
|------|---------|---------|
| 单 session 对话历史 | ✅ | — |
| Context window 压缩 | ✅ | — |
| Session 持久化/恢复 | ✅ | — |
| 跨 session 记忆 | ❌ | ✅ |
| 语义检索 | ❌ | ✅ |
| 记忆分层/晋升 | ❌ | ✅ |
| 重要性/衰减评分 | ❌ | ✅ |
| 合并/遗忘 | ❌ | ✅ |
| Knowledge graph | ❌ | ✅ |

## 关键设计启发

1. **不要重复造 session 管理** — SDK 已经搞定了单 session 内的历史和压缩
2. **用 hooks 注入 Memory** — `onSessionStart` 加载相关长期记忆，`onSessionEnd` 提取本次要记住的
3. **用 Custom Tools 给 agent 主动权** — agent 自己决定什么时候存/取记忆
4. **SessionFsProvider 做统一存储** — 可以让 session 数据和 Memory 数据统一管理
5. **Infinite Sessions 的 compaction 是我们的盟友** — 长对话不会爆 context，SDK 自动处理
