import { app, BrowserWindow, Menu, Notification } from 'electron'
import { join } from 'path'
import { registerIpcHandlers } from './ipc'
import { getDb, closeDb } from './db'
import { startAllJobs, stopAllJobs } from './jobs'
import { initAgent, generateMorningBriefing } from './agent'
import { createClient } from './agent/client'
import { initMcpServers, stopAllMcpServers } from './agent/mcp'
import { initConnectionState } from './connections'
import { setSdkHealth } from './health'

let mainWindow: BrowserWindow | null = null

// Window state persistence
function getWindowState(): { width: number; height: number; x?: number; y?: number } {
  try {
    const db = getDb()
    const row = db.prepare("SELECT content FROM memory_entries WHERE id = '__window_state'").get() as { content: string } | undefined
    if (row) return JSON.parse(row.content)
  } catch { /* ignore */ }
  return { width: 1200, height: 800 }
}

function saveWindowState(win: BrowserWindow): void {
  try {
    const bounds = win.getBounds()
    const db = getDb()
    const state = JSON.stringify(bounds)
    db.prepare(`INSERT OR REPLACE INTO memory_entries (id, layer, content, source, status, created_at, updated_at, tags) VALUES ('__window_state', 'L0', ?, 'system', 'active', datetime('now'), datetime('now'), '[]')`).run(state)
  } catch { /* ignore */ }
}

function createWindow(): void {
  const state = getWindowState()

  // Hide menu bar on Windows/Linux
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null)
  }

  mainWindow = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: 900,
    minHeight: 600,
    frame: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    titleBarOverlay: process.platform === 'win32' ? { color: '#fafafa', symbolColor: '#1a1a1a', height: 52 } : undefined,
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 16, y: 16 } } : {}),
    backgroundColor: '#fafafa',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false
    }
  })

  // Load renderer
  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // Save window state on close
  mainWindow.on('close', () => {
    if (mainWindow) saveWindowState(mainWindow)
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

app.whenReady().then(async () => {
  // Initialize database
  getDb()

  // Restore connection auth state from CLI tools
  await initConnectionState()

  // Initialize Copilot SDK
  try {
    const client = await createClient()
    initAgent(client)
    setSdkHealth('ready')
  } catch (err) {
    console.error('[Aide] Failed to initialize SDK:', err)
    setSdkHealth('error', err instanceof Error ? err.message : String(err))
  }

  // Start MCP servers for authenticated connections
  initMcpServers().catch(err => console.warn('[Aide] MCP init:', err))

  // Register IPC handlers
  registerIpcHandlers()

  // Start job scheduler
  startAllJobs()

  // Create window
  createWindow()

  // Trigger morning briefing after window is ready (non-blocking)
  mainWindow?.once('ready-to-show', () => {
    triggerMorningBriefingIfNeeded()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  stopAllJobs()
  stopAllMcpServers()
  closeDb()
})

// System notification helper (for high-priority tasks)
export function showSystemNotification(title: string, body: string): void {
  if (Notification.isSupported()) {
    new Notification({ title, body }).show()
  }
}

// Morning briefing — triggers once per day on first app open
function triggerMorningBriefingIfNeeded(): void {
  try {
    const db = getDb()
    const today = new Date().toISOString().split('T')[0]
    const row = db.prepare(
      "SELECT content FROM memory_entries WHERE id = '__last_briefing_date'"
    ).get() as { content: string } | undefined

    if (row?.content === today) return // Already did today's briefing

    // Mark as done for today (do this before async work to avoid re-triggers)
    db.prepare(`
      INSERT OR REPLACE INTO memory_entries (id, layer, content, source, status, created_at, updated_at, tags)
      VALUES ('__last_briefing_date', 'L0', ?, 'system', 'active', datetime('now'), datetime('now'), '[]')
    `).run(today)

    // Run briefing asynchronously
    generateMorningBriefing().then(result => {
      if (result && mainWindow) {
        // Save briefing as a General chat message so user can see it
        const db = getDb()
        const msgId = `briefing-${today}-${Date.now()}`
        db.prepare(`
          INSERT INTO chat_messages (id, role, content, timestamp, task_id, pending_action)
          VALUES (?, 'agent', ?, datetime('now'), NULL, NULL)
        `).run(msgId, result)

        mainWindow.webContents.send('aide:event', {
          type: 'chat:message',
          message: { id: msgId, role: 'agent', content: result, timestamp: new Date().toISOString(), taskId: null }
        })
      }
    }).catch(err => {
      console.error('[Aide] Morning briefing failed:', err)
    })
  } catch (err) {
    console.error('[Aide] Morning briefing check failed:', err)
  }
}
