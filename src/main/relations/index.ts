import { v4 as uuid } from 'uuid'
import { getDb } from '../db'
import { cleanupRelationReferences } from '../agent'
import type { Relation, CreateRelationInput, RelationRole } from '@shared/types'

function rowToRelation(row: Record<string, unknown>): Relation {
  return {
    id: row.id as string,
    name: row.name as string,
    role: row.role as RelationRole,
    org: row.org as string | null,
    title: row.title as string | null,
    email: row.email as string | null,
    teamsId: row.teams_id as string | null,
    timezone: row.timezone as string | null,
    expertise: JSON.parse(row.expertise as string),
    communicationStyle: row.communication_style as string | null,
    notes: row.notes as string | null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string
  }
}

export function listRelations(): Relation[] {
  const db = getDb()
  const rows = db.prepare('SELECT * FROM relations ORDER BY name').all() as Record<string, unknown>[]
  return rows.map(rowToRelation)
}

export function getRelation(id: string): Relation | null {
  const db = getDb()
  const row = db.prepare('SELECT * FROM relations WHERE id = ?').get(id) as Record<string, unknown> | undefined
  return row ? rowToRelation(row) : null
}

export function createRelation(input: CreateRelationInput): Relation {
  const db = getDb()
  const now = new Date().toISOString()
  const id = uuid()

  db.prepare(`
    INSERT INTO relations (id, name, role, org, title, email, teams_id, timezone, expertise, communication_style, notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.name,
    input.role,
    input.org || null,
    input.title || null,
    input.email || null,
    input.teamsId || null,
    input.timezone || null,
    JSON.stringify(input.expertise || []),
    input.communicationStyle || null,
    input.notes || null,
    now,
    now
  )

  return getRelation(id)!
}

export function updateRelation(id: string, changes: Partial<Relation>): Relation {
  const db = getDb()
  const now = new Date().toISOString()
  const sets: string[] = ['updated_at = ?']
  const params: unknown[] = [now]

  if (changes.name !== undefined) { sets.push('name = ?'); params.push(changes.name) }
  if (changes.role !== undefined) { sets.push('role = ?'); params.push(changes.role) }
  if (changes.org !== undefined) { sets.push('org = ?'); params.push(changes.org) }
  if (changes.title !== undefined) { sets.push('title = ?'); params.push(changes.title) }
  if (changes.email !== undefined) { sets.push('email = ?'); params.push(changes.email) }
  if (changes.teamsId !== undefined) { sets.push('teams_id = ?'); params.push(changes.teamsId) }
  if (changes.timezone !== undefined) { sets.push('timezone = ?'); params.push(changes.timezone) }
  if (changes.expertise !== undefined) { sets.push('expertise = ?'); params.push(JSON.stringify(changes.expertise)) }
  if (changes.communicationStyle !== undefined) { sets.push('communication_style = ?'); params.push(changes.communicationStyle) }
  if (changes.notes !== undefined) { sets.push('notes = ?'); params.push(changes.notes) }

  params.push(id)
  db.prepare(`UPDATE relations SET ${sets.join(', ')} WHERE id = ?`).run(...params)

  return getRelation(id)!
}

export function deleteRelation(id: string): void {
  const db = getDb()
  db.prepare('DELETE FROM relations WHERE id = ?').run(id)
  // Clean up references in tasks and memories
  cleanupRelationReferences(id)
}
