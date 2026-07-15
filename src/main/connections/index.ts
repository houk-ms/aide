import { BrowserWindow, shell, app } from 'electron'
import { spawn, ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { startMcpServer } from '../agent/mcp'
import { saveSecure, loadSecure, deleteSecure } from '../secure-store'
import type { ConnectionStatus, FoundryConfig } from '@shared/types'

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
  ['github', { id: 'github', type: 'github', authenticated: false, verified: false, checking: false, lastError: null, lastPolledAt: null, activeAccount: null }],
  ['foundry', { id: 'foundry', type: 'foundry', authenticated: false, verified: false, checking: false, lastError: null, lastPolledAt: null, activeAccount: null }]
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

export async function disconnect(type: 'workiq' | 'github' | 'foundry'): Promise<void> {
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
  } else if (type === 'foundry') {
    deleteFoundryCredentials()
    conn.authenticated = false
    conn.verified = false
    conn.checking = false
    conn.activeAccount = null
    conn.lastError = null
  }

  if (type !== 'foundry') {
    const { stopMcpServer } = await import('../agent/mcp')
    stopMcpServer(type)
  }
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

  // Foundry: restore from saved credentials
  const foundryConn = connections.get('foundry')
  if (foundryConn) {
    const fConfig = getFoundryConfig()
    const fKey = getFoundryApiKey()
    if (fConfig && fKey) {
      foundryConn.authenticated = true
      foundryConn.verified = true
      foundryConn.activeAccount = fConfig.displayName
    }
    foundryConn.lastPolledAt = now
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

// === Foundry (BYOK model provider via Azure SDK) ===

import { InteractiveBrowserCredential, type TokenCredential, type AccessToken } from '@azure/identity'
import { SubscriptionClient } from '@azure/arm-subscriptions'
import { CognitiveServicesManagementClient } from '@azure/arm-cognitiveservices'
import type { FoundryResource, FoundryDeployment } from '@shared/types'

const FOUNDRY_CONFIG_FILE = 'foundry-config.json'
const FOUNDRY_KEY_FILE = 'foundry-key.enc'

function foundryPath(file: string): string {
  return join(app.getPath('userData'), file)
}

/**
 * Token credential wrapper that caches the token and deduplicates concurrent
 * getToken() calls.  Prevents the underlying InteractiveBrowserCredential from
 * opening the browser more than once and ensures parallel SDK clients all share
 * a single valid token.
 */
class CachedCredential implements TokenCredential {
  private cached: AccessToken | null = null
  private inflight: Promise<AccessToken> | null = null

  constructor(private source: TokenCredential, initialToken?: AccessToken | null) {
    if (initialToken) this.cached = initialToken
  }

  async getToken(scopes: string | string[], options?: any): Promise<AccessToken> {
    // Return cached token if still valid (5-min buffer)
    if (this.cached && this.cached.expiresOnTimestamp > Date.now() + 5 * 60 * 1000) {
      return this.cached
    }
    // Deduplicate: if a refresh is already in flight, piggy-back on it
    if (!this.inflight) {
      this.inflight = this.source.getToken(scopes, options)
        .then(token => { this.cached = token; this.inflight = null; return token! })
        .catch(err => { this.inflight = null; throw err })
    }
    return this.inflight
  }
}

// Cached Azure credential (survives for the session after login)
let azureCredential: TokenCredential | null = null

/** Load saved Foundry config (endpoint, deployment, model info). */
export function getFoundryConfig(): FoundryConfig | null {
  return loadSecure<FoundryConfig>(foundryPath(FOUNDRY_CONFIG_FILE))
}

/** Load saved Foundry API key. */
export function getFoundryApiKey(): string | null {
  const data = loadSecure<{ apiKey: string }>(foundryPath(FOUNDRY_KEY_FILE))
  return data?.apiKey ?? null
}

/** Delete all Foundry credentials. */
function deleteFoundryCredentials(): void {
  deleteSecure(foundryPath(FOUNDRY_CONFIG_FILE))
  deleteSecure(foundryPath(FOUNDRY_KEY_FILE))
  azureCredential = null
}

/**
 * Step 1: Azure login via browser popup (no CLI required).
 * Uses @azure/identity InteractiveBrowserCredential which opens the system browser.
 */
export async function foundryLogin(): Promise<void> {
  const conn = connections.get('foundry')!
  conn.checking = true
  conn.lastError = null
  broadcastConnectionStatus()

  try {
    const credential = new InteractiveBrowserCredential({
      redirectUri: 'http://localhost:48901'
    })
    // Force a token fetch to validate the login — this is the only interactive prompt
    const initialToken = await credential.getToken('https://management.azure.com/.default')
    // Wrap in CachedCredential with pre-seeded token so SDK clients never re-prompt
    azureCredential = new CachedCredential(credential, initialToken)

    conn.authenticated = true
    conn.checking = false
    conn.lastError = null
  } catch (err: any) {
    conn.authenticated = false
    conn.checking = false
    conn.lastError = err?.message || 'Azure sign-in failed'
    throw err
  } finally {
    broadcastConnectionStatus()
  }
}

/**
 * Step 2: Discover Azure AI / OpenAI resources across all subscriptions.
 * Requires foundryLogin() to have been called first.
 */
export async function foundryListResources(): Promise<FoundryResource[]> {
  if (!azureCredential) throw new Error('Not signed in to Azure. Please sign in first.')

  const subClient = new SubscriptionClient(azureCredential)

  // List all subscriptions
  const subs: { subscriptionId: string; displayName: string }[] = []
  for await (const sub of subClient.subscriptions.list()) {
    if (sub.subscriptionId && sub.displayName) {
      subs.push({ subscriptionId: sub.subscriptionId, displayName: sub.displayName })
    }
  }

  const total = subs.length
  let scanned = 0

  /** Broadcast progress to all renderer windows. */
  const emitProgress = () => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('aide:event', {
        type: 'foundry:discovery-progress',
        scanned,
        total
      })
    }
  }

  emitProgress() // 0/N

  // Query all subscriptions in parallel (the main speedup)
  const results = await Promise.allSettled(
    subs.map(async (sub) => {
      const csClient = new CognitiveServicesManagementClient(azureCredential!, sub.subscriptionId)
      const found: FoundryResource[] = []
      for await (const account of csClient.accounts.list()) {
        const kind = account.kind || ''
        if (kind === 'OpenAI' || kind === 'AIServices' || kind === 'CognitiveServices') {
          found.push({
            subscriptionId: sub.subscriptionId,
            subscriptionName: sub.displayName,
            resourceGroup: extractResourceGroup(account.id || ''),
            accountName: account.name || '',
            endpoint: account.properties?.endpoint || '',
            kind,
            location: account.location || ''
          })
        }
      }
      scanned++
      emitProgress()
      return found
    })
  )

  const resources: FoundryResource[] = []
  for (const r of results) {
    if (r.status === 'fulfilled') resources.push(...r.value)
    // rejected = no access to that subscription, skip silently
  }
  return resources
}

/** Extract resource group from an Azure resource ID. */
function extractResourceGroup(resourceId: string): string {
  const match = resourceId.match(/\/resourceGroups\/([^/]+)/i)
  return match?.[1] || ''
}

/**
 * Step 3: List model deployments within a specific Azure AI resource.
 */
export async function foundryListDeployments(
  subscriptionId: string,
  resourceGroup: string,
  accountName: string
): Promise<FoundryDeployment[]> {
  if (!azureCredential) throw new Error('Not signed in to Azure. Please sign in first.')

  const csClient = new CognitiveServicesManagementClient(azureCredential, subscriptionId)
  const deployments: FoundryDeployment[] = []

  for await (const dep of csClient.deployments.list(resourceGroup, accountName)) {
    deployments.push({
      name: dep.name || '',
      model: dep.properties?.model?.name || '',
      modelVersion: dep.properties?.model?.version || '',
      skuName: dep.sku?.name || ''
    })
  }

  return deployments
}

// --- Resource / Deployment creation helpers ---

import { ResourceManagementClient } from '@azure/arm-resources'
import type { FoundryAvailableModel, AzureSubscription, AzureLocation } from '@shared/types'

/**
 * List all Azure subscriptions the signed-in user can access.
 */
export async function foundryListSubscriptions(): Promise<AzureSubscription[]> {
  if (!azureCredential) throw new Error('Not signed in to Azure. Please sign in first.')
  const subClient = new SubscriptionClient(azureCredential)
  const result: AzureSubscription[] = []
  for await (const sub of subClient.subscriptions.list()) {
    if (sub.subscriptionId && sub.displayName) {
      result.push({ id: sub.subscriptionId, name: sub.displayName })
    }
  }
  return result
}

/**
 * List available Azure locations for a subscription.
 */
// Regions known to support Azure AI Services / OpenAI model deployments
const AI_REGIONS = new Set([
  'australiaeast', 'brazilsouth', 'canadaeast', 'eastus', 'eastus2',
  'francecentral', 'germanywestcentral', 'japaneast', 'koreacentral',
  'northcentralus', 'norwayeast', 'polandcentral', 'southafricanorth',
  'southcentralus', 'southindia', 'swedencentral', 'switzerlandnorth',
  'uksouth', 'westeurope', 'westus', 'westus2', 'westus3'
])

/** Check which locations from a list have available AI Services quota. */
async function filterLocationsByQuota(
  csClient: CognitiveServicesManagementClient,
  locations: AzureLocation[]
): Promise<AzureLocation[]> {
  const results = await Promise.allSettled(locations.map(async (loc) => {
    try {
      for await (const usage of csClient.usages.list(loc.name)) {
        const name = usage.name?.value || ''
        if (name.includes('accounts') || name.includes('Accounts')) {
          if (usage.limit !== undefined && usage.currentValue !== undefined && usage.currentValue >= usage.limit) {
            return null // Quota exhausted in this region
          }
        }
      }
      return loc
    } catch {
      return null // Region doesn't support AI Services — exclude it
    }
  }))

  return results
    .map(r => r.status === 'fulfilled' ? r.value : null)
    .filter((loc): loc is AzureLocation => loc !== null)
}

export async function foundryListLocations(subscriptionId: string): Promise<AzureLocation[]> {
  if (!azureCredential) throw new Error('Not signed in to Azure. Please sign in first.')
  const subClient = new SubscriptionClient(azureCredential)
  const csClient = new CognitiveServicesManagementClient(azureCredential, subscriptionId)

  const aiLocations: AzureLocation[] = []
  const otherLocations: AzureLocation[] = []
  for await (const loc of subClient.subscriptions.listLocations(subscriptionId)) {
    if (loc.name && loc.displayName) {
      if (AI_REGIONS.has(loc.name)) {
        aiLocations.push({ name: loc.name, displayName: loc.displayName })
      } else {
        otherLocations.push({ name: loc.name, displayName: loc.displayName })
      }
    }
  }

  // First pass: check common AI regions
  let available = await filterLocationsByQuota(csClient, aiLocations)

  // Second pass: if no common regions have quota, cast a wider net
  if (available.length === 0 && otherLocations.length > 0) {
    available = await filterLocationsByQuota(csClient, otherLocations)
  }

  if (available.length === 0) {
    throw new Error('No Azure regions with available AI Services quota found for this subscription. Request a quota increase in the Azure portal or try a different subscription.')
  }

  return available.sort((a, b) => a.displayName.localeCompare(b.displayName))
}

/**
 * List AI models available for deployment in a given region.
 */
export async function foundryListAvailableModels(
  subscriptionId: string,
  resourceGroup: string,
  accountName: string
): Promise<FoundryAvailableModel[]> {
  if (!azureCredential) throw new Error('Not signed in to Azure. Please sign in first.')
  const csClient = new CognitiveServicesManagementClient(azureCredential, subscriptionId)
  const result: FoundryAvailableModel[] = []

  // Use account-scoped listModels — returns only models/SKUs valid for this specific account
  for await (const model of csClient.accounts.listModels(resourceGroup, accountName)) {
    const name = model.name || ''
    const version = model.version || ''
    const format = model.format || ''
    const skus = (model.skus || [])
      .filter(s => s.name && (s.capacity?.default ?? 0) > 0)
      .map(s => s.name!)
    if (format === 'OpenAI' && name && version && skus.length > 0) {
      result.push({ name, version, format, skus })
    }
  }

  result.sort((a, b) => a.name.localeCompare(b.name))
  return result
}

/**
 * Create a new Azure AI Services resource in the given subscription/location.
 * Also creates the resource group if it doesn't exist.
 */
export async function foundryCreateResource(
  subscriptionId: string,
  location: string,
  resourceGroup: string,
  accountName: string
): Promise<FoundryResource> {
  if (!azureCredential) throw new Error('Not signed in to Azure. Please sign in first.')

  const csClient = new CognitiveServicesManagementClient(azureCredential, subscriptionId)

  // Double-check quota (regions are pre-filtered, but guard against race conditions)
  for await (const usage of csClient.usages.list(location)) {
    const name = usage.name?.value || ''
    if ((name === 'CognitiveServices.accounts' || name === 'AIServices.accounts') &&
        usage.limit !== undefined && usage.currentValue !== undefined &&
        usage.currentValue >= usage.limit) {
      throw new Error(`Quota exceeded in ${location}: ${usage.name?.localizedValue || name} (${usage.currentValue}/${usage.limit}). Choose a different region or request a quota increase in the Azure portal.`)
    }
  }

  // Ensure resource group exists
  const rmClient = new ResourceManagementClient(azureCredential, subscriptionId)
  await rmClient.resourceGroups.createOrUpdate(resourceGroup, { location })

  // Create next-gen Foundry resource (with project management + custom subdomain)
  const poller = await csClient.accounts.beginCreate(resourceGroup, accountName, {
    location,
    kind: 'AIServices',
    sku: { name: 'S0' },
    identity: { type: 'SystemAssigned' as any },
    properties: {
      allowProjectManagement: true,
      customSubDomainName: accountName
    } as any
  })
  const account = await poller.pollUntilDone()

  const subClient = new SubscriptionClient(azureCredential)
  let subName = subscriptionId
  for await (const s of subClient.subscriptions.list()) {
    if (s.subscriptionId === subscriptionId) { subName = s.displayName || subscriptionId; break }
  }

  return {
    subscriptionId,
    subscriptionName: subName,
    resourceGroup,
    accountName: account.name || accountName,
    endpoint: account.properties?.endpoint || '',
    kind: 'AIServices',
    location
  }
}

/**
 * Create a model deployment within an existing Azure AI resource.
 */
export async function foundryCreateDeployment(
  subscriptionId: string,
  resourceGroup: string,
  accountName: string,
  deploymentName: string,
  modelName: string,
  modelVersion: string,
  modelFormat: string,
  skuName: string
): Promise<FoundryDeployment> {
  if (!azureCredential) throw new Error('Not signed in to Azure. Please sign in first.')

  const csClient = new CognitiveServicesManagementClient(azureCredential, subscriptionId)
  const poller = await csClient.deployments.beginCreateOrUpdate(
    resourceGroup,
    accountName,
    deploymentName,
    {
      sku: { name: skuName, capacity: 80 },
      properties: {
        model: {
          name: modelName,
          version: modelVersion,
          format: modelFormat
        }
      }
    }
  )
  const dep = await poller.pollUntilDone()

  return {
    name: dep.name || deploymentName,
    model: modelName,
    modelVersion,
    skuName: dep.sku?.name || 'Standard'
  }
}

/**
 * Step 4: User picks a deployment — we fetch the API key and save everything.
 */
export async function foundrySelect(
  subscriptionId: string,
  resourceGroup: string,
  accountName: string,
  endpoint: string,
  deploymentName: string,
  model: string
): Promise<void> {
  if (!azureCredential) throw new Error('Not signed in to Azure. Please sign in first.')

  const conn = connections.get('foundry')!
  conn.checking = true
  broadcastConnectionStatus()

  try {
    // Fetch API keys for the resource
    const csClient = new CognitiveServicesManagementClient(azureCredential, subscriptionId)
    const keys = await csClient.accounts.listKeys(resourceGroup, accountName)
    const apiKey = keys.key1 || keys.key2
    if (!apiKey) throw new Error('No API keys available for this resource. Check Azure portal permissions.')

    // Save config + key
    const config: FoundryConfig = {
      subscriptionId,
      resourceGroup,
      accountName,
      endpoint: endpoint.replace(/\/+$/, ''),
      deploymentName,
      modelId: model,
      displayName: `${model} (${accountName})`
    }
    saveSecure(foundryPath(FOUNDRY_CONFIG_FILE), config)
    saveSecure(foundryPath(FOUNDRY_KEY_FILE), { apiKey })

    conn.authenticated = true
    conn.verified = true
    conn.checking = false
    conn.lastError = null
    conn.activeAccount = config.displayName
  } catch (err: any) {
    conn.checking = false
    conn.lastError = err?.message || 'Failed to configure deployment'
    throw err
  } finally {
    broadcastConnectionStatus()
  }
}

/**
 * Build the SDK ProviderConfig for the active Foundry connection.
 * Returns null if Foundry is not configured.
 */
export function getFoundryProviderConfig(): {
  type: 'azure'
  baseUrl: string
  apiKey: string
  azure: { apiVersion: string }
  modelId: string
  wireModel: string
} | null {
  const config = getFoundryConfig()
  const apiKey = getFoundryApiKey()
  if (!config || !apiKey) return null

  const baseUrl = config.endpoint.replace(/\/+$/, '')
  return {
    type: 'azure',
    baseUrl,
    apiKey,
    azure: { apiVersion: '2025-04-01-preview' },
    modelId: config.modelId,
    wireModel: config.deploymentName
  }
}

/**
 * Check if a model ID corresponds to the Foundry connection.
 */
export function isFoundryModel(modelId: string): boolean {
  return modelId.startsWith('foundry:')
}

/**
 * Get the Foundry model as a ModelInfo entry for the model picker.
 * Returns null if Foundry is not configured/verified.
 */
export function getFoundryModelInfo(): import('@shared/types').ModelInfo | null {
  const conn = connections.get('foundry')
  if (!conn?.verified) return null
  const config = getFoundryConfig()
  if (!config) return null
  return {
    id: `foundry:${config.deploymentName}`,
    name: config.displayName,
    source: 'foundry'
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
