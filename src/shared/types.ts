// === Core Entity Types ===

export interface Task {
  id: string
  title: string
  description: string
  status: TaskStatus
  priority: Priority

  // Source tracing
  source: TaskSource

  // Relations
  projectId: string | null
  relatedRelationIds: string[]

  // Time
  createdAt: string // ISO 8601
  updatedAt: string
  dueDate: string | null
  completedAt: string | null

  // UI state
  seenAt: string | null // null = •new marker shown
  snoozedUntil: string | null // hidden until this time

  // Agent processing
  sessionId: string | null
  result: string | null
}

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled'
export type Priority = 'high' | 'medium' | 'low'

export interface TaskSource {
  type: 'email' | 'teams' | 'github' | 'calendar' | 'user' | 'agent'
  connectionId?: string
  externalId?: string
  externalUrl?: string
}

// === Memory ===

export interface MemoryEntry {
  id: string
  layer: MemoryLayer
  content: string
  source: MemorySource
  status: 'active' | 'inactive'
  createdAt: string
  updatedAt: string
  taskId: string | null
  projectId: string | null
  tags: string[]
  recallCount: number
}

export type MemoryLayer = 'L0' | 'L1' | 'L2'
export type MemorySource = 'agent' | 'system' | 'user'

// === Project ===

export interface Project {
  id: string
  name: string
  description: string
  repoPath: string | null
  docsPath: string | null
  techStack: string | null
  team: string[]
  notes: string | null
  createdAt: string
  updatedAt: string
}

// === Relation ===

export interface Relation {
  id: string
  name: string
  role: RelationRole
  org: string | null
  title: string | null
  email: string | null
  teamsId: string | null
  timezone: string | null
  expertise: string[]
  communicationStyle: string | null
  notes: string | null
  createdAt: string
  updatedAt: string
}

export type RelationRole = 'manager' | 'peer' | 'report' | 'external' | 'stakeholder'

// === Job ===

export interface Job {
  id: string
  name: string
  cron: string
  instruction: string
  enabled: boolean
  lastRunAt: string | null
  lastResult: 'success' | 'failed' | null
  lastSummary: string | null
}

// === Models ===

export interface ModelInfo {
  id: string
  name: string
}

// === Connection ===

export interface ConnectionStatus {
  id: string
  type: 'workiq' | 'github'
  authenticated: boolean
  verified: boolean // true = actually tested a real API call successfully
  lastError: string | null
}

// === IPC API ===

export interface AideAPI {
  tasks: {
    list(filter?: TaskFilter): Promise<Task[]>
    get(id: string): Promise<Task | null>
    create(input: CreateTaskInput): Promise<Task>
    update(id: string, changes: Partial<Task>): Promise<Task>
    markSeen(id: string): Promise<void>
    snooze(id: string, until: string): Promise<void>
  }
  chat: {
    send(message: string, taskId: string | null, attachments?: { name: string; type: string; dataUrl: string }[]): Promise<ChatMessage>
    getHistory(taskId: string | null): Promise<ChatMessage[]>
    confirmAction(actionId: string, decision: 'confirm' | 'modify' | 'cancel', modification?: string): Promise<void>
    triggerFirstMessage(taskId: string): Promise<ChatMessage>
    stopStream(): Promise<void>
    resetSession(taskId: string | null): Promise<void>
  }
  models: {
    list(): Promise<ModelInfo[]>
    getSelected(): Promise<string>
    setSelected(modelId: string): Promise<void>
  }
  memory: {
    getL0(): Promise<string>
    setL0(content: string): Promise<void>
    searchL1(query: string): Promise<MemoryEntry[]>
    list(filter?: MemoryFilter): Promise<MemoryEntry[]>
    update(id: string, content: string): Promise<void>
    delete(id: string): Promise<void>
  }
  jobs: {
    list(): Promise<Job[]>
    toggle(id: string, enabled: boolean): Promise<void>
    getLastSummary(id: string): Promise<string | null>
    create(data: { name: string; cron: string; instruction: string; enabled?: boolean }): Promise<Job>
    update(id: string, data: { name?: string; cron?: string; instruction?: string }): Promise<void>
    delete(id: string): Promise<void>
  }
  connections: {
    getStatus(): Promise<ConnectionStatus[]>
    authenticateGitHub(): Promise<void>
    authenticateMicrosoft(): Promise<void>
    disconnect(type: 'workiq' | 'github'): Promise<void>
  }
  projects: {
    list(): Promise<Project[]>
    get(id: string): Promise<Project | null>
    create(input: CreateProjectInput): Promise<Project>
    update(id: string, changes: Partial<Project>): Promise<Project>
    delete(id: string): Promise<void>
  }
  relations: {
    list(): Promise<Relation[]>
    get(id: string): Promise<Relation | null>
    create(input: CreateRelationInput): Promise<Relation>
    update(id: string, changes: Partial<Relation>): Promise<Relation>
    delete(id: string): Promise<void>
  }
  preferences: {
    get(): Promise<UserPreferences>
    set(prefs: Partial<UserPreferences>): Promise<void>
  }
  system: {
    health(): Promise<{ sdk: 'initializing' | 'ready' | 'error'; sdkError: string | null }>
  }
}

// === Input Types ===

export interface CreateTaskInput {
  title: string
  description?: string
  priority?: Priority
  source: TaskSource
  projectId?: string
  relatedRelationIds?: string[]
  dueDate?: string
}

export interface CreateProjectInput {
  name: string
  description?: string
  repoPath?: string
  docsPath?: string
  techStack?: string
  team?: string[]
  notes?: string
}

export interface CreateRelationInput {
  name: string
  role: RelationRole
  org?: string
  title?: string
  email?: string
  teamsId?: string
  timezone?: string
  expertise?: string[]
  communicationStyle?: string
  notes?: string
}

// === Filter Types ===

export interface TaskFilter {
  status?: TaskStatus[]
  priority?: Priority[]
  projectId?: string
  includeSnoozed?: boolean
}

export interface MemoryFilter {
  layer?: MemoryLayer[]
  projectId?: string
  status?: 'active' | 'inactive'
}

// === Chat Types ===

export interface ChatMessage {
  id: string
  role: 'user' | 'agent'
  content: string
  timestamp: string
  taskId: string | null
  pendingAction?: PendingAction
}

export interface PendingAction {
  id: string
  type: string
  description: string
  details: Record<string, unknown>
  status: 'pending' | 'confirmed' | 'cancelled'
}

// === Preferences ===

export interface UserPreferences {
  language: 'zh-CN' | 'en'
  autonomyLevel: 'default' | 'auto' | 'confirm'
  systemNotifications: boolean
  activeTaskCap: number
  onboardingComplete: boolean
}

export const DEFAULT_PREFERENCES: UserPreferences = {
  language: 'zh-CN',
  autonomyLevel: 'default',
  systemNotifications: false,
  activeTaskCap: 15,
  onboardingComplete: false
}

export interface DeviceCodeInfo {
  device_code: string
  user_code: string
  verification_uri: string
  expires_in: number
  interval: number
}

// === Events (Main → Renderer) ===

export type AideEvent =
  | { type: 'task:created'; task: Task }
  | { type: 'task:updated'; task: Task }
  | { type: 'chat:message'; message: ChatMessage }
  | { type: 'chat:stream'; taskId: string | null; delta: string }
  | { type: 'chat:stream-end'; taskId: string | null }
  | { type: 'chat:pending-action'; action: PendingAction }
  | { type: 'job:completed'; jobId: string; summary: string }
  | { type: 'connection:status'; connections: ConnectionStatus[] }
  | { type: 'connection:auth-progress'; connectionType: string; userCode: string; verificationUri: string }
