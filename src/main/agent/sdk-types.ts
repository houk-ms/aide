// ============================================================
// Copilot SDK Type Definitions
// ============================================================
// 基于 investigation/copilot-sdk/ 调研定义的接口
// 当 @github/copilot-sdk 正式发布后，替换为真实类型
// ============================================================

export interface CopilotClient {
  createSession(config: SessionConfig): Promise<Session>
  resumeSession(sessionId: string, config: Partial<SessionConfig>): Promise<Session>
  listSessions(filter?: { repository?: string }): Promise<SessionInfo[]>
  deleteSession(sessionId: string): Promise<void>
}

export interface Session {
  sessionId: string
  sendAndWait(options: { prompt: string }): Promise<SendResult>
  send(options: { prompt: string }): void
  on(handler: (event: SessionEvent) => void): () => void  // returns unsubscribe
  disconnect(): Promise<void>
  abort(): void
  getEvents(): Promise<SessionEvent[]>
}

export interface SessionConfig {
  sessionId?: string
  model?: string
  streaming?: boolean
  tools?: Tool[]
  hooks?: SessionHooks
  infiniteSessions?: InfiniteSessionConfig
  systemMessage?: { content: string }
  onPermissionRequest: (request: PermissionRequest) => Promise<boolean>
  agents?: CustomAgentConfig[]
  skillDirectories?: string[]
}

export interface InfiniteSessionConfig {
  enabled: boolean
  backgroundCompactionThreshold?: number  // default 0.80
  bufferExhaustionThreshold?: number       // default 0.95
}

export interface Tool {
  name: string
  description?: string
  parameters?: Record<string, unknown>
  handler?: (args: any) => Promise<unknown>
  skipPermission?: boolean
}

export interface SessionHooks {
  onSessionStart?: (input: SessionStartInput, invocation: { sessionId: string }) => Promise<SessionStartOutput | void>
  onUserPromptSubmitted?: (input: { prompt: string }) => Promise<{ modifiedPrompt?: string } | void>
  onSessionEnd?: (input: SessionEndInput, invocation: { sessionId: string }) => Promise<SessionEndOutput | void>
  onPostToolUse?: (input: PostToolUseInput) => Promise<void>
  onPreToolUse?: (input: PreToolUseInput) => Promise<{ allow: boolean } | void>
}

export interface SessionStartInput {
  timestamp: number
  source: 'startup' | 'resume' | 'new'
  initialPrompt?: string
}

export interface SessionStartOutput {
  additionalContext?: string
  modifiedConfig?: object
}

export interface SessionEndInput {
  reason: 'complete' | 'error' | 'abort' | 'timeout' | 'user_exit'
  finalMessage?: string
  conversationSummary?: string
  error?: string
  timestamp: number
}

export interface SessionEndOutput {
  suppressOutput?: boolean
  sessionSummary?: string
}

export interface PostToolUseInput {
  toolName: string
  toolResult: unknown
}

export interface PreToolUseInput {
  toolName: string
  arguments: Record<string, unknown>
}

export interface PermissionRequest {
  kind: 'tool_call' | 'memory'
  toolName?: string
  action?: string
  fact?: string
  subject?: string
}

export interface SendResult {
  message: string
  events?: SessionEvent[]
}

export type SessionEvent =
  | { type: 'assistant.message_delta'; content: string }
  | { type: 'assistant.message'; content: string }
  | { type: 'tool.call'; toolName: string; arguments: Record<string, unknown> }
  | { type: 'tool.result'; toolName: string; result: unknown }
  | { type: 'session.idle' }
  | { type: 'session.compaction_start' }
  | { type: 'session.compaction_complete'; summaryContent?: string }
  | { type: string; [key: string]: unknown }

export interface SessionInfo {
  sessionId: string
  createdAt: string
  lastActiveAt: string
}

export interface CustomAgentConfig {
  name: string
  prompt: string
  tools?: string[]
  skills?: string[]
}
