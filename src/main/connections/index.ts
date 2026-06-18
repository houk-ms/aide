import { BrowserWindow, shell, app } from 'electron'
import { spawn, ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { startMcpServer } from '../agent/mcp'
import type { ConnectionStatus } from '@shared/types'

// === Bundled Runtime Resolution ===

/**
 * Get the npx command, preferring the bundled Node.js runtime if available.
 * In packaged builds, we ship a portable Node.js in extraResources/runtimes/node.
 * Falls back to system npx if bundled version not found.
 */
function getNpxCommand(): string {
  if (app.isPackaged) {
    const bundledNpx = process.platform === 'win32'
      ? join(process.resourcesPath, 'runtimes', 'node', 'npx.cmd')
      : join(process.resourcesPath, 'runtimes', 'node', 'bin', 'npx')
    if (existsSync(bundledNpx)) {
      console.log('[Aide] Using bundled npx:', bundledNpx)
      // Quote the path for shell execution if it contains spaces
      return bundledNpx.includes(' ') ? `"${bundledNpx}"` : bundledNpx
    }
  }
  return 'npx'
}

// Cache the resolved npx command
let _npxCommand: string | null = null
function npx(): string {
  if (_npxCommand === null) _npxCommand = getNpxCommand()
  return _npxCommand
}

/**
 * Get the bundled Node.js directory path.
 * Returns null if not in a packaged build or bundled runtime doesn't exist.
 */
export function getBundledNodeDir(): string | null {
  if (app.isPackaged) {
    const nodeDir = join(process.resourcesPath, 'runtimes', 'node')
    const nodeExe = process.platform === 'win32'
      ? join(nodeDir, 'node.exe')
      : join(nodeDir, 'bin', 'node')
    if (existsSync(nodeExe)) {
      // Return the directory containing the node executable
      return process.platform === 'win32' ? nodeDir : join(nodeDir, 'bin')
    }
  }
  return null
}

/**
 * Get environment variables with bundled Node.js directory appended to PATH.
 * This ensures npx.cmd can find node.exe when spawned with shell: true,
 * while preferring any system-installed Node.js over the bundled one.
 */
export function getNodeEnv(extraEnv: Record<string, string> = {}): Record<string, string> {
  const bundledNodeDir = getBundledNodeDir()
  const pathKey = process.platform === 'win32' ? 'Path' : 'PATH'
  const pathSep = process.platform === 'win32' ? ';' : ':'
  const existingPath = process.env[pathKey] || process.env.PATH || ''
  const pathEnv = bundledNodeDir
    ? { [pathKey]: `${existingPath}${pathSep}${bundledNodeDir}` }
    : {}
  return { ...process.env as Record<string, string>, ...pathEnv, ...extraEnv }
}

// Connection state
const connections: Map<string, ConnectionStatus> = new Map([
  ['workiq', { id: 'workiq', type: 'workiq', authenticated: false, verified: false, checking: false, lastError: null, lastPolledAt: null, activeAccount: null }],
  ['github', { id: 'github', type: 'github', authenticated: false, verified: false, checking: false, lastError: null, lastPolledAt: null, activeAccount: null }]
])

export function getConnectionStatus(): ConnectionStatus[] {
  return Array.from(connections.values())
}

/** Broadcast the current connection state to every renderer window. */
function broadcastConnectionStatus(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('aide:event', { type: 'connection:status', connections: getConnectionStatus() })
  }
}

// === Check CLI Availability ===

export async function checkCliAvailability(): Promise<{ gh: boolean; npx: boolean }> {
  const check = (cmd: string, args: string[], env?: Record<string, string>): Promise<boolean> =>
    new Promise(resolve => {
      const proc = spawn(cmd, args, { env: env || process.env as Record<string, string>, shell: true, stdio: 'ignore' })
      proc.on('close', (code) => resolve(code === 0))
      proc.on('error', () => resolve(false))
    })

  const [gh, npxAvailable] = await Promise.all([
    check('gh', ['--version']),
    check(npx(), ['--version'], getNodeEnv())
  ])
  return { gh, npx: npxAvailable }
}

// === Check CLI Auth Status ===

/**
 * Get active gh account name + token.
 * Parses `gh auth status` output to find the active account.
 */
async function getActiveGhAccount(): Promise<{ account: string; token: string } | null> {
  // Get active account name from status output
  const account = await new Promise<string | null>(resolve => {
    const proc = spawn('gh', ['auth', 'status', '--hostname', 'github.com'], {
      shell: true, stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    proc.stdout?.on('data', (d: Buffer) => { output += d.toString() })
    proc.stderr?.on('data', (d: Buffer) => { output += d.toString() })
    proc.on('close', (code) => {
      if (code !== 0) return resolve(null)
      // Parse: "✓ Logged in to github.com account USERNAME (keyring)" + "Active account: true"
      const blocks = output.split(/\n\s*\n|(?=✓)/)
      for (const block of blocks) {
        if (block.includes('Active account: true')) {
          const m = block.match(/account\s+(\S+)/)
          if (m) return resolve(m[1])
        }
      }
      // Fallback: single account (no "Active account" line in older gh versions)
      const m = output.match(/account\s+(\S+)/)
      resolve(m ? m[1] : null)
    })
    proc.on('error', () => resolve(null))
  })
  if (!account) return null

  // Get token for the active account
  const token = await new Promise<string | null>(resolve => {
    const proc = spawn('gh', ['auth', 'token', '--hostname', 'github.com'], {
      shell: true, stdio: ['ignore', 'pipe', 'pipe']
    })
    let out = ''
    proc.stdout?.on('data', (d: Buffer) => { out += d.toString() })
    proc.on('close', (code) => resolve(code === 0 ? out.trim() : null))
    proc.on('error', () => resolve(null))
  })
  if (!token) return null

  return { account, token }
}

// Cached token for MCP server
let cachedGhToken: string | null = null

export function getGhToken(): string | null {
  return cachedGhToken
}

/**
 * List all gh accounts logged in on github.com.
 * Returns array of { account, active }.
 */
export async function listGhAccounts(): Promise<{ account: string; active: boolean }[]> {
  return new Promise(resolve => {
    const proc = spawn('gh', ['auth', 'status', '--hostname', 'github.com'], {
      shell: true, stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    proc.stdout?.on('data', (d: Buffer) => { output += d.toString() })
    proc.stderr?.on('data', (d: Buffer) => { output += d.toString() })
    proc.on('close', () => {
      const accounts: { account: string; active: boolean }[] = []
      // Each account block starts with ✓ and contains "account NAME" + "Active account: true/false"
      const blocks = output.split(/(?=✓)/)
      for (const block of blocks) {
        const nameMatch = block.match(/account\s+(\S+)/)
        if (nameMatch) {
          const active = block.includes('Active account: true')
          accounts.push({ account: nameMatch[1], active })
        }
      }
      resolve(accounts)
    })
    proc.on('error', () => resolve([]))
  })
}

/**
 * Switch active gh account and refresh cached token + MCP server.
 */
export async function switchGhAccount(account: string): Promise<void> {
  // Run gh auth switch
  await new Promise<void>((resolve, reject) => {
    const proc = spawn('gh', ['auth', 'switch', '--user', account, '--hostname', 'github.com'], {
      shell: true, stdio: 'ignore'
    })
    proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`gh auth switch failed (code ${code})`)))
    proc.on('error', (e) => reject(e))
  })

  // Refresh token & connection state
  const ghInfo = await getActiveGhAccount()
  const conn = connections.get('github')
  if (conn) {
    conn.authenticated = !!ghInfo
    conn.verified = !!ghInfo
    conn.checking = false
    conn.activeAccount = ghInfo?.account || null
  }
  cachedGhToken = ghInfo?.token || null

  // Restart MCP server with new token
  const { stopMcpServer, startMcpServer } = await import('../agent/mcp')
  stopMcpServer('github')
  if (cachedGhToken) {
    startMcpServer('github').catch(err => console.error('[Aide] MCP github restart:', err))
  }

  // Notify renderer
  const { BrowserWindow } = await import('electron')
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('aide:event', { type: 'connection:status', connections: getConnectionStatus() })
  }
}

async function acceptWorkiqEula(): Promise<void> {
  return new Promise(resolve => {
    const proc = spawn(npx(), ['-y', '@microsoft/workiq@preview', 'accept-eula'], {
      env: getNodeEnv(),
      shell: true, stdio: 'ignore'
    })
    proc.on('close', () => resolve())
    proc.on('error', () => resolve())
  })
}

// === Authenticate via CLI tools ===

let activeAuthProcess: ChildProcess | null = null

/**
 * Start GitHub authentication via `gh auth login`.
 * gh CLI handles device flow internally, opens browser.
 */
export function authenticateGitHub(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (activeAuthProcess) {
      activeAuthProcess.kill()
      activeAuthProcess = null
    }

    const proc = spawn('gh', [
      'auth', 'login',
      '--hostname', 'github.com',
      '--web',
      '--git-protocol', 'https',
      '--scopes', 'repo,read:org,notifications,workflow'
    ], {
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })

    activeAuthProcess = proc
    let output = ''

    const handleData = (data: Buffer) => {
      const text = data.toString()
      output += text
      console.log('[Aide] gh auth:', text.trim())

      // gh CLI shows: "! First copy your one-time code: XXXX-XXXX"
      const codeMatch = output.match(/one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i)
      if (codeMatch) {
        const userCode = codeMatch[1]
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send('aide:event', {
            type: 'connection:auth-progress',
            connectionType: 'github',
            userCode,
            verificationUri: 'https://github.com/login/device'
          })
        }
      }
    }

    proc.stdout?.on('data', handleData)
    proc.stderr?.on('data', handleData)

    // gh CLI prompts "Press Enter to open github.com in your browser" — auto-press
    setTimeout(() => { proc.stdin?.write('\n') }, 2000)

    proc.on('close', async (code) => {
      activeAuthProcess = null
      if (code === 0) {
        // Fetch active account + token after successful login
        const ghInfo = await getActiveGhAccount()
        const conn = connections.get('github')
        if (conn) {
          conn.authenticated = true
          conn.verified = true
          conn.lastError = null
          conn.activeAccount = ghInfo?.account || null
        }
        if (ghInfo) cachedGhToken = ghInfo.token
        startMcpServer('github').catch(err => console.error('[Aide] MCP github start:', err))
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send('aide:event', { type: 'connection:status', connections: getConnectionStatus() })
        }
        resolve()
      } else {
        const conn = connections.get('github')
        if (conn) { conn.lastError = 'Authentication failed'; conn.authenticated = false; conn.activeAccount = null }
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send('aide:event', { type: 'connection:status', connections: getConnectionStatus() })
        }
        reject(new Error('gh auth login failed'))
      }
    })

    proc.on('error', (err) => {
      activeAuthProcess = null
      reject(new Error(`gh CLI not found: ${err.message}`))
    })

    // Timeout after 5 minutes
    setTimeout(() => {
      if (activeAuthProcess === proc) {
        proc.kill()
        activeAuthProcess = null
        reject(new Error('Authentication timed out'))
      }
    }, 5 * 60 * 1000)
  })
}

/**
 * Start Microsoft authentication via `workiq auth login`.
 * workiq CLI handles OAuth internally.
 */
export function authenticateMicrosoft(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (activeAuthProcess) {
      activeAuthProcess.kill()
      activeAuthProcess = null
    }

    const proc = spawn(npx(), ['-y', '@microsoft/workiq@preview', 'auth', 'login'], {
      env: getNodeEnv(),
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })

    activeAuthProcess = proc
    let output = ''

    const handleData = (data: Buffer) => {
      const text = data.toString()
      output += text
      console.log('[Aide] workiq auth:', text.trim())

      // workiq shows: "To sign in, use a web browser to open the page https://microsoft.com/devicelogin and enter the code XXXXXXXX"
      const codeMatch = text.match(/enter the code\s+([A-Z0-9]+)/i)
      const uriMatch = text.match(/open the page\s+(https?:\/\/\S+)/i)
      if (codeMatch) {
        const userCode = codeMatch[1]
        const verificationUri = uriMatch?.[1] || 'https://microsoft.com/devicelogin'
        shell.openExternal(verificationUri)
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send('aide:event', {
            type: 'connection:auth-progress',
            connectionType: 'workiq',
            userCode,
            verificationUri
          })
        }
      }
    }

    proc.stdout?.on('data', handleData)
    proc.stderr?.on('data', handleData)

    proc.on('close', async (code) => {
      activeAuthProcess = null
      // workiq may exit non-zero even when auth succeeds (observed: outputs "Logged in as X" but exits 1)
      const success = code === 0 || /logged in/i.test(output)
      if (success) {
        const conn = connections.get('workiq')
        if (conn) { conn.authenticated = true; conn.checking = false; conn.lastError = null }
        // Auto-accept EULA (non-interactive, required before first use)
        await acceptWorkiqEula()
        // Start MCP and verify it actually works
        try {
          await startMcpServer('workiq')
          if (conn) { conn.verified = true }
        } catch (err: any) {
          console.error('[Aide] MCP workiq start:', err)
          if (conn) { conn.verified = false; conn.lastError = 'Signed in, but the MCP server failed to start — you may be missing Teams/M365 permissions' }
        }
        broadcastConnectionStatus()
        resolve()
      } else {
        console.error('[Aide] workiq auth failed (code', code, '):', output)
        const conn = connections.get('workiq')
        // Provide more helpful error message based on output
        let errorMsg = 'Authentication failed'
        if (/ENOENT|not found|cannot find/i.test(output)) {
          errorMsg = 'Could not start workiq CLI — Node.js runtime may be missing'
        } else if (/network|ETIMEDOUT|ECONNREFUSED/i.test(output)) {
          errorMsg = 'Authentication failed — network error'
        } else if (output.trim()) {
          // Include first line of output as hint
          const firstLine = output.trim().split('\n')[0].slice(0, 80)
          errorMsg = `Authentication failed: ${firstLine}`
        }
        if (conn) { conn.lastError = errorMsg; conn.authenticated = false; conn.checking = false }
        broadcastConnectionStatus()
        reject(new Error('workiq auth login failed'))
      }
    })

    proc.on('error', (err) => {
      activeAuthProcess = null
      console.error('[Aide] workiq spawn error:', err)
      const conn = connections.get('workiq')
      if (conn) {
        conn.lastError = `Could not start workiq CLI: ${err.message}`
        conn.authenticated = false
        conn.checking = false
      }
      broadcastConnectionStatus()
      reject(new Error(`workiq CLI not available: ${err.message}`))
    })

    // Timeout after 5 minutes
    setTimeout(() => {
      if (activeAuthProcess === proc) {
        proc.kill()
        activeAuthProcess = null
        reject(new Error('Authentication timed out'))
      }
    }, 5 * 60 * 1000)
  })
}

// === Disconnect ===

export async function disconnect(type: 'workiq' | 'github'): Promise<void> {
  const conn = connections.get(type)
  if (!conn) return

  if (type === 'github') {
    // Logout active account, then re-check if another account remains
    await new Promise<void>(resolve => {
      const proc = spawn('gh', ['auth', 'logout', '--hostname', 'github.com', '--yes'], { shell: true, stdio: 'ignore' })
      proc.on('close', () => resolve())
      proc.on('error', () => resolve())
    })
    cachedGhToken = null
    // Check if another account is still active
    const remaining = await getActiveGhAccount()
    if (remaining) {
      conn.authenticated = true
      conn.verified = true
      conn.activeAccount = remaining.account
      cachedGhToken = remaining.token
    } else {
      conn.authenticated = false
      conn.verified = false
      conn.activeAccount = null
    }
    conn.checking = false
    conn.lastError = null
  } else if (type === 'workiq') {
    spawn(npx(), ['-y', '@microsoft/workiq@preview', 'auth', 'logout'], { env: getNodeEnv(), shell: true, stdio: 'ignore' })
    conn.authenticated = false
    conn.verified = false
    conn.checking = false
    conn.activeAccount = null
    conn.lastError = null
  }

  const { stopMcpServer } = await import('../agent/mcp')
  stopMcpServer(type)
}

// === Init (check CLI auth on startup) ===

/**
 * Resolve the cheaply-known auth state on startup.
 *
 * GitHub has a reliable `gh auth status` command, so we settle its state here.
 * WorkIQ has no cheap auth-status check — the only honest way to know whether
 * it works is to start the real MCP server (which we do anyway). So we mark it
 * `checking` and let verifyConnectionsViaMcp() settle it from the real server,
 * the single source of truth. This removes the old fragile timing-based probe.
 */
export async function initConnectionState(): Promise<void> {
  const now = new Date().toISOString()

  const ghInfo = await getActiveGhAccount()
  const ghConn = connections.get('github')
  if (ghConn) {
    ghConn.authenticated = !!ghInfo
    ghConn.verified = !!ghInfo
    ghConn.checking = false
    ghConn.activeAccount = ghInfo?.account || null
    ghConn.lastPolledAt = now
    if (ghInfo) cachedGhToken = ghInfo.token
  }

  const wiqConn = connections.get('workiq')
  if (wiqConn) {
    wiqConn.authenticated = false
    wiqConn.verified = false
    wiqConn.checking = true // settled by verifyConnectionsViaMcp via the real server
    wiqConn.lastError = null
    wiqConn.lastPolledAt = now
  }
}

/**
 * Bring up the real MCP servers and let their success/failure be the single
 * source of truth for connection state. Fire-and-forget from startup.
 *
 * - GitHub: already settled via `gh auth status`; just load its tools if authed.
 * - WorkIQ: always attempt — a successful `tools/list` means connected+verified;
 *   any failure means not connected (no scary error: the user simply signs in).
 *   Broadcasts after each connection settles so the UI flips checking → final.
 */
export async function verifyConnectionsViaMcp(): Promise<void> {
  const ghConn = connections.get('github')
  if (ghConn?.authenticated) {
    startMcpServer('github').catch(err => console.warn('[Aide] MCP github start:', err))
  }

  const wiqConn = connections.get('workiq')
  if (wiqConn) {
    try {
      await startMcpServer('workiq')
      wiqConn.authenticated = true
      wiqConn.verified = true
      wiqConn.lastError = null
    } catch (err) {
      // Not signed in, token expired, or missing permissions — all surface the
      // same way: not connected, with a Connect button. No misleading error.
      console.log('[Aide] workiq not connected at startup:', err instanceof Error ? err.message : String(err))
      wiqConn.authenticated = false
      wiqConn.verified = false
    } finally {
      wiqConn.checking = false
      wiqConn.lastPolledAt = new Date().toISOString()
      broadcastConnectionStatus()
    }
  }
}

// === MCP Config (CLIs use their own cached auth, no env vars needed) ===

export function getMcpEnv(type: 'workiq' | 'github'): Record<string, string> | null {
  if (type === 'github') {
    if (cachedGhToken) return { GITHUB_PERSONAL_ACCESS_TOKEN: cachedGhToken }
    return {} // Will fall back to unauthenticated (rate-limited)
  }
  if (type === 'workiq') return {}
  return null
}

export function getMcpConfig() {
  return {
    workiq: { command: npx(), args: ['-y', '@microsoft/workiq@preview', 'mcp'] },
    github: { command: npx(), args: ['-y', '@modelcontextprotocol/server-github'] }
  }
}

// === Diagnostics ===

export interface ConnectionDiagnostics {
  platform: string
  arch: string
  electronVersion: string
  appVersion: string
  isPackaged: boolean
  resourcesPath: string
  npxCommand: string
  bundledNpxExists: boolean
  bundledNpxPath: string
  userDataPath: string
  connections: ConnectionStatus[]
}

export function getDiagnostics(): ConnectionDiagnostics {
  const bundledNpx = process.platform === 'win32'
    ? join(process.resourcesPath, 'runtimes', 'node', 'npx.cmd')
    : join(process.resourcesPath, 'runtimes', 'node', 'bin', 'npx')

  return {
    platform: process.platform,
    arch: process.arch,
    electronVersion: process.versions.electron,
    appVersion: app.getVersion(),
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    npxCommand: npx(),
    bundledNpxExists: existsSync(bundledNpx),
    bundledNpxPath: bundledNpx,
    userDataPath: app.getPath('userData'),
    connections: getConnectionStatus()
  }
}
