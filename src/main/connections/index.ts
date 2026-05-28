import { BrowserWindow, shell } from 'electron'
import { spawn, ChildProcess } from 'child_process'
import { startMcpServer } from '../agent/mcp'
import type { ConnectionStatus } from '@shared/types'

// Connection state
const connections: Map<string, ConnectionStatus> = new Map([
  ['workiq', { id: 'workiq', type: 'workiq', authenticated: false, verified: false, lastError: null, lastPolledAt: null, activeAccount: null }],
  ['github', { id: 'github', type: 'github', authenticated: false, verified: false, lastError: null, lastPolledAt: null, activeAccount: null }]
])

export function getConnectionStatus(): ConnectionStatus[] {
  return Array.from(connections.values())
}

// === Check CLI Availability ===

export async function checkCliAvailability(): Promise<{ gh: boolean; npx: boolean }> {
  const check = (cmd: string, args: string[]): Promise<boolean> =>
    new Promise(resolve => {
      const proc = spawn(cmd, args, { shell: true, stdio: 'ignore' })
      proc.on('close', (code) => resolve(code === 0))
      proc.on('error', () => resolve(false))
    })

  const [gh, npx] = await Promise.all([
    check('gh', ['--version']),
    check('npx', ['--version'])
  ])
  return { gh, npx }
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
    const proc = spawn('npx', ['-y', '@microsoft/workiq@preview', 'accept-eula'], {
      shell: true, stdio: 'ignore'
    })
    proc.on('close', () => resolve())
    proc.on('error', () => resolve())
  })
}

async function checkWorkiqAuth(): Promise<boolean> {
  // workiq has no "auth status" command. Try starting mcp and sending a real tools/list request.
  return new Promise(resolve => {
    const proc = spawn('npx', ['-y', '@microsoft/workiq@preview', 'mcp'], {
      shell: true, stdio: ['pipe', 'pipe', 'pipe']
    })
    let resolved = false
    let buffer = ''

    const finish = (result: boolean) => {
      if (!resolved) { resolved = true; proc.kill(); resolve(result) }
    }

    // Send initialize + tools/list to verify the server actually works
    const timer = setTimeout(() => {
      // If alive after 3s, send initialize handshake
      const initMsg = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'aide-check', version: '1.0.0' } } })
      proc.stdin?.write(initMsg + '\n')
      // Then ask for tools list as a real verification
      setTimeout(() => {
        const listMsg = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
        proc.stdin?.write(listMsg + '\n')
      }, 1000)
    }, 3000)

    // Give total 10s for the whole check
    const hardTimeout = setTimeout(() => finish(false), 10000)

    proc.stdout?.on('data', (data: Buffer) => {
      buffer += data.toString()
      // Look for a successful tools/list response (id: 2)
      if (buffer.includes('"id":2') || buffer.includes('"id": 2')) {
        try {
          const lines = buffer.split('\n')
          for (const line of lines) {
            if (!line.trim()) continue
            const msg = JSON.parse(line)
            if (msg.id === 2 && msg.result?.tools) {
              clearTimeout(timer)
              clearTimeout(hardTimeout)
              finish(true)
              return
            }
            if (msg.id === 2 && msg.error) {
              clearTimeout(timer)
              clearTimeout(hardTimeout)
              finish(false)
              return
            }
          }
        } catch { /* keep buffering */ }
      }
    })

    proc.on('close', () => {
      clearTimeout(timer)
      clearTimeout(hardTimeout)
      finish(false)
    })
    proc.on('error', () => {
      clearTimeout(timer)
      clearTimeout(hardTimeout)
      finish(false)
    })
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
        if (conn) { conn.lastError = '认证失败'; conn.authenticated = false; conn.activeAccount = null }
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
        reject(new Error('认证超时'))
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

    const proc = spawn('npx', ['-y', '@microsoft/workiq@preview', 'auth', 'login'], {
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
        if (conn) { conn.authenticated = true; conn.lastError = null }
        // Auto-accept EULA (non-interactive, required before first use)
        await acceptWorkiqEula()
        // Start MCP and verify it actually works
        try {
          await startMcpServer('workiq')
          if (conn) { conn.verified = true }
        } catch (err: any) {
          console.error('[Aide] MCP workiq start:', err)
          if (conn) { conn.verified = false; conn.lastError = '已登录但 MCP Server 启动失败，可能缺少 Teams/M365 权限' }
        }
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send('aide:event', { type: 'connection:status', connections: getConnectionStatus() })
        }
        resolve()
      } else {
        const conn = connections.get('workiq')
        if (conn) { conn.lastError = '认证失败'; conn.authenticated = false }
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send('aide:event', { type: 'connection:status', connections: getConnectionStatus() })
        }
        reject(new Error('workiq auth login failed'))
      }
    })

    proc.on('error', (err) => {
      activeAuthProcess = null
      reject(new Error(`workiq CLI not available: ${err.message}`))
    })

    // Timeout after 5 minutes
    setTimeout(() => {
      if (activeAuthProcess === proc) {
        proc.kill()
        activeAuthProcess = null
        reject(new Error('认证超时'))
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
    conn.lastError = null
  } else if (type === 'workiq') {
    spawn('npx', ['-y', '@microsoft/workiq@preview', 'auth', 'logout'], { shell: true, stdio: 'ignore' })
    conn.authenticated = false
    conn.verified = false
    conn.activeAccount = null
    conn.lastError = null
  }

  const { stopMcpServer } = await import('../agent/mcp')
  stopMcpServer(type)
}

// === Init (check CLI auth on startup) ===

export async function initConnectionState(): Promise<void> {
  const now = new Date().toISOString()

  const ghInfo = await getActiveGhAccount()
  const ghConn = connections.get('github')
  if (ghConn) {
    ghConn.authenticated = !!ghInfo
    ghConn.verified = !!ghInfo
    ghConn.activeAccount = ghInfo?.account || null
    ghConn.lastPolledAt = now
    if (ghInfo) cachedGhToken = ghInfo.token
  }

  const wiqAuth = await checkWorkiqAuth()
  const wiqConn = connections.get('workiq')
  if (wiqConn) {
    wiqConn.authenticated = wiqAuth
    wiqConn.verified = wiqAuth // checkWorkiqAuth now does a real tools/list call
    wiqConn.lastPolledAt = now
    if (wiqAuth) {
      // Ensure EULA is accepted for returning users
      await acceptWorkiqEula()
    } else {
      wiqConn.lastError = 'Work IQ 认证无效或权限不足，请重新登录'
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

export const MCP_CONFIG = {
  workiq: { command: 'npx', args: ['-y', '@microsoft/workiq@preview', 'mcp'] },
  github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] }
}
