import { getL0Content, searchMemory } from '../memory'
import { createTask, updateTask, listTasks, getTask } from '../tasks'
import { getProject, listProjects } from '../projects'
import { listRelations, getRelation } from '../relations'
import { getAutonomyLevel } from '../preferences'
import { getConnectionStatus } from '../connections'
import { getSkillsDirectory } from '../skills'
import { saveChatAttachment } from '../files'
import { showSystemNotification } from '../index'
import type { ChatMessage, Task, PendingAction, TurnStep } from '@shared/types'
import { v4 as uuid } from 'uuid'
import { getDb } from '../db'
import { BrowserWindow } from 'electron'
import type { CopilotClient, CopilotSession } from '@github/copilot-sdk'
import type { SessionConfig, PermissionRequest, PermissionRequestResult } from '@github/copilot-sdk'
import { buildTools } from './tools'
import { sdkError } from '../health'

// Build the user-facing error when the SDK never came up. Prefer the real
// startup failure (captured in health) over a generic message so packaging or
// auth issues are diagnosable instead of opaque.
function sdkUnavailableError(): Error {
  return new Error(
    sdkError
      ? `Copilot SDK failed to start: ${sdkError}`
      : 'Copilot SDK not initialized. Ensure SDK is configured.'
  )
}

// ============================================================
// Agent Engine — Adapter between Aide and Copilot SDK
// ============================================================
// The SDK is responsible for:
//   - Reasoning loop (receive → understand → plan → execute → respond)
//   - Tool orchestration (auto-select, invoke, process results, reason again)
//   - Session persistence & resume
//   - Multi-turn conversation & automatic context-window compaction (infinite sessions)
//   - Streaming output
//
// We are responsible for:
//   - Implementing Custom Tools (memory, tasks, reports)
//   - Lifecycle Hooks (inject Memory, extract facts)
//   - Permission handler (autonomy-level control)
//   - Dynamic System Prompt assembly
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

// === Reset Session (clear a corrupted conversation history) ===

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
  // Inject L0 Identity + dynamic context
  onSessionStart: async (_input: any, invocation: { sessionId: string }) => {
    setCurrentSessionId(invocation.sessionId)
    const l0 = getL0Content()
    const taskId = extractTaskIdFromSession(invocation.sessionId)
    const parts: string[] = []

    if (l0) parts.push(`## Identity\n${l0}`)

    if (taskId) {
      const task = getTask(taskId)
      if (task) {
        parts.push(formatTaskContext(task))
        // Load linked projects
        if (task.projectIds.length > 0) {
          const projects = task.projectIds.map(id => getProject(id)).filter(Boolean) as any[]
          if (projects.length > 0) {
            parts.push(projects.map(p => formatProjectContext(p)).join('\n\n'))
          }
        }
        if (task.relatedRelationIds.length > 0) {
          const rels = task.relatedRelationIds.map(id => getRelation(id)).filter(Boolean)
          if (rels.length) parts.push(formatRelationsContext(rels as any[]))
        }
      }
    } else if (invocation.sessionId === 'general') {
      // General chat: inject workspace awareness (task summary + connection status + projects)
      const conns = getConnectionStatus()
      const connSummary = conns.map(c =>
        `- ${c.type}: ${c.authenticated ? `✓ connected${c.activeAccount ? ` (${c.activeAccount})` : ''}` : '✗ not connected'}${c.lastError ? ` [error: ${c.lastError}]` : ''}`
      ).join('\n')
      parts.push(`## Connection status\n${connSummary}`)

      // Brief task overview with titles so agent can match user messages to tasks
      const allTasks = listTasks({})
      const activeTasks = allTasks.filter(t => t.status === 'pending' || t.status === 'in_progress')
      if (activeTasks.length > 0) {
        const taskLines = activeTasks.slice(0, 10).map(t =>
          `- id: "${t.id}" | "${t.title}" | ${t.status}${t.priority === 'p0' ? ' | URGENT' : ''}`
        ).join('\n')
        parts.push(`## Active tasks\n${taskLines}`)
      }

      // Inject project list for task-project linking
      const projects = listProjects()
      if (projects.length > 0) {
        const projectList = projects.map(p => `- id: "${p.id}" | name: "${p.name}"${p.repoPath ? ` | repo: "${p.repoPath}"` : ''}`).join('\n')
        parts.push(`## Available projects\n${projectList}`)
      }
    }

    // Token budget: ~3K total. Fixed prompt ~1K, L0 ~0.5K, dynamic ~1K
    // Truncation priority: Task > Relation > Project > L1
    return { additionalContext: parts.join('\n\n') }
  },

  // Inject L1 Knowledge — FTS5 retrieval based on the user message
  onUserPromptSubmitted: async (input: any, invocation: { sessionId: string }) => {
    // Keep session ID current (onSessionStart only fires once, but user switches between sessions)
    setCurrentSessionId(invocation.sessionId)

    const contextParts: string[] = []

    // If in a task session, inject the CURRENT working_state every turn
    // (it may have been updated externally from general chat since onSessionStart)
    const taskId = extractTaskIdFromSession(invocation.sessionId)
    if (taskId) {
      const task = getTask(taskId)
      if (task?.workingState) {
        contextParts.push(`<working-state>\n${task.workingState}\n</working-state>`)
      }
    }

    const memories = await searchMemory(input.prompt, 5)
    if (memories.length > 0) {
      const block = memories.map(m => `- [id: ${m.id}] ${m.content}`).join('\n')
      contextParts.push(`<memory-context>\nRelevant memories (use the id with memory_write update/remove if one is wrong):\n${block}\n</memory-context>`)
    }

    if (contextParts.length === 0) return {}
    return { modifiedPrompt: `${contextParts.join('\n\n')}\n\n${input.prompt}` }
  },

  // On session end — compact working_state if too long
  onSessionEnd: async (_input: any, invocation: { sessionId: string }) => {
    const taskId = extractTaskIdFromSession(invocation.sessionId)
    if (taskId) {
      const task = getTask(taskId)
      if (task?.workingState && task.workingState.length > 1500) {
        // Truncate to keep the most recent content (last 800 chars with a marker)
        const truncated = '...(earlier context compressed)\n' + task.workingState.slice(-800)
        updateTask(taskId, { workingState: truncated })
      }
    }
    return {}
  },

  // Before tool call — permission interception + push record to UI
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

    // Push a "running" record to the UI
    toolCallTimestamps.set(toolCallId, Date.now())
    // Mark a tool as in-flight so the idle watchdog treats this as activity and
    // won't declare the turn "stalled" while the tool (possibly slow) runs.
    activeTurnSignal?.toolStart()
    emitEvent({
      type: 'chat:tool-use',
      taskId,
      record: { id: toolCallId, toolName, status: 'running', timestamp: new Date().toISOString(), inputPreview }
    })

    // Protected tools → show a confirmation card and wait for user approval
    if (CONFIRM_REQUIRED_TOOLS.has(toolName)) {
      const approved = await requestToolConfirmation(toolName, input.toolArgs)
      if (!approved) {
        emitEvent({
          type: 'chat:tool-use',
          taskId,
          record: { id: toolCallId, toolName, status: 'error', timestamp: new Date().toISOString(), inputPreview, resultPreview: 'Cancelled by user' }
        })
        toolCallTimestamps.delete(toolCallId)
        activeTurnSignal?.toolEnd()
        return { permissionDecision: 'deny' as const, permissionDecisionReason: 'User cancelled the operation' }
      }
    }
    // All other tools → allow
    return undefined
  },

  // After tool call — push completion record to UI
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

    // Tool finished → clear in-flight state and re-arm the idle watchdog from now.
    activeTurnSignal?.toolEnd()

    // Background job sessions must never surface in any chat window.
    if (invocation.sessionId.startsWith('job-')) return

    // Record into the active turn's process trail (chronological with narration).
    if (activeTurnSteps) {
      activeTurnSteps.push({
        kind: 'tool',
        toolName,
        status: 'done',
        durationMs,
        inputPreview,
        resultPreview
      })
    }

    emitEvent({
      type: 'chat:tool-use',
      taskId,
      record: { id: toolCallId, toolName, status: 'done', timestamp: new Date().toISOString(), durationMs, inputPreview, resultPreview }
    })
  },

  // On error — log and emit event for UI awareness
  onErrorOccurred: async (input: any, invocation: { sessionId: string }) => {
    const taskId = extractTaskIdFromSession(invocation.sessionId)
    console.error(`[Agent] error in session ${invocation.sessionId}:`, input.error)

    // Emit an error event so the UI can display the failure
    emitEvent({
      type: 'chat:error',
      taskId,
      error: input.error || 'An error occurred during the agent session'
    })
  }
}

// Tool call timing tracker
const toolCallTimestamps = new Map<string, number>()
// Active interactive turn's step sink (set by runTurn). Tool hooks push their
// completed steps here so the turn's process trail stays in chronological order
// alongside the assistant's narration. Null when no interactive turn is running
// (e.g. background jobs), so those never collect a trail.
let activeTurnSteps: TurnStep[] | null = null
// Heartbeat + in-flight tool tracking for the active interactive turn's idle
// watchdog (set by runTurn). Tool hooks call these so a long-running tool call
// counts as *activity*: the turn is declared "stalled" only during genuine
// silence with no tool in flight — never while the agent is busy inside a tool
// (e.g. running a long test suite), which previously tripped a false abort.
let activeTurnSignal: { toolStart: () => void; toolEnd: () => void } | null = null
// Track sessions where task has been auto-promoted to in_progress
const activatedTaskSessions = new Set<string>()

// === Permission Handler (category-level authorization) ===

// onPermissionRequest handles SDK category-level permissions (shell, mcp, write, read, etc.)
// Fine-grained per-tool control lives in onPreToolUse (see hooks above)

const pendingActions = new Map<string, { resolve: (v: boolean) => void; action: PendingAction; timer: ReturnType<typeof setTimeout> }>()

async function handlePermissionRequest(request: PermissionRequest, _invocation: { sessionId: string }): Promise<PermissionRequestResult> {
  const level = getAutonomyLevel()

  // confirm mode — prompt for confirmation on every category
  if (level === 'confirm') {
    const approved = await requestCategoryConfirmation(request)
    return approved ? { kind: 'approve-once' } : { kind: 'reject' }
  }

  // default / auto — auto-approve all categories (specific tools are intercepted by onPreToolUse)
  return { kind: 'approve-once' }
}

function requestCategoryConfirmation(request: PermissionRequest): Promise<boolean> {
  return new Promise((resolve) => {
    const actionId = uuid()
    const action: PendingAction = {
      id: actionId,
      type: request.kind,
      description: `Allow ${request.kind} operation`,
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

// === Tool-level authorization (invoked by onPreToolUse) ===

// Tools that require mandatory confirmation (external write operations)
// Note: WorkIQ send-type tools are already filtered at the MCP layer and not registered with the LLM
const CONFIRM_REQUIRED_TOOLS = new Set([
  // GitHub — comment/review
  'create_issue_comment',
  'create_pull_request_review',
])

const TOOL_LABELS: Record<string, string> = {
  create_issue_comment: 'Comment on a GitHub issue',
  create_pull_request_review: 'Submit a PR review',
}

function requestToolConfirmation(toolName: string, toolArgs: unknown): Promise<boolean> {
  return new Promise((resolve) => {
    const actionId = uuid()
    const action: PendingAction = {
      id: actionId,
      type: 'tool_call',
      toolName,
      description: TOOL_LABELS[toolName] || `Run ${toolName}`,
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
  const locale = 'en-US'

  // Gather connected identities
  const conns = getConnectionStatus()
  const ghConn = conns.find(c => c.type === 'github')
  const identityLines: string[] = []
  if (ghConn?.activeAccount) identityLines.push(`- GitHub: ${ghConn.activeAccount}`)

  return `You are Aide, the user's personal work agent. You help the user manage work, track tasks, and process their information streams.

Current time: ${now.toLocaleDateString(locale)} ${now.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}${identityLines.length ? `\nActing as:\n${identityLines.join('\n')}` : ''}

## Behavior
- Answer concisely and directly
- Read operations: just do them. Write operations (send email, comment on PR): call the tool directly — the system shows a confirmation card automatically
- Call memory_write when you learn a new fact worth remembering

## Task management

Use Aide's task tools (create_aide_task, update_aide_task, query_aide_tasks) for task management when needed by background jobs.

**Bar (high)**: only create a Task for things that clearly need the user to act personally.
- Create: the user is named/asked to do something, sent to them individually for action, they are the clear owner
- Don't create: pure notifications, the user is only CC'd or in a broadcast, already-done items, automated subscriptions

**Priority**:
- P0: an important person names the user + sent individually + urgent. All three together.
- P1: needs the user, has importance or a deadline, but not urgent.
- P2: involved but not the sole owner, or low priority.
- When unsure, choose P2.

**De-dup**: before creating, confirm no identical task already exists (the system injects the existing task list). Pass sourceId for exact de-dup.

## Contacts & projects

Be restrained. Quality over quantity.
- Contacts: only record people the user has direct, substantive dealings with. Don't record people in a group who never interacted with the user. Test: will this person still matter next week?
- Projects: must map to a real repo (has a GitHub URL or local path). Don't create abstract concepts.
- Don't record on first sight; create only after it proves important or recurring.

## Memory
- Record: user corrections (highest priority), stable preferences, conventions, recurring people (one card per person)
- Format: one-liner declarative facts. People: "Name: role. Key traits."
- Before adding: search first → update if same subject exists → add only if new
- Do NOT record in memory: task progress, event logistics (dates/times/venues/budgets/attendees), scheduling info, session logs, one-off mentions. These belong in the task's working_state.
- If information is tied to a specific task or event that will expire → put it in working_state, NOT memory
- Use update_aide_task with working_state for task-specific progress, event details, and outputs

## Context awareness
- In general chat, if something relates to an existing Task → immediately call update_aide_task to record the progress/info in that task's working_state. Don't just suggest switching — update the task right there.
- When entering a Task chat → briefly state the task's background, status, and suggested handling`
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

// === Core API: send message ===

async function getOrCreateSession(taskId: string | null): Promise<CopilotSession> {
  if (!client) throw sdkUnavailableError()

  const sessionId = taskId ? getTaskSessionId(taskId) : 'general'
  const config: SessionConfig = {
    sessionId,
    model: getSelectedModel(),
    streaming: true,
    tools: buildTools(),
    hooks,
    infiniteSessions: { enabled: true },
    systemMessage: { mode: 'append', content: buildSystemMessage() },
    onPermissionRequest: handlePermissionRequest,
    skillDirectories: [getSkillsDirectory()]
  }

  try {
    return await client.resumeSession(sessionId, config)
  } catch {
    return await client.createSession(config)
  }
}

// === Turn runner ===
//
// A "turn" is one user prompt → assistant response cycle. Rather than blocking
// on a fixed total-duration timeout (which kills long-but-healthy work, loses
// streamed output, and leaves the agent running as a zombie), we drive the turn
// off the SDK event stream:
//
//   - Every event is a heartbeat that resets an *idle* watchdog.
//   - The turn finishes on `session.idle` (done), `session.error`, or `abort`.
//   - The watchdog fires only after IDLE_TIMEOUT_MS of *complete silence*,
//     which means the upstream is genuinely dead/hung — then we abort the
//     session (killing any zombie work) and finalize with whatever we have.
//
// This is how long-running agents (Codex, Claude Code) stay alive for hours:
// the limit is on inactivity, not on total elapsed time.
const IDLE_TIMEOUT_MS = 180_000

type TurnOutcome = {
  content: string
  process?: TurnStep[]
  kind: 'complete' | 'stalled' | 'error' | 'aborted'
  error?: string
}

function runTurn(
  session: CopilotSession,
  prompt: string,
  onStream: (delta: string) => void
): Promise<TurnOutcome> {
  return new Promise((resolve) => {
    let streamed = ''        // everything streamed live (partial fallback)
    let finalMessage = ''    // canonical reply = last completed assistant.message
    let settled = false
    let watchdog: ReturnType<typeof setTimeout> | null = null

    // Ordered process trail (narration + tool calls). Tool hooks push into this
    // same array via `activeTurnSteps`, so steps stay in chronological order.
    const steps: TurnStep[] = []
    activeTurnSteps = steps

    // In-flight tool counter. While a tool runs the agent is busy (not idle), so
    // the watchdog must not declare a stall — waiting on a tool is activity.
    let inFlightTools = 0
    activeTurnSignal = {
      toolStart: () => { inFlightTools++; armWatchdog() },
      toolEnd: () => { inFlightTools = Math.max(0, inFlightTools - 1); armWatchdog() }
    }

    const finish = (kind: TurnOutcome['kind'], error?: string) => {
      if (settled) return
      settled = true
      if (watchdog) clearTimeout(watchdog)
      if (activeTurnSteps === steps) activeTurnSteps = null
      if (activeTurnSignal) activeTurnSignal = null
      unsubscribe()
      const content = finalMessage || streamed
      // The final answer is the last narration segment; everything before it is
      // the foldable "work" trail. Drop that segment from the trail so it isn't
      // shown twice.
      const lastTextIdx = (() => {
        for (let i = steps.length - 1; i >= 0; i--) if (steps[i].kind === 'text') return i
        return -1
      })()
      const trail = lastTextIdx >= 0 ? steps.filter((_, i) => i !== lastTextIdx) : steps.slice()
      resolve({ content, process: trail.length ? trail : undefined, kind, error })
    }

    const armWatchdog = () => {
      if (watchdog) clearTimeout(watchdog)
      watchdog = setTimeout(() => {
        // A tool is still running — that's legitimate work, not a hang. Re-arm
        // and keep waiting instead of killing a busy turn (e.g. a long test run).
        if (inFlightTools > 0) { armWatchdog(); return }
        // No activity for IDLE_TIMEOUT_MS and nothing in flight — the turn is
        // genuinely stalled. Abort to stop any zombie run, then finalize.
        session.abort().catch(() => {})
        finish('stalled')
      }, IDLE_TIMEOUT_MS)
    }

    const unsubscribe = session.on((event: any) => {
      // Any event proves the turn is still alive — reset the death timer.
      armWatchdog()
      switch (event.type) {
        case 'assistant.message_delta': {
          const delta: string = event.data?.deltaContent || ''
          if (delta) { onStream(delta); streamed += delta }
          break
        }
        case 'assistant.message': {
          const content: string = event.data?.content || ''
          if (content) {
            finalMessage = content
            steps.push({ kind: 'text', content })
          }
          break
        }
        case 'session.idle':
          finish('complete')
          break
        case 'session.error':
          finish('error', event.data?.message || 'The assistant hit an error.')
          break
        case 'abort':
          finish('aborted')
          break
      }
    })

    armWatchdog()
    session.send({ prompt }).catch((err: any) => finish('error', err?.message || String(err)))
  })
}

export async function sendMessage(
  userMessage: string,
  taskId: string | null,
  onStream: (delta: string) => void,
  attachments?: { name: string; type: string; dataUrl: string }[]
): Promise<ChatMessage> {
  // Save the user message to the local DB (for UI display)
  const userMsg: ChatMessage = {
    id: uuid(),
    role: 'user',
    content: userMessage,
    timestamp: new Date().toISOString(),
    taskId,
    attachments: attachments && attachments.length > 0 ? attachments : undefined
  }
  saveMessage(userMsg)

  const session = await getOrCreateSession(taskId)
  activeSession = session

  // Build the prompt. Attachments are written into the session sandbox and
  // referenced by path, so the agent reads them with its native file tools
  // (inlining base64 wastes tokens and the model can't parse it anyway).
  let prompt = userMessage
  if (attachments && attachments.length > 0) {
    const lines = attachments.map(a => {
      const saved = saveChatAttachment(taskId, a.name, a.dataUrl)
      const type = a.type || 'unknown type'
      return saved
        ? `- "${a.name}" (${type}): ${saved.absPath}`
        : `- "${a.name}" (${type}): [attachment could not be saved]`
    }).join('\n')
    prompt = `${userMessage}\n\nThe user attached the following file(s), saved to disk. Read them as needed to answer:\n${lines}`
  }

  // Run the turn via the event stream (not a blocking total-duration timeout).
  // The turn ends when the session goes idle, errors, or is aborted — and an
  // idle watchdog only fires after a long stretch of *complete silence*, so a
  // task that keeps making progress is never cut off, however long it runs.
  let outcome: TurnOutcome
  try {
    outcome = await runTurn(session, prompt, onStream)
  } finally {
    activeSession = null
  }

  // Always persist *something* so a turn is never silently lost. Partial output
  // from a stalled/errored/aborted turn is kept (annotated), and a turn that
  // produced nothing gets a clear explanation instead of vanishing.
  let content = outcome.content
  if (content) {
    if (outcome.kind === 'stalled') {
      content += '\n\n⚠️ _Response interrupted — the assistant went silent. The text above may be incomplete._'
    } else if (outcome.kind === 'error') {
      content += `\n\n⚠️ _${outcome.error || 'The assistant hit an error.'}_`
    }
  } else {
    if (outcome.kind === 'stalled') {
      content = '⚠️ The assistant stopped responding (no activity for a while). It may still be working in the background — try again shortly.'
    } else if (outcome.kind === 'error') {
      content = `⚠️ ${outcome.error || 'The assistant hit an error.'}`
    }
    // A clean turn with no text, or a user abort with nothing generated yet,
    // leaves nothing worth persisting.
  }

  const agentMsg: ChatMessage = {
    id: uuid(),
    role: 'agent',
    content,
    timestamp: new Date().toISOString(),
    taskId,
    process: outcome.process
  }
  if (content) saveMessage(agentMsg)
  return agentMsg
}

// === Job execution (headless agent session) ===

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
      return { permissionDecision: 'deny' as const, permissionDecisionReason: 'Job mode does not allow send/write operations' }
    }
    return undefined
  },
  onSessionStart: async () => {
    const parts: string[] = []

    // Identity
    const l0 = getL0Content()
    if (l0) parts.push(`## Identity\n${l0}`)

    // Existing tasks (prevents duplicates — Agent sees what already exists)
    const existingTasks = listTasks({ status: ['pending', 'in_progress'] })
    if (existingTasks.length > 0) {
      const taskLines = existingTasks.slice(0, 30).map(t =>
        `- [${t.priority}] ${t.title}${t.source.externalId ? ` (src:${t.source.externalId})` : ''}`
      ).join('\n')
      parts.push(`## Existing tasks\n${taskLines}`)
    }

    parts.push(`[JOB MODE] Run automatically. You may create tasks and memories. External write operations (send email, comment, etc.) are not allowed.`)

    return { additionalContext: parts.join('\n\n') }
  }
}

import { setJobSession, setCurrentSessionId } from './state'

export async function executeJobSession(instruction: string, jobId: string, lastRunAt?: string | null): Promise<string> {
  if (!client) throw sdkUnavailableError()

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
  setCurrentSessionId(sessionId)
  try {
    const session = await client.createSession({
      sessionId,
      model: getSelectedModel(),
      tools: buildTools(),
      hooks: jobHooks,
      infiniteSessions: { enabled: false },
      systemMessage: { mode: 'append', content: buildSystemMessage() },
      onPermissionRequest: jobPermissionHandler,
      skillDirectories: [getSkillsDirectory()]
    })

    // Inject time context into the prompt so Agent knows the time window
    // Inject time context as metadata, not instructions
    let prompt = instruction
    if (lastRunAt) {
      prompt = `[Last run: ${lastRunAt}]\n\n${instruction}`
    } else {
      prompt = `[First run, current time: ${new Date().toISOString()}]\n\n${instruction}`
    }
    const result = await session.sendAndWait({ prompt }, timeoutMs)
    await session.disconnect()
    return result?.data.content || ''
  } finally {
    setJobSession(false)
  }
}

// === Morning Briefing (proactive message) ===

export async function generateMorningBriefing(): Promise<string> {
  // Fetch instruction from DB so there's a single source of truth
  const db = getDb()
  const row = db.prepare("SELECT instruction FROM jobs WHERE id = 'morning-briefing'").get() as { instruction: string } | undefined
  const instruction = row?.instruction || 'Check today\'s calendar events, new email, Teams messages, and GitHub notifications. Create tasks for anything I need to handle, and give prioritized suggestions for today.'
  return executeJobSession(instruction, 'morning-briefing')
}

// === Chat History (local DB, for UI display) ===

function saveMessage(msg: ChatMessage): void {
  const db = getDb()
  db.prepare(`
    INSERT INTO chat_messages (id, role, content, timestamp, task_id, pending_action, process, attachments)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    msg.id,
    msg.role,
    msg.content,
    msg.timestamp,
    msg.taskId,
    msg.pendingAction ? JSON.stringify(msg.pendingAction) : null,
    msg.process && msg.process.length ? JSON.stringify(msg.process) : null,
    msg.attachments && msg.attachments.length ? JSON.stringify(msg.attachments) : null
  )
}

/**
 * Persist an agent message into the General chat (taskId = null) and notify the
 * renderer. Used by job result delivery so background summaries land durably in
 * the desktop chat instead of being injected only when the user happens to be
 * viewing General chat.
 */
export function postAgentMessageToGeneral(content: string): void {
  const msg: ChatMessage = {
    id: uuid(),
    role: 'agent',
    content,
    timestamp: new Date().toISOString(),
    taskId: null
  }
  saveMessage(msg)
  emitEvent({ type: 'chat:message', message: msg })
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
    pendingAction: row.pending_action ? JSON.parse(row.pending_action as string) : undefined,
    process: row.process ? JSON.parse(row.process as string) : undefined,
    attachments: row.attachments ? JSON.parse(row.attachments as string) : undefined
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
  const sourceLabel = { email: 'Email', github: 'GitHub', teams: 'Teams', calendar: 'Calendar', chat: 'Chat' }[task.source.type] || task.source.type
  const priorityLabel = { p0: 'P0 (urgent)', p1: 'P1 (normal)', p2: 'P2 (can wait)' }[task.priority] || task.priority
  const statusLabel = { pending: 'Pending', in_progress: 'In progress', completed: 'Completed', cancelled: 'Cancelled' }[task.status] || task.status

  const lines: string[] = []
  lines.push(`**${task.title}**`)
  lines.push('')
  lines.push(`Source: ${sourceLabel}${task.source.externalUrl ? ` · [link](${task.source.externalUrl})` : ''}`)
  lines.push(`Priority: ${priorityLabel} · Status: ${statusLabel}`)
  if (task.dueDate) {
    const due = new Date(task.dueDate)
    const now = new Date()
    const diffDays = Math.ceil((due.getTime() - now.getTime()) / 86400000)
    const dueStr = due.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' })
    if (diffDays < 0) lines.push(`Due: ${dueStr} (${-diffDays} day(s) overdue)`)
    else if (diffDays === 0) lines.push(`Due: today`)
    else lines.push(`Due: ${dueStr} (in ${diffDays} day(s))`)
  }
  if (task.description) {
    lines.push('')
    lines.push(task.description)
  }
  lines.push('')
  lines.push('---')
  lines.push('Want me to help with this task? Just tell me what to do.')

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
  const lines = [`## Current task`, `- ID: ${task.id}`, `- Title: ${task.title}`, `- Status: ${task.status}`, `- Priority: ${task.priority}`]
  if (task.description) lines.push(`- Description: ${task.description}`)
  if (task.dueDate) lines.push(`- Due: ${task.dueDate}`)
  if (task.source.externalUrl) lines.push(`- Source: ${task.source.externalUrl}`)
  if (task.workingState) lines.push(`\n## Working state\n${task.workingState}`)
  if (!task.projectIds.length) lines.push(`\n> This task has no linked project. If you can determine which project(s) it belongs to, call update_aide_task to set projectIds.`)
  lines.push(`\n> The user is in this task's chat. You can operate on it directly with update_aide_task(id: "${task.id}", ...).`)
  return lines.join('\n')
}

function formatProjectContext(p: { name: string; description: string; repoPath: string | null; docsPath: string | null; techStack: string | null }): string {
  const lines = [`## Project: ${p.name}`]
  if (p.description) lines.push(p.description)
  if (p.repoPath) lines.push(`Repo: ${p.repoPath}`)
  if (p.docsPath) lines.push(`Docs: ${p.docsPath}`)
  if (p.techStack) lines.push(`Tech stack: ${p.techStack}`)
  return lines.join('\n')
}

function formatRelationsContext(rels: Array<{ name: string; role: string; expertise: string[]; communicationStyle: string | null }>): string {
  return '## Related people\n' + rels.map(r =>
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
