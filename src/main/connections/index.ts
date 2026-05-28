import { BrowserWindow, shell } from 'electron'
import { spawn, ChildProcess } from 'child_process'
import { startMcpServer } from '../agent/mcp'
import type { ConnectionStatus } from '@shared/types'

// Connection state
const connections: Map<string, ConnectionStatus> = new Map([
  ['workiq', { id: 'workiq', type: 'workiq', authenticated: false, verified: false, lastError: null }],
  ['github', { id: 'github', type: 'github', authenticated: false, verified: false, lastError: null }]
])

export function getConnectionStatus(): ConnectionStatus[] {
  return Array.from(connections.values())
}

// === Check CLI Auth Status ===

async function checkGitHubAuth(): Promise<boolean> {
  return new Promise(resolve => {
    const proc = spawn('gh', ['auth', 'status', '--hostname', 'github.com'], {
      shell: true, stdio: ['ignore', 'pipe', 'pipe']
    })
    proc.on('close', (code) => resolve(code === 0))
    proc.on('error', () => resolve(false))
  })
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
        const conn = connections.get('github')
        if (conn) { conn.authenticated = true; conn.verified = true; conn.lastError = null }
        startMcpServer('github').catch(err => console.error('[Aide] MCP github start:', err))
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send('aide:event', { type: 'connection:status', connections: getConnectionStatus() })
        }
        resolve()
      } else {
        const conn = connections.get('github')
        if (conn) { conn.lastError = '认证失败'; conn.authenticated = false }
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
  conn.authenticated = false
  conn.verified = false
  conn.lastError = null

  if (type === 'github') {
    spawn('gh', ['auth', 'logout', '--hostname', 'github.com', '--yes'], { shell: true, stdio: 'ignore' })
  } else if (type === 'workiq') {
    spawn('npx', ['-y', '@microsoft/workiq@preview', 'auth', 'logout'], { shell: true, stdio: 'ignore' })
  }

  const { stopMcpServer } = await import('../agent/mcp')
  stopMcpServer(type)
}

// === Init (check CLI auth on startup) ===

export async function initConnectionState(): Promise<void> {
  const ghAuth = await checkGitHubAuth()
  const ghConn = connections.get('github')
  if (ghConn) {
    ghConn.authenticated = ghAuth
    ghConn.verified = ghAuth // gh auth status already validates the token
  }

  const wiqAuth = await checkWorkiqAuth()
  const wiqConn = connections.get('workiq')
  if (wiqConn) {
    wiqConn.authenticated = wiqAuth
    wiqConn.verified = wiqAuth // checkWorkiqAuth now does a real tools/list call
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
  if (type === 'github') return {}
  if (type === 'workiq') return {}
  return null
}

export const MCP_CONFIG = {
  workiq: { command: 'npx', args: ['-y', '@microsoft/workiq@preview', 'mcp'] },
  github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] }
}
