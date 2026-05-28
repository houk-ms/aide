import { v4 as uuid } from 'uuid'
import { getDb } from '../db'
import type { MemoryEntry, MemoryFilter, MemoryLayer, MemorySource } from '@shared/types'

function rowToMemory(row: Record<string, unknown>): MemoryEntry {
  return {
    id: row.id as string,
    layer: row.layer as MemoryLayer,
    content: row.content as string,
    source: row.source as MemorySource,
    status: row.status as 'active' | 'inactive',
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    taskId: row.task_id as string | null,
    projectId: row.project_id as string | null,
    tags: JSON.parse(row.tags as string),
    recallCount: row.recall_count as number
  }
}

// === L0 Identity Memory ===

export function getL0Content(): string {
  const db = getDb()
  const rows = db.prepare(
    "SELECT content FROM memory_entries WHERE layer = 'L0' AND status = 'active' AND id NOT LIKE '__%' ORDER BY created_at"
  ).all() as { content: string }[]
  return rows.map(r => r.content).join('\n\n')
}

export function setL0Content(content: string, source: MemorySource = 'user'): void {
  // Enforce 8K character hard limit
  if (content.length > 8000) {
    throw new Error(`L0 content exceeds 8K character limit (${content.length} chars). Condense or remove entries.`)
  }

  const db = getDb()
  const now = new Date().toISOString()

  // L0 is treated as a single document — replace all user L0 entries
  // Preserve system records: window state, briefing date, tokens, config, preferences
  db.prepare("DELETE FROM memory_entries WHERE layer = 'L0' AND id NOT LIKE '__%.%' AND id != '__window_state' AND id != '__last_briefing_date' AND id NOT LIKE '__token_%' AND id NOT LIKE '__config_%' AND id != '__user_preferences'").run()

  db.prepare(`
    INSERT INTO memory_entries (id, layer, content, source, status, created_at, updated_at, tags)
    VALUES (?, 'L0', ?, ?, 'active', ?, ?, '[]')
  `).run(uuid(), content, source, now, now)
}

// === L1 Knowledge Memory ===

export function writeMemory(params: {
  content: string
  layer?: MemoryLayer
  source?: MemorySource
  taskId?: string
  projectId?: string
  tags?: string[]
}): MemoryEntry {
  const db = getDb()
  const now = new Date().toISOString()
  const id = uuid()

  db.prepare(`
    INSERT INTO memory_entries (id, layer, content, source, status, created_at, updated_at, task_id, project_id, tags)
    VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)
  `).run(
    id,
    params.layer || 'L1',
    params.content,
    params.source || 'agent',
    now,
    now,
    params.taskId || null,
    params.projectId || null,
    JSON.stringify(params.tags || [])
  )

  return getMemoryById(id)!
}

// === FTS5 Search with BM25 + Time Decay + Chinese fallback ===

export function searchMemory(query: string, limit: number = 10): MemoryEntry[] {
  const db = getDb()

  // Check if query contains Chinese characters
  const hasChinese = /[\u4e00-\u9fff]/.test(query)

  if (hasChinese) {
    // For Chinese, use LIKE-based search with bigram tokenization for better recall
    // Split into Chinese segments and non-Chinese words
    const tokens: string[] = []
    // Extract continuous Chinese segments and English words separately
    const chineseSegments = query.match(/[\u4e00-\u9fff]{2,}/g) || []
    const englishWords = query.match(/[a-zA-Z0-9_]{2,}/g) || []

    // For Chinese segments: use the whole segment if ≤3 chars, else generate bigrams for broader matching
    for (const seg of chineseSegments) {
      if (seg.length <= 3) {
        tokens.push(seg)
      } else {
        // Keep the full segment for exact match priority
        tokens.push(seg)
        // Also add bigrams for partial match
        for (let i = 0; i < seg.length - 1; i++) {
          tokens.push(seg.slice(i, i + 2))
        }
      }
    }
    // Add English words directly
    tokens.push(...englishWords)

    // Deduplicate
    const uniqueTokens = [...new Set(tokens)]
    if (uniqueTokens.length === 0) return []

    // Weight: full phrases match more conditions than bigrams → natural ranking
    const conditions = uniqueTokens.map(() => 'me.content LIKE ?').join(' OR ')
    const params = uniqueTokens.map(k => `%${k}%`)

    // Order by number of matching conditions (relevance) + recency
    const matchScore = uniqueTokens.map(() => `(CASE WHEN me.content LIKE ? THEN 1 ELSE 0 END)`).join(' + ')

    const rows = db.prepare(`
      SELECT me.*, (${matchScore}) AS relevance
      FROM memory_entries me
      WHERE (${conditions}) AND me.status = 'active' AND me.layer IN ('L1', 'L2')
      ORDER BY relevance DESC, me.updated_at DESC
      LIMIT ?
    `).all(...params, ...params, limit) as Record<string, unknown>[]

    if (rows.length > 0) {
      const ids = rows.map(r => r.id as string)
      const placeholders = ids.map(() => '?').join(',')
      db.prepare(`UPDATE memory_entries SET recall_count = recall_count + 1 WHERE id IN (${placeholders})`).run(...ids)
    }

    return rows.map(rowToMemory)
  }

  // For non-Chinese, use FTS5
  // Sanitize FTS5 query: escape special characters
  const sanitizedQuery = query
    .replace(/['"]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 1)
    .map(w => `"${w}"`)
    .join(' OR ')

  if (!sanitizedQuery) return []

  // BM25 scoring + time decay factor
  const rows = db.prepare(`
    SELECT me.*, 
      bm25(memory_fts) AS score,
      (julianday('now') - julianday(me.created_at)) AS age_days
    FROM memory_entries me
    JOIN memory_fts ON memory_fts.rowid = me.rowid
    WHERE memory_fts MATCH ? AND me.status = 'active' AND me.layer IN ('L1', 'L2')
    ORDER BY (bm25(memory_fts) * (1.0 / (1.0 + 0.01 * (julianday('now') - julianday(me.created_at)))))
    LIMIT ?
  `).all(sanitizedQuery, limit) as Record<string, unknown>[]

  // Increment recall count for retrieved entries
  if (rows.length > 0) {
    const ids = rows.map(r => r.id as string)
    const placeholders = ids.map(() => '?').join(',')
    db.prepare(`UPDATE memory_entries SET recall_count = recall_count + 1 WHERE id IN (${placeholders})`).run(...ids)
  }

  return rows.map(rowToMemory)
}

// === CRUD ===

export function getMemoryById(id: string): MemoryEntry | null {
  const db = getDb()
  const row = db.prepare('SELECT * FROM memory_entries WHERE id = ?').get(id) as Record<string, unknown> | undefined
  return row ? rowToMemory(row) : null
}

export function listMemory(filter?: MemoryFilter): MemoryEntry[] {
  const db = getDb()
  let sql = 'SELECT * FROM memory_entries WHERE 1=1'
  const params: unknown[] = []

  if (filter?.layer && filter.layer.length > 0) {
    sql += ` AND layer IN (${filter.layer.map(() => '?').join(',')})`
    params.push(...filter.layer)
  }

  if (filter?.projectId) {
    sql += ' AND project_id = ?'
    params.push(filter.projectId)
  }

  if (filter?.status) {
    sql += ' AND status = ?'
    params.push(filter.status)
  }

  sql += ' ORDER BY updated_at DESC LIMIT 100'

  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[]
  return rows.map(rowToMemory)
}

export function updateMemory(id: string, content: string): void {
  const db = getDb()
  db.prepare('UPDATE memory_entries SET content = ?, updated_at = ? WHERE id = ?')
    .run(content, new Date().toISOString(), id)
}

export function deleteMemory(id: string): void {
  const db = getDb()
  db.prepare('DELETE FROM memory_entries WHERE id = ?').run(id)
}

export function markMemoryInactive(id: string): void {
  const db = getDb()
  db.prepare("UPDATE memory_entries SET status = 'inactive', updated_at = ? WHERE id = ?")
    .run(new Date().toISOString(), id)
}

// === Archive (L2) — Session End Extraction ===

export function archiveFromSession(sessionId: string, extractedFacts: string[]): void {
  for (const fact of extractedFacts) {
    writeMemory({ content: fact, layer: 'L2', source: 'system' })
  }
}
