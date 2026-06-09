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

  // Progress timeline
  lastActivityAt?: string | null
}

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled'
export type Priority = 'p0' | 'p1' | 'p2'

export type TaskActivityType = 'progress' | 'status_change' | 'comment' | 'blocker' | 'note'

export interface TaskActivity {
  id: string
  taskId: string
  timestamp: string
  type: TaskActivityType
  summary: string
  statusFrom?: TaskStatus | null
  statusTo?: TaskStatus | null
  sourceRef?: string | null
  createdAt: string
}

export interface TaskSource {
  type: 'email' | 'teams' | 'github' | 'calendar' | 'chat'
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
  source: 'user' | 'agent'
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
  source: 'user' | 'agent'
  createdAt: string
  updatedAt: string
}

export type RelationRole = 'manager' | 'peer' | 'report' | 'external' | 'stakeholder'

// === Job ===

export type DeliveryTarget = 'desktop' | 'wechat' | 'whatsapp' | 'telegram' | 'discord'

export interface Job {
  id: string
  name: string
  cron: string
  instruction: string
  enabled: boolean
  deliveryTargets: DeliveryTarget[]
  isBuiltin: boolean
  lastRunAt: string | null
  lastResult: 'success' | 'failed' | null
  lastSummary: string | null
}

// === Skill ===

export interface Skill {
  id: string
  name: string
  description: string
  source: 'local' | 'marketplace'
  sourceId?: string              // Marketplace source ID (e.g., 'anthropic-official')
  sourceUrl: string | null
  verified: boolean              // true if from an official/curated marketplace source
  enabled: boolean
  path: string
  createdAt: string
  updatedAt: string
}

// === Marketplace ===

export type MarketplaceSourceType = 'official' | 'community'

export interface MarketplaceSource {
  id: string
  name: string
  type: MarketplaceSourceType
  url: string                    // Git repo URL (https://github.com/owner/repo)
  branch: string                 // Default: 'main'
  enabled: boolean
  lastSyncedAt: string | null
  skillCount: number
}

/** marketplace.json format (Claude standard) */
export interface MarketplaceManifest {
  version: string
  name?: string
  description?: string
  skills: MarketplaceSkillEntry[]
}

export interface MarketplaceSkillEntry {
  name: string
  description: string
  path: string                   // Relative path to SKILL.md
  category?: string
  risk?: string                  // Safety hint from the source index (e.g., 'safe')
  source?: string                // Provenance from the index (e.g., 'community', 'official', a repo URL)
  dateAdded?: string             // ISO date the entry was added to the catalog
  setup?: SkillSetup             // Extra setup the skill needs before it works
}

/** Whether a skill needs manual configuration before it can run. */
export interface SkillSetup {
  type: 'none' | 'manual' | string
  summary?: string               // Human-readable setup steps (when type !== 'none')
  docs?: string | null           // Optional link to setup docs
}

/** Skill that can be browsed but not yet installed */
export interface BrowsableSkill {
  name: string
  description: string
  category?: string
  sourceId: string
  sourceName: string
  sourceType: MarketplaceSourceType
  path: string                   // Path in the repository
  installed: boolean
  risk?: string                  // Safety hint from the source index (e.g., 'safe')
  source?: string                // Provenance (e.g., 'community', 'official', a repo URL)
  dateAdded?: string             // ISO date added to the catalog
  setup?: SkillSetup             // Extra setup the skill needs before it works
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
  checking: boolean // true = currently verifying via the real MCP server (transient)
  lastError: string | null
  lastPolledAt: string | null
  activeAccount: string | null // e.g. GitHub username
}

// === WeChat ===

export type WeChatConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface WeChatStatus {
  connection: WeChatConnectionStatus
  accountId: string | null
  targetUser: string | null
  lastError: string | null
  monitorActive: boolean
}

// === WhatsApp ===

export interface WhatsAppStatus {
  connection: 'disconnected' | 'connecting' | 'connected' | 'error'
  phoneNumber: string | null
  qrCode: string | null
  lastError: string | null
  monitorActive: boolean
}

// === Telegram ===

export interface TelegramStatus {
  connection: 'disconnected' | 'connecting' | 'connected' | 'error'
  botUsername: string | null
  chatId: string | null
  lastError: string | null
  monitorActive: boolean
}

// === Discord ===

export interface DiscordStatus {
  connection: 'disconnected' | 'connecting' | 'connected' | 'error'
  botUsername: string | null
  channelId: string | null
  lastError: string | null
  monitorActive: boolean
}

// === Channels ===

export type ChannelId = 'wechat' | 'whatsapp' | 'telegram' | 'discord'

export interface ChannelStatusInfo {
  id: ChannelId
  connection: 'disconnected' | 'connecting' | 'connected' | 'error'
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
    listActivities(taskId: string): Promise<TaskActivity[]>
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
    run(id: string): Promise<void>
    create(data: { name: string; cron: string; instruction: string; enabled?: boolean; deliveryTargets?: DeliveryTarget[] }): Promise<Job>
    update(id: string, data: { name?: string; cron?: string; instruction?: string; deliveryTargets?: DeliveryTarget[] }): Promise<void>
    delete(id: string): Promise<void>
  }
  connections: {
    getStatus(): Promise<ConnectionStatus[]>
    checkCli(): Promise<{ gh: boolean; npx: boolean }>
    authenticateGitHub(): Promise<void>
    authenticateMicrosoft(): Promise<void>
    disconnect(type: 'workiq' | 'github'): Promise<void>
    listGhAccounts(): Promise<{ account: string; active: boolean }[]>
    switchGhAccount(account: string): Promise<void>
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
  skills: {
    list(): Promise<Skill[]>
    get(id: string): Promise<Skill | null>
    toggle(id: string, enabled: boolean): Promise<Skill>
    delete(id: string): Promise<void>
  }
  marketplace: {
    listSources(): Promise<MarketplaceSource[]>
    syncSource(id: string): Promise<MarketplaceSource>
    syncAll(): Promise<void>
    browse(sourceId?: string): Promise<BrowsableSkill[]>
    install(sourceId: string, path: string): Promise<Skill>
  }
  wechat: {
    getStatus(): Promise<WeChatStatus>
    connect(): Promise<WeChatStatus>
    disconnect(): Promise<WeChatStatus>
    push(text: string): Promise<void>
    setTargetUser(userId: string): Promise<void>
    setBaseUrl(url: string): Promise<void>
  }
  whatsapp: {
    getStatus(): Promise<WhatsAppStatus>
    connect(): Promise<WhatsAppStatus>
    disconnect(clearSession?: boolean): Promise<WhatsAppStatus>
    push(text: string): Promise<void>
  }
  telegram: {
    getStatus(): Promise<TelegramStatus>
    connect(config?: { botToken: string; chatId: string }): Promise<TelegramStatus>
    disconnect(clearConfig?: boolean): Promise<TelegramStatus>
    push(text: string): Promise<void>
  }
  discord: {
    getStatus(): Promise<DiscordStatus>
    connect(config?: { botToken: string; channelId: string }): Promise<DiscordStatus>
    disconnect(clearConfig?: boolean): Promise<DiscordStatus>
    push(text: string): Promise<void>
  }
  channels: {
    list(): Promise<ChannelStatusInfo[]>
    deliver(channelId: ChannelId, text: string): Promise<void>
  }
  updates: {
    getState(): Promise<UpdateState>
    check(): Promise<UpdateState>
    download(): Promise<UpdateState>
    install(): Promise<void>
  }
  files: {
    open(taskId: string | null, ref: string): Promise<{ ok: boolean; error?: string }>
    reveal(taskId: string | null, ref: string): Promise<{ ok: boolean; error?: string }>
    exists(taskId: string | null, ref: string): Promise<boolean>
  }
  system: {
    health(): Promise<{ sdk: 'initializing' | 'ready' | 'error'; sdkError: string | null }>
  }
}

// === Auto-update ===

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'not-available'
  | 'error'

export interface UpdateState {
  status: UpdateStatus
  supported: boolean
  currentVersion: string
  latestVersion: string | null
  progressPercent: number | null
  error: string | null
  lastCheckedAt: string | null
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
  source?: 'user' | 'agent'
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
  source?: 'user' | 'agent'
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
  /** Ordered "work" steps (narration + tool calls) that led to this reply.
   *  Kept as a foldable process trail so a long turn's intermediate output is
   *  preserved instead of being discarded once the final answer lands. */
  process?: TurnStep[]
}

/** One step in an agent turn's process trail. */
export type TurnStep =
  | { kind: 'text'; content: string }
  | {
      kind: 'tool'
      toolName: string
      status: 'done' | 'error'
      durationMs?: number
      inputPreview?: string
      resultPreview?: string
    }

export interface PendingAction {
  id: string
  type: string
  toolName?: string
  description: string
  details: Record<string, unknown>
  status: 'pending' | 'confirmed' | 'cancelled'
}

export interface ToolCallRecord {
  id: string
  toolName: string
  status: 'running' | 'done' | 'error'
  timestamp: string
  durationMs?: number
  inputPreview?: string
  resultPreview?: string
}

// === Preferences ===

export interface UserPreferences {
  autonomyLevel: 'default' | 'confirm'
  systemNotifications: boolean
  onboardingComplete: boolean
}

export const DEFAULT_PREFERENCES: UserPreferences = {
  autonomyLevel: 'default',
  systemNotifications: false,
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
  | { type: 'task:activity'; taskId: string; activity: TaskActivity }
  | { type: 'chat:message'; message: ChatMessage }
  | { type: 'chat:stream'; taskId: string | null; delta: string }
  | { type: 'chat:stream-end'; taskId: string | null }
  | { type: 'chat:error'; taskId: string | null; error: string }
  | { type: 'chat:pending-action'; action: PendingAction }
  | { type: 'chat:tool-use'; taskId: string | null; record: ToolCallRecord }
  | { type: 'chat:action-expired'; actionId: string }
  | { type: 'job:completed'; jobId: string; summary: string }
  | { type: 'job:failed'; jobId: string; error: string }
  | { type: 'connection:status'; connections: ConnectionStatus[] }
  | { type: 'connection:auth-progress'; connectionType: string; userCode: string; verificationUri: string }
  | { type: 'wechat:qrcode'; qrcode: string; imgContent: string }
  | { type: 'wechat:login-progress'; stage: 'scanned' | 'confirmed' | 'expired' | 'timeout' }
  | { type: 'wechat:status'; status: WeChatStatus }
  | { type: 'whatsapp:qrcode'; qrCode: string }
  | { type: 'whatsapp:status'; status: WhatsAppStatus }
  | { type: 'telegram:status'; status: TelegramStatus }
  | { type: 'discord:status'; status: DiscordStatus }
  | { type: 'update:state'; state: UpdateState }
