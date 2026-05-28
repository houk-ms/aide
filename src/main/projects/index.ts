import { v4 as uuid } from 'uuid'
import { getDb } from '../db'
import type { Project, CreateProjectInput } from '@shared/types'

function rowToProject(row: Record<string, unknown>): Project {
  return {
    id: row.id as string,
    name: row.name as string,
    description: row.description as string,
    repoPath: row.repo_path as string | null,
    docsPath: row.docs_path as string | null,
    techStack: row.tech_stack as string | null,
    team: JSON.parse(row.team as string),
    notes: row.notes as string | null,
    source: (row.source as 'user' | 'agent') || 'user',
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string
  }
}

export function listProjects(): Project[] {
  const db = getDb()
  const rows = db.prepare('SELECT * FROM projects ORDER BY name').all() as Record<string, unknown>[]
  return rows.map(rowToProject)
}

export function getProject(id: string): Project | null {
  const db = getDb()
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Record<string, unknown> | undefined
  return row ? rowToProject(row) : null
}

export function createProject(input: CreateProjectInput): Project {
  const db = getDb()
  const now = new Date().toISOString()
  const id = uuid()

  db.prepare(`
    INSERT INTO projects (id, name, description, repo_path, docs_path, tech_stack, team, notes, source, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.name,
    input.description || '',
    input.repoPath || null,
    input.docsPath || null,
    input.techStack || null,
    JSON.stringify(input.team || []),
    input.notes || null,
    input.source || 'user',
    now,
    now
  )

  return getProject(id)!
}

export function updateProject(id: string, changes: Partial<Project>): Project {
  const db = getDb()
  const now = new Date().toISOString()
  const sets: string[] = ['updated_at = ?']
  const params: unknown[] = [now]

  if (changes.name !== undefined) { sets.push('name = ?'); params.push(changes.name) }
  if (changes.description !== undefined) { sets.push('description = ?'); params.push(changes.description) }
  if (changes.repoPath !== undefined) { sets.push('repo_path = ?'); params.push(changes.repoPath) }
  if (changes.docsPath !== undefined) { sets.push('docs_path = ?'); params.push(changes.docsPath) }
  if (changes.techStack !== undefined) { sets.push('tech_stack = ?'); params.push(changes.techStack) }
  if (changes.team !== undefined) { sets.push('team = ?'); params.push(JSON.stringify(changes.team)) }
  if (changes.notes !== undefined) { sets.push('notes = ?'); params.push(changes.notes) }

  params.push(id)
  db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...params)

  return getProject(id)!
}

export function deleteProject(id: string): void {
  const db = getDb()
  db.prepare('DELETE FROM projects WHERE id = ?').run(id)
}
