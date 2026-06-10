import { createRequire } from 'module'
import type DatabaseConstructor from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'fs'

const require = createRequire(import.meta.url)

let Database: typeof DatabaseConstructor
try {
  Database = require('better-sqlite3')
} catch (err: any) {
  const msg = `Failed to load the database module (better-sqlite3). Please reinstall the app.\n${err?.message || err}`
  if (typeof process !== 'undefined' && process.versions?.electron) {
    const { dialog } = require('electron') as typeof import('electron')
    dialog.showErrorBox('Aide failed to start', msg)
  }
  throw new Error(msg)
}

type DatabaseInstance = ReturnType<typeof DatabaseConstructor>

let db: DatabaseInstance | null = null

export function getDb(): DatabaseInstance {
  if (!db) {
    const userDataPath = app.getPath('userData')
    const dbDir = join(userDataPath, 'data')
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true })
    }
    const dbPath = join(dbDir, 'aide.db')
    const isFreshDb = !existsSync(dbPath)
    db = new Database(dbPath)
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    initSchema(db)
    runMigrations(db, { dbDir, isFreshDb })
    syncBuiltinJobs(db)
  }
  return db
}

function initSchema(db: DatabaseInstance): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      priority TEXT NOT NULL DEFAULT 'p1',
      source_type TEXT NOT NULL,
      source_connection_id TEXT,
      source_external_id TEXT,
      source_external_url TEXT,
      project_ids TEXT NOT NULL DEFAULT '[]',
      related_relation_ids TEXT NOT NULL DEFAULT '[]',
      working_state TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      due_date TEXT,
      completed_at TEXT,
      seen_at TEXT,
      snoozed_until TEXT,
      session_id TEXT,
      result TEXT,
      last_activity_at TEXT
    );

    CREATE TABLE IF NOT EXISTS task_activities (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'progress',
      summary TEXT NOT NULL,
      status_from TEXT,
      status_to TEXT,
      source_ref TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS memory_entries (
      id TEXT PRIMARY KEY,
      layer TEXT NOT NULL,
      content TEXT NOT NULL,
      source TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      task_id TEXT,
      project_id TEXT,
      tags TEXT NOT NULL DEFAULT '[]',
      recall_count INTEGER NOT NULL DEFAULT 0,
      embedding BLOB,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE SET NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
      content,
      tags,
      content='memory_entries',
      content_rowid='rowid',
      tokenize='unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS memory_ai AFTER INSERT ON memory_entries BEGIN
      INSERT INTO memory_fts(rowid, content, tags)
      VALUES (new.rowid, new.content, new.tags);
    END;

    CREATE TRIGGER IF NOT EXISTS memory_ad AFTER DELETE ON memory_entries BEGIN
      INSERT INTO memory_fts(memory_fts, rowid, content, tags)
      VALUES ('delete', old.rowid, old.content, old.tags);
    END;

    CREATE TRIGGER IF NOT EXISTS memory_au AFTER UPDATE ON memory_entries BEGIN
      INSERT INTO memory_fts(memory_fts, rowid, content, tags)
      VALUES ('delete', old.rowid, old.content, old.tags);
      INSERT INTO memory_fts(rowid, content, tags)
      VALUES (new.rowid, new.content, new.tags);
    END;

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      repo_path TEXT,
      docs_path TEXT,
      tech_stack TEXT,
      team TEXT NOT NULL DEFAULT '[]',
      notes TEXT,
      source TEXT NOT NULL DEFAULT 'user',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS relations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      org TEXT,
      title TEXT,
      email TEXT,
      teams_id TEXT,
      timezone TEXT,
      expertise TEXT NOT NULL DEFAULT '[]',
      communication_style TEXT,
      notes TEXT,
      source TEXT NOT NULL DEFAULT 'user',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      cron TEXT NOT NULL,
      instruction TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      delivery_targets TEXT NOT NULL DEFAULT '[]',
      is_builtin INTEGER NOT NULL DEFAULT 0,
      last_run_at TEXT,
      last_result TEXT,
      last_summary TEXT
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      task_id TEXT,
      pending_action TEXT,
      process TEXT,
      attachments TEXT,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);
    CREATE INDEX IF NOT EXISTS idx_activity_task ON task_activities(task_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_memory_layer ON memory_entries(layer);
    CREATE INDEX IF NOT EXISTS idx_memory_status ON memory_entries(status);
    CREATE INDEX IF NOT EXISTS idx_memory_project ON memory_entries(project_id);
    CREATE INDEX IF NOT EXISTS idx_chat_task ON chat_messages(task_id);
    CREATE INDEX IF NOT EXISTS idx_chat_timestamp ON chat_messages(timestamp);
  `)

}

// ─────────────────────────────────────────────────────────────────────────────
// Versioned migrations
//
// The schema version is tracked in SQLite's `PRAGMA user_version`. Each
// migration runs exactly once, in order, inside its own transaction. Before
// touching an existing database we snapshot it (VACUUM INTO) so a bad migration
// shipped via auto-update can never silently corrupt a user's data — they can
// recover from the backup.
//
// Fresh installs are born at the latest version (initSchema already builds the
// current shape), so migrations only ever run on databases created by an older
// build. Migrations that correspond to already-shipped ad-hoc changes stay
// idempotent so existing production DBs (still at user_version 0) converge.
// ─────────────────────────────────────────────────────────────────────────────

type Migration = { version: number; name: string; up: (db: DatabaseInstance) => void }

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'baseline columns, timeline & connection state',
    up: (db) => {
      const cols = (table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(c => c.name)

      if (!cols('projects').includes('source')) {
        db.exec("ALTER TABLE projects ADD COLUMN source TEXT NOT NULL DEFAULT 'user'")
      }
      if (!cols('relations').includes('source')) {
        db.exec("ALTER TABLE relations ADD COLUMN source TEXT NOT NULL DEFAULT 'user'")
      }
      const taskCols = cols('tasks')
      if (!taskCols.includes('source_connection_id')) {
        db.exec("ALTER TABLE tasks ADD COLUMN source_connection_id TEXT")
      }
      if (!taskCols.includes('last_activity_at')) {
        db.exec("ALTER TABLE tasks ADD COLUMN last_activity_at TEXT")
      }
      db.exec(`
        CREATE TABLE IF NOT EXISTS task_activities (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          timestamp TEXT NOT NULL,
          type TEXT NOT NULL DEFAULT 'progress',
          summary TEXT NOT NULL,
          status_from TEXT,
          status_to TEXT,
          source_ref TEXT,
          created_at TEXT NOT NULL,
          FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_activity_task ON task_activities(task_id, timestamp);
      `)
      db.exec(`
        CREATE TABLE IF NOT EXISTS connection_state (
          connection_id TEXT PRIMARY KEY,
          last_polled_at TEXT,
          poll_cursor TEXT
        )
      `)
      // Normalize legacy priority labels (runs once, here, instead of every boot).
      db.exec(`
        UPDATE tasks SET priority = 'p0' WHERE priority = 'high';
        UPDATE tasks SET priority = 'p1' WHERE priority = 'medium';
        UPDATE tasks SET priority = 'p2' WHERE priority = 'low';
      `)
      // Add delivery_targets to jobs; seed the morning briefing's default targets.
      if (!cols('jobs').includes('delivery_targets')) {
        db.exec("ALTER TABLE jobs ADD COLUMN delivery_targets TEXT NOT NULL DEFAULT '[]'")
        db.prepare("UPDATE jobs SET delivery_targets = ? WHERE id = 'morning-briefing'").run(JSON.stringify(['desktop', 'wechat']))
      }
    },
  },
  {
    version: 2,
    name: 'distinguish built-in jobs from user jobs',
    up: (db) => {
      const jobCols = (db.prepare("PRAGMA table_info(jobs)").all() as { name: string }[]).map(c => c.name)
      if (!jobCols.includes('is_builtin')) {
        db.exec("ALTER TABLE jobs ADD COLUMN is_builtin INTEGER NOT NULL DEFAULT 0")
      }
      // Mark the jobs that shipped as built-ins so future sync/cleanup can tell
      // app-managed jobs apart from ones the user (or agent) created.
      const ids = BUILTIN_JOBS.map(j => j.id)
      const placeholders = ids.map(() => '?').join(', ')
      db.prepare(`UPDATE jobs SET is_builtin = 1 WHERE id IN (${placeholders})`).run(...ids)
    },
  },
  {
    version: 3,
    name: 'chat message process trail',
    up: (db) => {
      const cols = (db.prepare('PRAGMA table_info(chat_messages)').all() as { name: string }[]).map(c => c.name)
      if (!cols.includes('process')) {
        db.exec('ALTER TABLE chat_messages ADD COLUMN process TEXT')
      }
    },
  },
  {
    version: 4,
    name: 'chat message attachments',
    up: (db) => {
      const cols = (db.prepare('PRAGMA table_info(chat_messages)').all() as { name: string }[]).map(c => c.name)
      if (!cols.includes('attachments')) {
        db.exec('ALTER TABLE chat_messages ADD COLUMN attachments TEXT')
      }
    },
  },
  {
    version: 5,
    name: 'memory redesign: working_state, projectIds, embedding',
    up: (db) => {
      const taskCols = (db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map(c => c.name)
      // Add working_state column
      if (!taskCols.includes('working_state')) {
        db.exec('ALTER TABLE tasks ADD COLUMN working_state TEXT')
      }
      // Migrate projectId → projectIds (JSON array)
      if (taskCols.includes('project_id') && !taskCols.includes('project_ids')) {
        db.exec("ALTER TABLE tasks ADD COLUMN project_ids TEXT NOT NULL DEFAULT '[]'")
        // Migrate existing project_id values
        db.exec("UPDATE tasks SET project_ids = json_array(project_id) WHERE project_id IS NOT NULL AND project_id != ''")
      } else if (!taskCols.includes('project_ids')) {
        db.exec("ALTER TABLE tasks ADD COLUMN project_ids TEXT NOT NULL DEFAULT '[]'")
      }
      // Add embedding column to memory_entries
      const memCols = (db.prepare('PRAGMA table_info(memory_entries)').all() as { name: string }[]).map(c => c.name)
      if (!memCols.includes('embedding')) {
        db.exec('ALTER TABLE memory_entries ADD COLUMN embedding BLOB')
      }
      // Wipe L2 entries (broken checkpoint data)
      db.exec("DELETE FROM memory_entries WHERE layer = 'L2'")
    },
  },
]

const LATEST_SCHEMA_VERSION = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0)

function runMigrations(db: DatabaseInstance, opts: { dbDir: string; isFreshDb: boolean }): void {
  // A brand-new database already matches the latest schema (initSchema built it),
  // so stamp it current and skip migrations entirely — nothing to upgrade.
  if (opts.isFreshDb) {
    db.pragma(`user_version = ${LATEST_SCHEMA_VERSION}`)
    return
  }

  const current = db.pragma('user_version', { simple: true }) as number
  const pending = MIGRATIONS.filter(m => m.version > current).sort((a, b) => a.version - b.version)
  if (pending.length === 0) return

  // Snapshot before mutating an existing database — the safety net for updates.
  backupDatabase(db, opts.dbDir, current)

  for (const migration of pending) {
    const apply = db.transaction(() => {
      migration.up(db)
      db.pragma(`user_version = ${migration.version}`)
    })
    try {
      apply()
      console.log(`[Aide][db] Migrated to v${migration.version} (${migration.name}).`)
    } catch (err) {
      // The transaction rolled back this migration; the pre-migration backup is
      // intact. Fail loudly rather than limp along on a half-migrated schema.
      console.error(`[Aide][db] Migration v${migration.version} (${migration.name}) failed:`, err)
      throw err
    }
  }
}

/** Snapshot the database to data/backups before applying migrations. */
function backupDatabase(db: DatabaseInstance, dbDir: string, fromVersion: number): void {
  try {
    const backupDir = join(dbDir, 'backups')
    if (!existsSync(backupDir)) mkdirSync(backupDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const dest = join(backupDir, `aide-pre-v${fromVersion}-${stamp}.db`)
    // VACUUM INTO produces a consistent, WAL-safe copy in one synchronous step.
    db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`)
    pruneBackups(backupDir, 5)
    console.log(`[Aide][db] Snapshotted database before migration → ${dest}`)
  } catch (err) {
    // A failed backup must not block startup; log and continue.
    console.warn('[Aide][db] Pre-migration backup failed (continuing):', err)
  }
}

/** Keep only the most recent `keep` backups; delete the rest. */
function pruneBackups(backupDir: string, keep: number): void {
  try {
    const files = readdirSync(backupDir)
      .filter(f => f.endsWith('.db'))
      .map(f => ({ f, t: statSync(join(backupDir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
    for (const { f } of files.slice(keep)) {
      try { unlinkSync(join(backupDir, f)) } catch { /* best effort */ }
    }
  } catch { /* best effort */ }
}

const DEFAULT_PERIODIC_POLL_INSTRUCTION = `Check for new email, Teams messages, and GitHub notifications since the last run (on first run, look back 24 hours). When using ask_work_iq, set the query range based on the time info above.

Before handling each new item, call query_aide_tasks to see current active tasks, then make one of four decisions:

1. Link to an existing task: if the item is a follow-up to an existing task. First use find_related_task (with sourceId/PR#/email ID, etc.) to confirm ownership; on a match, use add_task_activity to record progress, including sourceRef when possible.
2. Update status: on objective complete/blocked signals (PR merged → completed, CI failing or changes requested → record a blocker, etc.) use update_aide_task to change status (status changes are logged automatically).
3. Create a new task: only when no related task exists. Always fill sourceType by the real source (GitHub → github, Teams → teams, email → email, calendar → calendar) and attach sourceId and sourceUrl (external link).
4. Ignore: if unrelated to existing tasks and not worth creating, skip it.

Keep the bar for recording activity strict: only record when something actually moves forward, gets blocked, changes status, or requires substantive input from the user. Skip pleasantries, acknowledgements, forwards, CCs, bot notifications, and minor wording tweaks; default to ignoring — recording is the exception. Record each piece of progress only once (check with get_task_activities first), and merge multiple related items for the same task in one poll into a single note.`

const DEFAULT_WORLD_SYNC_INSTRUCTION = `Maintain the contacts and projects lists. Do not create tasks.

Contacts: look at people with 1:1 interactions over the past week (direct emails, direct replies, 1:1 chats). Only create/update contacts for these people. Skip broadcast CCs and people who appear only once.

Projects: look at GitHub repos with recent commit/PR/issue activity. Make sure a matching project exists (must have a repo URL).

Retire: contacts with no interaction for 3 months → inactive. Projects with no activity → archived.`

const BUILTIN_JOBS: { id: string; name: string; cron: string; instruction: string; deliveryTargets: string[] }[] = [
  { id: 'morning-briefing', name: 'Daily morning briefing', cron: '0 9 * * 1-5', deliveryTargets: ['desktop', 'wechat'], instruction: 'Check for new email, Teams messages, and GitHub notifications since the last run, plus today\'s calendar events. Create a Task for items that need the user to act (fill sourceType by the real source: github/teams/email/calendar, and attach sourceId and sourceUrl), and give a prioritized summary of suggestions for today.' },
  { id: 'periodic-poll', name: 'Periodic poll', cron: '*/30 * * * *', deliveryTargets: [], instruction: DEFAULT_PERIODIC_POLL_INSTRUCTION },
  { id: 'daily-reconcile', name: 'End-of-day review', cron: '0 18 * * 1-5', deliveryTargets: ['desktop', 'wechat'], instruction: 'Review today\'s task statuses. Mark tasks that are confirmed done but unmarked as completed. Suggest cleaning up P2 tasks untouched for over 7 days. Generate a short daily summary.' },
  { id: 'world-sync', name: 'Relationships & projects sync', cron: '0 10 * * 1', deliveryTargets: [], instruction: DEFAULT_WORLD_SYNC_INSTRUCTION },
]

/** The set of built-in job IDs, used by the jobs layer to enforce ownership. */
export const BUILTIN_JOB_IDS: ReadonlySet<string> = new Set(BUILTIN_JOBS.map(j => j.id))

/**
 * Reconcile the built-in jobs on every launch — the single source of truth for
 * app-managed schedules.
 *
 * - Definition (name/cron/instruction) is owned by the app: synced so updates
 *   ship improved schedules/prompts.
 * - Runtime state (enabled, delivery_targets, last_run_*) is owned by the user:
 *   preserved across updates.
 * - Retired built-ins (shipped by an older version, now gone) are removed, so a
 *   dropped job never keeps firing forever.
 * - User/agent-created jobs (is_builtin = 0) are never touched.
 */
function syncBuiltinJobs(db: DatabaseInstance): void {
  const upsert = db.prepare(`
    INSERT INTO jobs (id, name, cron, instruction, enabled, delivery_targets, is_builtin)
    VALUES (?, ?, ?, ?, 1, ?, 1)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      cron = excluded.cron,
      instruction = excluded.instruction,
      is_builtin = 1
  `)
  const ids = [...BUILTIN_JOB_IDS]
  const placeholders = ids.map(() => '?').join(', ')

  const reconcile = db.transaction(() => {
    for (const job of BUILTIN_JOBS) {
      upsert.run(job.id, job.name, job.cron, job.instruction, JSON.stringify(job.deliveryTargets))
    }
    // Remove built-ins that no longer ship (ghost jobs from older versions).
    db.prepare(`DELETE FROM jobs WHERE is_builtin = 1 AND id NOT IN (${placeholders})`).run(...ids)
  })
  reconcile()
}

export function closeDb(): void {
  if (db) {
    db.close()
    db = null
  }
}
