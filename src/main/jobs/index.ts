import { Cron } from 'croner'
import { getDb } from '../db'
import { executeJobSession } from '../agent'
import { BrowserWindow } from 'electron'
import type { Job } from '@shared/types'

const activeJobs = new Map<string, Cron>()

function rowToJob(row: Record<string, unknown>): Job {
  return {
    id: row.id as string,
    name: row.name as string,
    cron: row.cron as string,
    instruction: row.instruction as string,
    enabled: (row.enabled as number) === 1,
    lastRunAt: row.last_run_at as string | null,
    lastResult: row.last_result as 'success' | 'failed' | null,
    lastSummary: row.last_summary as string | null
  }
}

export function startAllJobs(): void {
  const db = getDb()
  const rows = db.prepare('SELECT * FROM jobs WHERE enabled = 1').all() as Record<string, unknown>[]

  for (const row of rows) {
    const job = rowToJob(row)
    scheduleJob(job)
  }
}

export function stopAllJobs(): void {
  for (const [id, cron] of activeJobs) {
    cron.stop()
  }
  activeJobs.clear()
}

function scheduleJob(job: Job): void {
  // Stop existing if any
  const existing = activeJobs.get(job.id)
  if (existing) existing.stop()

  const cronJob = new Cron(job.cron, async () => {
    await runJob(job.id)
  })

  activeJobs.set(job.id, cronJob)
}

export async function runJob(jobId: string): Promise<void> {
  const db = getDb()
  const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as Record<string, unknown> | undefined
  if (!row) return

  const job = rowToJob(row)
  const now = new Date().toISOString()
  const today = now.split('T')[0]

  // Pre-filter: For periodic-poll, skip if last run was very recent
  if (jobId === 'periodic-poll') {
    const lastRun = job.lastRunAt ? new Date(job.lastRunAt).getTime() : 0
    const minutesSince = (Date.now() - lastRun) / (1000 * 60)
    if (minutesSince < 25 && job.lastResult === 'success') {
      return
    }
  }

  // Pre-filter: For morning-briefing, skip if already ran today (startup trigger or earlier cron)
  if (jobId === 'morning-briefing') {
    if (job.lastRunAt && job.lastRunAt.startsWith(today) && job.lastResult === 'success') {
      return
    }
  }

  // Pre-filter: For world-sync, skip if already ran this week
  if (jobId === 'world-sync') {
    if (job.lastRunAt && job.lastResult === 'success') {
      const lastRun = new Date(job.lastRunAt).getTime()
      const daysSince = (Date.now() - lastRun) / (1000 * 60 * 60 * 24)
      if (daysSince < 6) return
    }
  }

  try {
    const summary = await executeJobSession(job.instruction, jobId, job.lastRunAt)

    db.prepare(`
      UPDATE jobs SET last_run_at = ?, last_result = 'success', last_summary = ? WHERE id = ?
    `).run(now, summary, jobId)

    // Notify renderer
    const windows = BrowserWindow.getAllWindows()
    for (const win of windows) {
      win.webContents.send('aide:event', {
        type: 'job:completed',
        jobId,
        summary
      })
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown error'
    db.prepare(`
      UPDATE jobs SET last_run_at = ?, last_result = 'failed', last_summary = ? WHERE id = ?
    `).run(now, errorMsg, jobId)

    // Surface failure to renderer so user knows something's wrong
    const windows = BrowserWindow.getAllWindows()
    for (const win of windows) {
      win.webContents.send('aide:event', {
        type: 'job:failed',
        jobId,
        error: errorMsg
      })
    }
  }
}

export function listJobs(): Job[] {
  const db = getDb()
  const rows = db.prepare('SELECT * FROM jobs ORDER BY name').all() as Record<string, unknown>[]
  return rows.map(rowToJob)
}

export function toggleJob(id: string, enabled: boolean): void {
  const db = getDb()
  db.prepare('UPDATE jobs SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id)

  if (enabled) {
    const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Record<string, unknown>
    if (row) scheduleJob(rowToJob(row))
  } else {
    const existing = activeJobs.get(id)
    if (existing) {
      existing.stop()
      activeJobs.delete(id)
    }
  }
}

export function getJobLastSummary(id: string): string | null {
  const db = getDb()
  const row = db.prepare('SELECT last_summary FROM jobs WHERE id = ?').get(id) as { last_summary: string | null } | undefined
  return row?.last_summary || null
}

export function createJob(data: { name: string; cron: string; instruction: string; enabled?: boolean }): Job {
  const db = getDb()
  const id = `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const enabled = data.enabled !== false
  db.prepare('INSERT INTO jobs (id, name, cron, instruction, enabled) VALUES (?, ?, ?, ?, ?)').run(id, data.name, data.cron, data.instruction, enabled ? 1 : 0)

  const job: Job = { id, name: data.name, cron: data.cron, instruction: data.instruction, enabled, lastRunAt: null, lastResult: null, lastSummary: null }
  if (enabled) scheduleJob(job)
  return job
}

export function updateJob(id: string, data: { name?: string; cron?: string; instruction?: string }): void {
  const db = getDb()

  // Read current row to check what actually changed
  const current = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Record<string, unknown> | undefined
  if (!current) return

  const sets: string[] = []
  const vals: unknown[] = []

  if (data.name !== undefined && data.name !== current.name) { sets.push('name = ?'); vals.push(data.name) }
  if (data.cron !== undefined && data.cron !== current.cron) { sets.push('cron = ?'); vals.push(data.cron) }
  if (data.instruction !== undefined && data.instruction !== current.instruction) { sets.push('instruction = ?'); vals.push(data.instruction) }

  if (sets.length === 0) return
  vals.push(id)
  db.prepare(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`).run(...vals)

  // Reschedule if cron actually changed and job is enabled
  if (data.cron !== undefined && data.cron !== current.cron && (current.enabled as number) === 1) {
    const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Record<string, unknown> | undefined
    if (row) scheduleJob(rowToJob(row))
  }
}

export function deleteJob(id: string): void {
  const db = getDb()
  const existing = activeJobs.get(id)
  if (existing) {
    existing.stop()
    activeJobs.delete(id)
  }
  db.prepare('DELETE FROM jobs WHERE id = ?').run(id)
}
