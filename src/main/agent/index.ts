import { getL0Content, searchMemory, writeMemory } from '../memory'
import { createTask, updateTask, listTasks, getTask } from '../tasks'
import { getProject } from '../projects'
import { listRelations, getRelation } from '../relations'
import { getAutonomyLevel, getPreferences } from '../preferences'
import { getConnectionStatus } from '../connections'
import { showSystemNotification } from '../index'
import type { ChatMessage, Task, PendingAction } from '@shared/types'
import { v4 as uuid } from 'uuid'
import { getDb } from '../db'
import { BrowserWindow } from 'electron'
import type { CopilotClient, CopilotSession } from '@github/copilot-sdk'
import type { SessionConfig, PermissionRequest, PermissionRequestResult } from '@github/copilot-sdk'
import { buildTools } from './tools'

// ============================================================
// Agent Engine — Adapter between Aide and Copilot SDK
// ============================================================
// SDK 负责:
//   - 推理循环 (receive → understand → plan → execute → respond)
//   - Tool 编排 (自动选择、调用、处理结果、再次推理)
//   - Session 持久化 & resume
//   - 多轮对话 & context window 自动压缩 (infinite sessions)
//   - 流式输出
//
// 我们负责:
//   - Custom Tools (memory, tasks, reports) 的实现
//   - Lifecycle Hooks (注入 Memory, 提取 facts)
//   - Permission handler (自主级别控制)
//   - 动态 System Prompt 拼装
// ============================================================

let client: CopilotClient | null = null
let activeSession: CopilotSession | null = null

export function initAgent(sdkClient: CopilotClient): void {
  client = sdkClient
}

export function stopStream(): void {
  if (activeSession) {
    activeSession.abort()
    activeSession = null
  }
}

// === Reset Session (清除有问题的对话历史) ===

export async function resetSession(taskId: string | null): Promise<void> {
  if (!client) return
  const sessionId = taskId ? getTaskSessionId(taskId) : 'general'
  try {
    await client.deleteSession(sessionId)
    console.log(`[Agent] session reset: ${sessionId}`)
  } catch (e) {
    console.log(`[Agent] session reset failed (may not exist): ${sessionId}`)
  }
}

// === Session ID Convention ===
// Task: "task-{taskId}-{attempt}"
// General: "general"
// Job: "job-{jobId}-{timestamp}"

function getTaskSessionId(taskId: string): string {
  return `task-${taskId}-1`
}

function extractTaskIdFromSession(sessionId: string): string | null {
  const match = sessionId.match(/^task-(.+)-\d+$/)
  return match ? match[1] : null
}

// === Lifecycle Hooks ===

const hooks: SessionConfig['hooks'] = {
  // 注入 L0 Identity + 动态上下文
  onSessionStart: async (_input: any, invocation: { sessionId: string }) => {
    const l0 = getL0Content()
    const taskId = extractTaskIdFromSession(invocation.sessionId)
    const parts: string[] = []

    if (l0) parts.push(`## 身份记忆\n${l0}`)

    if (taskId) {
      const task = getTask(taskId)
      if (task) {
        parts.push(formatTaskContext(task))
        if (task.projectId) {
          const project = getProject(task.projectId)
          if (project) parts.push(formatProjectContext(project))
        }
        if (task.relatedRelationIds.length > 0) {
          const rels = task.relatedRelationIds.map(id => getRelation(id)).filter(Boolean)
          if (rels.length) parts.push(formatRelationsContext(rels as any[]))
        }
      }
    } else if (invocation.sessionId === 'general') {
      // General chat: inject workspace awareness (task summary + connection status)
      const conns = getConnectionStatus()
      const connSummary = conns.map(c =>
        `- ${c.type}: ${c.authenticated ? `✓ 已连接${c.activeAccount ? ` (${c.activeAccount})` : ''}` : '✗ 未连接'}${c.lastError ? ` [错误: ${c.lastError}]` : ''}`
      ).join('\n')
      parts.push(`## 当前连接状态\n${connSummary}`)

      // Brief task overview
      const allTasks = listTasks({})
      const pendingCount = allTasks.filter(t => t.status === 'pending' || t.status === 'in_progress').length
      const p0Count = allTasks.filter(t => (t.status === 'pending' || t.status === 'in_progress') && t.priority === 'p0').length
      const unseenCount = allTasks.filter(t => (t.status === 'pending' || t.status === 'in_progress') && !t.seenAt).length
      if (pendingCount > 0) {
        parts.push(`## 任务概况\n活跃任务: ${pendingCount} 个${p0Count > 0 ? `（其中 ${p0Count} 个紧急）` : ''}${unseenCount > 0 ? `，${unseenCount} 个未读` : ''}`)
      }
    }

    // Token budget: ~4K total. 固定 prompt ~1K, L0 ~2K, 动态 ~1K
    // 截断优先级: Task > Relation > Project > L1
    return { additionalContext: parts.join('\n\n') }
  },

  // 注入 L1 Knowledge — 基于用户消息做 FTS5 检索
  // Also tracks interaction count for periodic memory flush (since infinite sessions never trigger onSessionEnd)
  onUserPromptSubmitted: async (input: any, invocation: { sessionId: string }) => {
    // Track interaction count and periodically flush a session context marker to L2
    const count = (sessionInteractionCount.get(invocation.sessionId) || 0) + 1
    sessionInteractionCount.set(invocation.sessionId, count)
    if (count % MEMORY_FLUSH_INTERVAL === 0) {
      const taskId = extractTaskIdFromSession(invocation.sessionId)
      writeMemory({
        content: `[Session Checkpoint] session=${invocation.sessionId}, ${count} interactions. Recent topic: ${input.prompt.slice(0, 200)}`,
        layer: 'L2',
        source: 'system',
        taskId: taskId || undefined
      })
    }

    const memories = searchMemory(input.prompt, 5)
    if (memories.length === 0) return {}
    const block = memories.map(m => `- ${m.content}`).join('\n')
    return { modifiedPrompt: `<memory-context>\n${block}\n</memory-context>\n\n${input.prompt}` }
  },

  // Session 结束时：提取 summary → L2, 补漏提取
  onSessionEnd: async (input: any, invocation: { sessionId: string }) => {
    if (input.reason === 'complete' || input.reason === 'user_exit') {
      const taskId = extractTaskIdFromSession(invocation.sessionId)

      // Archive session summary to L2
      if (input.finalMessage) {
        writeMemory({
          content: `[Session Summary] ${input.finalMessage}`,
          layer: 'L2',
          source: 'system',
          taskId: taskId || undefined
        })
      }
    }
    return {}
  },

  // 工具调用前 — 授权拦截 + 向 UI 推送记录
  onPreToolUse: async (input: any, invocation: { sessionId: string }) => {
    const toolName: string = input.toolName || ''
    const toolCallId: string = input.toolCallId || `tc-${Date.now()}`
    const inputPreview = summarizeToolInput(toolName, input.toolArgs)
    console.log(`[Agent] tool_pre: ${toolName} | session: ${invocation.sessionId} | args: ${JSON.stringify(input.toolArgs || {}).slice(0, 200)}`)

    // Auto-promote task to in_progress on first tool call
    const taskId = extractTaskIdFromSession(invocation.sessionId)
    if (taskId && !activatedTaskSessions.has(invocation.sessionId)) {
      activatedTaskSessions.add(invocation.sessionId)
      const task = getTask(taskId)
      if (task && task.status === 'pending') {
        updateTask(taskId, { status: 'in_progress' })
        emitEvent({ type: 'task:updated', task: { ...task, status: 'in_progress' } })
      }
    }

    // 向 UI 推送"正在调用"记录
    toolCallTimestamps.set(toolCallId, Date.now())
    emitEvent({
      type: 'chat:tool-use',
      taskId,
      record: { id: toolCallId, toolName, status: 'running', timestamp: new Date().toISOString(), inputPreview }
    })

    // 受保护工具 → 弹确认卡片等用户批准
    if (CONFIRM_REQUIRED_TOOLS.has(toolName)) {
      const approved = await requestToolConfirmation(toolName, input.toolArgs)
      if (!approved) {
        emitEvent({
          type: 'chat:tool-use',
          taskId,
          record: { id: toolCallId, toolName, status: 'error', timestamp: new Date().toISOString(), inputPreview, resultPreview: '用户取消' }
        })
        toolCallTimestamps.delete(toolCallId)
        return { permissionDecision: 'deny' as const, permissionDecisionReason: '用户取消了操作' }
      }
    }
    // 其余工具 → 放行
    return undefined
  },

  // 工具调用后 — 向 UI 推送完成记录
  onPostToolUse: async (input: any, invocation: { sessionId: string }) => {
    const toolName: string = input.toolName || ''
    const toolCallId: string = input.toolCallId || ''
    const taskId = extractTaskIdFromSession(invocation.sessionId)
    const inputPreview = summarizeToolInput(toolName, input.toolArgs)
    const startTime = toolCallTimestamps.get(toolCallId)
    const durationMs = startTime ? Date.now() - startTime : undefined
    toolCallTimestamps.delete(toolCallId)

    const resultStr = JSON.stringify(input.toolResult || '')
    const resultPreview = resultStr.length > 120 ? resultStr.slice(0, 120) + '…' : resultStr
    console.log(`[Agent] tool_post: ${toolName} | session: ${invocation.sessionId} | ${durationMs}ms | result_size: ${resultStr.length}`)

    emitEvent({
      type: 'chat:tool-use',
      taskId,
      record: { id: toolCallId, toolName, status: 'done', timestamp: new Date().toISOString(), durationMs, inputPreview, resultPreview }
    })
  }
}

// Tool call timing tracker
const toolCallTimestamps = new Map<string, number>()
// Track sessions where task has been auto-promoted to in_progress
const activatedTaskSessions = new Set<string>()
// Track interaction count per session for periodic memory flush
const sessionInteractionCount = new Map<string, number>()
const MEMORY_FLUSH_INTERVAL = 10 // Flush every N user messages

// === Permission Handler (分类级别授权) ===

// onPermissionRequest 处理 SDK 分类级别的权限（shell, mcp, write, read 等）
// 工具级别的精确控制在 onPreToolUse 中（见上方 hooks）

const pendingActions = new Map<string, { resolve: (v: boolean) => void; action: PendingAction; timer: ReturnType<typeof setTimeout> }>()

async function handlePermissionRequest(request: PermissionRequest, _invocation: { sessionId: string }): Promise<PermissionRequestResult> {
  const level = getAutonomyLevel()

  // confirm 模式 — 所有分类都弹确认
  if (level === 'confirm') {
    const approved = await requestCategoryConfirmation(request)
    return approved ? { kind: 'approve-once' } : { kind: 'reject' }
  }

  // default / auto — 分类级别全部自动批准（具体工具由 onPreToolUse 拦截）
  return { kind: 'approve-once' }
}

function requestCategoryConfirmation(request: PermissionRequest): Promise<boolean> {
  return new Promise((resolve) => {
    const actionId = uuid()
    const action: PendingAction = {
      id: actionId,
      type: request.kind,
      description: `允许 ${request.kind} 类操作`,
      details: request as unknown as Record<string, unknown>,
      status: 'pending'
    }

    const timer = setTimeout(() => {
      if (pendingActions.has(actionId)) {
        pendingActions.delete(actionId)
        action.status = 'cancelled'
        emitEvent({ type: 'chat:action-expired', actionId })
        resolve(false)
      }
    }, 5 * 60 * 1000)

    pendingActions.set(actionId, { resolve, action, timer })
    emitEvent({ type: 'chat:pending-action', action })
  })
}

// === 工具级别授权 (由 onPreToolUse 调用) ===

// 需要强制确认的工具（外部写操作）
// 注：WorkIQ 发送类工具已在 MCP 层过滤，不再注册给 LLM
const CONFIRM_REQUIRED_TOOLS = new Set([
  // GitHub — 评论/review
  'create_issue_comment',
  'create_pull_request_review',
])

const TOOL_LABELS: Record<string, string> = {
  create_issue_comment: '评论 GitHub Issue',
  create_pull_request_review: '提交 PR Review',
}

function requestToolConfirmation(toolName: string, toolArgs: unknown): Promise<boolean> {
  return new Promise((resolve) => {
    const actionId = uuid()
    const action: PendingAction = {
      id: actionId,
      type: 'tool_call',
      toolName,
      description: TOOL_LABELS[toolName] || `执行 ${toolName}`,
      details: toolArgs as Record<string, unknown> || {},
      status: 'pending'
    }

    const timer = setTimeout(() => {
      if (pendingActions.has(actionId)) {
        pendingActions.delete(actionId)
        action.status = 'cancelled'
        emitEvent({ type: 'chat:action-expired', actionId })
        resolve(false)
      }
    }, 5 * 60 * 1000)

    pendingActions.set(actionId, { resolve, action, timer })
    emitEvent({ type: 'chat:pending-action', action })
  })
}

export function resolveAction(actionId: string, decision: 'confirm' | 'modify' | 'cancel'): void {
  confirmAction(actionId, decision)
}

// === System Prompt ===

function buildSystemMessage(): string {
  const now = new Date()
  const prefs = getPreferences()
  const langInstruction = prefs.language === 'en'
    ? '- Respond in English unless the user writes in another language'
    : '- 使用中文回复（除非用户用其他语言）'
  const locale = prefs.language === 'en' ? 'en-US' : 'zh-CN'

  // Gather connected identities
  const conns = getConnectionStatus()
  const ghConn = conns.find(c => c.type === 'github')
  const identityLines: string[] = []
  if (ghConn?.activeAccount) identityLines.push(`- GitHub: ${ghConn.activeAccount}`)

  return `你是 Aide，用户的个人工作 Agent。你帮助用户管理工作事务、跟踪任务、处理信息流。

当前时间: ${now.toLocaleDateString(locale)} ${now.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}${identityLines.length ? `\n当前操作身份:\n${identityLines.join('\n')}` : ''}

## 行为准则
- 回答简洁直接
- 读操作直接做；写操作（发邮件/评论PR）直接调工具，系统会自动弹确认卡片
- 发现值得记住的新事实时调 memory_write

## 任务管理原则

**门槛（高）**：只有明确需要我本人出手的事才建 Task。
- 该建：点名要我做某事、单独发给我要求行动、我是明确责任人
- 不该建：纯通知、我只是 CC/群发对象、已完成的事、自动订阅

**优先级**：
- P0：重要的人点名我 + 单独发给我 + 事情紧急。三者结合。
- P1：需要我处理，有重要性或时限，但不紧急。
- P2：被牵涉但不是唯一责任人，或低优先级。
- 不确定就选 P2。

**去重**：创建前确认没有已存在的相同任务（系统会注入已有任务列表）。传 sourceId 做精确去重。

## 联系人与项目

克制。质量优先于数量。
- 联系人：只记与我有直接实质性往来的人。群里没跟我交流过的不记。判断标准：这个人下周还会出现吗？
- 项目：必须对应真实 repo（有 GitHub URL 或本地路径）。抽象概念不建。
- 不要首次看到就记录，确认重要/重复出现后再建。

## 记忆管理
- 该记：用户纠正、偏好、稳定事实、人际关系
- 不该记：临时状态、会快速过期的信息
- 用户纠正时，检查并修正已有的错误记忆，不能只加新的不管旧的

## 上下文感知
- General 对话中提到与已有 Task 相关的事 → 提示是否切换
- 进入 Task 对话时 → 简要说明任务背景、状态、建议处理方式
${langInstruction}`
}

// === Model Selection (persisted to DB) ===

let selectedModel: string | null = null

export async function listModels(): Promise<{ id: string; name: string }[]> {
  if (!client) return [{ id: 'claude-opus-4.8', name: 'Claude Opus 4.8' }]
  try {
    const models = await client.listModels()
    return models.map(m => ({ id: m.id, name: m.name }))
  } catch {
    return [{ id: 'claude-opus-4.8', name: 'Claude Opus 4.8' }]
  }
}

export function getSelectedModel(): string {
  if (!selectedModel) {
    const db = getDb()
    const row = db.prepare("SELECT content FROM memory_entries WHERE id = '__selected_model'").get() as { content: string } | undefined
    selectedModel = row?.content || 'claude-opus-4.8'
  }
  return selectedModel
}

export function setSelectedModel(modelId: string): void {
  selectedModel = modelId
  const db = getDb()
  const now = new Date().toISOString()
  db.prepare(`
    INSERT OR REPLACE INTO memory_entries (id, layer, content, source, status, created_at, updated_at, tags)
    VALUES ('__selected_model', 'L0', ?, 'system', 'active', ?, ?, '[]')
  `).run(modelId, now, now)
}

// === 核心 API: 发送消息 ===

async function getOrCreateSession(taskId: string | null): Promise<CopilotSession> {
  if (!client) throw new Error('Copilot SDK not initialized. Ensure SDK is configured.')

  const sessionId = taskId ? getTaskSessionId(taskId) : 'general'
  const config: SessionConfig = {
    sessionId,
    model: getSelectedModel(),
    streaming: true,
    tools: buildTools(),
    hooks,
    infiniteSessions: { enabled: true },
    systemMessage: { mode: 'append', content: buildSystemMessage() },
    onPermissionRequest: handlePermissionRequest
  }

  try {
    return await client.resumeSession(sessionId, config)
  } catch {
    return await client.createSession(config)
  }
}

export async function sendMessage(
  userMessage: string,
  taskId: string | null,
  onStream: (delta: string) => void,
  attachments?: { name: string; type: string; dataUrl: string }[]
): Promise<ChatMessage> {
  // 存用户消息到本地 DB (UI 展示用)
  const userMsg: ChatMessage = {
    id: uuid(),
    role: 'user',
    content: userMessage,
    timestamp: new Date().toISOString(),
    taskId
  }
  saveMessage(userMsg)

  const session = await getOrCreateSession(taskId)
  activeSession = session

  // 构建 prompt（附件以内联方式附加）
  let prompt = userMessage
  if (attachments && attachments.length > 0) {
    const attachmentDescriptions = attachments.map(a => {
      if (a.type.startsWith('image/')) {
        return `[附件: 图片 "${a.name}" (${a.type}), data: ${a.dataUrl}]`
      }
      return `[附件: 文件 "${a.name}" (${a.type})]`
    }).join('\n')
    prompt = `${userMessage}\n\n${attachmentDescriptions}`
  }

  // 订阅流式事件
  let fullResponse = ''
  const unsubscribe = session.on('assistant.message_delta', (event) => {
    const delta = event.data.deltaContent || ''
    onStream(delta)
    fullResponse += delta
  })

  try {
    const result = await session.sendAndWait({ prompt }, 180_000)
    if (result) {
      fullResponse = result.data.content || fullResponse
    }
  } finally {
    unsubscribe()
    activeSession = null
  }

  // 存 agent 回复
  const agentMsg: ChatMessage = {
    id: uuid(),
    role: 'agent',
    content: fullResponse,
    timestamp: new Date().toISOString(),
    taskId
  }
  saveMessage(agentMsg)
  return agentMsg
}

// === Job 执行 (无头 agent session) ===

// Job: category-level auto-approve. Tool-level blocking via onPreToolUse in job hooks.
function jobPermissionHandler(_request: PermissionRequest): PermissionRequestResult {
  return { kind: 'approve-once' }
}

// Job hooks: override onPreToolUse to hard-deny protected tools (no user to confirm)
const jobHooks = {
  ...hooks,
  onPreToolUse: async (input: any, invocation: { sessionId: string }) => {
    const toolName: string = input.toolName || ''
    console.log(`[Agent/Job] tool_pre: ${toolName} | session: ${invocation.sessionId}`)
    if (CONFIRM_REQUIRED_TOOLS.has(toolName)) {
      return { permissionDecision: 'deny' as const, permissionDecisionReason: 'Job 模式不允许发送类操作' }
    }
    return undefined
  },
  onSessionStart: async () => {
    const parts: string[] = []

    // Identity
    const l0 = getL0Content()
    if (l0) parts.push(`## 身份记忆\n${l0}`)

    // Existing tasks (prevents duplicates — Agent sees what already exists)
    const existingTasks = listTasks({ status: ['pending', 'in_progress'] })
    if (existingTasks.length > 0) {
      const taskLines = existingTasks.slice(0, 30).map(t =>
        `- [${t.priority}] ${t.title}${t.source.externalId ? ` (src:${t.source.externalId})` : ''}`
      ).join('\n')
      parts.push(`## 已有任务\n${taskLines}`)
    }

    parts.push(`[JOB MODE] 自动执行。可创建任务和记忆。不允许发邮件/评论等外部写操作。`)

    return { additionalContext: parts.join('\n\n') }
  }
}

import { setJobSession } from './state'

export async function executeJobSession(instruction: string, jobId: string, lastRunAt?: string | null): Promise<string> {
  if (!client) throw new Error('Copilot SDK not initialized')

  // Timeouts per job type (MCP calls like ask_work_iq take 60-90s each)
  const JOB_TIMEOUTS: Record<string, number> = {
    'periodic-poll': 300_000,      // 5 min — checks new items, creates tasks
    'morning-briefing': 480_000,   // 8 min — scans all sources, creates many tasks
    'eod-review': 300_000,         // 5 min — reviews today's tasks
    'world-sync': 600_000,         // 10 min — full relation/project sync
  }
  const timeoutMs = JOB_TIMEOUTS[jobId] || 300_000

  const sessionId = `job-${jobId}-${Date.now()}`
  setJobSession(true)
  try {
    const session = await client.createSession({
      sessionId,
      model: getSelectedModel(),
      tools: buildTools(),
      hooks: jobHooks,
      infiniteSessions: { enabled: false },
      systemMessage: { mode: 'append', content: buildSystemMessage() },
      onPermissionRequest: jobPermissionHandler
    })

    // Inject time context into the prompt so Agent knows the time window
    // Inject time context as metadata, not instructions
    let prompt = instruction
    if (lastRunAt) {
      prompt = `[上次执行时间: ${lastRunAt}]\n\n${instruction}`
    } else {
      prompt = `[首次执行，当前时间: ${new Date().toISOString()}]\n\n${instruction}`
    }
    const result = await session.sendAndWait({ prompt }, timeoutMs)
    await session.disconnect()
    return result?.data.content || ''
  } finally {
    setJobSession(false)
  }
}

// === Morning Briefing (主动消息) ===

export async function generateMorningBriefing(): Promise<string> {
  // Fetch instruction from DB so there's a single source of truth
  const db = getDb()
  const row = db.prepare("SELECT instruction FROM jobs WHERE id = 'morning-briefing'").get() as { instruction: string } | undefined
  const instruction = row?.instruction || '检查今天的日历事件、新邮件、Teams 消息和 GitHub 通知。为需要我处理的事项创建 Task，按优先级排序给出今日建议。'
  return executeJobSession(instruction, 'morning-briefing')
}

// === Chat History (本地 DB, UI 展示用) ===

function saveMessage(msg: ChatMessage): void {
  const db = getDb()
  db.prepare(`
    INSERT INTO chat_messages (id, role, content, timestamp, task_id, pending_action)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(msg.id, msg.role, msg.content, msg.timestamp, msg.taskId, msg.pendingAction ? JSON.stringify(msg.pendingAction) : null)
}

export function getChatHistory(taskId: string | null): ChatMessage[] {
  const db = getDb()
  const rows = taskId
    ? db.prepare('SELECT * FROM chat_messages WHERE task_id = ? ORDER BY timestamp').all(taskId)
    : db.prepare('SELECT * FROM chat_messages WHERE task_id IS NULL ORDER BY timestamp').all()

  return (rows as Record<string, unknown>[]).map(row => ({
    id: row.id as string,
    role: row.role as 'user' | 'agent',
    content: row.content as string,
    timestamp: row.timestamp as string,
    taskId: row.task_id as string | null,
    pendingAction: row.pending_action ? JSON.parse(row.pending_action as string) : undefined
  }))
}

export function confirmAction(actionId: string, decision: 'confirm' | 'modify' | 'cancel', modification?: string): void {
  const pending = pendingActions.get(actionId)
  if (!pending) return

  clearTimeout(pending.timer)

  if (decision === 'modify' && modification) {
    pending.action.status = 'cancelled'
    pending.resolve(false)
    pendingActions.delete(actionId)
    return
  }

  pending.action.status = decision === 'confirm' ? 'confirmed' : 'cancelled'
  pending.resolve(decision === 'confirm')
  pendingActions.delete(actionId)
}

// === First Message: Instant task briefing from local data (no LLM call) ===

export async function triggerFirstMessage(taskId: string): Promise<ChatMessage | null> {
  const task = getTask(taskId)
  if (!task) return null

  // Check if there's already chat history for this task — if so, don't re-explain
  const history = getChatHistory(taskId)
  if (history.length > 0) return null

  // Build a local briefing from structured data — instant, no LLM needed
  const sourceLabel = { email: '邮件', github: 'GitHub', teams: 'Teams', calendar: '日历', user: '手动创建', agent: 'Agent' }[task.source.type] || task.source.type
  const priorityLabel = { p0: 'P0（紧急）', p1: 'P1（正常）', p2: 'P2（可延后）' }[task.priority] || task.priority
  const statusLabel = { pending: '待处理', in_progress: '处理中', completed: '已完成', cancelled: '已取消' }[task.status] || task.status

  const lines: string[] = []
  lines.push(`**${task.title}**`)
  lines.push('')
  lines.push(`来源：${sourceLabel}${task.source.externalUrl ? ` · [链接](${task.source.externalUrl})` : ''}`)
  lines.push(`优先级：${priorityLabel} · 状态：${statusLabel}`)
  if (task.dueDate) {
    const due = new Date(task.dueDate)
    const now = new Date()
    const diffDays = Math.ceil((due.getTime() - now.getTime()) / 86400000)
    const dueStr = due.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
    if (diffDays < 0) lines.push(`截止：${dueStr}（已逾期 ${-diffDays} 天）`)
    else if (diffDays === 0) lines.push(`截止：今天`)
    else lines.push(`截止：${dueStr}（${diffDays} 天后）`)
  }
  if (task.description) {
    lines.push('')
    lines.push(task.description)
  }
  lines.push('')
  lines.push('---')
  lines.push('需要我帮你处理这个任务吗？可以直接告诉我要做什么。')

  const agentMsg: ChatMessage = {
    id: uuid(),
    role: 'agent',
    content: lines.join('\n'),
    timestamp: new Date().toISOString(),
    taskId
  }
  saveMessage(agentMsg)
  emitEvent({ type: 'chat:message', message: agentMsg })
  return agentMsg
}

// === Helpers ===

function formatTaskContext(task: Task): string {
  const lines = [`## 当前任务`, `- ID: ${task.id}`, `- 标题: ${task.title}`, `- 状态: ${task.status}`, `- 优先级: ${task.priority}`]
  if (task.description) lines.push(`- 描述: ${task.description}`)
  if (task.dueDate) lines.push(`- 截止: ${task.dueDate}`)
  if (task.source.externalUrl) lines.push(`- 来源: ${task.source.externalUrl}`)
  lines.push(`\n> 用户在此任务的对话中。可直接用 update_task(id: "${task.id}", ...) 操作此任务。`)
  return lines.join('\n')
}

function formatProjectContext(p: { name: string; description: string; techStack: string | null }): string {
  return `## 关联项目: ${p.name}\n${p.description}${p.techStack ? `\n技术栈: ${p.techStack}` : ''}`
}

function formatRelationsContext(rels: Array<{ name: string; role: string; expertise: string[]; communicationStyle: string | null }>): string {
  return '## 相关人员\n' + rels.map(r =>
    `- ${r.name} (${r.role})${r.expertise.length ? ' — ' + r.expertise.join(', ') : ''}${r.communicationStyle ? ' — ' + r.communicationStyle : ''}`
  ).join('\n')
}

function emitEvent(event: { type: string; [key: string]: unknown }): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('aide:event', event)
  }
}

function summarizeToolInput(toolName: string, toolArgs: unknown): string | undefined {
  if (!toolArgs || typeof toolArgs !== 'object') return undefined

  const args = toolArgs as Record<string, unknown>
  const preferredKeys = toolName.toLowerCase().includes('powershell') || toolName.toLowerCase().includes('shell')
    ? ['command', 'cmd', 'script', 'code', 'input']
    : ['command', 'cmd', 'script', 'query', 'prompt', 'title', 'path', 'filePath', 'url', 'repo', 'name', 'action']

  for (const key of preferredKeys) {
    const value = args[key]
    const preview = previewValue(value)
    if (preview) return preview
  }

  const entries = Object.entries(args)
    .map(([key, value]) => {
      const preview = previewValue(value)
      return preview ? `${key}: ${preview}` : null
    })
    .filter(Boolean) as string[]

  if (entries.length === 0) return undefined
  return truncatePreview(entries.slice(0, 2).join(' · '))
}

function previewValue(value: unknown): string | undefined {
  if (typeof value === 'string') return truncatePreview(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value) && value.length > 0) return truncatePreview(value.map(v => previewValue(v) || '').filter(Boolean).join(', '))
  return undefined
}

function truncatePreview(value: string, max = 160): string | undefined {
  const compact = value.replace(/\s+/g, ' ').trim()
  if (!compact) return undefined
  return compact.length > max ? compact.slice(0, max - 1) + '…' : compact
}

// === Relation cleanup helper ===

export function cleanupRelationReferences(relationId: string): void {
  const db = getDb()
  const rows = db.prepare(
    "SELECT id, related_relation_ids FROM tasks WHERE related_relation_ids LIKE ?"
  ).all(`%${relationId}%`) as { id: string; related_relation_ids: string }[]

  for (const row of rows) {
    const ids: string[] = JSON.parse(row.related_relation_ids)
    const filtered = ids.filter(id => id !== relationId)
    db.prepare('UPDATE tasks SET related_relation_ids = ? WHERE id = ?')
      .run(JSON.stringify(filtered), row.id)
  }
}
