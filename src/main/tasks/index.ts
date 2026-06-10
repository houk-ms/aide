import { v4 as uuid } from 'uuid'
import { getDb } from '../db'
import { listProjects } from '../projects'
import type { Task, TaskFilter, CreateTaskInput, TaskStatus, Priority, TaskActivity, TaskActivityType, Project } from '@shared/types'

/** Auto-match projects by keyword when task has no explicit projectIds */
function inferProjects(title: string, description: string, projects: Project[]): string[] {
  const text = `${title} ${description}`.toLowerCase()
  return projects
    .filter(p => {
      const terms = [p.name.toLowerCase()]
      if (p.repoPath) terms.push(p.repoPath.split('/').pop()!.toLowerCase())
      return terms.some(t => t.length > 2 && text.includes(t))
    })
    .map(p => p.id)
}

function rowToTask(row: Record<string, unknown>): Task {
  return {
    id: row.id as string,
    title: row.title as string,
    description: row.description as string,
    status: row.status as TaskStatus,
    priority: row.priority as Priority,
    source: {
      type: row.source_type as Task['source']['type'],
      connectionId: row.source_connection_id as string | undefined,
      externalId: row.source_external_id as string | undefined,
      externalUrl: row.source_external_url as string | undefined
    },
    projectIds: JSON.parse((row.project_ids as string) || '[]'),
    relatedRelationIds: JSON.parse(row.related_relation_ids as string),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    dueDate: row.due_date as string | null,
    completedAt: row.completed_at as string | null,
    seenAt: row.seen_at as string | null,
    snoozedUntil: row.snoozed_until as string | null,
    sessionId: row.session_id as string | null,
    result: row.result as string | null,
    workingState: (row.working_state as string | null) ?? null,
    lastActivityAt: (row.last_activity_at as string | null) ?? null
  }
}

function rowToActivity(row: Record<string, unknown>): TaskActivity {
  return {
    id: row.id as string,
    taskId: row.task_id as string,
    timestamp: row.timestamp as string,
    type: row.type as TaskActivityType,
    summary: row.summary as string,
    statusFrom: (row.status_from as TaskStatus | null) ?? null,
    statusTo: (row.status_to as TaskStatus | null) ?? null,
    sourceRef: (row.source_ref as string | null) ?? null,
    createdAt: row.created_at as string
  }
}

export function listTasks(filter?: TaskFilter): Task[] {
  const db = getDb()
  let sql = 'SELECT * FROM tasks WHERE 1=1'
  const params: unknown[] = []

  if (filter?.status && filter.status.length > 0) {
    sql += ` AND status IN (${filter.status.map(() => '?').join(',')})`
    params.push(...filter.status)
  }

  if (filter?.priority && filter.priority.length > 0) {
    sql += ` AND priority IN (${filter.priority.map(() => '?').join(',')})`
    params.push(...filter.priority)
  }

  if (filter?.projectId) {
    sql += " AND project_ids LIKE '%' || ? || '%'"
    params.push(`"${filter.projectId}"`)
  }

  if (!filter?.includeSnoozed) {
    sql += ' AND (snoozed_until IS NULL OR snoozed_until <= ?)'
    params.push(new Date().toISOString())
  }

  // Sort: p0 > p1 > p2, then urgent due dates, then newest first
  sql += ` ORDER BY 
    CASE priority WHEN 'p0' THEN 0 WHEN 'p1' THEN 1 WHEN 'p2' THEN 2 ELSE 3 END,
    CASE WHEN due_date IS NOT NULL AND due_date <= date('now', '+1 day') THEN 0 ELSE 1 END,
    created_at DESC`

  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[]
  return rows.map(rowToTask)
}

export function getTask(id: string): Task | null {
  const db = getDb()
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined
  return row ? rowToTask(row) : null
}

export interface CreateTaskResult {
  task: Task
  deduplicated: boolean
}

export function createTask(input: CreateTaskInput): CreateTaskResult {
  const db = getDb()
  const now = new Date().toISOString()
  const id = uuid()

  // De-dup: check externalId first
  if (input.source.externalId) {
    const existing = findTaskByExternalId(input.source.externalId)
    if (existing) return { task: existing, deduplicated: true }
  }

  // De-dup: content similarity check (threshold 0.75 for title, also checks description)
  const similar = findSimilarTask(input.title, 0.75, input.description)
  if (similar) return { task: similar, deduplicated: true }

  const priority = input.priority || 'p1'

  // Auto-infer projects if none explicitly set
  let projectIds = input.projectIds || []
  if (projectIds.length === 0) {
    const allProjects = listProjects()
    if (allProjects.length > 0) {
      projectIds = inferProjects(input.title, input.description || '', allProjects)
    }
  }

  db.prepare(`
    INSERT INTO tasks (id, title, description, status, priority, source_type, source_connection_id, source_external_id, source_external_url, project_ids, related_relation_ids, created_at, updated_at, due_date)
    VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.title,
    input.description || '',
    priority,
    input.source.type,
    input.source.connectionId || null,
    input.source.externalId || null,
    input.source.externalUrl || null,
    JSON.stringify(projectIds),
    JSON.stringify(input.relatedRelationIds || []),
    now,
    now,
    input.dueDate || null
  )

  return { task: getTask(id)!, deduplicated: false }
}

export function updateTask(id: string, changes: Partial<Task>): Task {
  const db = getDb()
  const now = new Date().toISOString()

  // Capture prior status for auto status_change activity
  const prior = changes.status !== undefined ? getTask(id) : null

  // Enforce terminal state: completed/cancelled cannot be reverted
  if (changes.status && changes.status !== 'completed' && changes.status !== 'cancelled') {
    const current = getTask(id)
    if (current && (current.status === 'completed' || current.status === 'cancelled')) {
      throw new Error(`Cannot change status of ${current.status} task`)
    }
  }

  const sets: string[] = ['updated_at = ?']
  const params: unknown[] = [now]

  if (changes.title !== undefined) { sets.push('title = ?'); params.push(changes.title) }
  if (changes.description !== undefined) { sets.push('description = ?'); params.push(changes.description) }
  if (changes.status !== undefined) {
    sets.push('status = ?'); params.push(changes.status)
    if (changes.status === 'completed' || changes.status === 'cancelled') {
      sets.push('completed_at = ?'); params.push(now)
    }
  }
  if (changes.priority !== undefined) { sets.push('priority = ?'); params.push(changes.priority) }
  if (changes.projectIds !== undefined) { sets.push('project_ids = ?'); params.push(JSON.stringify(changes.projectIds)) }
  if (changes.relatedRelationIds !== undefined) { sets.push('related_relation_ids = ?'); params.push(JSON.stringify(changes.relatedRelationIds)) }
  if (changes.dueDate !== undefined) { sets.push('due_date = ?'); params.push(changes.dueDate) }
  if (changes.seenAt !== undefined) { sets.push('seen_at = ?'); params.push(changes.seenAt) }
  if (changes.snoozedUntil !== undefined) { sets.push('snoozed_until = ?'); params.push(changes.snoozedUntil) }
  if (changes.sessionId !== undefined) { sets.push('session_id = ?'); params.push(changes.sessionId) }
  if (changes.result !== undefined) { sets.push('result = ?'); params.push(changes.result) }
  if (changes.workingState !== undefined) { sets.push('working_state = ?'); params.push(changes.workingState) }

  params.push(id)
  db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...params)

  // Auto-log a status_change activity when status actually changed
  if (changes.status !== undefined && prior && prior.status !== changes.status) {
    addTaskActivity(id, {
      type: 'status_change',
      summary: `Status changed: ${prior.status} → ${changes.status}`,
      statusFrom: prior.status,
      statusTo: changes.status
    })
  }

  return getTask(id)!
}

// === Task Activity Timeline ===

export interface AddActivityInput {
  type?: TaskActivityType
  summary: string
  statusFrom?: TaskStatus | null
  statusTo?: TaskStatus | null
  sourceRef?: string | null
}

export function addTaskActivity(taskId: string, input: AddActivityInput): TaskActivity {
  const db = getDb()
  const now = new Date().toISOString()
  const id = uuid()
  db.prepare(`
    INSERT INTO task_activities (id, task_id, timestamp, type, summary, status_from, status_to, source_ref, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    taskId,
    now,
    input.type || 'progress',
    input.summary,
    input.statusFrom ?? null,
    input.statusTo ?? null,
    input.sourceRef ?? null,
    now
  )
  // Bump task's last_activity_at so UI can surface "new activity"
  db.prepare('UPDATE tasks SET last_activity_at = ? WHERE id = ?').run(now, taskId)

  const row = db.prepare('SELECT * FROM task_activities WHERE id = ?').get(id) as Record<string, unknown>
  return rowToActivity(row)
}

export function listTaskActivities(taskId: string): TaskActivity[] {
  const db = getDb()
  const rows = db.prepare(
    'SELECT * FROM task_activities WHERE task_id = ? ORDER BY timestamp DESC'
  ).all(taskId) as Record<string, unknown>[]
  return rows.map(rowToActivity)
}

export function markTaskSeen(id: string): void {
  const db = getDb()
  // Always bump seenAt to "now" on open. The unread-activity dot is computed as
  // lastActivityAt > seenAt, so a stale seenAt would keep the dot lit forever
  // once a background job adds activity. Refreshing it each open lets opening
  // the task actually clear the dot (until new activity arrives).
  db.prepare('UPDATE tasks SET seen_at = ? WHERE id = ?')
    .run(new Date().toISOString(), id)
}

export function snoozeTask(id: string, until: string): void {
  // Validate date
  const date = new Date(until)
  if (isNaN(date.getTime())) {
    throw new Error(`Invalid snooze date: ${until}`)
  }
  if (date.getTime() < Date.now()) {
    throw new Error('Snooze date must be in the future')
  }
  const db = getDb()
  db.prepare('UPDATE tasks SET snoozed_until = ?, updated_at = ? WHERE id = ?')
    .run(until, new Date().toISOString(), id)
}

export function findTaskByExternalId(externalId: string): Task | null {
  const db = getDb()
  const row = db.prepare('SELECT * FROM tasks WHERE source_external_id = ?').get(externalId) as Record<string, unknown> | undefined
  return row ? rowToTask(row) : null
}

// === Content Similarity De-dup ===
// Before creating a task, check if a very similar one already exists.
// Uses simple token overlap (Jaccard similarity) as FTS5 can't do this well.

export function findSimilarTask(title: string, threshold: number = 0.6, description?: string): Task | null {
  const db = getDb()
  // Check active tasks AND recently completed/cancelled tasks (within 7 days)
  // This prevents re-creating tasks that were just completed
  const activeTasks = db.prepare(
    `SELECT * FROM tasks WHERE status IN ('pending', 'in_progress')
     UNION ALL
     SELECT * FROM tasks WHERE status IN ('completed', 'cancelled')
       AND completed_at >= datetime('now', '-7 days')`
  ).all() as Record<string, unknown>[]

  const inputTokens = tokenize(title)
  const inputDescTokens = description ? tokenize(description) : null
  const inputEntities = extractEntities(title + (description ? ' ' + description : ''))

  for (const row of activeTasks) {
    const existingTitle = row.title as string
    const existingDesc = (row.description as string) || ''

    // 1. Entity match: if both share specific identifiers (PR #, issue #, email subject key), it's the same task
    if (inputEntities.size > 0) {
      const existingEntities = extractEntities(existingTitle + ' ' + existingDesc)
      const sharedEntities = [...inputEntities].filter(e => existingEntities.has(e))
      if (sharedEntities.length > 0) {
        return rowToTask(row)
      }
    }

    // 2. Token similarity on title
    const existingTokens = tokenize(existingTitle)
    const titleSim = jaccardSimilarity(inputTokens, existingTokens)
    if (titleSim >= threshold) {
      return rowToTask(row)
    }

    // 3. Lower title threshold if description also matches well
    if (titleSim >= 0.4 && inputDescTokens && existingDesc) {
      const descSim = jaccardSimilarity(inputDescTokens, tokenize(existingDesc))
      if (descSim >= 0.5) {
        return rowToTask(row)
      }
    }
  }
  return null
}

// === Related-task finder (shared by "create" and "associate activity" paths) ===
// Returns the best candidate with a score and human-readable reason, so the
// agent can decide whether to associate an activity vs. open a new task.

export interface RelatedTaskMatch {
  task: Task
  score: number // 0..1
  reason: 'entity' | 'source_ref' | 'title' | 'title+desc'
}

export function findRelatedTask(
  title: string,
  description?: string,
  sourceRef?: string
): RelatedTaskMatch | null {
  const db = getDb()
  const candidates = db.prepare(
    `SELECT * FROM tasks WHERE status IN ('pending', 'in_progress')
     UNION ALL
     SELECT * FROM tasks WHERE status IN ('completed', 'cancelled')
       AND completed_at >= datetime('now', '-7 days')`
  ).all() as Record<string, unknown>[]

  // 0. Precise binding: a prior activity already linked this source_ref to a task
  if (sourceRef) {
    const act = db.prepare(
      'SELECT task_id FROM task_activities WHERE source_ref = ? ORDER BY timestamp DESC LIMIT 1'
    ).get(sourceRef) as { task_id: string } | undefined
    if (act) {
      const t = getTask(act.task_id)
      if (t) return { task: t, score: 1, reason: 'source_ref' }
    }
  }

  const inputTokens = tokenize(title)
  const inputDescTokens = description ? tokenize(description) : null
  const inputEntities = extractEntities(title + (description ? ' ' + description : '') + (sourceRef ? ' ' + sourceRef : ''))

  let best: RelatedTaskMatch | null = null
  for (const row of candidates) {
    const existingTitle = row.title as string
    const existingDesc = (row.description as string) || ''

    if (inputEntities.size > 0) {
      const existingEntities = extractEntities(existingTitle + ' ' + existingDesc)
      const shared = [...inputEntities].filter(e => existingEntities.has(e))
      if (shared.length > 0) {
        return { task: rowToTask(row), score: 1, reason: 'entity' }
      }
    }

    const titleSim = jaccardSimilarity(inputTokens, tokenize(existingTitle))
    if (!best || titleSim > best.score) {
      let reason: RelatedTaskMatch['reason'] = 'title'
      let score = titleSim
      if (titleSim >= 0.4 && inputDescTokens && existingDesc) {
        const descSim = jaccardSimilarity(inputDescTokens, tokenize(existingDesc))
        if (descSim >= 0.5) { reason = 'title+desc'; score = Math.max(titleSim, (titleSim + descSim) / 2) }
      }
      best = { task: rowToTask(row), score, reason }
    }
  }

  // Only surface a meaningful candidate
  if (best && best.score >= 0.3) return best
  return null
}

// Extract key identifiers that uniquely identify a work item
function extractEntities(text: string): Set<string> {
  const entities = new Set<string>()
  // PR/Issue numbers: #123, PR #456, issue #789
  const numRefs = text.match(/(?:PR|pr|issue|Issue|#)\s*#?(\d{2,})/g)
  if (numRefs) for (const r of numRefs) entities.add(r.toLowerCase().replace(/\s+/g, ''))
  // GitHub-style refs: owner/repo#123
  const ghRefs = text.match(/[\w-]+\/[\w-]+#\d+/g)
  if (ghRefs) for (const r of ghRefs) entities.add(r.toLowerCase())
  // Email message IDs or thread subjects in angle brackets
  const msgIds = text.match(/<[^>]+@[^>]+>/g)
  if (msgIds) for (const r of msgIds) entities.add(r.toLowerCase())
  return entities
}

function tokenize(text: string): Set<string> {
  const cleaned = text.toLowerCase().replace(/[^\w\u4e00-\u9fff]+/g, ' ')
  const tokens = new Set<string>()

  // Split ASCII words by whitespace
  const words = cleaned.split(/\s+/).filter(t => t.length > 1)
  for (const w of words) tokens.add(w)

  // For Chinese characters, generate character bigrams
  const cjk = cleaned.replace(/[^\u4e00-\u9fff]/g, '')
  for (let i = 0; i < cjk.length - 1; i++) {
    tokens.add(cjk.slice(i, i + 2))
  }
  // Also add individual Chinese characters for short titles
  if (cjk.length <= 4) {
    for (const ch of cjk) tokens.add(ch)
  }

  return tokens
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1
  const intersection = new Set([...a].filter(x => b.has(x)))
  const union = new Set([...a, ...b])
  return intersection.size / union.size
}

// === Priority Calculation ===
// Factors: relation role, deadline proximity, explicit urgency


