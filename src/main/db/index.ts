import { createRequire } from 'module'
import type DatabaseConstructor from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync } from 'fs'

const require = createRequire(import.meta.url)

let Database: typeof DatabaseConstructor
try {
  Database = require('better-sqlite3')
} catch (err: any) {
  const msg = `无法加载数据库模块 (better-sqlite3)。请重新安装应用。\n${err?.message || err}`
  if (typeof process !== 'undefined' && process.versions?.electron) {
    const { dialog } = require('electron') as typeof import('electron')
    dialog.showErrorBox('Aide 启动失败', msg)
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
    db = new Database(dbPath)
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    initSchema(db)
    runMigrations(db)
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
      project_id TEXT,
      related_relation_ids TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      due_date TEXT,
      completed_at TEXT,
      seen_at TEXT,
      snoozed_until TEXT,
      session_id TEXT,
      result TEXT,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
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
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);
    CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
    CREATE INDEX IF NOT EXISTS idx_memory_layer ON memory_entries(layer);
    CREATE INDEX IF NOT EXISTS idx_memory_status ON memory_entries(status);
    CREATE INDEX IF NOT EXISTS idx_memory_project ON memory_entries(project_id);
    CREATE INDEX IF NOT EXISTS idx_chat_task ON chat_messages(task_id);
    CREATE INDEX IF NOT EXISTS idx_chat_timestamp ON chat_messages(timestamp);
  `)

  // Seed default jobs if empty
  const jobCount = db.prepare('SELECT COUNT(*) as count FROM jobs').get() as { count: number }
  if (jobCount.count === 0) {
    seedDefaultJobs(db)
  }
}

function runMigrations(db: DatabaseInstance): void {
  // Add source column to projects/relations for existing DBs
  const projCols = db.prepare("PRAGMA table_info(projects)").all() as { name: string }[]
  if (!projCols.some(c => c.name === 'source')) {
    db.exec("ALTER TABLE projects ADD COLUMN source TEXT NOT NULL DEFAULT 'user'")
  }
  const relCols = db.prepare("PRAGMA table_info(relations)").all() as { name: string }[]
  if (!relCols.some(c => c.name === 'source')) {
    db.exec("ALTER TABLE relations ADD COLUMN source TEXT NOT NULL DEFAULT 'user'")
  }
  // Add source_connection_id to tasks
  const taskCols = db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]
  if (!taskCols.some(c => c.name === 'source_connection_id')) {
    db.exec("ALTER TABLE tasks ADD COLUMN source_connection_id TEXT")
  }
  // Add last_polled_at to connections tracking
  db.exec(`
    CREATE TABLE IF NOT EXISTS connection_state (
      connection_id TEXT PRIMARY KEY,
      last_polled_at TEXT,
      poll_cursor TEXT
    )
  `)
  // Migrate priority values: high→p0, medium→p1, low→p2
  db.exec(`
    UPDATE tasks SET priority = 'p0' WHERE priority = 'high';
    UPDATE tasks SET priority = 'p1' WHERE priority = 'medium';
    UPDATE tasks SET priority = 'p2' WHERE priority = 'low';
  `)
}

const DEFAULT_PERIODIC_POLL_INSTRUCTION = `检查时间窗口内（见上方时间标记）的新邮件、Teams 消息和 GitHub 通知。用 ask_work_iq 时在 prompt 中指定时间范围。

对需要我处理的事项创建 Task（附 sourceId）。同时检查已有任务是否已被自行解决（邮件已回、PR 已 merge 等），是则标记 completed。`

const DEFAULT_WORLD_SYNC_INSTRUCTION = `维护联系人和项目列表。不创建任务。

联系人：查过去一周 1:1 互动的人（单独邮件、单独回复、1:1 聊天）。只为这些人建/更联系人。跳过群发CC、只出现一次的人。

项目：查近期有 commit/PR/issue 活动的 GitHub 仓库。确保对应 project 存在（必须有 repo URL）。

淘汰：3个月无互动的联系人 → inactive。无活动的项目 → archived。`

function seedDefaultJobs(db: DatabaseInstance): void {
  const insert = db.prepare(`
    INSERT INTO jobs (id, name, cron, instruction, enabled)
    VALUES (?, ?, ?, ?, ?)
  `)

  insert.run(
    'morning-briefing',
    '每日开工简报',
    '0 9 * * 1-5',
    '检查今天的日历事件、新邮件、Teams 消息和 GitHub 通知。为需要我处理的事项创建 Task（附 sourceId），按优先级排序给出今日建议。',
    1
  )

  insert.run(
    'periodic-poll',
    '定时轮询',
    '0 * * * *',
    DEFAULT_PERIODIC_POLL_INSTRUCTION,
    1
  )

  insert.run(
    'daily-reconcile',
    '下班前回顾',
    '0 18 * * 1-5',
    '回顾今天的任务状态。将已确认完成但未标记的任务标为 completed。对超过 7 天未动的 P2 任务建议清理。生成简短日报总结。',
    1
  )

  insert.run(
    'world-sync',
    '人脉与项目同步',
    '0 10 * * 1',
    DEFAULT_WORLD_SYNC_INSTRUCTION,
    1
  )
}

export function closeDb(): void {
  if (db) {
    db.close()
    db = null
  }
}
