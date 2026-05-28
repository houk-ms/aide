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
      priority TEXT NOT NULL DEFAULT 'medium',
      source_type TEXT NOT NULL,
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

function seedDefaultJobs(db: DatabaseInstance): void {
  const insert = db.prepare(`
    INSERT INTO jobs (id, name, cron, instruction, enabled)
    VALUES (?, ?, ?, ?, ?)
  `)

  insert.run(
    'morning-briefing',
    '每日开工简报',
    '0 9 * * 1-5',
    '检查所有新邮件、Teams 消息、GitHub 通知和今天的日历事件。识别需要用户处理的事项，为每个创建 Task。生成今日优先级建议。',
    1
  )

  insert.run(
    'periodic-poll',
    '定时轮询',
    '*/15 * * * *',
    '检查是否有新的未读邮件、Teams 消息或 GitHub 通知。如果有需要用户处理的新事项，创建 Task。',
    1
  )

  insert.run(
    'daily-reconcile',
    '下班前回顾',
    '0 18 * * 1-5',
    '回顾今天的所有信息流。检查是否有遗漏的任务需要补建。检查已完成但未标记的任务。对超过 7 天未互动的低优先级任务提出清理建议。生成今日工作日报。',
    1
  )
}

export function closeDb(): void {
  if (db) {
    db.close()
    db = null
  }
}
