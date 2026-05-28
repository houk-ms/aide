import { getDb } from '../db'
import type { UserPreferences } from '@shared/types'

const PREFS_KEY = '__user_preferences'

const DEFAULT_PREFERENCES: UserPreferences = {
  language: 'zh-CN',
  autonomyLevel: 'default',
  systemNotifications: false,
  activeTaskCap: 15,
  onboardingComplete: false
}

export function getPreferences(): UserPreferences {
  const db = getDb()
  const row = db.prepare(
    "SELECT content FROM memory_entries WHERE id = ?"
  ).get(PREFS_KEY) as { content: string } | undefined

  if (!row) return { ...DEFAULT_PREFERENCES }

  try {
    return { ...DEFAULT_PREFERENCES, ...JSON.parse(row.content) }
  } catch {
    return { ...DEFAULT_PREFERENCES }
  }
}

export function setPreferences(partial: Partial<UserPreferences>): void {
  const db = getDb()
  const current = getPreferences()
  const merged = { ...current, ...partial }
  const now = new Date().toISOString()

  db.prepare(`
    INSERT OR REPLACE INTO memory_entries (id, layer, content, source, status, created_at, updated_at, tags)
    VALUES (?, 'L0', ?, 'system', 'active', ?, ?, '[]')
  `).run(PREFS_KEY, JSON.stringify(merged), now, now)
}

export function getAutonomyLevel(): UserPreferences['autonomyLevel'] {
  return getPreferences().autonomyLevel
}
