import { getL0Content, searchMemory, writeMemory } from '../memory'
import { createTask, updateTask, listTasks, getTask } from '../tasks'
import { getProject } from '../projects'
import { listRelations, getRelation } from '../relations'
import { getAutonomyLevel, getPreferences } from '../preferences'
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
    }

    // Token budget: ~4K total. 固定 prompt ~1K, L0 ~2K, 动态 ~1K
    // 截断优先级: Task > Relation > Project > L1
    return { additionalContext: parts.join('\n\n') }
  },

  // 注入 L1 Knowledge — 基于用户消息做 FTS5 检索
  onUserPromptSubmitted: async (input: any) => {
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

  // 工具调用前 — 确认是否真的触发了
  onPreToolUse: async (input: any, invocation: { sessionId: string }) => {
    console.log(`[Agent] tool_pre: ${input.toolName} | session: ${invocation.sessionId} | args: ${JSON.stringify(input.toolArgs || input.arguments || {}).slice(0, 200)}`)
  },

  // 工具调用后 — 观察结果
  onPostToolUse: async (input: any, invocation: { sessionId: string }) => {
    console.log(`[Agent] tool_post: ${input.toolName} | session: ${invocation.sessionId} | result_size: ${JSON.stringify(input.toolResult || '').length}`)
  }
}

// === Permission Handler (自主级别) ===

// 读操作=自动, 记忆=通知, 写操作=确认
const AUTO_TOOLS = new Set([
  'memory_search', 'query_tasks', 'generate_report',
  'ask_work_iq', 'fetch_work_iq', 'fetch_blob_work_iq', 'get_schema_work_iq', 'search_paths_work_iq'
])
const NOTIFY_TOOLS = new Set(['memory_write', 'create_task'])
// All others → confirm

const pendingActions = new Map<string, { resolve: (v: PermissionRequestResult) => void; action: PendingAction }>()

async function handlePermissionRequest(request: PermissionRequest, _invocation: { sessionId: string }): Promise<PermissionRequestResult> {
  const level = getAutonomyLevel()

  // Full auto mode — approve everything
  if (level === 'auto') {
    return { kind: 'approve-once' }
  }

  // Full confirm mode — everything asks
  if (level === 'confirm') {
    return requestUserConfirmation(request)
  }

  // Default mode — read/memory/custom-tool auto, write confirm
  if (request.kind === 'memory' || request.kind === 'read' || request.kind === 'custom-tool') {
    return { kind: 'approve-once' }
  }

  // Shell/command — auto-approve if intention is clearly read-only
  const details = request as any
  if (details.readOnly === true || details.commands?.every?.((c: any) => c.readOnly === true)) {
    return { kind: 'approve-once' }
  }
  // Check intention text for read-like operations
  const intention = (details.intention || details.description || '').toLowerCase()
  if (/\b(fetch|read|get|list|check|query|search|look up|查看|获取|检查|搜索)\b/.test(intention)) {
    return { kind: 'approve-once' }
  }

  return requestUserConfirmation(request)
}

function requestUserConfirmation(request: PermissionRequest): Promise<PermissionRequestResult> {
  return new Promise((resolve) => {
    const actionId = uuid()
    const action: PendingAction = {
      id: actionId,
      type: request.kind,
      description: `执行 ${request.kind}`,
      details: request as unknown as Record<string, unknown>,
      status: 'pending'
    }
    pendingActions.set(actionId, { resolve, action })
    emitEvent({ type: 'chat:pending-action', action })

    // Auto-reject after 5 minutes if user doesn't respond
    setTimeout(() => {
      if (pendingActions.has(actionId)) {
        pendingActions.delete(actionId)
        resolve({ kind: 'reject' })
      }
    }, 5 * 60 * 1000)
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

  return `你是 Aide，用户的个人工作 Agent。你帮助用户管理工作事务、跟踪任务、处理信息流。

当前时间: ${now.toLocaleDateString(locale)} ${now.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}

## 行为准则
- 主动识别用户需要处理的事项，创建 Task 跟踪
- 回答简洁直接，不啰嗦
- 读操作直接做，不问
- 写操作先告知用户方案，等确认后执行
- 获知新信息时主动调用 memory_write 记录
${langInstruction}

## 工具使用原则
- 需要回忆历史信息时，先调 memory_search
- 发现用户有新的待办事项时，调 create_task
- 任务完成时，调 update_task 更新状态
- 发邮件/消息等写操作，先描述方案等用户确认
- 查看邮件、Teams 消息、日历时，使用 workiq 系列工具（ask_work_iq, fetch_work_iq 等）
- 查看 GitHub Issue/PR/通知时，使用 GitHub 系列工具

## 记忆管理原则
- 该记：用户纠正、明确偏好、稳定事实、工具环境、人际关系
- 不该记：任务进度、session 内临时状态、会快速过期的信息
- 格式：陈述性事实（"用户偏好简洁回复" ✓，"总是简洁回复" ✗）
- **错误修正**：当用户纠正你时，不仅要写入正确事实，还要检查是否有已存在的错误记忆导致了这次错误。如果有，用 memory_write(action: update/remove) 修正它。不能只加新的不管旧的。

## 对话中的上下文感知
- 如果 General 对话中用户提到的事情与某个已有 Task 明显相关，主动提示："这个和任务「XX」相关，要切换到那个任务继续吗？"
- 用户第一次进入某个 Task 的对话时，主动简要说明该任务是什么、来自哪里、当前状态、建议如何处理。`
}

// === Model Selection (persisted to DB) ===

let selectedModel: string | null = null

export async function listModels(): Promise<{ id: string; name: string }[]> {
  if (!client) return [{ id: 'gpt-4.1', name: 'GPT-4.1' }]
  try {
    const models = await client.listModels()
    return models.map(m => ({ id: m.id, name: m.name }))
  } catch {
    return [{ id: 'gpt-4.1', name: 'GPT-4.1' }]
  }
}

export function getSelectedModel(): string {
  if (!selectedModel) {
    const db = getDb()
    const row = db.prepare("SELECT content FROM memory_entries WHERE id = '__selected_model'").get() as { content: string } | undefined
    selectedModel = row?.content || 'gpt-4.1'
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

// Job safety: only auto-approve reads, memory writes, and task operations. Reject external writes.
function jobPermissionHandler(request: PermissionRequest): PermissionRequestResult {
  const safeKinds = new Set(['read', 'memory', 'custom-tool'])
  if (safeKinds.has(request.kind)) {
    return { kind: 'approve-once' }
  }
  // Reject external write operations (email send, PR actions, etc.) in headless mode
  return { kind: 'reject' }
}

export async function executeJobSession(instruction: string, jobId: string): Promise<string> {
  if (!client) throw new Error('Copilot SDK not initialized')

  const sessionId = `job-${jobId}-${Date.now()}`
  const session = await client.createSession({
    sessionId,
    model: getSelectedModel(),
    tools: buildTools(),
    hooks: {
      ...hooks,
      onSessionStart: async () => ({
        additionalContext: `${getL0Content() ? `## 身份记忆\n${getL0Content()}\n\n` : ''}[JOB MODE] 自动执行定时任务。可以创建任务和记录记忆。不允许执行外部写操作（发邮件、评论 PR 等），这些需要用户在 Chat 中确认。`
      })
    },
    infiniteSessions: { enabled: false },
    systemMessage: { mode: 'append', content: buildSystemMessage() },
    onPermissionRequest: jobPermissionHandler
  })

  const result = await session.sendAndWait({ prompt: instruction }, 180_000)
  await session.disconnect()
  return result?.data.content || ''
}

// === Morning Briefing (主动消息) ===

export async function generateMorningBriefing(): Promise<string> {
  return executeJobSession(
    '生成今日工作 briefing。检查新邮件、Teams 消息、GitHub 通知和今天的日历。列出需要用户处理的事项，并按优先级排序给出建议。',
    'morning-briefing'
  )
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

  if (decision === 'modify' && modification) {
    pending.action.status = 'cancelled'
    pending.resolve({ kind: 'reject' })
    pendingActions.delete(actionId)
    return
  }

  pending.action.status = decision === 'confirm' ? 'confirmed' : 'cancelled'
  pending.resolve(decision === 'confirm' ? { kind: 'approve-once' } : { kind: 'reject' })
  pendingActions.delete(actionId)
}

// === First Message: Agent proactively explains task when user enters ===

export async function triggerFirstMessage(taskId: string): Promise<ChatMessage | null> {
  const task = getTask(taskId)
  if (!task) return null

  // Check if there's already chat history for this task — if so, don't re-explain
  const history = getChatHistory(taskId)
  if (history.length > 0) return null

  // Synthesize a first-message prompt
  const prompt = `用户刚进入了任务「${task.title}」的对话。这是用户第一次查看这个任务。
请主动说明：这个任务是什么、来自哪里（${task.source.type}${task.source.externalUrl ? ', ' + task.source.externalUrl : ''}）、当前状态（${task.status}）、优先级（${task.priority}）${task.dueDate ? '、截止时间 ' + task.dueDate : ''}，以及你建议如何处理。
简洁明了，2-4 句话。`

  const session = await getOrCreateSession(taskId)
  let fullResponse = ''

  const unsubscribe = session.on('assistant.message_delta', (event) => {
    const delta = event.data.deltaContent || ''
    emitEvent({ type: 'chat:stream', taskId, delta })
    fullResponse += delta
  })

  try {
    const result = await session.sendAndWait({ prompt }, 180_000)
    if (result) {
      fullResponse = result.data.content || fullResponse
    }
  } finally {
    unsubscribe()
  }

  emitEvent({ type: 'chat:stream-end', taskId })

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

// === Helpers ===

function formatTaskContext(task: Task): string {
  const lines = [`## 当前任务`, `- 标题: ${task.title}`, `- 状态: ${task.status}`, `- 优先级: ${task.priority}`]
  if (task.description) lines.push(`- 描述: ${task.description}`)
  if (task.dueDate) lines.push(`- 截止: ${task.dueDate}`)
  if (task.source.externalUrl) lines.push(`- 来源: ${task.source.externalUrl}`)
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
